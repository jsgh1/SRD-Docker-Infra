param([string]$FixturePath)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
$SrdComposeProject=$env:SRD_COMPOSE_PROJECT
if(-not $SrdComposeProject){$SrdComposeProject=$env:COMPOSE_PROJECT_NAME}
if(-not $SrdComposeProject -or $SrdComposeProject -notmatch '^srd-(p[0-9]+-[a-z0-9-]+-[0-9]+-[0-9]+|casa-qa-[0-9]{8}|qa-[a-z0-9-]+|mi-entorno)$'){throw 'Establece SRD_COMPOSE_PROJECT con el nombre explícito del proyecto QA aislado.'}
if(-not $FixturePath) {
    node tools/fixture-credentials.mjs
    if($LASTEXITCODE){throw 'No se pudieron preparar las credenciales sintéticas.'}
    $FixturePath=Join-Path $SrdRoot '.local/e2e-fixture.json'
}
$SrdFixture=(Resolve-Path -LiteralPath $FixturePath).Path
if(-not $SrdFixture.StartsWith($SrdRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'La semilla debe estar dentro de SRD.'}
$SrdFixtureTarget='/tmp/'+[IO.Path]::GetFileName($SrdFixture)
$SrdServices=@('configuration','identity')
if($env:SRD_BROWSER_SPEC -eq 'calendar-delivery-retry.spec.mjs'){$SrdServices+= 'calendar'}
if($env:SRD_BROWSER_SPEC -eq 'audit-export.spec.mjs'){$SrdServices+= 'audit'}
foreach($SrdService in $SrdServices) {
    docker compose --project-name $SrdComposeProject cp tools/fixture-safety.php "${SrdService}:/tmp/srd-fixture-safety.php"
    if($LASTEXITCODE){throw 'No se pudo copiar la política de seguridad de fixtures.'}
    docker compose --project-name $SrdComposeProject cp tools/create-fixtures.php "${SrdService}:/tmp/srd-fixtures.php"
    if($LASTEXITCODE){throw 'No se pudo copiar el generador de pruebas.'}
    docker compose --project-name $SrdComposeProject cp $SrdFixture "${SrdService}:$SrdFixtureTarget"
    if($LASTEXITCODE){throw 'No se pudieron preparar las credenciales sintéticas.'}
    docker compose --project-name $SrdComposeProject exec -T -e SRD_ROOT=/app -e SRD_ALLOW_MYSQL_FIXTURES=1 -e "SRD_COMPOSE_PROJECT=$SrdComposeProject" -e SRD_FIXTURE_SAFETY_PATH=/tmp/srd-fixture-safety.php -e "SRD_FIXTURE_PATH=$SrdFixtureTarget" -e "SRD_BROWSER_SPEC=$env:SRD_BROWSER_SPEC" $SrdService php /tmp/srd-fixtures.php $SrdService
    if($LASTEXITCODE){throw "Falló la semilla sintética: $SrdService"}
}
