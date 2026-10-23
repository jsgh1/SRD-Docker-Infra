param(
    [switch]$Build,
    [switch]$SkipSeed,
    [switch]$WebOnly,
    [string]$AdbPath
)
$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot

& (Join-Path $PSScriptRoot 'Prepare-ExpoDemo.ps1') -Build:$Build
if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el entorno de exposición.' }

if (-not $SkipSeed) {
    & (Join-Path $PSScriptRoot 'Seed-Exposition.ps1') -Build:$Build
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo cargar la semilla de exposición.' }
} else {
    if ($Build) {
        foreach ($SrdService in @('treasury', 'inventory')) {
            docker compose build $SrdService
            if ($LASTEXITCODE -ne 0) { throw "Compilación fallida: $SrdService" }
        }
    }
    docker compose up -d --wait --no-build treasury inventory
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron iniciar Tesorería e Inventario.' }
}

Write-Host 'Web: http://localhost:8080/j/srd-e2e-a/login'
Write-Host 'Correo MFA local: http://localhost:8025'
Write-Host 'Cuenta: admin@srd-e2e.test'
Write-Host 'Contraseña: campo password de .local/e2e-fixture.json'

if ($WebOnly) {
    Write-Host 'Web lista. Para abrir el móvil más tarde: ./scripts/Start-ExpoGo.ps1'
    return
}

Write-Host 'Conecta y autoriza el teléfono Android por USB; Expo Go se abrirá automáticamente.'
if ($AdbPath) {
    & (Join-Path $PSScriptRoot 'Start-ExpoGo.ps1') -AdbPath $AdbPath
} else {
    & (Join-Path $PSScriptRoot 'Start-ExpoGo.ps1')
}
if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar Expo Go.' }
