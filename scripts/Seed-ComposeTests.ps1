param([string]$FixturePath)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
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
    docker compose cp tools/create-fixtures.php "${SrdService}:/tmp/srd-fixtures.php"
    if($LASTEXITCODE){throw 'No se pudo copiar el generador de pruebas.'}
    docker compose cp $SrdFixture "${SrdService}:$SrdFixtureTarget"
    if($LASTEXITCODE){throw 'No se pudieron preparar las credenciales sintéticas.'}
    docker compose exec -T -e SRD_ROOT=/app -e SRD_ALLOW_MYSQL_FIXTURES=1 -e "SRD_FIXTURE_PATH=$SrdFixtureTarget" -e "SRD_BROWSER_SPEC=$env:SRD_BROWSER_SPEC" $SrdService php /tmp/srd-fixtures.php $SrdService
    if($LASTEXITCODE){throw "Falló la semilla sintética: $SrdService"}
}
