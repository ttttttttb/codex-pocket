$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$nodeExe = Join-Path $packageRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
$main = Join-Path $packageRoot 'dist\main.js'
$stateDir = if($env:POCKET_STATE_DIR){$env:POCKET_STATE_DIR}else{Join-Path $packageRoot 'data'}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
# Protect the TLS key and device verifier from other local accounts.
& icacls.exe $stateDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw '无法保护本机密钥目录，请检查当前用户的目录权限。'}
$pkg = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if($pkg){
    $manifest=Join-Path $pkg.InstallLocation 'AppxManifest.xml'
    [IO.File]::WriteAllText((Join-Path $stateDir 'desktop-install.json'),(@{manifest=$manifest}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    $env:POCKET_CODEX_MANIFEST=$manifest
}
$listening = Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction SilentlyContinue
if ($listening | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }) { throw '调试端口不是仅监听本机。请先关闭暴露该端口的程序。' }
if (-not $listening) {
    $running = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if (-not $running) {
        $pkg = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
        if (-not $pkg) { throw '未找到 Codex 桌面应用。请先安装并登录桌面 Codex。' }
        $codexExe = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'
        Start-Process -FilePath $codexExe -ArgumentList @('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--force-renderer-accessibility') -WindowStyle Normal
    }
    # A running desktop is deliberately never killed, especially during active work.
}
$bridge = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 43828 -ErrorAction SilentlyContinue
if (-not $bridge) {
    $env:POCKET_STATE_DIR = $stateDir
    Start-Process -FilePath $nodeExe -ArgumentList @('"' + $main + '"') -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'startup.log') -RedirectStandardError (Join-Path $stateDir 'startup-error.log')
}
$dashboardFile = Join-Path $stateDir 'dashboard.url'
$ready = $false
for ($i=0; $i -lt 60; $i++) {
    if (Test-Path -LiteralPath $dashboardFile) {
        try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:43828/' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){$ready=$true;break} } catch {}
    }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw ('连接程序未能启动。请查看 '+(Join-Path $stateDir 'startup-error.log')) }
$dashboardUrl = (Get-Content -LiteralPath $dashboardFile -Raw).Trim()
if ($dashboardUrl -notmatch '^http://127\.0\.0\.1:43828/#[A-Za-z0-9_-]+$') { throw '本机设置页地址无效。' }
Start-Process $dashboardUrl
