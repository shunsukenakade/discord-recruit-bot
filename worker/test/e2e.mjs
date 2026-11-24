// ローカルの wrangler dev に、Discord と同じ形式の署名付きリクエストを送って動作を確認する。
// Discord API への送信は、このスクリプトが立てる偽サーバーで受け取って記録する。
// 実行: npm test
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const WORKER = "http://127.0.0.1:8797";
const MOCK_PORT = 8798;

// ---- テスト用の鍵 ----
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");

// ---- 偽の Discord API ----
const apiCalls = [];
let channelMessageStatus = 200; // 返信の送信を失敗させるときに変える
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    apiCalls.push({ method: req.method, path: req.url, body: JSON.parse(body || "{}"), auth: req.headers.authorization });
    const status = req.url.includes("/channels/") ? channelMessageStatus : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? JSON.stringify({ id: `posted${apiCalls.length}` }) : '{"message":"error"}');
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

// ---- wrangler dev ----
const dev = spawn("npx", [
  "wrangler", "dev", "--port", "8797", "--ip", "127.0.0.1",
  "--persist-to", mkdtempSync(join(tmpdir(), "recruit-e2e-")),
  "--var", `DISCORD_PUBLIC_KEY:${publicKeyHex}`,
  "--var", `DISCORD_API_BASE:http://127.0.0.1:${MOCK_PORT}`,
  "--var", "DISCORD_TOKEN:dummy-token",
], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

function stopAll() {
  mock.close();
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"]);
  else dev.kill();
}

for (let i = 0; ; i++) {
  try {
    if ((await fetch(WORKER)).ok) break;
  } catch {}
  if (i > 120) {
    console.error(devLog);
    stopAll();
    throw new Error("wrangler dev が起動しませんでした");
  }
  await new Promise((r) => setTimeout(r, 500));
}

// ---- ヘルパー ----
let seq = 1000;
const nextId = () => String(++seq);
const CHANNEL = "555";

async function send(payload, { badSignature = false, noSignature = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { "Content-Type": "application/json" };
  if (!noSignature) {
    let sig = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    if (badSignature) sig = sig.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    headers["X-Signature-Ed25519"] = sig;
    headers["X-Signature-Timestamp"] = timestamp;
  }
  const res = await fetch(WORKER, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : text };
}

const user = (id, name) => ({ member: { nick: null, user: { id, username: name, global_name: name } } });

function command(name, options, who) {
  const id = nextId();
  return { id, type: 2, token: "tok" + id, channel_id: CHANNEL, data: { name, options }, ...who };
}

function press(customId, who, messageId = "msg1") {
  return {
    id: nextId(), type: 3, token: "tok-press", channel_id: CHANNEL,
    message: { id: messageId }, data: { custom_id: customId, component_type: 2 }, ...who,
  };
}

async function waitForCalls(count) {
  for (let i = 0; i < 60 && apiCalls.length < count; i++) await new Promise((r) => setTimeout(r, 100));
  return apiCalls.slice(0, count);
}

const buttons = (res) => Object.fromEntries(
  res.json.data.components[0].components.map((b) => [b.custom_id.split(":")[0], b]),
);
const field = (res, name) => res.json.data.embeds[0].fields.find((f) => f.name === name)?.value;
const isError = (res, text) => res.json.type === 4 && res.json.data.flags === 64 && res.json.data.content.includes(text);

const host = user("1", "主催者");
const A = user("2", "Aさん");
const B = user("3", "Bさん");
const C = user("4", "Cさん");
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}`);
    stopAll();
    throw e;
  }
}

console.log("署名・PING");
await test("署名なしは401", async () => assert.equal((await send({ type: 1 }, { noSignature: true })).status, 401));
await test("不正な署名は401", async () => assert.equal((await send({ type: 1 }, { badSignature: true })).status, 401));
await test("PINGにPONGを返す", async () => assert.deepEqual((await send({ type: 1 })).json, { type: 1 }));

console.log("/help");
await test("本人にだけ見える使い方", async () => {
  const r = await send(command("help", undefined, host));
  assert.equal(r.json.data.flags, 64);
  assert.ok(r.json.data.embeds[0].fields[0].value.startsWith("`/v` … valorant（5人）"));
});

console.log("/v 人数:3 時刻:22:00〜");
const v = command("v", [{ name: "人数", type: 4, value: 3 }, { name: "時刻", type: 3, value: "22:00〜" }], host);
const rid = v.id;
await test("@everyone付きで募集を投稿", async () => {
  const r = await send(v);
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.content, "@everyone");
  assert.deepEqual(r.json.data.allowed_mentions, { parse: ["everyone"] });
  assert.equal(r.json.data.embeds[0].title, "🟢 募集中｜valorant 参加者募集");
  assert.equal(field(r, "開始予定"), "22:00〜");
  assert.equal(field(r, "定員"), "1/3人");
  assert.equal(buttons(r).join.custom_id, `join:${rid}`);
  assert.equal(buttons(r).start.disabled, true);
});

await test("主催者以外は再募集できない", async () =>
  assert.ok(isError(await send(press(`again:${rid}`, A)), "主催者のみ")));
await test("再募集は返信で「@everyone valorant @2」", async () => {
  const r = await send(press(`again:${rid}`, host));
  assert.equal(r.json.type, 6);
  const [call] = await waitForCalls(1);
  assert.equal(call.path, `/channels/${CHANNEL}/messages`);
  assert.equal(call.auth, "Bot dummy-token");
  assert.equal(call.body.content, "@everyone valorant @2");
  assert.equal(call.body.message_reference.message_id, "msg1");
  assert.deepEqual(call.body.allowed_mentions, { parse: ["everyone"], replied_user: false });
});
await test("締め切り前は開始を呼びかけられない", async () =>
  assert.ok(isError(await send(press(`start:${rid}`, host)), "締め切り後")));
await test("Aさんが参加 → 2/3人", async () => {
  const r = await send(press(`join:${rid}`, A));
  assert.equal(r.json.type, 7);
  assert.equal(field(r, "定員"), "2/3人");
  assert.equal(field(r, "参加者一覧"), "・主催者\n・Aさん");
});
await test("二重参加はできない", async () => assert.ok(isError(await send(press(`join:${rid}`, A)), "すでに参加")));
await test("主催者は抜けられない", async () => assert.ok(isError(await send(press(`leave:${rid}`, host)), "主催者は抜けられません")));
await test("Bさんが参加 → 満員で自動締め切り＋メンションなしの通知", async () => {
  apiCalls.length = 0;
  const r = await send(press(`join:${rid}`, B));
  assert.equal(r.json.data.embeds[0].title, "🔴 締め切り｜valorant 参加者募集");
  assert.equal(buttons(r).join.disabled, true);
  assert.equal(buttons(r).again.disabled, true);
  assert.equal(buttons(r).start.disabled, false);
  const [call] = await waitForCalls(1);
  assert.equal(call.body.content, "valorant のメンバーが揃いました！（3/3人）募集を締め切りました。\n参加者: 主催者、Aさん、Bさん");
  assert.deepEqual(call.body.allowed_mentions, { parse: [], replied_user: false });
});
await test("締め切り後は参加できない", async () => assert.ok(isError(await send(press(`join:${rid}`, C)), "締め切られています")));
await test("開始の呼びかけで参加者全員にメンション", async () => {
  apiCalls.length = 0;
  const r = await send(press(`start:${rid}`, host));
  assert.equal(r.json.type, 6);
  const [call] = await waitForCalls(1);
  assert.equal(call.body.content, "<@1> <@2> <@3>\nvalorant を開始します！集まってください。");
  assert.deepEqual(call.body.allowed_mentions, { users: ["1", "2", "3"], replied_user: false });
});

console.log("その他");
await test("Python版の古いボタンには案内を返す", async () =>
  assert.ok(isError(await send(press("recruit_join", A)), "以前のバージョン")));
await test("存在しない募集には期限切れを返す", async () =>
  assert.ok(isError(await send(press("join:999999", A)), "期限切れ")));
await test("/recruit（定員なし）と再募集", async () => {
  const c = command("recruit", [{ name: "game", type: 3, value: "minecraft" }, { name: "memo", type: 3, value: "初心者歓迎" }], host);
  const r = await send(c);
  assert.equal(field(r, "参加人数"), "1人");
  assert.equal(field(r, "メモ"), "初心者歓迎");
  apiCalls.length = 0;
  await send(press(`again:${c.id}`, host, "msg2"));
  const [call] = await waitForCalls(1);
  assert.equal(call.body.content, "@everyone minecraft");
});
await test("主催者の締め切りでは「揃いました」を送らない", async () => {
  const c = command("anow", undefined, host);
  await send(c);
  apiCalls.length = 0;
  const r = await send(press(`close:${c.id}`, host));
  assert.equal(r.json.data.embeds[0].title, "🔴 締め切り｜今apex 参加者募集");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(apiCalls.length, 0);
});
await test("5人が同時に参加しても定員（3人）を超えない", async () => {
  const c = command("a", undefined, host);
  await send(c);
  apiCalls.length = 0;
  const people = ["10", "11", "12", "13", "14"].map((id) => user(id, "user" + id));
  const results = await Promise.all(people.map((p) => send(press(`join:${c.id}`, p))));
  assert.equal(results.filter((r) => r.json.type === 7).length, 2);
  const final = results.filter((r) => r.json.type === 7).find((r) => field(r, "定員") === "3/3人");
  assert.ok(final, "3/3人の表示がない");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(apiCalls.filter((a) => a.body.content?.includes("揃いました")).length, 1);
});
console.log("ワンボタン募集パネル");
await test("/panel でボタン9個（3行）のパネルを置く", async () => {
  const r = await send(command("panel", undefined, host));
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.flags, undefined);
  assert.equal(r.json.data.embeds[0].title, "🎮 ワンボタン募集");
  const rows = r.json.data.components;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].components.map((b) => b.custom_id), ["panel:v", "panel:o", "panel:a"]);
  assert.equal(rows[1].components[0].label, "夜valorant（5人）");
});
await test("パネルのボタンで、押した人が主催者の募集を投稿", async () => {
  const p = press("panel:a", A, "panelMsg");
  const r = await send(p);
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.content, "@everyone");
  assert.deepEqual(r.json.data.allowed_mentions, { parse: ["everyone"] });
  assert.equal(r.json.data.embeds[0].title, "🟢 募集中｜apex 参加者募集");
  assert.equal(r.json.data.embeds[0].footer.text, "主催: Aさん");
  assert.equal(field(r, "定員"), "1/3人");
  assert.equal(buttons(r).join.custom_id, `join:${p.id}`);
  // 作られた募集のボタンも動く
  const j = await send(press(`join:${p.id}`, B));
  assert.equal(field(j, "定員"), "2/3人");
  assert.ok(isError(await send(press(`close:${p.id}`, host)), "主催者のみ"));
});
await test("同じパネルは何度でも使える", async () => {
  const r = await send(press("panel:v", C, "panelMsg"));
  assert.equal(r.json.data.embeds[0].footer.text, "主催: Cさん");
});
await test("知らないパネルボタンには案内を返す", async () =>
  assert.ok(isError(await send(press("panel:zzz", A)), "パネルを置き直して")));

console.log("送信先つきパネル");
const TARGET = "777";
await test("/panel 送信先:#募集 のボタンには送信先が入る", async () => {
  const c = command("panel", [{ name: "送信先", type: 7, value: TARGET }], host);
  const r = await send(c);
  assert.equal(r.json.data.components[0].components[0].custom_id, `panel:v:${TARGET}`);
  assert.ok(r.json.data.embeds[0].description.includes(`<#${TARGET}> に`));
});
await test("押すと送信先チャンネルに募集を投稿し、本人にだけリンクを知らせる", async () => {
  apiCalls.length = 0;
  const p = { ...press(`panel:o:${TARGET}`, A, "panelMsg"), guild_id: "999" };
  const r = await send(p);
  assert.equal(r.json.type, 5);
  assert.equal(r.json.data.flags, 64);
  const [post, edit] = await waitForCalls(2);
  assert.equal(post.method, "POST");
  assert.equal(post.path, `/channels/${TARGET}/messages`);
  assert.equal(post.body.content, "@everyone");
  assert.deepEqual(post.body.allowed_mentions, { parse: ["everyone"] });
  assert.equal(post.body.embeds[0].footer.text, "主催: Aさん");
  assert.equal(post.body.components[0].components[0].custom_id, `join:${p.id}`);
  assert.equal(edit.method, "PATCH");
  assert.equal(edit.path, "/webhooks/1551533498056314951/tok-press/messages/@original");
  assert.equal(edit.body.content, `<#${TARGET}> に募集を投稿しました → https://discord.com/channels/999/${TARGET}/posted1`);
  // 投稿された募集のボタンも動く（送信先チャンネルで押される）
  const j = await send({ ...press(`join:${p.id}`, B, "posted1"), channel_id: TARGET });
  assert.equal(field(j, "定員"), "2/5人");
});
await test("送信先がパネルと同じチャンネルなら、そのまま投稿する", async () => {
  const r = await send({ ...press(`panel:a:${TARGET}`, A), channel_id: TARGET });
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.content, "@everyone");
});
await test("送信先に投稿できないときは本人に知らせる", async () => {
  channelMessageStatus = 403;
  apiCalls.length = 0;
  await send(press(`panel:v:${TARGET}`, A));
  const [, edit] = await waitForCalls(2);
  channelMessageStatus = 200;
  assert.ok(edit.body.content.includes(`<#${TARGET}> を見られて`), edit.body.content);
});

for (const [status, expected] of [[403, "権限"], [401, "トークン"]]) {
  await test(`返信を送れないとき（${status}）は押した本人に「${expected}」を知らせる`, async () => {
    const c = command("o", undefined, host);
    await send(c);
    channelMessageStatus = status;
    apiCalls.length = 0;
    await send(press(`again:${c.id}`, host));
    const calls = await waitForCalls(2);
    channelMessageStatus = 200;
    assert.equal(calls[1].path, "/webhooks/1551533498056314951/tok-press");
    assert.equal(calls[1].body.flags, 64);
    assert.ok(calls[1].body.content.includes(expected), calls[1].body.content);
  });
}

console.log(`\n${passed}件すべて成功`);
stopAll();
