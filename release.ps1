# 新しいバージョンをGitHubにリリースする。
# 使い方: updater.py の VERSION を上げてコミットしてから、このスクリプトを実行する。
# リリース後、各PCのBotは /update または次回起動時に自動で更新される。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$version = (Select-String -Path updater.py -Pattern '^VERSION = "(.+)"').Matches[0].Groups[1].Value
$tag = "v$version"

gh release view $tag *> $null
if ($LASTEXITCODE -eq 0) { throw "$tag はリリース済みです。updater.py の VERSION を上げてください。" }
if (git status --porcelain) { throw "コミットしていない変更があります。先にコミットしてください。" }

& .\venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --noconsole --name GameRecruitBot --distpath dist --workpath build bot.py
if ($LASTEXITCODE -ne 0) { throw "ビルドに失敗しました。" }

git push
if ($LASTEXITCODE -ne 0) { throw "git push に失敗しました。" }
gh release create $tag dist\GameRecruitBot.exe --title $tag --notes "GameRecruitBot $tag"
if ($LASTEXITCODE -ne 0) { throw "リリースの作成に失敗しました。" }
Write-Host "$tag をリリースしました。"
