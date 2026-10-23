param([switch]$Packaged)
$ErrorActionPreference='Stop'
$SrdRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot
try {
    if($Packaged){
        $env:SRD_DESKTOP_EXECUTABLE=Join-Path $SrdRoot '.local/desktop-out/SRD Sistema de Registro Digital-win32-x64/SRD.exe'
        if(-not (Test-Path -LiteralPath $env:SRD_DESKTOP_EXECUTABLE)){throw 'Primero ejecuta npm run package en apps/desktop.'}
    }
    node tools/test-desktop.mjs
    if($LASTEXITCODE){throw 'Falló la prueba del cliente Windows.'}
} finally {
    Remove-Item Env:SRD_DESKTOP_EXECUTABLE -ErrorAction SilentlyContinue
}
