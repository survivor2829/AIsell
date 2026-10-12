param(
  [Parameter(Mandatory=$true)][string]$ResourceDirectory,
  [string]$PublisherThumbprint = ''
)
# Offline compilation only. Does not sign, publish, install or launch anything.
# With PublisherThumbprint provided, the EXE refuses execution until correctly
# code-signed by that publisher. Without it, use only the official internal channel.
$ErrorActionPreference = 'Stop'
$helperRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$outputParent = [IO.Path]::GetFullPath((Join-Path $helperRoot '../../.build/update-assistant'))
$resourceRoot = [IO.Path]::GetFullPath($ResourceDirectory)
if (!$resourceRoot.StartsWith($outputParent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'resources_outside_workspace' }
for ($checkPath=$resourceRoot; $checkPath; $checkPath=[IO.Path]::GetDirectoryName($checkPath)) {
  if ((Get-Item -LiteralPath $checkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'resource_link_forbidden' }
  if ($checkPath -eq [IO.Path]::GetPathRoot($checkPath)) { break }
}
if ($PublisherThumbprint -and $PublisherThumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'publisher_invalid' }
$report = Get-Content -LiteralPath (Join-Path $resourceRoot 'review-report.json') -Raw | ConvertFrom-Json
$descriptor = Get-Content -LiteralPath (Join-Path $resourceRoot 'payload-manifest.json') -Raw | ConvertFrom-Json
if ($descriptor.schema -ne 1 -or $descriptor.appId -ne 'com.aihuoke.desktop.test' -or $descriptor.channel -ne 'test' -or
    $descriptor.mode -notin @('inspect','update') -or $descriptor.mode -ne $report.mode) { throw 'descriptor_invalid' }
$hashes = @{}
foreach ($name in @('payload.zip','payload-manifest.json','runtime-catalog.json')) {
  $file = Join-Path $resourceRoot $name
  if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'resource_link_forbidden' }
  $hashes[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($hashes['payload.zip'] -ne $report.payloadSha256 -or $hashes['payload-manifest.json'] -ne $report.descriptorSha256 -or
    $hashes['runtime-catalog.json'] -ne $report.runtimeCatalogSha256) { throw 'resource_changed_since_review' }
$outputRoot = Join-Path $outputParent ('build-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$constants = @"
internal static class TrustedBuild {
 internal const string PublisherThumbprint = "$PublisherThumbprint";
 internal const string DescriptorSha256 = "$($hashes['payload-manifest.json'])";
 internal const string PayloadSha256 = "$($hashes['payload.zip'])";
 internal const string RuntimeCatalogSha256 = "$($hashes['runtime-catalog.json'])";
 internal const string ExecutableName = "AI获客 V1.0版本-测试版.exe";
 internal const string ApplicationId = "com.aihuoke.desktop.test";
}
"@
$constantsFile = Join-Path $outputRoot 'TrustedBuild.cs'
[IO.File]::WriteAllText($constantsFile, $constants, [Text.UTF8Encoding]::new($false))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'framework_compiler_missing' }
$executable = Join-Path $outputRoot 'AI获客更新助手.exe'
$arguments = @('/nologo','/utf8output','/target:winexe','/platform:x64','/optimize+','/codepage:65001',('/out:' + $executable),
 '/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.IO.Compression.dll',
 ('/resource:' + (Join-Path $resourceRoot 'payload.zip') + ',payload.zip'),
 ('/resource:' + (Join-Path $resourceRoot 'payload-manifest.json') + ',payload-manifest.json'),
 ('/resource:' + (Join-Path $resourceRoot 'runtime-catalog.json') + ',runtime-catalog.json'),
 $constantsFile, (Join-Path $helperRoot 'Launcher.cs'))
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'launcher_compile_failed' }
$result = [ordered]@{ schema=1; mode=$descriptor.mode; executable=$executable;
  sha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant();
  bytes=(Get-Item -LiteralPath $executable).Length; publisherRequired=[bool]$PublisherThumbprint;
  authenticodeSigned=$false; launched=$false; published=$false }
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'build-report.json') -Encoding UTF8
$result | ConvertTo-Json
