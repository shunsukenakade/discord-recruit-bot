// ゲーム募集bot（Cloudflare Workers 版）
// Discord の Interactions Endpoint としてスラッシュコマンドとボタン操作を受け取る。

import { QUICK_RECRUITS } from "./commands";
import {
  Recruit,
  buildComponents,
  buildEmbed,
  filledMessage,
  helpEmbed,
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
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_UPDATE_MESSAGE = 6;
const UPDATE_MESSAGE = 7;
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
        return handleCommand(interaction, env);
      case MESSAGE_COMPONENT:
        return handleComponent(interaction, env, ctx);
    }
    return new Response("unknown interaction type", { status: 400 });
  },
} satisfies ExportedHandler<Env>;

async function handleCommand(interaction: any, env: Env): Promise<Response> {
  const name: string = interaction.data.name;
  if (name === "help") {
    return json({ type: CHANNEL_MESSAGE, data: { embeds: [helpEmbed()], flags: EPHEMERAL } });
  }

  const options: Record<string, any> = Object.fromEntries(
    (interaction.data.options ?? []).map((o: any) => [o.name, o.value]),
  );
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

  // 募集ごとの保存先はコマンドの interaction ID で決め、ボタンの custom_id に埋め込む
  const recruitId: string = interaction.id;
  await recruitStub(env, recruitId).create(state);

  return json({
    type: CHANNEL_MESSAGE,
    data: {
      content: "@everyone",
      embeds: [buildEmbed(state)],
      components: buildComponents(recruitId, state),
      allowed_mentions: { parse: ["everyone"] },
    },
  });
}

async function handleComponent(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [action, recruitId] = String(interaction.data.custom_id).split(":");
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
  }
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
    await discordApi(env, `/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}`, {
      content: "返信を送れませんでした。Botに「メッセージを送信」「メッセージ履歴を読む」権限があるか確認してください。",
      flags: EPHEMERAL,
    });
  }
}

function discordApi(env: Env, path: string, payload: object): Promise<Response> {
  return fetch(`${env.DISCORD_API_BASE}${path}`, {
    method: "POST",
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
