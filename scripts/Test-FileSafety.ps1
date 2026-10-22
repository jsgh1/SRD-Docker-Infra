param([switch]$UnitOnly)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
New-Item -ItemType Directory -Force -Path '.local/file-safety' | Out-Null
$SrdCompose='docker/file-safety.compose.yaml'
try {
    docker compose -f $SrdCompose build check
    if($LASTEXITCODE){throw 'No se pudo construir el verificador de imágenes.'}
    if($UnitOnly) {
        docker compose -f $SrdCompose run --rm --no-deps -e SRD_CLAMD_ADDRESS= check
    } else {
        docker compose -f $SrdCompose up -d --wait antivirus
        if($LASTEXITCODE){throw 'El antivirus local no está disponible; no se autoriza ninguna imagen.'}
        docker compose -f $SrdCompose run --rm --no-deps check
    }
    if($LASTEXITCODE){throw 'Falló la verificación de imágenes; consulta .local/file-safety/results.json.'}
} finally {
    # Separate project, no production services or named data volumes.
    docker compose -f $SrdCompose down
}
