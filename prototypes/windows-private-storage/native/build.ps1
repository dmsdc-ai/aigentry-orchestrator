#Requires -Version 5.1
<#
.SYNOPSIS
  CI-only build of the task-1167 Windows private-storage prototype (win32-x64).

.DESCRIPTION
  Compiles native/private_storage.c with MSVC cl against explicitly supplied,
  CI-pinned Node headers and node.lib. No downloads, no node-gyp, no binary
  search, no shell-evaluated command text: cl is invoked with an argument array.
  Must run inside an MSVC developer environment prepared and pinned by the CI
  job (INCLUDE/LIB set for the Windows SDK and MSVC). Writes the binary to
  -OutputPath and a build receipt to "<OutputPath>.build.json".
  Not a product build step and not wired into package.json or release gates.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ClExe,
  [Parameter(Mandatory = $true)][string]$NodeIncludeDir,
  [Parameter(Mandatory = $true)][string]$NodeLib,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$ExpectedNodeLibSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExplicitPath([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name is required" }
  if ($Value -notmatch '^[A-Za-z]:\\') { throw "$Name must be an absolute drive-letter path" }
  if ($Value.IndexOfAny([char[]]'"*?<>|') -ge 0) { throw "$Name contains a refused character" }
  if ($Value.Contains('\..\') -or $Value.EndsWith('\..')) { throw "$Name must not contain '..'" }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

Assert-ExplicitPath 'ClExe' $ClExe
Assert-ExplicitPath 'NodeIncludeDir' $NodeIncludeDir
Assert-ExplicitPath 'NodeLib' $NodeLib
Assert-ExplicitPath 'OutputPath' $OutputPath

if (-not (Test-Path -LiteralPath $ClExe -PathType Leaf)) { throw 'ClExe not found' }
if (-not (Test-Path -LiteralPath $NodeIncludeDir -PathType Container)) { throw 'NodeIncludeDir not found' }
if (-not (Test-Path -LiteralPath $NodeLib -PathType Leaf)) { throw 'NodeLib not found' }
if (-not $OutputPath.EndsWith('.node', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputPath must end with .node'
}
if (Test-Path -LiteralPath $OutputPath) { throw 'OutputPath already exists; refusing to overwrite' }
$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outDir -PathType Container)) { throw 'OutputPath parent not found' }
if ([string]::IsNullOrEmpty($env:INCLUDE) -or [string]::IsNullOrEmpty($env:LIB)) {
  throw 'INCLUDE/LIB not set: run inside the CI-pinned MSVC developer environment'
}

$headers = @('node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h')
$headerHashes = [ordered]@{}
foreach ($h in $headers) {
  $hp = Join-Path $NodeIncludeDir $h
  if (-not (Test-Path -LiteralPath $hp -PathType Leaf)) { throw "missing header $h" }
  $headerHashes[$h] = Get-Sha256 $hp
}

$nodeLibSha = Get-Sha256 $NodeLib
if ($PSBoundParameters.ContainsKey('ExpectedNodeLibSha256') -and
    $nodeLibSha -ne $ExpectedNodeLibSha256.ToLowerInvariant()) {
  throw 'node.lib sha256 does not match ExpectedNodeLibSha256'
}

$source = Join-Path $PSScriptRoot 'private_storage.c'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'private_storage.c not found' }

$objDir = "$OutputPath.obj"
if (Test-Path -LiteralPath $objDir) { throw 'object directory already exists; refusing to reuse' }
New-Item -ItemType Directory -Path $objDir | Out-Null

$clArgs = @(
  '/nologo', '/LD', '/MT', '/O2', '/W4', '/sdl', '/GS', '/guard:cf',
  '/DNAPI_VERSION=8', '/DBUILDING_NODE_EXTENSION', '/DUNICODE', '/D_UNICODE',
  '/DWIN32_LEAN_AND_MEAN', '/D_WIN32_WINNT=0x0A00',
  "/I$NodeIncludeDir",
  $source,
  "/Fo$objDir\private_storage.obj",
  "/Fe$OutputPath",
  '/link', '/DLL', '/NXCOMPAT', '/DYNAMICBASE', '/HIGHENTROPYVA', '/GUARD:CF',
  '/INCREMENTAL:NO', "/IMPLIB:$objDir\private_storage.lib",
  $NodeLib, 'kernel32.lib', 'advapi32.lib'
)

$clVersion = (Get-Item -LiteralPath $ClExe).VersionInfo.FileVersion
& $ClExe @clArgs
$clExit = $LASTEXITCODE
if ($clExit -ne 0) { throw "cl failed with exit code $clExit" }
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { throw 'cl reported success but produced no output' }

$receipt = [ordered]@{
  task = 1167
  arch = 'win32-x64'
  clExe = $ClExe
  clFileVersion = $clVersion
  clSha256 = Get-Sha256 $ClExe
  clArgs = $clArgs
  clExitCode = $clExit
  sourceSha256 = Get-Sha256 $source
  nodeIncludeDir = $NodeIncludeDir
  nodeHeaderSha256 = $headerHashes
  nodeLib = $NodeLib
  nodeLibSha256 = $nodeLibSha
  outputPath = $OutputPath
  outputSha256 = Get-Sha256 $OutputPath
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$OutputPath.build.json" -Encoding UTF8
Write-Output "built $OutputPath sha256=$($receipt.outputSha256)"
