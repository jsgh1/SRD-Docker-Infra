param([switch]$Compose,[switch]$Tls,[string]$Php='G:\xampp\php\php.exe',[ValidatePattern('^[a-z0-9-]+[.]spec[.]mjs$')][string]$Spec,[ValidatePattern('^[a-z0-9-]+[.]spec[.]mjs$')][string[]]$Specs)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $SrdRoot '.local/browsers'
if($Tls -and -not $Compose){throw 'La prueba TLS necesita -Compose.'}
$env:SRD_TEST_URL=if($Tls){'https://localhost:8443'}elseif($Compose){'http://localhost:8080'}else{'http://127.0.0.1:5173'}
$env:SRD_TEST_TLS=if($Tls){'1'}else{'0'}
$env:SRD_MAILPIT_URL=if($Compose){'http://localhost:8025'}else{'http://127.0.0.1:8125'}
$SrdRunDirectory=Join-Path $SrdRoot ('.local/browser-runs/'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $SrdRunDirectory -Force | Out-Null
$SrdAllSpecs=@(Get-ChildItem -LiteralPath (Join-Path $SrdRoot 'tools/browser-tests') -Filter '*.spec.mjs' -File | Sort-Object Name | Select-Object -ExpandProperty Name)
$SrdSpecs=@($SrdAllSpecs | Where-Object { $_ -ne 'chat-latency.spec.mjs' })
if($Spec -and $Specs){throw 'Usa -Spec o -Specs, no ambos.'}
if($Spec){
    if($Spec -notin $SrdAllSpecs){throw 'No existe la prueba solicitada.'}
    $SrdSpecs=@($Spec)
} elseif($Specs) {
    $SrdMissing=@($Specs | Where-Object { $_ -notin $SrdAllSpecs })
    if($SrdMissing.Count){throw ('No existen estas pruebas: '+($SrdMissing -join ', '))}
    $SrdSpecs=@($Specs | Select-Object -Unique)
}
$SrdFailed=$false
try {
    foreach($SrdSpec in $SrdSpecs) {
        if($SrdSpec -eq 'document-boundary.spec.mjs') {
            & $Php -d extension=zip tools/create-office-boundary-fixture.php
            if($LASTEXITCODE){throw 'No se pudieron crear los documentos sintéticos del límite de tamaño.'}
        }
        if($SrdSpec -eq 'folder-image.spec.mjs') {
            & $Php -d extension=gd tools/create-folder-image-fixture.php
            if($LASTEXITCODE){throw 'No se pudo crear la imagen sintética para navegador.'}
        }
        if($SrdSpec -in @('folder-access.spec.mjs','folder-search.spec.mjs')) {
            & $Php -d extension=zip tools/create-office-fixture.php
            if($LASTEXITCODE){throw 'No se pudo crear el documento sintético para permisos.'}
        }
        # Each file gets its own accounts and juntas, so code cooldowns cannot cross tests.
        $env:SRD_BROWSER_SPEC=$SrdSpec
        $SrdBrowserFixture=node tools/browser-fixture.mjs
        if($LASTEXITCODE){throw 'No se pudo preparar una ejecución aislada.'}
        $env:SRD_BROWSER_FIXTURE=$SrdBrowserFixture
        if($Compose) {
            & "$PSScriptRoot/Seed-ComposeTests.ps1" -FixturePath $SrdBrowserFixture
        } else {
            $env:SRD_FIXTURE_PATH=$SrdBrowserFixture
            $SrdServices=@('configuration','identity')
            if($SrdSpec -eq 'calendar-delivery-retry.spec.mjs'){$SrdServices+='calendar'}
            if($SrdSpec -eq 'audit-export.spec.mjs'){$SrdServices+='audit'}
            foreach($SrdService in $SrdServices) {
                & $Php tools/create-fixtures.php $SrdService
                if($LASTEXITCODE){throw 'Falló la preparación local de las pruebas.'}
            }
        }
        $env:SRD_BROWSER_REPORT=Join-Path $SrdRunDirectory ($SrdSpec+'.json')
        $env:SRD_BROWSER_OUTPUT=Join-Path $SrdRunDirectory ($SrdSpec+'-results')
        node tools/browser-tests/node_modules/playwright/cli.js test $SrdSpec --config tools/browser-tests/playwright.config.mjs
        if($LASTEXITCODE){$SrdFailed=$true}
    }
    node tools/merge-browser-reports.mjs $SrdRunDirectory $SrdSpecs.Count
    if($LASTEXITCODE){throw 'No se pudo consolidar la evidencia de navegador.'}
} finally {
    Remove-Item Env:SRD_BROWSER_REPORT -ErrorAction SilentlyContinue
    Remove-Item Env:SRD_BROWSER_OUTPUT -ErrorAction SilentlyContinue
    Remove-Item Env:SRD_BROWSER_SPEC -ErrorAction SilentlyContinue
    Remove-Item Env:SRD_TEST_TLS -ErrorAction SilentlyContinue
}
if($SrdFailed){throw 'Fallaron pruebas de navegador. Revisar .local/browser-results.json y .local/browser-runs.'}
