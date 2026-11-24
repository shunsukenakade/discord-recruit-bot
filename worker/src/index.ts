// ゲーム募集bot（Cloudflare Workers 版）
// Discord の Interactions Endpoint としてスラッシュコマンドとボタン操作を受け取る。

import { QUICK_RECRUITS } from "./commands";
import {
  Recruit,
  buildComponents,
  buildEmbed,
  buildPanelComponents,
  filledMessage,
  helpEmbed,
  buildVpanelComponents,
  panelEmbed,
  startTimeModal,
  timePicker,
  tokenToTime,
  vpanelEmbed,
  type Action,
  type Member,
  type RecruitState,
} from "./recruit";

export { Recruit };

export interface Env {
  RECRUITS: DurableObjectNamespace<Recruit>;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string; // wrangler secret put DISCORD_TOKEN で設定する
  DISCORD_API_BASE: string;
}

// Discord の interaction / response の種類
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_CHANNEL_MESSAGE = 5;
const DEFERRED_UPDATE_MESSAGE = 6;
const UPDATE_MESSAGE = 7;
const MODAL = 9;
const EPHEMERAL = 64;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response("ゲーム募集bot は稼働中です。");

    const body = await request.text();
    if (!(await verifySignature(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);
    switch (interaction.type) {
      case PING:
        return json({ type: PONG });
      case APPLICATION_COMMAND:
        return handleCommand(interaction, env, ctx);
      case MESSAGE_COMPONENT:
        return handleComponent(interaction, env, ctx);
      case MODAL_SUBMIT:
        return handleModalSubmit(interaction, env);
    }
    return new Response("unknown interaction type", { status: 400 });
  },
} satisfies ExportedHandler<Env>;

async function handleCommand(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const name: string = interaction.data.name;
  if (name === "help") {
    return json({ type: CHANNEL_MESSAGE, data: { embeds: [helpEmbed()], flags: EPHEMERAL } });
  }

  const options: Record<string, any> = Object.fromEntries(
    (interaction.data.options ?? []).map((o: any) => [o.name, o.value]),
  );
  if (name === "panel") {
    // 3ゲームのパネルと valorant パネルを続けて置く。送信先を指定すると、パネルから作った募集はそこに投稿される
    const target: string | null = options["送信先"] ?? null;
    const panels = [
      { embeds: [panelEmbed(target)], components: buildPanelComponents(target) },
      { embeds: [vpanelEmbed(target)], components: buildVpanelComponents(target) },
    ];
    // コマンドへの応答として出すと「〇〇さんが /panel を使用しました」と付くので、Botの普通のメッセージとして置く
    for (const [i, panel] of panels.entries()) {
      const res = await discordApi(env, `/channels/${interaction.channel_id}/messages`, panel);
      if (res.ok) continue;
      console.error("パネルを置けませんでした", res.status, await res.text());
      const reason = res.status === 401
        ? "Botのトークン設定に問題があります（Botの管理者に連絡してください）。"
        : "このチャンネルで、Botに「チャンネルを見る」「メッセージを送信」「埋め込みリンク」の権限があるか確認してください。";
      return ephemeral(i === 0 ? `パネルを置けませんでした。${reason}` : `valorant パネルを置けませんでした。${reason}`);
    }
    return ephemeral("パネルを置きました。");
  }
  const host = memberOf(interaction);
  let state: RecruitState;
  if (name === "recruit") {
    state = newState(host, options.game, options.capacity ?? null, options.start_time ?? null, options.memo ?? null);
  } else {
    const quick = QUICK_RECRUITS.find(([n]) => n === name);
    if (!quick) return ephemeral("不明なコマンドです。");
    const [, game, defaultCapacity] = quick;
    state = newState(host, game, options["人数"] ?? defaultCapacity, options["時刻"] ?? null, null);
  }

  return postRecruit(interaction, env, ctx, state);
}

/** 募集を保存して、@everyone 付きの募集メッセージを投稿する。 */
async function postRecruit(interaction: any, env: Env, ctx: ExecutionContext,
                           state: RecruitState): Promise<Response> {
  // 募集ごとの保存先は interaction ID で決め、ボタンの custom_id に埋め込む
  const recruitId: string = interaction.id;
  await recruitStub(env, recruitId).create(state);
  return json({ type: CHANNEL_MESSAGE, data: recruitMessage(recruitId, state) });
}

/** 別のチャンネルに募集を投稿し、押した本人にだけ投稿先を知らせる。 */
async function postRecruitTo(interaction: any, env: Env, ctx: ExecutionContext, state: RecruitState,
                             channelId: string): Promise<Response> {
  const recruitId: string = interaction.id;
  await recruitStub(env, recruitId).create(state);

  ctx.waitUntil((async () => {
    const res = await discordApi(env, `/channels/${channelId}/messages`, recruitMessage(recruitId, state));
    let content: string;
    if (res.ok) {
      const message = (await res.json()) as { id: string };
      content = `<#${channelId}> に募集を投稿しました → ` +
        `https://discord.com/channels/${interaction.guild_id}/${channelId}/${message.id}`;
    } else {
      console.error("募集の投稿に失敗しました", res.status, await res.text());
      content = res.status === 401
        ? "募集を投稿できませんでした。Botのトークン設定に問題があります（Botの管理者に連絡してください）。"
        : `募集を投稿できませんでした。Botが <#${channelId}> を見られて、メッセージを送信できるか確認してください。`;
    }
    await discordApi(env, `/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`,
                     { content }, "PATCH");
  })());

  // 投稿が終わるまで「考え中…」を本人にだけ表示しておく
  return json({ type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
}

/** パネルから作った募集を、送信先があればそこへ、無ければパネルと同じチャンネルに投稿する。 */
function postPanelRecruit(interaction: any, env: Env, ctx: ExecutionContext, state: RecruitState,
                          target: string | undefined): Promise<Response> {
  if (target && target !== interaction.channel_id) return postRecruitTo(interaction, env, ctx, state, target);
  return postRecruit(interaction, env, ctx, state);
}

function recruitMessage(recruitId: string, state: RecruitState) {
  return {
    content: "@everyone",
    embeds: [buildEmbed(state)],
    components: buildComponents(recruitId, state),
    allowed_mentions: { parse: ["everyone"] },
  };
}

async function handleComponent(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [action, recruitId, target] = String(interaction.data.custom_id).split(":");
  if (action === "panel") {
    // ワンボタン募集パネル: 押した人を主催者にして、既定の人数で募集する
    // custom_id は panel:<コマンド名>[:<送信先チャンネルID>]
    const quick = QUICK_RECRUITS.find(([n]) => n === recruitId);
    if (!quick) return ephemeral("このボタンは現在使えません。パネルを置き直してください。");
    const [, game, capacity] = quick;
    return postPanelRecruit(interaction, env, ctx, newState(memberOf(interaction), game, capacity, null, null), target);
  }
  if (action === "vtime" || action === "vtimesel") {
    // valorant パネル: 押した人を主催者にして、選んだ時刻で valorant を募集する
    //   ボタン         vtime:<時刻(2130・今・夜)>[:<送信先>]
    //   ドロップダウン vtimesel[:<送信先>]、時刻は選んだ値（一時期ドロップダウンにしていたパネル用）
    const [token, channel] = action === "vtime"
      ? [recruitId, target]
      : [interaction.data.values?.[0] ?? "", recruitId];
    const startTime = tokenToTime(token);
    const quick = QUICK_RECRUITS.find(([n]) => n === "v");
    if (!startTime || !quick) return ephemeral("このボタンは現在使えません。パネルを置き直してください。");
    const [, game, capacity] = quick;
    return postPanelRecruit(interaction, env, ctx, newState(memberOf(interaction), game, capacity, startTime, null),
                            channel);
  }
  if (action === "timeset" || action === "timeinput") return handleTimePicker(interaction, env);
  if (!recruitId) {
    // Python版のBotで作られた募集のボタン
    return ephemeral("この募集は以前のバージョンで作られたため操作できません。新しく募集を作り直してください。");
  }

  const outcome = await recruitStub(env, recruitId).act(action as Action, memberOf(interaction));
  switch (outcome.kind) {
    case "missing":
      return ephemeral("この募集は期限切れのため操作できません。新しく募集を作り直してください。");
    case "error":
      return ephemeral(outcome.message);
    case "update":
      if (outcome.filled) {
        // 人数が揃ったことを知らせる（通知は鳴らさず、名前だけ表示）
        ctx.waitUntil(replyToRecruit(env, interaction, filledMessage(outcome.state), { parse: [] }));
      }
      return json({
        type: UPDATE_MESSAGE,
        data: { embeds: [buildEmbed(outcome.state)], components: buildComponents(recruitId, outcome.state) },
      });
    case "reply": {
      const allowed = outcome.mention === "everyone" ? { parse: ["everyone"] } : { users: outcome.userIds };
      ctx.waitUntil(replyToRecruit(env, interaction, outcome.content, allowed, true));
      return json({ type: DEFERRED_UPDATE_MESSAGE });
    }
    case "pickTime":
      // 選択画面は別のメッセージなので、あとで書き換えられるよう募集メッセージの場所を custom_id に入れる
      return json({
        type: CHANNEL_MESSAGE,
        data: {
          ...timePicker(`${recruitId}:${interaction.channel_id}:${interaction.message.id}`, outcome.state),
          flags: EPHEMERAL,
        },
      });
  }
}

/**
 * 時刻の選択画面の操作。custom_id は
 *   timeset:<募集ID>:<チャンネル>:<メッセージ>[:今|夜]  … 時刻を選んだ（時刻はメニューの値）
 *   timeinput:<募集ID>:<チャンネル>:<メッセージ>       … 「自分で入力」で入力欄を開く
 */
async function handleTimePicker(interaction: any, env: Env): Promise<Response> {
  const [action, recruitId, channelId, messageId, ...rest] = String(interaction.data.custom_id).split(":");
  if (action === "timeinput") {
    const found = await recruitStub(env, recruitId).act("settime", memberOf(interaction));
    if (found.kind !== "pickTime") return updatePicker(timeErrorMessage(found));
    return json({
      type: MODAL,
      data: startTimeModal(`timeedit:${recruitId}:${channelId}:${messageId}`, found.state.startTime),
    });
  }
  const value = interaction.data.values?.[0] ?? rest.join(":");
  return applyStartTime(interaction, env, recruitId, channelId, messageId, value);
}

/** 開始時刻を保存して募集メッセージを書き換え、選択画面を結果の表示に置き換える。 */
async function applyStartTime(interaction: any, env: Env, recruitId: string, channelId: string,
                              messageId: string, startTime: string): Promise<Response> {
  const outcome = await recruitStub(env, recruitId).setStartTime(memberOf(interaction), startTime);
  if (outcome.kind !== "update") return updatePicker(timeErrorMessage(outcome));

  const state = outcome.state;
  const res = await discordApi(env, `/channels/${channelId}/messages/${messageId}`,
                               { embeds: [buildEmbed(state)], components: buildComponents(recruitId, state) },
                               "PATCH");
  if (res.ok) {
    return updatePicker(state.startTime ? `開始予定を「${state.startTime}」にしました。` : "開始予定を消しました。");
  }
  console.error("募集メッセージの書き換えに失敗しました", res.status, await res.text());
  return updatePicker(
    res.status === 404 ? "募集メッセージが見つかりませんでした（削除された可能性があります）。"
      : res.status === 401 ? "募集メッセージを書き換えられませんでした。Botのトークン設定に問題があります（Botの管理者に連絡してください）。"
      : "募集メッセージを書き換えられませんでした。Botの権限を確認してください。",
  );
}

function timeErrorMessage(outcome: { kind: string; message?: string }): string {
  if (outcome.kind === "missing") return "この募集は期限切れのため操作できません。";
  return outcome.message ?? "時刻を設定できませんでした。";
}

/** 本人にだけ見えている選択画面を、文章だけのメッセージに置き換える。 */
function updatePicker(content: string): Response {
  return json({ type: UPDATE_MESSAGE, data: { content, components: [] } });
}

/** 「✏️ 自分で入力」の入力欄が送信されたら、開始時刻を反映する。 */
async function handleModalSubmit(interaction: any, env: Env): Promise<Response> {
  const [action, recruitId, channelId, messageId] = String(interaction.data.custom_id).split(":");
  if (action !== "timeedit" || !messageId) return ephemeral("この入力欄は現在使えません。");
  const startTime = findInputValue(interaction.data.components, "time") ?? "";
  return applyStartTime(interaction, env, recruitId, channelId, messageId, startTime);
}

/** 送信された入力欄の中から、指定した custom_id のテキスト入力の値を探す。 */
function findInputValue(components: any[] | undefined, customId: string): string | undefined {
  for (const c of components ?? []) {
    if (c.custom_id === customId && typeof c.value === "string") return c.value;
    const nested = findInputValue(c.components ?? (c.component ? [c.component] : undefined), customId);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function newState(host: Member, game: string, capacity: number | null, startTime: string | null,
                  memo: string | null): RecruitState {
  return { host, game, capacity, startTime, memo, participants: [host], closed: false };
}

function memberOf(interaction: any): Member {
  const user = interaction.member?.user ?? interaction.user;
  return { id: user.id, name: interaction.member?.nick ?? user.global_name ?? user.username };
}

function recruitStub(env: Env, recruitId: string) {
  return env.RECRUITS.get(env.RECRUITS.idFromName(recruitId));
}

/** 募集メッセージに返信（引用）する形で投稿する。warnOnFailure なら失敗を押した本人に伝える。 */
async function replyToRecruit(env: Env, interaction: any, content: string, allowedMentions: object,
                              warnOnFailure = false): Promise<void> {
  const res = await discordApi(env, `/channels/${interaction.channel_id}/messages`, {
    content,
    message_reference: { message_id: interaction.message.id, fail_if_not_exists: false },
    allowed_mentions: { ...allowedMentions, replied_user: false },
  });
  if (res.ok) return;

  console.error("返信の送信に失敗しました", res.status, await res.text());
  if (warnOnFailure) {
    // 押した本人への通知は interaction のトークンで送るので、Botトークンが無効でも届く
    const content = res.status === 401
      ? "返信を送れませんでした。Botのトークン設定に問題があります（Botの管理者に連絡してください）。"
      : "返信を送れませんでした。Botに「メッセージを送信」「メッセージ履歴を読む」権限があるか確認してください。";
    await discordApi(env, `/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}`, {
      content,
      flags: EPHEMERAL,
    });
  }
}

function discordApi(env: Env, path: string, payload: object, method = "POST"): Promise<Response> {
  return fetch(`${env.DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/shunsukenakade/discord-recruit-bot, 2.0.0)",
    },
    body: JSON.stringify(payload),
  });
}

/** Discord からのリクエストであることを Ed25519 署名で確認する。 */
async function verifySignature(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature),
                                      new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

function json(data: unknown): Response {
  return Response.json(data);
}

function ephemeral(content: string): Response {
  return json({ type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });
}
