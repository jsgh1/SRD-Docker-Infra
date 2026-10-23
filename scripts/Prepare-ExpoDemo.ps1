param([switch]$Build)
$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot

& (Join-Path $PSScriptRoot 'Initialize.ps1')
if ($Build) {
    foreach ($SrdService in @('gateway', 'identity', 'configuration', 'records', 'calendar', 'notifications', 'audit',
        'web', 'identity-scheduler', 'calendar-scheduler', 'notifications-scheduler', 'records-scheduler')) {
        docker compose build $SrdService
        if ($LASTEXITCODE -ne 0) { throw "Compilación fallida: $SrdService" }
    }
}

docker compose up -d --wait --no-build mysql mailpit
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron iniciar MySQL y Mailpit.' }
docker compose exec -T mysql bash /docker-entrypoint-initdb.d/01-services.sh
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron preparar las bases de servicio.' }

$SrdServices = @('gateway', 'identity', 'configuration', 'records', 'calendar', 'notifications', 'audit')
docker compose up -d --wait --no-build @SrdServices
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron iniciar los servicios móviles.' }
foreach ($SrdService in $SrdServices) {
    docker compose exec -T $SrdService php artisan migrate --force
    if ($LASTEXITCODE -ne 0) { throw "Migración fallida: $SrdService" }
}

& (Join-Path $PSScriptRoot 'Seed-ComposeTests.ps1')
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron preparar las juntas y cuentas sintéticas.' }

docker compose up -d --wait --no-build web identity-scheduler calendar-scheduler notifications-scheduler records-scheduler
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron iniciar el acceso local y los planificadores.' }

Write-Host 'Base móvil preparada en http://localhost:8080'
Write-Host 'Correo MFA local en http://localhost:8025'
Write-Host 'Junta: srd-e2e-a | Cuenta: admin@srd-e2e.test'
Write-Host 'Contraseña: campo password de .local/e2e-fixture.json (no se imprime)'
