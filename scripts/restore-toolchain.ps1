$ErrorActionPreference='Stop'
$toolsRoot=Join-Path (Split-Path $PSScriptRoot -Parent) '..\toolchain'
New-Item -ItemType Directory -Force $toolsRoot | Out-Null
$toolsRoot=(Resolve-Path $toolsRoot).Path
& node (Join-Path $PSScriptRoot 'download-toolchain.cjs')
if($LASTEXITCODE -ne 0){throw 'Toolchain download/checksum failed'}
function Extract($name,$destination){
  & tar.exe -xf (Join-Path $toolsRoot $name) -C $destination
  if($LASTEXITCODE -ne 0){throw "Archive extraction failed: $name"}
}
if(-not(Test-Path "$toolsRoot\jdk-17")){
  $meta=Get-Content -LiteralPath "$toolsRoot\jdk-meta.json" -Raw | ConvertFrom-Json
  Extract 'jdk.zip' $toolsRoot
  Move-Item -LiteralPath (Join-Path $toolsRoot $meta.folder) -Destination "$toolsRoot\jdk-17"
}
if(-not(Test-Path "$toolsRoot\gradle-8.13")){Extract 'gradle.zip' $toolsRoot}
$sdk=Join-Path $toolsRoot 'android-sdk'
New-Item -ItemType Directory -Force "$sdk\cmdline-tools","$sdk\platforms","$sdk\build-tools\35.0.0" | Out-Null
if(-not(Test-Path "$sdk\cmdline-tools\latest")){
  Extract 'sdk.zip' $toolsRoot
  Move-Item -LiteralPath "$toolsRoot\cmdline-tools" -Destination "$sdk\cmdline-tools\latest"
}
if(-not(Test-Path "$sdk\platforms\android-35\android.jar")){Extract 'platform35.zip' "$sdk\platforms"}
if(-not(Test-Path "$sdk\build-tools\35.0.0\aapt2.exe")){
  Extract 'buildtools35.zip' $toolsRoot
  Copy-Item -Path "$toolsRoot\android-15\*" -Destination "$sdk\build-tools\35.0.0" -Recurse -Force
}
if(-not(Test-Path "$sdk\platform-tools\adb.exe")){Extract 'platformtools.zip' $sdk}
$savedJava=$env:JAVA_HOME
try{
  $env:JAVA_HOME="$toolsRoot\jdk-17"
  (1..100 | ForEach-Object {'y'}) | & "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
  if($LASTEXITCODE -ne 0){throw 'SDK license acceptance failed'}
}finally{$env:JAVA_HOME=$savedJava}
Write-Output 'Android build toolchain ready. No emulator is downloaded.'
