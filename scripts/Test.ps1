param([switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
$env:COMPOSER_HOME = Join-Path $SrdRoot '.local\composer'
$env:COMPOSER_CACHE_DIR = Join-Path $SrdRoot '.local\composer-cache'
$env:npm_config_cache = Join-Path $SrdRoot '.local\npm-cache'
foreach ($SrdService in @('identity','configuration','records','audit','gateway','files','calendar','notifications','treasury','inventory','chat')) {
    if (!$SkipInstall) { composer install --working-dir="services/$SrdService" --no-interaction --quiet; if ($LASTEXITCODE) { throw "Falló Composer: $SrdService" } }
    Push-Location "services/$SrdService"
    try { php vendor/phpunit/phpunit/phpunit; if ($LASTEXITCODE) { throw "Fallaron pruebas: $SrdService" } }
    finally { Pop-Location }
}
if (!$SkipInstall) { npm.cmd ci --prefix apps/web --no-audit --no-fund; if ($LASTEXITCODE) { throw 'Falló npm ci' } }
npm.cmd run build --prefix apps/web
if ($LASTEXITCODE) { throw 'Falló la compilación web' }
