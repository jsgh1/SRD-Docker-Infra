param([string]$AdbPath)
$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent

if (-not $AdbPath) {
    $SrdAdb = Get-Command adb -ErrorAction SilentlyContinue
    if ($SrdAdb) { $AdbPath = $SrdAdb.Source }
    elseif (Test-Path -LiteralPath 'G:\SRD-Android-tools\sdk\platform-tools\adb.exe') {
        $AdbPath = 'G:\SRD-Android-tools\sdk\platform-tools\adb.exe'
    }
}
if (-not $AdbPath -or -not (Test-Path -LiteralPath $AdbPath)) {
    throw 'No se encontró adb. Indica -AdbPath con la ruta a adb.exe.'
}

$SrdDevices = @(& $AdbPath devices | Select-String '\sdevice$')
if ($LASTEXITCODE -ne 0 -or $SrdDevices.Count -ne 1) {
    throw 'Conecta y autoriza exactamente un teléfono Android por USB; comprueba adb devices.'
}

& $AdbPath reverse tcp:8080 tcp:8080
if ($LASTEXITCODE -ne 0) { throw 'No se pudo conectar el gateway local al teléfono.' }
& $AdbPath reverse tcp:8081 tcp:8081
if ($LASTEXITCODE -ne 0) { throw 'No se pudo conectar Expo al teléfono.' }

$env:PATH = "$(Split-Path $AdbPath -Parent);$env:PATH"
$SrdSdkRoot = Split-Path (Split-Path $AdbPath -Parent) -Parent
if (Test-Path -LiteralPath (Join-Path $SrdSdkRoot 'platforms')) {
    $env:ANDROID_HOME = $SrdSdkRoot
}
$env:EXPO_NO_TELEMETRY = '1'
$env:EXPO_OFFLINE = '1'
if ($env:NODE_OPTIONS -notmatch 'dns-result-order') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --dns-result-order=ipv4first".Trim()
}
Set-Location -LiteralPath (Join-Path $SrdRoot 'apps/mobile-expo')
Write-Host 'Gateway SRD en teléfono: http://localhost:8080'
Write-Host 'Abriendo Expo Go por USB. Mantén esta terminal abierta.'
npm run start:usb
