// Windows' own OCR on a bitmap, shared by every step that reads WeChat from the screen: touch's search (since
// 1.2.x, wechat_window_driver.cjs) and deleting friends on a WeChat that gives no UI Automation tree (1.3.75,
// wechat_delete_contact_visual.cjs). Moved here unchanged from the touch search script so both read the same way.
// Initialize-XiaoxiOcr loads the WinRT types and returns a Chinese engine, or $null when this Windows has none.
// Read-SearchLineOcr asks the desktop app's PP-OCRv4 line reader (when it runs) to read one small band again.
const WECHAT_SCREEN_OCR_POWERSHELL = String.raw`
function Initialize-XiaoxiOcr {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:searchAsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
  return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("zh-Hans-CN"))
}
function Wait-SearchWinRt($operation, [Type]$resultType, [int]$timeoutMs = 1800) {
  if ($script:searchAsTaskMethod -eq $null) { throw "windows_runtime_as_task_missing" }
  $task = $script:searchAsTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) { throw "windows_runtime_task_timeout" }
  return $task.Result
}
function Read-SearchOcrBitmap($bitmap, $engine) {
  $memory = $null; $random = $null; $software = $null; $writer = $null
  try {
    $memory = [IO.MemoryStream]::new()
    $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $random = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($random)
    $writer.WriteBytes($memory.ToArray())
    [void](Wait-SearchWinRt ($writer.StoreAsync()) ([uint32]))
    [void](Wait-SearchWinRt ($writer.FlushAsync()) ([bool]))
    [void]$writer.DetachStream(); $writer.Dispose(); $writer = $null; $random.Seek(0)
    $decoder = Wait-SearchWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Wait-SearchWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    return (Wait-SearchWinRt ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult]) 2200)
  } finally {
    if ($writer) { $writer.Dispose() }; if ($software) { $software.Dispose() }; if ($random) { $random.Dispose() }; if ($memory) { $memory.Dispose() }
  }
}
# The "微信号：…" caption read again by the chat-title reader (PP-OCRv4, served by the desktop
# app). Windows' OCR misread this small gray caption on 100% screens (a letter as "×", a dot
# inside 微信号): on the development machine (2026-11-20) two of six real contacts were then
# "not found"; the reader read all six exactly. Without the reader, or with a doubtful reading,
# Windows' reading stays. The reader may only cost accuracy, never the search: 1.5 s per caption,
# 3 s for all of them, and no more calls after one failed.
$script:lineOcrIdRows = 0; $script:lineOcrIdReplaced = 0; $script:lineOcrIdErrors = 0; $script:lineOcrIdError = ""
$script:lineOcrBudget = [Diagnostics.Stopwatch]::StartNew()
function Read-SearchLineOcr($source, [int]$x, [int]$y, [int]$width, [int]$height) {
  $lineOcrUrl = [Environment]::GetEnvironmentVariable("XIAOXI_LINE_OCR_URL")
  $lineOcrToken = [Environment]::GetEnvironmentVariable("XIAOXI_LINE_OCR_TOKEN")
  if (-not ($lineOcrUrl -match '^http://127[.]0[.]0[.]1:[0-9]+/read$') -or $lineOcrToken.Length -lt 32 -or $width -lt 8 -or $height -lt 6) { return $null }
  if ($script:lineOcrIdErrors -gt 0 -or $script:lineOcrBudget.ElapsedMilliseconds -gt 3000) { return $null }
  $band = $null; $pngStream = $null
  try {
    $band = $source.Clone([System.Drawing.Rectangle]::new($x, $y, $width, $height), $source.PixelFormat)
    $pngStream = [IO.MemoryStream]::new(); $band.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $request = [System.Net.HttpWebRequest]::Create($lineOcrUrl)
    $request.Method = 'POST'; $request.Timeout = 1500; $request.ReadWriteTimeout = 1500; $request.Proxy = $null
    $request.ContentType = 'image/png'; $request.Headers.Add('X-Xiaoxi-Token', $lineOcrToken)
    $request.ServicePoint.Expect100Continue = $false
    $payload = $pngStream.ToArray(); $request.ContentLength = $payload.Length
    $requestStream = $request.GetRequestStream(); $requestStream.Write($payload, 0, $payload.Length); $requestStream.Close()
    $response = $request.GetResponse()
    try { $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8); return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $response.Close() }
  } catch { $script:lineOcrIdErrors++; $script:lineOcrIdError = $_.Exception.GetType().Name; return $null } finally { foreach ($resource in @($pngStream, $band)) { if ($null -ne $resource) { $resource.Dispose() } } }
}
`;

module.exports = { WECHAT_SCREEN_OCR_POWERSHELL };
