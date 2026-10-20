$ErrorActionPreference='Stop'
$packageRoot=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$expected=Join-Path $packageRoot 'runtime\node.exe'
$listener=@(& netstat.exe -ano -p tcp | Select-String -Pattern '^\s*TCP\s+127\.0\.0\.1:43828\s+\S+\s+LISTENING\s+(\d+)\s*$')
foreach($line in $listener){
    $match=[regex]::Match($line.Line,'LISTENING\s+(\d+)\s*$')
    if(-not $match.Success){continue}
    $bridgeId=[int]$match.Groups[1].Value
    $bridge=Get-Process -Id $bridgeId -ErrorAction Stop
    if($bridge.Path -ne $expected){throw '端口被其他程序占用，已停止修复。'}
    Stop-Process -Id $bridgeId -ErrorAction Stop
}
& (Join-Path $PSScriptRoot 'Start-Pocket.ps1')
$runtime=Join-Path $packageRoot 'runtime\node.exe'
& $runtime (Join-Path $packageRoot 'dist\diagnose.js')
if($LASTEXITCODE -ne 0){throw '桌面读取检查尚未通过，请将提示文字发给助手。'}
Write-Host '配套程序已更新并重新连接。请查看手机；如提示授权失效，请重新扫码。'
Read-Host '按回车关闭此窗口'
