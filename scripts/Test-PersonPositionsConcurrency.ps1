$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
docker compose cp tools/check-person-positions-concurrency.php records:/app/services/records/storage/framework/check-person-positions-concurrency.php
if($LASTEXITCODE){throw 'No se pudo preparar la prueba de cargos.'}
docker compose exec -T -e SRD_ALLOW_POSITION_PROBE=1 records php storage/framework/check-person-positions-concurrency.php
if($LASTEXITCODE){throw 'Falló la prueba MySQL de concurrencia de cargos.'}
