// スラッシュコマンドの定義。Worker本体とコマンド登録スクリプトの両方から使う。
// （登録スクリプトは node で直接実行するので、このファイルは他のファイルを import しない）

// ショートカット募集コマンド: [コマンド名, 表示するゲーム名, デフォルト人数]
export const QUICK_RECRUITS: [string, string, number][] = [
  ["v", "valorant", 5],
  ["o", "overwatch", 5],
  ["a", "apex", 3],
  ["vnight", "夜valorant", 5],
  ["onight", "夜overwatch", 5],
  ["anight", "夜apex", 3],
  ["vnow", "今valorant", 5],
  ["onow", "今overwatch", 5],
  ["anow", "今apex", 3],
];

const STRING = 3;
const INTEGER = 4;
// サーバー内でだけ使えるようにする（DMでは使わせない）
const GUILD_ONLY = { contexts: [0], integration_types: [0] };

export const COMMANDS = [
  {
    name: "recruit",
    description: "ゲームの参加者募集を投稿します",
    ...GUILD_ONLY,
    options: [
      { type: STRING, name: "game", description: "ゲーム名", required: true },
      { type: INTEGER, name: "capacity", description: "定員（人数上限。指定しない場合は無制限）", min_value: 1, max_value: 99 },
      { type: STRING, name: "start_time", description: "開始予定（例: 21:00〜 / 今すぐ など、自由記述）" },
      { type: STRING, name: "memo", description: "補足メモ（任意）" },
    ],
  },
  ...QUICK_RECRUITS.map(([name, game, capacity]) => ({
    name,
    description: `${game}の募集（${capacity}人）`,
    ...GUILD_ONLY,
    options: [
      { type: INTEGER, name: "人数", description: `人数（指定しない場合は${capacity}人）`, min_value: 1, max_value: 99 },
      { type: STRING, name: "時刻", description: "開始時刻（例: 21:00〜）" },
    ],
  })),
  {
    name: "help",
    description: "コマンドとボタンの使い方を表示します",
    ...GUILD_ONLY,
  },
];
