$ErrorActionPreference='Stop'
$root=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if(-not $env:POCKET_STATE_DIR){$env:POCKET_STATE_DIR=Join-Path $root 'data'}
$runtime=Join-Path $root 'runtime\node.exe'
if(-not(Test-Path -LiteralPath $runtime)){$runtime=(Get-Command node.exe -ErrorAction Stop).Source}
& $runtime (Join-Path $root 'dist\diagnose.js')
if($LASTEXITCODE -eq 0){
    Write-Host '可选：在当前桌面聊天发送一条测试消息。请先确认该聊天空闲、没有草稿。'
    $answer=Read-Host '输入 TEST 执行真实收发验证；直接回车退出'
    if($answer -ceq 'TEST'){& $runtime (Join-Path $root 'dist\diagnose.js') --send-test}
}
Read-Host '按回车关闭'
