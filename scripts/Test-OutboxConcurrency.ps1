$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
docker compose cp tools/check-outbox-concurrency.php configuration:/app/services/configuration/storage/framework/check-outbox-concurrency.php
if($LASTEXITCODE){throw 'No se pudo preparar la prueba local del outbox.'}
docker compose exec -T -e SRD_ALLOW_OUTBOX_PROBE=1 configuration php storage/framework/check-outbox-concurrency.php
if($LASTEXITCODE){throw 'Falló la prueba de concurrencia MySQL del outbox.'}
