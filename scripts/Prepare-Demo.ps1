param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot

docker info *> $null
if ($LASTEXITCODE) { throw 'Inicia Docker Desktop con contenedores Linux y vuelve a ejecutar este script.' }

& (Join-Path $PSScriptRoot 'Up.ps1') -SkipBuild:$SkipBuild
if ($LASTEXITCODE) { throw 'No se pudo iniciar SRD.' }
& (Join-Path $PSScriptRoot 'Seed-ComposeTests.ps1')
if ($LASTEXITCODE) { throw 'No se pudieron crear las cuentas y juntas ficticias.' }

$SrdFixture = Join-Path $SrdRoot '.local/e2e-fixture.json'
if (-not (Test-Path -LiteralPath $SrdFixture)) { throw 'Falta el archivo local de credenciales ficticias.' }

Write-Host ''
Write-Host 'Demostración preparada:'
Write-Host '  Inicio: http://localhost:8080'
Write-Host '  Login de la junta A: http://localhost:8080/j/srd-e2e-a/login'
Write-Host '  Correo MFA local: http://localhost:8025'
Write-Host '  Cuenta admin: admin@srd-e2e.test'
Write-Host '  Contraseña aleatoria: campo password de .local/e2e-fixture.json'
Write-Host '  Código de junta: srd-e2e-a'
Write-Host 'La contraseña y los códigos no se imprimen ni se incluyen en los ZIP.'
