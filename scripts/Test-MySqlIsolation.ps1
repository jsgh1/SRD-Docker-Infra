$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
foreach($SrdService in @('gateway','identity','configuration','records','audit','files','calendar','notifications','treasury','inventory','chat')) {
    docker compose cp tools/check-mysql-isolation.php "${SrdService}:/tmp/check-isolation.php"
    if($LASTEXITCODE){throw 'No se pudo preparar la comprobación.'}
    docker compose exec -T -e "SRD_CHECK_SERVICE=$SrdService" $SrdService php /tmp/check-isolation.php
    if($LASTEXITCODE){throw "Falló aislamiento MySQL: $SrdService"}
}
