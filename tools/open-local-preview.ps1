param([ValidateRange(1024, 65535)][int]$Port = 8081)

$ErrorActionPreference = 'Stop'
$previewRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previewProfile = Join-Path $previewRepoRoot 'tmp/locallab-preview-profile'
$previewChrome = Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'
if (-not (Test-Path -LiteralPath $previewChrome)) {
    throw 'Google Chrome is required for the configured local preview profile.'
}
# This is the interactive app window the user will operate, with its own local data profile.
Start-Process -FilePath $previewChrome -ArgumentList @(
    ('--user-data-dir="{0}"' -f $previewProfile),
    '--no-first-run',
    '--window-size=1280,900',
    ('--app=http://localhost:{0}' -f $Port)
)
