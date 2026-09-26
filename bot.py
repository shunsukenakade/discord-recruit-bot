"""
ゲーム募集bot (discord.py)

機能:
- /recruit コマンドでゲームの参加者募集メッセージを作成
- 「参加する」「参加をやめる」ボタンで参加者を管理
- 定員に達したら自動的に募集を締め切り
- /recruit_close で手動締め切り
- /v /o /a（valorant・overwatch・apex）、/vnight /onight /anight（夜〜）、/vnow /onow /anow（今〜）の
  ショートカット募集。オプションで人数・時刻を指定可能
- 募集中は「再募集」、締め切り後は「開始を呼びかける」ボタン
- /help で使い方を表示
- 更新後の起動時に、更新内容をチャットに通知
- /update（Botの所有者のみ）と起動時チェックで、GitHub Releases から自動更新（updater.py）

必要なもの:
- Python 3.10+
- discord.py 2.x
- Botトークン（.envのDISCORD_TOKENに設定）
- サーバー側でスラッシュコマンドを使うため applications.commands スコープでBotを招待

使い方は README.md を参照してください。
"""

import asyncio
import json
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

import updater

# exe化した場合はexeと同じフォルダ、通常実行時はこのファイルと同じフォルダの.envを読む
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 拡張子非表示のまま作ると「.env.txt」になりがちなので、それも読む。BOM付きUTF-8にも対応
for _env_name in (".env", ".env.txt"):
    _env_path = os.path.join(BASE_DIR, _env_name)
    if os.path.exists(_env_path):
        load_dotenv(_env_path, encoding="utf-8-sig")
        break
TOKEN = os.getenv("DISCORD_TOKEN")

# 前回起動時のバージョンや、更新通知を送るチャンネルを覚えておくファイル
STATE_PATH = os.path.join(BASE_DIR, "bot_state.json")


def load_state() -> dict:
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict):
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except OSError:
        logging.exception("状態ファイルを保存できませんでした")

intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)


class RecruitView(discord.ui.View):
    """募集メッセージに付くボタン群。参加者リストを保持して埋め込みを更新する。"""

    def __init__(self, host: discord.Member, game: str, capacity: int | None,
                 memo: str | None, start_time: str | None):
        super().__init__(timeout=None)  # ボタンを恒久的に有効にする
        self.host = host
        self.game = game
        self.capacity = capacity
        self.memo = memo
        self.start_time = start_time
        self.participants: list[discord.Member] = [host]
        self.closed = False

    def build_embed(self) -> discord.Embed:
        status = "🔴 締め切り" if self.closed else "🟢 募集中"
        title = f"{status}｜{self.game} 参加者募集"
        embed = discord.Embed(title=title, color=0x57F287 if not self.closed else 0x99AAB5)

        if self.start_time:
            embed.add_field(name="開始予定", value=self.start_time, inline=True)
        if self.capacity:
            embed.add_field(name="定員", value=f"{len(self.participants)}/{self.capacity}人",
                             inline=True)
        else:
            embed.add_field(name="参加人数", value=f"{len(self.participants)}人", inline=True)
        if self.memo:
            embed.add_field(name="メモ", value=self.memo, inline=False)

        names = "\n".join(f"・{m.display_name}" for m in self.participants) or "（まだいません）"
        embed.add_field(name="参加者一覧", value=names, inline=False)
        embed.set_footer(text=f"主催: {self.host.display_name}")
        return embed

    async def refresh(self, interaction: discord.Interaction):
        # 定員に達したら自動締め切り
        if self.capacity and len(self.participants) >= self.capacity and not self.closed:
            self.closed = True

        # 募集中は「参加する」「再募集」、締め切り後は「開始を呼びかける」だけ押せるようにする
        self.join_button.disabled = self.closed
        self.rerecruit_button.disabled = self.closed
        self.start_button.disabled = not self.closed

        await interaction.message.edit(embed=self.build_embed(), view=self)

    async def reply_to_recruit(self, interaction: discord.Interaction, content: str,
                               mentions: discord.AllowedMentions):
        """募集メッセージに返信（引用）する形で投稿する。"""
        await interaction.response.defer()
        try:
            await interaction.message.reply(content, allowed_mentions=mentions, mention_author=False)
        except discord.Forbidden:
            await interaction.followup.send(
                "返信を送れませんでした。Botに「メッセージ履歴を読む」権限があるか確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="参加する", style=discord.ButtonStyle.success, custom_id="recruit_join")
    async def join_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.closed:
            await interaction.response.send_message("この募集は締め切られています。", ephemeral=True)
            return
        if interaction.user in self.participants:
            await interaction.response.send_message("すでに参加しています。", ephemeral=True)
            return
        if self.capacity and len(self.participants) >= self.capacity:
            await interaction.response.send_message("定員に達しています。", ephemeral=True)
            return

        self.participants.append(interaction.user)
        await interaction.response.defer()
        await self.refresh(interaction)

    @discord.ui.button(label="参加をやめる", style=discord.ButtonStyle.secondary, custom_id="recruit_leave")
    async def leave_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user == self.host:
            await interaction.response.send_message("主催者は抜けられません。締め切るには /recruit_close を使ってください。",
                                                      ephemeral=True)
            return
        if interaction.user not in self.participants:
            await interaction.response.send_message("参加していません。", ephemeral=True)
            return

        self.participants.remove(interaction.user)
        await interaction.response.defer()
        await self.refresh(interaction)

    @discord.ui.button(label="締め切る", style=discord.ButtonStyle.danger, custom_id="recruit_close_btn")
    async def close_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user != self.host:
            await interaction.response.send_message("締め切りは主催者のみ操作できます。", ephemeral=True)
            return
        self.closed = True
        await interaction.response.defer()
        await self.refresh(interaction)

    @discord.ui.button(label="再募集", style=discord.ButtonStyle.primary, custom_id="recruit_again")
    async def rerecruit_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user != self.host:
            await interaction.response.send_message("再募集は主催者のみ操作できます。", ephemeral=True)
            return
        if self.closed:
            await interaction.response.send_message("この募集は締め切られています。", ephemeral=True)
            return

        content = f"@everyone {self.game}"
        if self.capacity:
            content += f" @{self.capacity - len(self.participants)}"
        await self.reply_to_recruit(interaction, content, discord.AllowedMentions(everyone=True))

    @discord.ui.button(label="開始を呼びかける", style=discord.ButtonStyle.primary,
                       custom_id="recruit_start", disabled=True)
    async def start_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user != self.host:
            await interaction.response.send_message("開始の呼びかけは主催者のみ操作できます。", ephemeral=True)
            return
        if not self.closed:
            await interaction.response.send_message("締め切り後に使えます。", ephemeral=True)
            return

        members = " ".join(m.mention for m in self.participants)
        content = f"{members}\n{self.game} を開始します！集まってください。"
        await self.reply_to_recruit(interaction, content, discord.AllowedMentions(users=True))


async def post_recruit(interaction: discord.Interaction, view: RecruitView):
    """募集メッセージを@everyone付きで投稿する。"""
    await interaction.response.send_message(
        content="@everyone",
        embed=view.build_embed(),
        view=view,
        allowed_mentions=discord.AllowedMentions(everyone=True),
    )


_update_lock = asyncio.Lock()
_startup_checked = False


@bot.event
async def on_ready():
    global _startup_checked
    await bot.tree.sync()
    logging.info(f"ログイン完了: {bot.user}（v{updater.VERSION}）")
    if not _startup_checked:
        _startup_checked = True
        bot.loop.create_task(after_first_ready())


async def after_first_ready():
    await announce_update_if_needed()
    await startup_update_check()


async def announce_update_if_needed():
    """前回起動時からバージョンが変わっていたら、更新内容をチャットに送る。"""
    state = load_state()
    prev = state.get("last_version")
    updated = updater.AFTER_UPDATE_ARG in sys.argv or (prev is not None and prev != updater.VERSION)
    state["last_version"] = updater.VERSION
    save_state(state)
    if not updated:
        return

    try:
        notes = await updater.fetch_release_notes(updater.VERSION)
    except Exception:
        logging.exception("更新内容の取得に失敗しました")
        notes = None
    embed = discord.Embed(
        title=f"🔄 Botをアップデートしました（v{updater.VERSION}）",
        description=(notes or "更新内容は登録されていません。")[:4000],
        color=0x5865F2,
    )
    if prev and prev != updater.VERSION:
        embed.set_footer(text=f"v{prev} → v{updater.VERSION}")

    # /update を使ったチャンネルがあればそこへ、無ければ各サーバーのシステムメッセージチャンネルへ
    channel = bot.get_channel(state.get("notice_channel_id") or 0)
    if channel:
        channels = [channel]
    else:
        channels = [g.system_channel for g in bot.guilds
                    if g.system_channel and g.system_channel.permissions_for(g.me).send_messages]
    if not channels:
        logging.warning("更新通知を送れるチャンネルが見つかりませんでした")
    for ch in channels:
        try:
            await ch.send(embed=embed)
        except discord.HTTPException:
            logging.exception("更新通知の送信に失敗しました: #%s", ch)


async def startup_update_check():
    """起動時に新しいバージョンがあれば自動で更新する。"""
    if not updater.is_frozen():
        return
    try:
        async with _update_lock:
            release = await updater.fetch_latest_release()
            if release:
                logging.info("新しいバージョン %s が見つかりました", release["version"])
                await apply_update(release)
    except Exception:
        logging.exception("起動時の更新確認に失敗しました")


async def apply_update(release: dict):
    """新しいexeに入れ替え、新しい方を起動してから自分は終了する。"""
    await updater.download_and_replace(release)
    updater.launch_new_instance()
    logging.info("%s への更新を適用しました。再起動します", release["version"])
    bot.loop.create_task(shutdown())


@bot.tree.command(name="update", description="Botを最新バージョンに更新します（Botの所有者のみ）")
@app_commands.default_permissions(administrator=True)  # 一般メンバーのコマンド一覧には出さない
async def update_command(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    if not await bot.is_owner(interaction.user):
        await interaction.followup.send("このコマンドはBotの所有者のみ使えます。", ephemeral=True)
        return
    if not updater.is_frozen():
        await interaction.followup.send("exeで起動しているときだけ更新できます。", ephemeral=True)
        return
    if _update_lock.locked():
        await interaction.followup.send("更新処理の途中です。しばらく待ってください。", ephemeral=True)
        return

    state = load_state()
    state["notice_channel_id"] = interaction.channel_id  # 更新後の通知はこのチャンネルへ
    save_state(state)

    async with _update_lock:
        try:
            release = await updater.fetch_latest_release()
            if not release:
                await interaction.followup.send(f"最新版です（v{updater.VERSION}）。", ephemeral=True)
                return
            await interaction.followup.send(
                f"v{updater.VERSION} → {release['version']} に更新します。数十秒後に再起動します。",
                ephemeral=True,
            )
            await apply_update(release)
        except Exception as e:
            logging.exception("更新に失敗しました")
            await interaction.followup.send(f"更新に失敗しました: {e}", ephemeral=True)


@bot.tree.command(name="recruit", description="ゲームの参加者募集を投稿します")
@app_commands.describe(
    game="ゲーム名",
    capacity="定員（人数上限。指定しない場合は無制限）",
    start_time="開始予定（例: 21:00〜 / 今すぐ など、自由記述）",
    memo="補足メモ（任意）",
)
async def recruit(interaction: discord.Interaction, game: str,
                   capacity: app_commands.Range[int, 1, 99] | None = None,
                   start_time: str | None = None, memo: str | None = None):
    view = RecruitView(host=interaction.user, game=game, capacity=capacity,
                        memo=memo, start_time=start_time)
    await post_recruit(interaction, view)


# ショートカット募集コマンド: (コマンド名, 表示するゲーム名, デフォルト人数)
QUICK_RECRUITS = [
    ("v", "valorant", 5),
    ("o", "overwatch", 5),
    ("a", "apex", 3),
    ("vnight", "夜valorant", 5),
    ("onight", "夜overwatch", 5),
    ("anight", "夜apex", 3),
    ("vnow", "今valorant", 5),
    ("onow", "今overwatch", 5),
    ("anow", "今apex", 3),
]


def make_quick_recruit(name: str, game: str, default_capacity: int) -> app_commands.Command:
    @app_commands.describe(
        capacity=f"人数（指定しない場合は{default_capacity}人）",
        start_time="開始時刻（例: 21:00〜）",
    )
    @app_commands.rename(capacity="人数", start_time="時刻")
    async def callback(interaction: discord.Interaction,
                       capacity: app_commands.Range[int, 1, 99] | None = None,
                       start_time: str | None = None):
        view = RecruitView(host=interaction.user, game=game,
                           capacity=capacity or default_capacity,
                           memo=None, start_time=start_time)
        await post_recruit(interaction, view)

    return app_commands.Command(name=name, description=f"{game}の募集（{default_capacity}人）",
                                callback=callback)


for _name, _game, _capacity in QUICK_RECRUITS:
    bot.tree.add_command(make_quick_recruit(_name, _game, _capacity))


@bot.tree.command(name="help", description="コマンドとボタンの使い方を表示します")
async def help_command(interaction: discord.Interaction):
    embed = discord.Embed(title="📖 ゲーム募集bot の使い方", color=0x5865F2)

    quick = "\n".join(f"`/{name}` … {game}（{cap}人）" for name, game, cap in QUICK_RECRUITS)
    embed.add_field(
        name="かんたん募集",
        value=f"{quick}\n\nオプションで **人数** と **時刻** を変更できます。\n例: `/v 人数:3 時刻:22:00〜`",
        inline=False,
    )
    embed.add_field(
        name="自由に募集",
        value="`/recruit ゲーム名` … 好きなゲームで募集します。\n"
              "オプション: 定員（capacity）・開始予定（start_time）・メモ（memo）",
        inline=False,
    )
    embed.add_field(
        name="募集メッセージのボタン",
        value="**参加する** … 募集に参加します\n"
              "**参加をやめる** … 参加を取り消します（主催者は不可）\n"
              "**締め切る** … 募集を締め切ります（主催者のみ）\n"
              "**再募集** … 残り人数を @everyone で呼びかけます（主催者のみ・募集中）\n"
              "**開始を呼びかける** … 参加者全員にメンションします（主催者のみ・締め切り後）\n"
              "定員に達すると自動で締め切られます。",
        inline=False,
    )
    embed.add_field(
        name="その他",
        value="`/help` … この説明を表示します\n`/update` … Botを最新版に更新します（Botの所有者のみ）",
        inline=False,
    )
    embed.set_footer(text=f"v{updater.VERSION}")
    await interaction.response.send_message(embed=embed, ephemeral=True)


@bot.tree.command(name="recruit_close", description="自分が直前に立てた募集を締め切ります（メッセージへの返信で使う場合はそちらが優先）")
async def recruit_close(interaction: discord.Interaction):
    await interaction.response.send_message(
        "募集メッセージ内の「締め切る」ボタンから締め切ってください。", ephemeral=True
    )


APP_NAME = "ゲーム募集bot"
LOG_PATH = os.path.join(BASE_DIR, "bot.log")


def show_message(text: str, error: bool = False):
    """ウィンドウが無いので、重要な通知はWindowsのメッセージボックスで出す。"""
    import ctypes
    flags = 0x10 if error else 0x40  # MB_ICONERROR / MB_ICONINFORMATION
    ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, flags)


def create_tray_image():
    from PIL import Image, ImageDraw
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((4, 4, 60, 60), fill=(88, 101, 242))  # Discordっぽい青紫
    draw.ellipse((22, 22, 42, 42), fill=(87, 242, 135))  # 稼働中を示す緑
    return image


async def shutdown():
    """先にオフライン表示へ切り替えてから切断する（すぐ灰色になるように）。"""
    logging.info("終了処理を開始します")
    try:
        if bot.is_ready():
            await bot.change_presence(status=discord.Status.invisible, activity=None)
            await asyncio.sleep(1.5)  # ステータス変更がDiscordに届くのを待つ
    except Exception:
        logging.exception("ステータス変更に失敗しました")
    await bot.close()


def run_bot_thread(state: dict):
    """Botを別スレッドのイベントループで動かす。"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    state["loop"] = loop
    try:
        loop.run_until_complete(bot.start(TOKEN))
        logging.info("切断しました")
    except discord.LoginFailure:
        logging.exception("ログイン失敗")
        state["error"] = "ログインに失敗しました。.env のトークンが正しいか確認してください。"
    except Exception as e:
        logging.exception("Botが異常終了しました")
        state["error"] = f"Botが停止しました: {e}\n詳細は bot.log を確認してください。"
    finally:
        loop.close()
        icon = state.get("icon")
        if icon:
            icon.stop()


def main():
    import ctypes
    import threading
    import pystray

    import time

    # 二重起動防止（同じトークンで2つ動くとボタンの応答が衝突するため）。
    # 更新直後の起動では、旧版が終了するまで最大60秒待つ
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    attempts = 60 if updater.AFTER_UPDATE_ARG in sys.argv else 1
    for _ in range(attempts):
        mutex = kernel32.CreateMutexW(None, False, "GameRecruitBot_SingleInstance")
        if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
            break
        kernel32.CloseHandle(mutex)
        time.sleep(1)
    else:
        show_message("すでに起動しています。タスクトレイのアイコンを確認してください。")
        return
    updater.cleanup_old_exe()

    if not TOKEN:
        found = [n for n in (".env", ".env.txt") if os.path.exists(os.path.join(BASE_DIR, n))]
        if found:
            detail = f"{found[0]} はありますが、中に DISCORD_TOKEN=トークン の行が見つかりません。"
        else:
            detail = ".env ファイルが見つかりません。"
            if "temp" in BASE_DIR.lower():
                detail += "\nzipを展開せずに起動している可能性があります。先にzipを展開してください。"
        show_message(f"DISCORD_TOKEN が設定されていません。\n{detail}\n\n探した場所:\n{BASE_DIR}", error=True)
        return

    handler = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    discord.utils.setup_logging(handler=handler, root=True)

    state: dict = {}

    def on_quit(icon, item):
        loop = state.get("loop")
        if loop and loop.is_running():
            icon.title = f"{APP_NAME}（終了中…）"
            asyncio.run_coroutine_threadsafe(shutdown(), loop)
        else:
            icon.stop()

    def on_open_log(icon, item):
        os.startfile(LOG_PATH)

    icon = pystray.Icon(
        "GameRecruitBot",
        create_tray_image(),
        f"{APP_NAME} v{updater.VERSION}（稼働中）",
        menu=pystray.Menu(
            pystray.MenuItem("ログを開く", on_open_log),
            pystray.MenuItem("終了", on_quit),
        ),
    )
    state["icon"] = icon

    threading.Thread(target=run_bot_thread, args=(state,), daemon=True).start()
    icon.run()  # 「終了」が押されるかBotが止まるまでここで待つ

    if state.get("error"):
        show_message(state["error"], error=True)


if __name__ == "__main__":
    main()
