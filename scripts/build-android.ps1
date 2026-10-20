param([switch]$IncludeUiTests,[switch]$CompileUiTests)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$bundleRoot=Split-Path -Parent (Split-Path -Parent $sourceRoot)
$drive=$null
foreach($letter in @('P','Q','R','S','U','V','W','X','Y','Z')){if(-not(Test-Path ($letter+':\'))){$drive=$letter+':';break}}
if(-not $drive){throw '没有可用的临时盘符。'}
$properties=Join-Path $sourceRoot 'android\local.properties'
$previous=if(Test-Path -LiteralPath $properties){[IO.File]::ReadAllText($properties)}else{$null}
$savedJava=$env:JAVA_HOME;$savedAndroid=$env:ANDROID_HOME;$savedGradle=$env:GRADLE_USER_HOME
try{
    & subst.exe $drive $bundleRoot
    if($LASTEXITCODE -ne 0){throw '无法创建构建路径映射。'}
    # Android and Gradle subprocesses on Windows require an ASCII toolchain path.
    $env:JAVA_HOME="$drive\work\toolchain\jdk-17"
    $env:ANDROID_HOME="$drive\work\toolchain\android-sdk"
    $env:GRADLE_USER_HOME="$drive\work\toolchain\gradle-cache"
    [IO.File]::WriteAllText($properties,('sdk.dir='+$drive+'/work/toolchain/android-sdk'),[Text.UTF8Encoding]::new($false))
    Push-Location "$drive\work\codex-pocket\android"
    try{
        $tasks=@('--no-daemon',':app:assembleRelease',':app:testDebugUnitTest')
        if($IncludeUiTests -or $CompileUiTests){$tasks+=@(':app:assembleDebug',':app:assembleDebugAndroidTest')}
        if($IncludeUiTests){$tasks+=@(':app:connectedDebugAndroidTest')}
        & "$drive\work\toolchain\gradle-8.13\bin\gradle.bat" @tasks
        if($LASTEXITCODE -ne 0){throw 'Android 构建或测试未通过。'}
    }finally{Pop-Location}
}finally{
    if($null -ne $previous){[IO.File]::WriteAllText($properties,$previous,[Text.UTF8Encoding]::new($false))}
    elseif(Test-Path -LiteralPath $properties){Remove-Item -LiteralPath $properties}
    $env:JAVA_HOME=$savedJava;$env:ANDROID_HOME=$savedAndroid;$env:GRADLE_USER_HOME=$savedGradle
    & subst.exe $drive /D
}
