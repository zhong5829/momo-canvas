# Stop-hook: ensure the momo canvas dev app is running.
# IMPORTANT: never kill a healthy instance -- an in-flight generation would be lost
# (the provider still charges). Vite HMR applies frontend edits live, and `tauri dev`
# watches src-tauri and rebuilds Rust changes by itself, so no forced restart is needed.
$ErrorActionPreference = 'SilentlyContinue'
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log = Join-Path $proj '.claude\dev-server.log'

$serverUp = $false
try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', 1430)
    $serverUp = $c.Connected
    $c.Close()
} catch {}
$appUp = [bool](Get-Process 'momo-canvas' -ErrorAction SilentlyContinue)

if ($serverUp -and $appUp) { exit 0 }

# Something is down: clear leftovers, then relaunch.
# 清理只匹配本项目路径：本机还有别的 Tauri 项目（弹宠, 端口1420）在跑，
# 不能用 'tauri dev' 这种宽泛特征误杀它的进程
Get-Process 'momo-canvas', 'MOMO-Canvas' -ErrorAction SilentlyContinue | Stop-Process -Force
$projEsc = [regex]::Escape($proj)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match $projEsc } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" |
    Where-Object { $_.CommandLine -match 'pnpm tauri dev' -and $_.CommandLine -match $projEsc } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 800

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "pnpm tauri dev > `"$log`" 2>&1" `
    -WorkingDirectory $proj -WindowStyle Hidden

Write-Output '{"systemMessage": "momo canvas was down - relaunched via pnpm tauri dev (log: .claude/dev-server.log)"}'
exit 0
