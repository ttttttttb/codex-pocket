$ErrorActionPreference='Stop'
$connections=Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 43828 -ErrorAction SilentlyContinue
foreach($connection in $connections){
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    $root=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    $expected=Join-Path $root 'dist\main.js'
    if($process.Name -eq 'node.exe' -and $process.CommandLine.Contains($expected)){Stop-Process -Id $process.ProcessId}
}
# Stopping the companion never closes desktop Codex or a task.
