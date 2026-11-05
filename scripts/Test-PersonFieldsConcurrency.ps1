$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
docker compose cp tools/check-person-fields-concurrency.php records:/app/services/records/storage/framework/check-person-fields-concurrency.php
if($LASTEXITCODE){throw 'No se pudo preparar la prueba de campos.'}
docker compose exec -T -e SRD_ALLOW_FIELD_PROBE=1 records php storage/framework/check-person-fields-concurrency.php
if($LASTEXITCODE){throw 'Falló la prueba MySQL de concurrencia de campos.'}
