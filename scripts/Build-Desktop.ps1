param([switch]$PackageOnly)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
$SrdDesktop=Join-Path $SrdRoot 'apps/desktop'
$PreviousNpmCache=$env:npm_config_cache
$PreviousElectronCache=$env:ELECTRON_CACHE
$PreviousRunAsNode=$env:ELECTRON_RUN_AS_NODE
try {
    $env:npm_config_cache=Join-Path $SrdRoot '.local/npm-cache'
    $env:ELECTRON_CACHE=Join-Path $SrdRoot '.local/electron-cache'
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Push-Location -LiteralPath $SrdDesktop
    try {
        npm.cmd ci --no-audit --no-fund
        if($LASTEXITCODE){throw 'No se pudieron instalar las dependencias fijadas del cliente Windows.'}
        npm.cmd test
        if($LASTEXITCODE){throw 'Fallaron las pruebas del cliente Windows.'}
        if($PackageOnly){npm.cmd run package}else{npm.cmd run make}
        if($LASTEXITCODE){throw 'No se pudo construir el cliente Windows.'}
    } finally {Pop-Location}
    if(-not $PackageOnly){
        $SrdSetup=Join-Path $SrdRoot '.local/desktop-out/make/squirrel.windows/x64/SRD-Setup.exe'
        if(-not (Test-Path -LiteralPath $SrdSetup)){throw 'No se encontró el instalador local esperado.'}
        Get-FileHash -Algorithm SHA256 -LiteralPath $SrdSetup | Select-Object Path,Hash
        Get-AuthenticodeSignature -LiteralPath $SrdSetup | Select-Object Status
    }
} finally {
    if($null -eq $PreviousNpmCache){Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue}else{$env:npm_config_cache=$PreviousNpmCache}
    if($null -eq $PreviousElectronCache){Remove-Item Env:ELECTRON_CACHE -ErrorAction SilentlyContinue}else{$env:ELECTRON_CACHE=$PreviousElectronCache}
    if($null -eq $PreviousRunAsNode){Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue}else{$env:ELECTRON_RUN_AS_NODE=$PreviousRunAsNode}
}
