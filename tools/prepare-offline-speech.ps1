[CmdletBinding()]
param([switch]$VerifyModelHashes)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$cachePath = Join-Path $repoPath 'tmp/offline-speech-models'
$publicPath = Join-Path $repoPath 'apps/mobile/public/speech'
$runtimePath = Join-Path $cachePath 'runtime-package/package/wasm'
New-Item -ItemType Directory -Force -Path $cachePath, (Join-Path $publicPath 'runtime') | Out-Null
# The SDK57-compatible native beta omits its advertised wasm directory.
# Stable1.3.1 ships the matching sherpa1.13.0 C-API runtime; pin it explicitly.
if (-not (Test-Path -LiteralPath $runtimePath)) {
  $runtimeArchive = Join-Path $cachePath 'sherpa-runtime-1.3.1.tgz'
  if (-not (Test-Path -LiteralPath $runtimeArchive)) {
    & curl.exe -L --fail --retry 2 -o $runtimeArchive 'https://registry.npmjs.org/@siteed/sherpa-onnx.rn/-/sherpa-onnx.rn-1.3.1.tgz'
    if ($LASTEXITCODE -ne 0) { throw 'Speech WASM runtime download failed.' }
  }
  if ((Get-Item -LiteralPath $runtimeArchive).Length -ne 39287714 -or (Get-FileHash -LiteralPath $runtimeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '1beacdebc3d6f0274f7ef63c46f1bdbf6eb2e6c6722e0c799faa952ce4632b06') { throw 'Speech WASM package integrity check failed.' }
  $runtimeExtract = Join-Path $cachePath 'runtime-package'
  New-Item -ItemType Directory -Force -Path $runtimeExtract | Out-Null
  & tar -xf $runtimeArchive -C $runtimeExtract
  if ($LASTEXITCODE -ne 0) { throw 'Speech WASM runtime extraction failed.' }
}
foreach ($name in @('sherpa-onnx-wasm-combined.js', 'sherpa-onnx-wasm-combined.wasm')) {
  Copy-Item -LiteralPath (Join-Path $runtimePath $name) -Destination (Join-Path $publicPath "runtime/$name") -Force
}
$runtimeFiles = @('worker.js','runtime/sherpa-onnx-wasm-combined.js','runtime/sherpa-onnx-wasm-combined.wasm') | ForEach-Object {
  $file = Get-Item -LiteralPath (Join-Path $publicPath $_)
  @{name=$_; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
@{package='@siteed/sherpa-onnx.rn'; version='1.3.1'; sherpaOnnxVersion='1.13.0'; workerRevision=2; source='https://registry.npmjs.org/@siteed/sherpa-onnx.rn/-/sherpa-onnx.rn-1.3.1.tgz'; license='MIT'; files=@($runtimeFiles)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $publicPath 'runtime/source.json') -Encoding UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$models = @(
  @{ id='kokoro-v1'; directory='kokoro-multi-lang-v1_0'; model='model.onnx'; bytes=349906910; sha256='c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298'; extras=@('voices.bin','lexicon-us-en.txt','LICENSE') },
  @{ id='piper-lj'; directory='vits-piper-en_US-ljspeech-high'; model='en_US-ljspeech-high.onnx'; bytes=115817679; sha256='00c6408d2409050312193b0d40ae07fde28af7d3d45a56efcc55440db516b935'; extras=@('MODEL_CARD') }
)
foreach ($model in $models) {
  $archivePath = Join-Path $cachePath "$($model.directory).tar.bz2"
  $sourcePath = Join-Path $cachePath $model.directory
  if (-not (Test-Path -LiteralPath $archivePath)) {
    $url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$($model.directory).tar.bz2"
    & curl.exe -L --fail --retry 2 -o $archivePath $url
    if ($LASTEXITCODE -ne 0) { throw "Model download failed: $($model.id)" }
  }
  if ((Get-Item -LiteralPath $archivePath).Length -ne $model.bytes) { throw "Voice archive is incomplete: $($model.id)" }
  if ($VerifyModelHashes -and (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $model.sha256) { throw "Voice archive integrity check failed: $($model.id)" }
  if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $model.model))) {
    & tar -xf $archivePath -C $cachePath
    if ($LASTEXITCODE -ne 0) { throw "Model extraction failed: $($model.id)" }
  }
  $targetPath = Join-Path $publicPath "models/$($model.id)"
  New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourcePath $model.model) -Destination (Join-Path $targetPath 'model.onnx') -Force
  Copy-Item -LiteralPath (Join-Path $sourcePath 'tokens.txt') -Destination (Join-Path $targetPath 'tokens.txt') -Force
  foreach ($name in $model.extras) { Copy-Item -LiteralPath (Join-Path $sourcePath $name) -Destination (Join-Path $targetPath $name) -Force }
  $zipPath = Join-Path $targetPath 'espeak-ng-data.zip'
  if (-not (Test-Path -LiteralPath $zipPath)) {
    [System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $sourcePath 'espeak-ng-data'), $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  }
  $files = @(Get-ChildItem -LiteralPath $targetPath -File | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
    $speechPreparedFile = @{name=$_.Name; bytes=$_.Length}
    if ($VerifyModelHashes) { $speechPreparedFile.sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    $speechPreparedFile
  })
  @{modelId=$model.id; source="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$($model.directory).tar.bz2"; files=$files} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $targetPath 'manifest.json') -Encoding UTF8
  Write-Output "Prepared $($model.id) local assets."
}
