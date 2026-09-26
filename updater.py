"""
GitHub Releases からの自動更新。

リリースを出すときは VERSION を上げてから exe をビルドし、
タグ「v<VERSION>」のリリースに GameRecruitBot.exe を添付する（release.ps1 参照）。
"""

import hashlib
import logging
import os
import subprocess
import sys

import aiohttp

VERSION = "1.3.0"
GITHUB_REPO = "shunsukenakade/discord-recruit-bot"
ASSET_NAME = "GameRecruitBot.exe"

AFTER_UPDATE_ARG = "--after-update"


class UpdateError(Exception):
    pass


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def parse_version(tag: str) -> tuple[int, ...]:
    try:
        return tuple(int(p) for p in tag.lstrip("vV").split("."))
    except ValueError:
        return (0,)


def cleanup_old_exe():
    """前回の更新で退避した古いexeを削除する。"""
    if not is_frozen():
        return
    old = sys.executable + ".old"
    try:
        if os.path.exists(old):
            os.remove(old)
    except OSError:
        logging.warning("古いexeを削除できませんでした: %s", old)


async def fetch_latest_release() -> dict | None:
    """最新リリースが今より新しければ {version, url, size, sha256} を返す。"""
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "GameRecruitBot"}
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status == 404:
                return None  # まだリリースが無い
            resp.raise_for_status()
            data = await resp.json()

    tag = data.get("tag_name", "")
    if parse_version(tag) <= parse_version(VERSION):
        return None
    for asset in data.get("assets", []):
        if asset.get("name") == ASSET_NAME:
            digest = asset.get("digest") or ""
            return {
                "version": tag,
                "url": asset["browser_download_url"],
                "size": asset.get("size"),
                "sha256": digest.removeprefix("sha256:") if digest.startswith("sha256:") else None,
            }
    raise UpdateError(f"リリース {tag} に {ASSET_NAME} が添付されていません。")


async def fetch_release_notes(version: str) -> str | None:
    """指定バージョンのリリースに書かれた更新内容を取得する。"""
    url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/v{version}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "GameRecruitBot"}
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status == 404:
                return None
            resp.raise_for_status()
            data = await resp.json()
    return (data.get("body") or "").strip() or None


async def download_and_replace(release: dict):
    """新しいexeをダウンロードし、実行中のexeと入れ替える（起動し直すまでは旧版のまま動く）。"""
    if not is_frozen():
        raise UpdateError("exeで起動しているときだけ更新できます。")

    exe = sys.executable
    new = exe + ".new"
    old = exe + ".old"

    sha = hashlib.sha256()
    size = 0
    headers = {"User-Agent": "GameRecruitBot"}
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(release["url"], timeout=aiohttp.ClientTimeout(total=600)) as resp:
            resp.raise_for_status()
            with open(new, "wb") as f:
                async for chunk in resp.content.iter_chunked(1 << 16):
                    f.write(chunk)
                    sha.update(chunk)
                    size += len(chunk)

    try:
        if release["size"] is not None and size != release["size"]:
            raise UpdateError(f"ダウンロードサイズが一致しません（{size} / {release['size']}）")
        if release["sha256"] and sha.hexdigest() != release["sha256"]:
            raise UpdateError("ダウンロードしたファイルのハッシュが一致しません。")
    except UpdateError:
        os.remove(new)
        raise

    # 実行中のexeは上書きできないが、名前の変更はできる
    if os.path.exists(old):
        os.remove(old)
    os.replace(exe, old)
    try:
        os.replace(new, exe)
    except OSError:
        os.replace(old, exe)  # 失敗したら元に戻す
        raise


def launch_new_instance():
    """入れ替えた新しいexeを起動する。新しい方は旧版が終了するのを待ってから動き出す。"""
    env = os.environ.copy()
    # onefile版から別のexeを起動するとき、実行環境を引き継がないようにする
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    subprocess.Popen(
        [sys.executable, AFTER_UPDATE_ARG],
        env=env,
        cwd=os.path.dirname(sys.executable),
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
    )
