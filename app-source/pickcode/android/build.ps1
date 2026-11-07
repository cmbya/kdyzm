param(
    [string]$JavaRoot = 'F:/Java/OpenJDK17U-jdk_x64_windows_hotspot_17.0.19_10/jdk-17.0.19+10',
    [string]$SdkRoot = 'F:/Android/Sdk',
    [string[]]$Tasks = @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $JavaRoot 'bin/java.exe'))) { throw "JDK 17 not found: $JavaRoot" }
if (-not (Test-Path -LiteralPath (Join-Path $SdkRoot 'platforms/android-35/android.jar'))) { throw "Android SDK 35 not found: $SdkRoot" }
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDirectory = $PSScriptRoot
$mappedDrive = $null
$previousJava = $env:JAVA_HOME
$previousSdk = $env:ANDROID_HOME
try {
    # Gradle's JVM test worker cannot reliably load classes from non-ASCII Windows paths.
    # SUBST creates only a temporary path alias; the checkout remains in place.
    if ($projectRoot -match '[^\x00-\x7F]') {
        foreach ($letter in @('R', 'U', 'V', 'W', 'X', 'Y', 'Z')) {
            if (-not (Test-Path "${letter}:\")) {
                & subst.exe "${letter}:" $projectRoot
                if ($LASTEXITCODE -ne 0) { throw 'Could not create temporary ASCII build path.' }
                $mappedDrive = "${letter}:"
                $buildDirectory = "${letter}:\android"
                break
            }
        }
        if (-not $mappedDrive) { throw 'No free temporary drive letter for the Android build.' }
    }
    $env:JAVA_HOME = $JavaRoot
    $env:ANDROID_HOME = $SdkRoot
    Push-Location $buildDirectory
    try {
        & '.\gradlew.bat' @Tasks '--no-daemon'
        if ($LASTEXITCODE -ne 0) { throw "Android verification failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
} finally {
    $env:JAVA_HOME = $previousJava
    $env:ANDROID_HOME = $previousSdk
    if ($mappedDrive) { & subst.exe $mappedDrive /D }
}
