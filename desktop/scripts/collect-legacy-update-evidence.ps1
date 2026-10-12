param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\AI获客-测试版'),
  [string]$OutputDirectory = [Environment]::GetFolderPath('Desktop'),
  [switch]$SkipActiveSelection
)

# Compatible with Windows PowerShell 5.1. Read published program files only;
# never execute the collected application, follow links, or change its profile.
$ErrorActionPreference = 'Stop'
$issues = [Collections.Generic.List[object]]::new()
$inventory = [Collections.Generic.List[object]]::new()
$roots = [Collections.Generic.List[object]]::new()
$selectionSummary = @{ inspected = $false; active = $null; previous = $null; pending = $false }
$utf8 = [Text.UTF8Encoding]::new($false)
$script:bytes = [long]0

function Assert-PlainPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.StartsWith('\\')) { throw 'network_path_not_allowed' }
  $part = $full
  while ($part) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -LiteralPath $part -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked_path_not_allowed' }
    }
    $parent = [IO.Path]::GetDirectoryName($part.TrimEnd('\'))
    if ($parent -eq $part) { break }
    $part = $parent
  }
  return $full
}

function Child-Path([string]$Root, [string]$Relative) {
  if (!$Relative -or $Relative -match '[:\\\x00-\x1f]' -or $Relative.StartsWith('/') -or
      @($Relative.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' -or !$_ -or $_ -match '[. ]$' }).Count) {
    throw 'invalid_manifest_path'
  }
  $path = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
  if (!$path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'path_outside_root' }
  return Assert-PlainPath $path
}

function Read-PublicJson([string]$Path) {
  $safe = Assert-PlainPath $Path
  $item = Get-Item -LiteralPath $safe
  if ($item.Length -gt 32MB) { throw 'metadata_too_large' }
  return [IO.File]::ReadAllText($safe) | ConvertFrom-Json
}

function Issue([string]$Scope, [string]$File, [string]$Code) {
  # Do not export exception messages: they can contain the Windows account path.
  $issues.Add([pscustomobject]@{ scope = $Scope; path = $File; code = $Code })
}

function Copy-PublishedFile([string]$Root, [string]$Scope, [string]$Relative, $Expected) {
  try {
    $source = Child-Path $Root $Relative
    $file = Get-Item -LiteralPath $source -Force
    if ($file.PSIsContainer -or $file.Length -gt 64MB -or ($script:bytes + $file.Length) -gt 512MB) { throw 'file_or_bundle_limit' }
    if ($Relative -match '(?i)(^|/)(\.env[^/]*|id_rsa[^/]*|id_ed25519[^/]*|credentials\.json|secrets\.json)$|\.(pem|key|pfx|p12|log|sqlite|db)$') { throw 'private_file_excluded' }
    if ($file.Extension -match '^\.(cjs|mjs|js|json|txt|html|css|crt)$') {
      if ([IO.File]::ReadAllText($source) -match '-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----') { throw 'private_key_excluded' }
    }
    $destination = Child-Path $bundle ($Scope + '/' + $Relative)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::Copy($source, $destination, $false)
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $destination).Length
    $matches = $null
    if ($Expected) {
      $matches = ($hash -eq $Expected.sha256 -and $size -eq $Expected.size)
      if (!$matches) { Issue $Scope $Relative 'published_digest_mismatch' }
    }
    $inventory.Add([pscustomobject]@{ path = "$Scope/$Relative"; size = $size; sha256 = $hash; matchesPublished = $matches })
    $script:bytes += $size
  } catch {
    $code = if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'read_or_copy_failed' }
    Issue $Scope $Relative $code
  }
}

function Collect-Program([string]$Root, [string]$Scope) {
  try {
    $safe = Assert-PlainPath $Root
    $baseline = Read-PublicJson (Child-Path $safe 'component-base.json')
    if ($baseline.schema -ne 2 -or !$baseline.files -or $baseline.files.Count -gt 100000) { throw 'published_manifest_invalid' }
    $package = Read-PublicJson (Child-Path $safe 'resources/app/package.json')
    $roots.Add([pscustomobject]@{ scope = $Scope; applicationVersion = $package.version; baseVersion = $baseline.base.version; baseFingerprint = $baseline.base.fingerprint })
    Copy-PublishedFile $safe $Scope 'component-base.json' $null
    if (Test-Path -LiteralPath (Join-Path $safe 'component-complete.json')) { Copy-PublishedFile $safe $Scope 'component-complete.json' $null }
    $seen = @{}
    foreach ($entry in $baseline.files) {
      $relative = [string]$entry.path
      if ($relative -notmatch '^(版本清单\.json|版本标识\.txt|version|resources/app/(package\.json|product-brand\.json|installer-targets\.json|src/(main|shared)/.+\.(cjs|mjs|js|json|crt)|dist/.+))$') { continue }
      if ($seen.ContainsKey($relative)) { Issue $Scope $relative 'duplicate_manifest_path'; continue }
      $seen[$relative] = $true
      if ($entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.size -lt 0) { Issue $Scope $relative 'published_entry_invalid'; continue }
      Copy-PublishedFile $safe $Scope $relative $entry
    }
    foreach ($required in @('resources/app/package.json', 'resources/app/src/main/bootstrap.cjs', 'resources/app/src/main/main.cjs', 'resources/app/dist/index.html')) {
      if (!$seen.ContainsKey($required)) { Issue $Scope $required 'required_file_not_in_manifest' }
    }
  } catch {
    $code = if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'program_manifest_unreadable' }
    Issue $Scope 'component-base.json' $code
  }
}

try {
  $install = Assert-PlainPath $InstallDirectory
  if (!(Test-Path -LiteralPath (Join-Path $install 'resources/app/package.json') -PathType Leaf)) {
    throw '未找到软件安装目录。请查看软件快捷方式的“打开文件所在的位置”，按说明指定 -InstallDirectory 后重试。'
  }
  $output = Assert-PlainPath $OutputDirectory
  if ($output.Equals($install, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($install.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '输出目录不能在软件安装目录中。'
  }
  [IO.Directory]::CreateDirectory($output) | Out-Null
  $name = 'AI-update-evidence-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $bundle = Join-Path $output $name
  [IO.Directory]::CreateDirectory($bundle) | Out-Null
  Write-Host '正在读取已发布的程序文件；不会停止软件或修改原文件，请稍候。'
  Collect-Program $install 'installed'

  if (!$SkipActiveSelection) {
    try {
      $edition = Read-PublicJson (Child-Path $install 'resources/app/dist/build-edition.json')
      if ($edition.edition -notin @('development', 'delivery', 'production')) { throw 'edition_unknown' }
      $profileName = if ($edition.edition -eq 'development') { 'xiaoxi-active-touch-test' } else { 'xiaoxi-active-touch-delivery' }
      $components = Assert-PlainPath (Join-Path $env:APPDATA "$profileName\data\cloud-maintenance\components")
      $selectionFile = Join-Path $components 'selection.json'
      if (Test-Path -LiteralPath $selectionFile) {
        $selection = Read-PublicJson $selectionFile
        $selectionSummary.inspected = $true
        foreach ($key in @('active', 'previous')) {
          if ($selection.$key -and $selection.$key -notmatch '^[a-f0-9]{64}$') { throw 'selection_id_invalid' }
          $selectionSummary[$key] = $selection.$key
        }
        $selectionSummary.pending = [bool]$selection.pending
        if ($selection.active) { Collect-Program (Child-Path $components ('generations/' + $selection.active)) 'active' }
      }
    } catch {
      $code = if ($_.Exception.Message -match '^[a-z_]+$') { $_.Exception.Message } else { 'active_selection_unreadable' }
      Issue 'selection' 'selection.json' $code
    }
  }

  $status = if ($issues.Count) { 'partial' } else { 'complete' }
  $report = [ordered]@{ schema = 1; status = $status; collectedAt = [DateTime]::UtcNow.ToString('o'); programRoots = @($roots.ToArray()); selection = $selectionSummary; files = $inventory.Count; bytes = $script:bytes; issues = @($issues.ToArray()); scope = 'Published program sources, built UI and version metadata only; excludes user data and large runtimes. Not a full runnable installation.' }
  [IO.File]::WriteAllText((Join-Path $bundle 'report.json'), ($report | ConvertTo-Json -Depth 8), $utf8)
  [IO.File]::WriteAllText((Join-Path $bundle 'sha256.json'), (ConvertTo-Json -InputObject @($inventory.ToArray()) -Depth 5), $utf8)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $output ($name + '.zip')
  [IO.Compression.ZipFile]::CreateFromDirectory($bundle, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
  if ($issues.Count) {
    Write-Host ('部分采集：有 ' + $issues.Count + ' 项未能完整读取或核验，已在 report.json 记录。仍请把 ZIP 发回排查。') -ForegroundColor Yellow
  } else {
    Write-Host '程序文件采集完成。请把下方 ZIP 发回；这不是安装包，不需要覆盖安装。' -ForegroundColor Green
  }
  Write-Host $zip
  Write-Host '旁边同名文件夹是采集副本，可供检查。原程序和原数据没有改动。'
  if ($issues.Count) { exit 2 }
  exit 0
} catch {
  Write-Host ('采集未完成：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '原程序和原数据没有改动。请保留窗口中的提示并联系开发人员。'
  exit 1
}
