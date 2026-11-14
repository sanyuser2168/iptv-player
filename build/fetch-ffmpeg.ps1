$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null

$target = Join-Path $bin 'ffmpeg.exe'
if (Test-Path $target) {
    Write-Host "FFmpeg already present: $target"
    exit 0
}

$zip = Join-Path $env:TEMP 'ffmpeg-essentials.zip'
$tmp = Join-Path $env:TEMP 'ffmpeg-extract'

Write-Host 'Downloading FFmpeg essentials...'
Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $tmp -Force

$exe = Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
if (-not $exe) { throw 'ffmpeg.exe not found in archive' }

Copy-Item $exe.FullName $target -Force
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Remove-Item $zip -ErrorAction SilentlyContinue

$size = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Host "FFmpeg ready: $target ($size MB)"