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

// 前回のテストの wrangler dev が残っていると、別の鍵で応答してしまうので先に確かめる
try {
  await fetch(WORKER);
  throw new Error(`${WORKER} が使用中です。前回のテストの wrangler dev が残っていないか確認してください。`);
} catch (e) {
  if (e.message.includes("使用中")) throw e;
}

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
  res.json.data.components.flatMap((row) => row.components).map((b) => [b.custom_id.split(":")[0], b]),
);

// 時刻の選択画面の操作（target は <募集ID>:<チャンネル>:<メッセージ>）
function pickFromMenu(target, half, value, who) {
  return {
    id: nextId(), type: 3, token: "tok-pick", channel_id: CHANNEL, message: { id: "picker" },
    data: { custom_id: `timeset:${target}:${half}`, component_type: 3, values: [value] }, ...who,
  };
}
function pickButton(customId, who) {
  return {
    id: nextId(), type: 3, token: "tok-pick", channel_id: CHANNEL, message: { id: "picker" },
    data: { custom_id: customId, component_type: 2 }, ...who,
  };
}
function submitTimeInput(target, value, who) {
  return {
    id: nextId(), type: 5, token: "tok-pick", channel_id: CHANNEL, message: { id: "picker" },
    data: { custom_id: `timeedit:${target}`, components: [{ type: 1, components: [{ type: 4, custom_id: "time", value }] }] },
    ...who,
  };
}
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
console.log("⏰ 時刻を設定（選択画面）");
await test("募集メッセージの2行目に「⏰ 時刻を設定」がある", async () => {
  const c = command("v", undefined, host);
  const r = await send(c);
  assert.equal(r.json.data.components.length, 2);
  assert.equal(r.json.data.components[1].components[0].custom_id, `settime:${c.id}`);
  assert.equal(field(r, "開始予定"), undefined);
});
await test("主催者以外は時刻を設定できない", async () => {
  const c = command("v", undefined, host);
  await send(c);
  assert.ok(isError(await send(press(`settime:${c.id}`, A)), "主催者のみ"));
  const r = await send(pickFromMenu(`${c.id}:${CHANNEL}:msgX`, "pm", "21:00", A));
  assert.equal(r.json.type, 7);
  assert.ok(r.json.data.content.includes("主催者のみ"));
});

const oc = command("o", undefined, host);
const target = `${oc.id}:${CHANNEL}:msgO`;
const startTimeOf = (call) => call.body.embeds[0].fields.find((f) => f.name === "開始予定")?.value;
await test("主催者が押すと、本人にだけ30分おきの時刻・今・夜・自分で入力の選択画面が出る", async () => {
  await send(oc);
  const r = await send(press(`settime:${oc.id}`, host, "msgO"));
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.flags, 64);
  assert.equal(r.json.data.content, "「overwatch」の開始予定を選んでください");
  const [am, pm, buttonsRow] = r.json.data.components.map((row) => row.components);
  assert.equal(am[0].custom_id, `timeset:${target}:am`);
  assert.equal(am[0].options.length, 24);
  assert.equal(am[0].options[0].value, "0:00");
  assert.equal(am[0].options[1].value, "0:30");
  assert.equal(am[0].options[23].value, "11:30");
  assert.equal(pm[0].options[0].value, "12:00");
  assert.equal(pm[0].options[23].value, "23:30");
  assert.deepEqual(buttonsRow.map((b) => [b.label, b.custom_id]), [
    ["今", `timeset:${target}:今`],
    ["夜", `timeset:${target}:夜`],
    ["✏️ 自分で入力", `timeinput:${target}`],
  ]);
});
await test("メニューで 21:30 を選ぶと、募集メッセージが書き換わり選択画面が結果に変わる", async () => {
  await send(press(`join:${oc.id}`, A, "msgO"));
  apiCalls.length = 0;
  const r = await send(pickFromMenu(target, "pm", "21:30", host));
  assert.equal(r.json.type, 7);
  assert.deepEqual(r.json.data, { content: "開始予定を「21:30」にしました。", components: [] });
  const [patch] = apiCalls;
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, `/channels/${CHANNEL}/messages/msgO`);
  assert.equal(startTimeOf(patch), "21:30");
  assert.equal(patch.body.embeds[0].fields.find((f) => f.name === "定員").value, "2/5人");
  assert.equal(patch.body.components[0].components[0].custom_id, `join:${oc.id}`);
  // もう一度開くと今の時刻が分かる
  const again = await send(press(`settime:${oc.id}`, host, "msgO"));
  assert.ok(again.json.data.content.endsWith("（現在: 21:30）"));
  assert.equal(again.json.data.components[1].components[0].options.find((o) => o.default).value, "21:30");
});
for (const word of ["今", "夜"]) {
  await test(`「${word}」ボタンで開始予定が「${word}」になる`, async () => {
    apiCalls.length = 0;
    const r = await send(pickButton(`timeset:${target}:${word}`, host));
    assert.equal(r.json.data.content, `開始予定を「${word}」にしました。`);
    assert.equal(startTimeOf(apiCalls[0]), word);
  });
}
await test("「自分で入力」で入力欄が開き、送信すると反映、空欄なら消える", async () => {
  const m = await send(pickButton(`timeinput:${target}`, host));
  assert.equal(m.json.type, 9);
  assert.equal(m.json.data.custom_id, `timeedit:${target}`);
  assert.equal(m.json.data.components[0].components[0].value, "夜");
  apiCalls.length = 0;
  const r = await send(submitTimeInput(target, "  22:00〜  ", host));
  assert.deepEqual(r.json.data, { content: "開始予定を「22:00〜」にしました。", components: [] });
  assert.equal(startTimeOf(apiCalls[0]), "22:00〜");
  apiCalls.length = 0;
  const cleared = await send(submitTimeInput(target, "", host));
  assert.equal(cleared.json.data.content, "開始予定を消しました。");
  assert.equal(startTimeOf(apiCalls[0]), undefined);
});
await test("締め切り後も時刻を変えられる", async () => {
  const c = command("anow", undefined, host);
  await send(c);
  await send(press(`close:${c.id}`, host));
  apiCalls.length = 0;
  await send(pickFromMenu(`${c.id}:${CHANNEL}:msgA`, "am", "1:00", host));
  assert.equal(startTimeOf(apiCalls[0]), "1:00");
  assert.equal(apiCalls[0].body.embeds[0].title, "🔴 締め切り｜今apex 参加者募集");
});
await test("募集メッセージが消されていたら知らせる", async () => {
  channelMessageStatus = 404;
  const r = await send(pickFromMenu(target, "am", "9:00", host));
  channelMessageStatus = 200;
  assert.ok(r.json.data.content.includes("見つかりませんでした"), r.json.data.content);
});

console.log("定員＋1 / 定員－1");
await test("2行目に定員＋1・定員－1があり、主催者だけ1人では減らせない状態", async () => {
  const c = command("a", undefined, host);
  const r = await send(c);
  const row = r.json.data.components[1].components;
  assert.deepEqual(row.map((b) => b.custom_id), [`settime:${c.id}`, `capup:${c.id}`, `capdown:${c.id}`]);
  assert.equal(buttons(r).capup.disabled, false);
  assert.equal(buttons(r).capdown.disabled, false); // 定員3・参加1なので減らせる
});
await test("主催者以外は定員を変えられない", async () => {
  const c = command("a", undefined, host);
  await send(c);
  assert.ok(isError(await send(press(`capup:${c.id}`, A)), "主催者のみ"));
  assert.ok(isError(await send(press(`capdown:${c.id}`, A)), "主催者のみ"));
});
await test("＋1で定員が増え、－1で減る", async () => {
  const c = command("a", undefined, host);
  await send(c);
  const up = await send(press(`capup:${c.id}`, host));
  assert.equal(up.json.type, 7);
  assert.equal(field(up, "定員"), "1/4人");
  const down = await send(press(`capdown:${c.id}`, host));
  assert.equal(field(down, "定員"), "1/3人");
});
await test("参加者の人数より少なくはできず、ちょうど満員になったら締め切って知らせる", async () => {
  const c = command("a", undefined, host); // 定員3
  await send(c);
  await send(press(`join:${c.id}`, A)); // 2/3
  apiCalls.length = 0;
  const r = await send(press(`capdown:${c.id}`, host)); // 2/2 → 満員
  assert.equal(field(r, "定員"), "2/2人");
  assert.equal(r.json.data.embeds[0].title, "🔴 締め切り｜apex 参加者募集");
  assert.equal(buttons(r).capdown.disabled, true);
  assert.equal(buttons(r).start.disabled, false);
  const [call] = await waitForCalls(1);
  assert.ok(call.body.content.startsWith("apex のメンバーが揃いました！（2/2人）"));
  assert.ok(isError(await send(press(`capdown:${c.id}`, host)), "減らせません"));
});
await test("満員で締め切られた募集に＋1すると募集中に戻り、また参加できる", async () => {
  const c = command("a", [{ name: "人数", type: 4, value: 2 }], host);
  await send(c);
  await send(press(`join:${c.id}`, A)); // 2/2 満員
  const r = await send(press(`capup:${c.id}`, host));
  assert.equal(field(r, "定員"), "2/3人");
  assert.equal(r.json.data.embeds[0].title, "🟢 募集中｜apex 参加者募集");
  assert.equal(buttons(r).join.disabled, false);
  const j = await send(press(`join:${c.id}`, B));
  assert.equal(field(j, "定員"), "3/3人");
});
await test("定員なしの募集では押せない", async () => {
  const c = command("recruit", [{ name: "game", type: 3, value: "minecraft" }], host);
  const r = await send(c);
  assert.equal(buttons(r).capup.disabled, true);
  assert.equal(buttons(r).capdown.disabled, true);
  assert.ok(isError(await send(press(`capup:${c.id}`, host)), "定員なし"));
});
await test("定員は1〜99人の範囲", async () => {
  const one = command("a", [{ name: "人数", type: 4, value: 1 }], host);
  const r1 = await send(one);
  assert.equal(buttons(r1).capdown.disabled, true);
  assert.ok(isError(await send(press(`capdown:${one.id}`, host)), "1人より少なく"));
  const max = command("a", [{ name: "人数", type: 4, value: 99 }], host);
  const r99 = await send(max);
  assert.equal(buttons(r99).capup.disabled, true);
  assert.ok(isError(await send(press(`capup:${max.id}`, host)), "99人まで"));
});

console.log("ワンボタン募集パネル");
await test("/panel で valorant・overwatch・apex の3ボタンのパネルを置く", async () => {
  const r = await send(command("panel", undefined, host));
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.flags, undefined);
  assert.equal(r.json.data.embeds[0].title, "🎮 ワンボタン募集");
  const rows = r.json.data.components;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].components.map((b) => [b.custom_id, b.label]),
    [["panel:v", "valorant（5人）"], ["panel:o", "overwatch（5人）"], ["panel:a", "apex（3人）"]]);
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

console.log("valorant パネル（/vpanel）");
const vselect = (value, who, customId = "vtimesel") => ({
  id: nextId(), type: 3, token: "tok-vsel", channel_id: CHANNEL, guild_id: "999", message: { id: "vpanelMsg" },
  data: { custom_id: customId, component_type: 3, values: [value] }, ...who,
});
await test("/vpanel で 1行目に今・夜のボタン、2行目に 19:00〜2:00（30分おき）のドロップダウン", async () => {
  const r = await send(command("vpanel", undefined, host));
  assert.equal(r.json.type, 4);
  assert.equal(r.json.data.embeds[0].title, "🎯 valorant 募集パネル");
  const [words, menuRow] = r.json.data.components.map((row) => row.components);
  assert.equal(r.json.data.components.length, 2);
  assert.deepEqual(words.map((b) => [b.label, b.custom_id]), [["今", "vtime:今"], ["夜", "vtime:夜"]]);
  const menu = menuRow[0];
  assert.equal(menu.type, 3);
  assert.equal(menu.custom_id, "vtimesel");
  assert.deepEqual(menu.options.map((o) => o.label), [
    "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00", "22:30",
    "23:00", "23:30", "0:00", "0:30", "1:00", "1:30", "2:00",
  ]);
  assert.deepEqual(menu.options[10], { label: "0:00", value: "0000" });
});
for (const word of ["今", "夜"]) {
  await test(`「${word}」ボタンで、押した人が主催者で開始予定「${word}」の valorant 募集を投稿`, async () => {
    const p = press(`vtime:${word}`, A, "vpanelMsg");
    const r = await send(p);
    assert.equal(r.json.type, 4);
    assert.equal(r.json.data.content, "@everyone");
    assert.equal(r.json.data.embeds[0].title, "🟢 募集中｜valorant 参加者募集");
    assert.equal(r.json.data.embeds[0].footer.text, "主催: Aさん");
    assert.equal(field(r, "開始予定"), word);
    assert.equal(field(r, "定員"), "1/5人");
    assert.equal(buttons(r).join.custom_id, `join:${p.id}`);
  });
}
for (const [value, expected] of [["2130", "21:30"], ["0030", "0:30"]]) {
  await test(`ドロップダウンで ${expected} を選ぶと、開始予定 ${expected} の valorant 募集を投稿`, async () => {
    const s = vselect(value, B);
    const r = await send(s);
    assert.equal(r.json.type, 4);
    assert.equal(r.json.data.embeds[0].footer.text, "主催: Bさん");
    assert.equal(field(r, "開始予定"), expected);
    const j = await send(press(`join:${s.id}`, C));
    assert.equal(field(j, "定員"), "2/5人");
  });
}
await test("以前のパネルの時刻ボタン（vtime:2130）もそのまま動く", async () => {
  const r = await send(press("vtime:2130", A, "oldPanel"));
  assert.equal(field(r, "開始予定"), "21:30");
});
await test("送信先つきの /vpanel は、ボタンもドロップダウンも送信先に投稿する", async () => {
  const r = await send(command("vpanel", [{ name: "送信先", type: 7, value: "777" }], host));
  assert.equal(r.json.data.components[0].components[1].custom_id, "vtime:夜:777");
  assert.equal(r.json.data.components[1].components[0].custom_id, "vtimesel:777");
  apiCalls.length = 0;
  const sent = await send(vselect("2100", B, "vtimesel:777"));
  assert.equal(sent.json.type, 5);
  const [post] = await waitForCalls(2);
  assert.equal(post.path, "/channels/777/messages");
  assert.equal(post.body.embeds[0].fields.find((f) => f.name === "開始予定").value, "21:00");
  apiCalls.length = 0;
  await send({ ...press("vtime:今:777", B, "vpanelMsg"), guild_id: "999" });
  const [post2] = await waitForCalls(2);
  assert.equal(post2.path, "/channels/777/messages");
});
await test("知らない時刻には案内を返す", async () => {
  assert.ok(isError(await send(press("vtime:1234", A)), "パネルを置き直して"));
  assert.ok(isError(await send(vselect("朝", A)), "パネルを置き直して"));
});

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
