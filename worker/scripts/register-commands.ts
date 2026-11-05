// スラッシュコマンドを Discord に登録する（コマンドを変えたときだけ実行する）。
// トークンは環境変数 DISCORD_TOKEN、無ければ1つ上のフォルダの .env から読む。
import { readFileSync } from "node:fs";
import { COMMANDS } from "../src/commands.ts";

const APPLICATION_ID = "1551533498056314951";

function readToken(): string {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  const env = readFileSync(new URL("../../.env", import.meta.url), "utf-8").replace(/^\uFEFF/, "");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("DISCORD_TOKEN="));
  if (!line) throw new Error(".env に DISCORD_TOKEN がありません");
  return line.slice("DISCORD_TOKEN=".length).trim();
}

const res = await fetch(`https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${readToken()}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
});
if (!res.ok) {
  console.error("登録に失敗しました", res.status, await res.text());
  process.exit(1);
}
const registered = (await res.json()) as { name: string }[];
console.log(`${registered.length}個のコマンドを登録しました: ${registered.map((c) => "/" + c.name).join(" ")}`);
