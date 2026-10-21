param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$software = $null; $random = $null; $writer = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
  function Wait-DocumentOcr($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null,@($operation))
    if (-not $task.Wait(5000)) { throw 'OCR_TIMEOUT' }
    return $task.Result
  }
  $bytes = [IO.File]::ReadAllBytes($ImagePath)
  if ($bytes.Length -gt 2097152) { throw 'OCR_IMAGE_LIMIT' }
  $random = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $writer = [Windows.Storage.Streams.DataWriter]::new($random); $writer.WriteBytes($bytes)
  [void](Wait-DocumentOcr ($writer.StoreAsync()) ([uint32]))
  [void](Wait-DocumentOcr ($writer.FlushAsync()) ([bool]))
  [void]$writer.DetachStream(); $writer.Dispose(); $writer = $null; $random.Seek(0)
  $decoder = Wait-DocumentOcr ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
  if ($null -eq $engine) { throw 'OCR_LANGUAGE_UNAVAILABLE' }
  if ($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'OCR_DIMENSION_LIMIT' }
  $software = Wait-DocumentOcr ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $reading = Wait-DocumentOcr ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
  @{ status = 'completed'; text = (@($reading.Lines | ForEach-Object { $_.Text }) -join "`n") } | ConvertTo-Json -Compress
} catch { @{ status = 'unavailable'; reason = 'LOCAL_OCR_UNAVAILABLE' } | ConvertTo-Json -Compress } finally {
  foreach ($resource in @($software,$writer,$random)) { if ($null -ne $resource) { $resource.Dispose() } }
}
