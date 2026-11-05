$ErrorActionPreference = 'Stop'
$SrdRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $SrdRoot

& (Join-Path $PSScriptRoot 'Package.ps1')
if ($LASTEXITCODE) { throw 'No se pudo preparar el paquete fuente.' }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$SrdTarget = Join-Path $SrdRoot 'dist/SRD-exposicion-2026-10-06.zip'
$SrdPartial = "$SrdTarget.partial"
$SrdFiles = Get-Content -LiteralPath (Join-Path $SrdRoot '.local/package-files.json') -Raw | ConvertFrom-Json
$SrdExtras = @(
    @{ Source = '.local/mobile/app-debug-embedded.apk'; Entry = 'SRD/entregables/Android-debug-x86_64.apk' },
    @{ Source = '.local/desktop-out/make/squirrel.windows/x64/SRD-Setup.exe'; Entry = 'SRD/entregables/Windows-SRD-Setup-sin-firma.exe' }
)

$SrdStream = [IO.File]::Open($SrdPartial, [IO.FileMode]::Create)
$SrdZip = New-Object IO.Compression.ZipArchive($SrdStream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($SrdRelative in $SrdFiles) {
        $SrdSource = Join-Path $SrdRoot $SrdRelative
        $SrdEntry = 'SRD/' + ($SrdRelative -replace '\\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($SrdZip, $SrdSource, $SrdEntry,
            [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    foreach ($SrdExtra in $SrdExtras) {
        $SrdSource = Join-Path $SrdRoot $SrdExtra.Source
        if (Test-Path -LiteralPath $SrdSource) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($SrdZip, $SrdSource, $SrdExtra.Entry,
                [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
} finally {
    $SrdZip.Dispose()
    $SrdStream.Dispose()
}
Move-Item -LiteralPath $SrdPartial -Destination $SrdTarget -Force
$SrdHash = (Get-FileHash -LiteralPath $SrdTarget -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$SrdTarget.sha256", "$SrdHash  SRD-exposicion-2026-10-06.zip`n")
Write-Host "Paquete de exposición: $SrdTarget"
Write-Host "SHA-256: $SrdHash"
