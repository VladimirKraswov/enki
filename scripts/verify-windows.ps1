[CmdletBinding()]
param(
  [string]$InstallerPath = '',
  [switch]$ArtifactOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'select-windows-install.ps1')

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This artifact check must run on Windows.'
}

# The bundled Enki Runtime: every manifest file present, regular and unchanged,
# no unlisted files, and the pinned node.exe still carries its Authenticode
# signature (it is the official Node.js binary, never rebuilt).
function Test-RuntimeArtifact([string]$Root) {
  $manifestPath = Join-Path $Root 'runtime-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Runtime manifest missing in $Root" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema -ne 1 -or $manifest.node -ne 'node/node.exe') { throw 'Unexpected runtime manifest' }
  $listed = @{}
  foreach ($entry in $manifest.files.PSObject.Properties) {
    $relative = $entry.Name
    $listed[$relative] = $true
    $path = Join-Path $Root ($relative -replace '/', '\')
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime file is a link: $relative" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($actual -ne $entry.Value) { throw "Runtime file changed after manifest: $relative" }
  }
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    $relative = $_.FullName.Substring($Root.TrimEnd('\').Length + 1) -replace '\\', '/'
    if ($relative -ne 'runtime-manifest.json' -and -not $listed.ContainsKey($relative)) { throw "Unlisted runtime file: $relative" }
  }
  $node = Get-AuthenticodeSignature -LiteralPath (Join-Path $Root 'node\node.exe')
  if ($node.Status -ne 'Valid') { throw "Bundled node.exe signature is $($node.Status)" }
  [pscustomobject]@{ RuntimeVersion = $manifest.version; RuntimeFiles = $listed.Count; NodeSigner = $node.SignerCertificate.Subject }
}

if (-not $InstallerPath) {
  $bundleDir = Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle\nsis'
  $candidate = Get-ChildItem -LiteralPath $bundleDir -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $candidate) {
    throw "No NSIS installer found in $bundleDir"
  }
  $InstallerPath = $candidate.FullName
}

$installer = Get-Item -LiteralPath $InstallerPath
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName
$signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
$runtime = Test-RuntimeArtifact (Resolve-Path (Join-Path $PSScriptRoot '..\src-tauri\target\enki-agent\current')).Path

$installed = $null
$installedRuntime = $null
if (-not $ArtifactOnly) {
  $package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
  $uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  $entries = @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue })
  $installed = Select-DesktopInstallation -Entries $entries -ExpectedVersion $package.version
  if ($installed.InstallLocation) {
    $installedRuntime = Test-RuntimeArtifact (Join-Path $installed.InstallLocation 'agent-runtime')
  }
}

[pscustomobject]@{
  Installer = $installer.FullName
  InstallerBytes = $installer.Length
  SHA256 = $hash.Hash
  SignatureStatus = [string]$signature.Status
  RuntimeVersion = $runtime.RuntimeVersion
  RuntimeFiles = $runtime.RuntimeFiles
  NodeSigner = $runtime.NodeSigner
  InstalledProduct = $installed.DisplayName
  InstalledVersion = $installed.DisplayVersion
  InstallLocation = $installed.InstallLocation
  InstalledRuntimeVersion = $installedRuntime.RuntimeVersion
} | Format-List

if ($installer.Length -eq 0) {
  throw 'Installer is empty.'
}
Write-Host 'Windows artifact checks completed. UI and agent acceptance require separate live tests.'
