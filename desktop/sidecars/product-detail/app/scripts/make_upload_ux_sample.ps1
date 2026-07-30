param(
  [string]$OutDir = "test_batch_input\upload_ux_sample",
  [int]$LargeMB = 0
)

$ErrorActionPreference = "Stop"

function Write-Bytes {
  param(
    [string]$Path,
    [byte[]]$Bytes
  )
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [System.IO.File]::WriteAllBytes((Resolve-Path -LiteralPath $parent).Path + "\" + (Split-Path -Leaf $Path), $Bytes)
}

function Write-Text {
  param(
    [string]$Path,
    [string]$Text
  )
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Set-Content -LiteralPath $Path -Value $Text -Encoding UTF8
}

$root = $OutDir
New-Item -ItemType Directory -Force -Path $root | Out-Null

# 1x1 PNG. The sample is intentionally synthetic and contains no customer data.
$pngBytes = [Convert]::FromBase64String(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)

$products = @("sample-product-a", "sample-product-b")
foreach ($product in $products) {
  $productDir = Join-Path $root $product
  New-Item -ItemType Directory -Force -Path $productDir | Out-Null
  Write-Bytes -Path (Join-Path $productDir "main.png") -Bytes $pngBytes
  Write-Bytes -Path (Join-Path $productDir "detail-1.png") -Bytes $pngBytes
  Write-Text -Path (Join-Path $productDir "info.txt") -Text @"
Name: $product
Purpose: synthetic upload UX browser validation sample
Contains: no real customer data
"@
}

if ($LargeMB -gt 0) {
  $paddingPath = Join-Path $root "upload-progress-padding.bin"
  $bytes = New-Object byte[] (1024 * 1024)
  $stream = [System.IO.File]::Open($paddingPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    for ($i = 0; $i -lt $LargeMB; $i++) {
      $stream.Write($bytes, 0, $bytes.Length)
    }
  } finally {
    $stream.Close()
  }
}

Write-Host ("upload UX sample generated: {0}" -f (Resolve-Path -LiteralPath $root).Path)
Write-Host "Select this folder in /batch/upload during browser validation."
if ($LargeMB -gt 0) {
  Write-Host ("large padding added: {0} MB" -f $LargeMB)
}
