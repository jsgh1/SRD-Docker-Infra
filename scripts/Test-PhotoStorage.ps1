$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
New-Item -ItemType Directory -Force -Path '.local/photo-storage' | Out-Null
$SrdCompose='docker/photo-storage.compose.yaml'
try {
    docker compose -f docker/file-safety.compose.yaml build check
    if($LASTEXITCODE){throw 'No se pudo construir PHP/GD.'}
    docker compose -f $SrdCompose build check
    if($LASTEXITCODE){throw 'No se pudo construir la prueba de almacenamiento.'}
    docker compose -f $SrdCompose up -d --wait mysql
    if($LASTEXITCODE){throw 'MySQL de prueba no está disponible.'}
    docker compose -f $SrdCompose run --rm --no-deps check
    if($LASTEXITCODE){throw 'Falló el almacenamiento de fotografías; consulta .local/photo-storage/results.json.'}
} finally {
    # Only this isolated synthetic test project; database is ephemeral tmpfs.
    docker compose -f $SrdCompose down
}
