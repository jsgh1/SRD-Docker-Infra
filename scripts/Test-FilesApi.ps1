param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
$SrdCompose='docker/files-api.compose.yaml'
try {
    if (!$SkipBuild) {
        docker compose -f $SrdCompose build files
        if ($LASTEXITCODE) { throw 'Falló la imagen de Archivos.' }
    }
    docker compose -f $SrdCompose up -d --wait mysql files
    if ($LASTEXITCODE) { throw 'Falló el entorno aislado de Archivos.' }
    docker compose -f $SrdCompose exec -T files php artisan migrate --force
    if ($LASTEXITCODE) { throw 'Falló la migración de Archivos.' }
    docker compose -f $SrdCompose exec -T files php artisan migrate --force
    if ($LASTEXITCODE) { throw 'Falló la repetición de migraciones.' }
    Get-Content -Raw -LiteralPath tools/check-files-api.php | docker compose -f $SrdCompose exec -T files php
    if ($LASTEXITCODE) { throw 'Falló la comprobación de Archivos.' }
} finally {
    # Only disposable containers belonging to srd-files-api; no main database volumes.
    docker compose -f $SrdCompose down
}
