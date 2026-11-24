// 募集の状態と、ボタン操作の処理。
// 状態は募集ごとに1つの Durable Object に保存する。同じ募集への操作は順番に処理されるので、
// 同時に「参加する」が押されても定員を超えない。

import { DurableObject } from "cloudflare:workers";
import { QUICK_RECRUITS } from "./commands";

export interface Member {
  id: string;
  name: string;
}

export interface RecruitState {
  host: Member;
  game: string;
  capacity: number | null;
  startTime: string | null;
  memo: string | null;
  participants: Member[];
  closed: boolean;
}

export type Action = "join" | "leave" | "close" | "again" | "start" | "settime";

export type Outcome =
  | { kind: "missing" }
  | { kind: "error"; message: string }
  // 開始時刻の入力欄を開く（今の時刻を最初から入れておく）
  | { kind: "modal"; startTime: string | null }
  // 募集メッセージを書き換える。filled なら定員到達で締め切ったことも知らせる
  | { kind: "update"; state: RecruitState; filled: boolean }
  // 募集メッセージに返信（引用）する
  | { kind: "reply"; content: string; mention: "everyone" | "participants"; userIds: string[] };

const KEEP_FOR_MS = 30 * 24 * 60 * 60 * 1000; // 30日たった募集は削除する

export class Recruit extends DurableObject {
  async create(state: RecruitState): Promise<void> {
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_FOR_MS);
  }

  async act(action: Action, user: Member): Promise<Outcome> {
    const state = await this.ctx.storage.get<RecruitState>("state");
    if (!state) return { kind: "missing" };
    const outcome = applyAction(state, action, user);
    if (outcome.kind === "update") await this.ctx.storage.put("state", outcome.state);
    return outcome;
  }

  async setStartTime(user: Member, startTime: string): Promise<Outcome> {
    const state = await this.ctx.storage.get<RecruitState>("state");
    if (!state) return { kind: "missing" };
    const outcome = applyStartTime(state, user, startTime);
    if (outcome.kind === "update") await this.ctx.storage.put("state", outcome.state);
    return outcome;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** 入力欄で送られた開始時刻を反映する。空欄なら時刻を消す。 */
export function applyStartTime(state: RecruitState, user: Member, startTime: string): Outcome {
  if (user.id !== state.host.id) return { kind: "error", message: "時刻の設定は主催者のみ操作できます。" };
  state.startTime = startTime.trim() || null;
  return { kind: "update", state, filled: false };
}

/** ボタン操作を状態に反映する（state は書き換える）。 */
export function applyAction(state: RecruitState, action: Action, user: Member): Outcome {
  const isHost = user.id === state.host.id;
  const joined = state.participants.some((m) => m.id === user.id);

  switch (action) {
    case "join": {
      if (state.closed) return { kind: "error", message: "この募集は締め切られています。" };
      if (joined) return { kind: "error", message: "すでに参加しています。" };
      if (state.capacity && state.participants.length >= state.capacity) {
        return { kind: "error", message: "定員に達しています。" };
      }
      state.participants.push(user);
      // 定員に達したら自動締め切り
      const filled = !!state.capacity && state.participants.length >= state.capacity;
      if (filled) state.closed = true;
      return { kind: "update", state, filled };
    }
    case "leave": {
      if (isHost) {
        return { kind: "error", message: "主催者は抜けられません。締め切るには「締め切る」ボタンを使ってください。" };
      }
      if (!joined) return { kind: "error", message: "参加していません。" };
      state.participants = state.participants.filter((m) => m.id !== user.id);
      return { kind: "update", state, filled: false };
    }
    case "close": {
      if (!isHost) return { kind: "error", message: "締め切りは主催者のみ操作できます。" };
      state.closed = true;
      return { kind: "update", state, filled: false };
    }
    case "again": {
      if (!isHost) return { kind: "error", message: "再募集は主催者のみ操作できます。" };
      if (state.closed) return { kind: "error", message: "この募集は締め切られています。" };
      let content = `@everyone ${state.game}`;
      if (state.capacity) content += ` @${state.capacity - state.participants.length}`;
      return { kind: "reply", content, mention: "everyone", userIds: [] };
    }
    case "start": {
      if (!isHost) return { kind: "error", message: "開始の呼びかけは主催者のみ操作できます。" };
      if (!state.closed) return { kind: "error", message: "締め切り後に使えます。" };
      const mentions = state.participants.map((m) => `<@${m.id}>`).join(" ");
      return {
        kind: "reply",
        content: `${mentions}\n${state.game} を開始します！集まってください。`,
        mention: "participants",
        userIds: state.participants.map((m) => m.id),
      };
    }
    case "settime": {
      if (!isHost) return { kind: "error", message: "時刻の設定は主催者のみ操作できます。" };
      return { kind: "modal", startTime: state.startTime };
    }
  }
}

export function filledMessage(state: RecruitState): string {
  const names = state.participants.map((m) => m.name).join("、");
  return `${state.game} のメンバーが揃いました！（${state.participants.length}/${state.capacity}人）募集を締め切りました。\n参加者: ${names}`;
}

export function buildEmbed(state: RecruitState) {
  const status = state.closed ? "🔴 締め切り" : "🟢 募集中";
  const count = state.participants.length;
  const fields: { name: string; value: string; inline: boolean }[] = [];

  if (state.startTime) fields.push({ name: "開始予定", value: state.startTime, inline: true });
  if (state.capacity) fields.push({ name: "定員", value: `${count}/${state.capacity}人`, inline: true });
  else fields.push({ name: "参加人数", value: `${count}人`, inline: true });
  if (state.memo) fields.push({ name: "メモ", value: state.memo, inline: false });

  const names = state.participants.map((m) => `・${m.name}`).join("\n") || "（まだいません）";
  fields.push({ name: "参加者一覧", value: names.slice(0, 1024), inline: false });

  return {
    title: `${status}｜${state.game} 参加者募集`,
    color: state.closed ? 0x99aab5 : 0x57f287,
    fields,
    footer: { text: `主催: ${state.host.name}` },
  };
}

export function buildComponents(recruitId: string, state: RecruitState) {
  const button = (action: Action, label: string, style: number, disabled = false) => ({
    type: 2,
    custom_id: `${action}:${recruitId}`,
    label,
    style,
    disabled,
  });
  // 募集中は「参加する」「再募集」、締め切り後は「開始を呼びかける」だけ押せるようにする
  return [
    {
      type: 1,
      components: [
        button("join", "参加する", 3, state.closed),
        button("leave", "参加をやめる", 2),
        button("close", "締め切る", 4),
        button("again", "再募集", 1, state.closed),
        button("start", "開始を呼びかける", 1, !state.closed),
      ],
    },
    // 1行に置けるボタンは5個までなので2行目に置く
    { type: 1, components: [button("settime", "⏰ 時刻を設定", 2)] },
  ];
}

/** 開始時刻の入力欄。送信すると settime:<募集ID> の MODAL_SUBMIT が届く。 */
export function startTimeModal(recruitId: string, startTime: string | null) {
  return {
    custom_id: `settime:${recruitId}`,
    title: "開始時刻を設定",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4, // テキスト入力
            custom_id: "time",
            label: "開始時刻（空欄で送信すると時刻を消します）",
            style: 1,
            required: false,
            max_length: 50,
            placeholder: "例: 22:00〜",
            ...(startTime ? { value: startTime } : {}),
          },
        ],
      },
    ],
  };
}

export function panelEmbed(targetChannelId: string | null) {
  const where = targetChannelId ? ` <#${targetChannelId}> に` : "";
  return {
    title: "🎮 ワンボタン募集",
    description: `ボタンを押すと、押した人が主催者になって${where} @everyone で募集します。\n` +
      "開始時刻は、投稿された募集の「⏰ 時刻を設定」ボタンからあとで設定できます。",
    color: 0x5865f2,
  };
}

/** パネルのボタン。QUICK_RECRUITS を3つずつ1行に並べる（通常・夜・今）。 */
export function buildPanelComponents(targetChannelId: string | null) {
  const suffix = targetChannelId ? `:${targetChannelId}` : "";
  const rows = [];
  for (let i = 0; i < QUICK_RECRUITS.length; i += 3) {
    rows.push({
      type: 1,
      components: QUICK_RECRUITS.slice(i, i + 3).map(([name, game, capacity]) => ({
        type: 2,
        custom_id: `panel:${name}${suffix}`,
        label: `${game}（${capacity}人）`,
        style: 1,
      })),
    });
  }
  return rows;
}

export function helpEmbed() {
  const quick = QUICK_RECRUITS.map(([name, game, cap]) => `\`/${name}\` … ${game}（${cap}人）`).join("\n");
  return {
    title: "📖 ゲーム募集bot の使い方",
    color: 0x5865f2,
    fields: [
      {
        name: "かんたん募集",
        value: `${quick}\n\nオプションで **人数** と **時刻** を変更できます。\n例: \`/v 人数:3 時刻:22:00〜\``,
        inline: false,
      },
      {
        name: "自由に募集",
        value: "`/recruit ゲーム名` … 好きなゲームで募集します。\nオプション: 定員（capacity）・開始予定（start_time）・メモ（memo）",
        inline: false,
      },
      {
        name: "募集メッセージのボタン",
        value:
          "**参加する** … 募集に参加します\n" +
          "**参加をやめる** … 参加を取り消します（主催者は不可）\n" +
          "**締め切る** … 募集を締め切ります（主催者のみ）\n" +
          "**再募集** … 残り人数を @everyone で呼びかけます（主催者のみ・募集中）\n" +
          "**開始を呼びかける** … 参加者全員にメンションします（主催者のみ・締め切り後）\n" +
          "**⏰ 時刻を設定** … 開始予定を設定・変更します（主催者のみ）\n" +
          "定員に達すると自動で締め切られます。",
        inline: false,
      },
      {
        name: "その他",
        value: "`/panel` … ボタン1つで募集できるパネルを置きます（サーバー管理権限が必要）。" +
          "`送信先` で募集を投稿するチャンネルを選べます\n" +
          "`/help` … この説明を表示します",
        inline: false,
      },
    ],
  };
}
