// Read only the fixed title band, never names in the session list or chat body.
const WECHAT_HEADER_TITLE_POWERSHELL = String.raw`
function Test-WechatHeaderTitle($windowRect, [uint32]$dpi, [string]$expectedTitle) {
  $bitmap=$null; $scaled=$null; $graphics=$null; $scaleGraphics=$null
  $memory=$null; $random=$null; $writer=$null; $software=$null
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
    $null=[Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
    $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    function Wait-HeaderTitle($operation, [Type]$type) {
      $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation))
      if (-not $task.Wait(2200)) { throw 'header_read_timeout' }
      return $task.Result
    }
    if ($dpi -lt 72) { return $false }
    $left=[int]($windowRect.Left+[Math]::Max(240,$windowRect.Width*0.28))
    $top=[int]($windowRect.Top+34*$dpi/96.0)
    $right=[int]($windowRect.Left+$windowRect.Width*0.78)
    $bottom=[int][Math]::Min($windowRect.Bottom-1,$windowRect.Top+74*$dpi/96.0)
    if ($right-$left -lt 120 -or $bottom-$top -lt 32) { return $false }
    $bitmap=[System.Drawing.Bitmap]::new($right-$left,$bottom-$top)
    $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($left,$top,0,0,$bitmap.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
    $graphics.Dispose(); $graphics=$null
    # A narrow title strip needs surrounding whitespace for WinRT line detection.
    $padding=$bitmap.Height*2
    $scaled=[System.Drawing.Bitmap]::new($bitmap.Width*3+2*$padding,$bitmap.Height*3+2*$padding)
    $scaleGraphics=[System.Drawing.Graphics]::FromImage($scaled)
    $scaleGraphics.Clear([System.Drawing.Color]::White)
    $scaleGraphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaleGraphics.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scaleGraphics.DrawImage($bitmap,[System.Drawing.Rectangle]::new($padding,$padding,$bitmap.Width*3,$bitmap.Height*3),0,0,$bitmap.Width,$bitmap.Height,[System.Drawing.GraphicsUnit]::Pixel)
    $scaleGraphics.Dispose(); $scaleGraphics=$null
    $memory=[IO.MemoryStream]::new(); $scaled.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
    $random=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer=[Windows.Storage.Streams.DataWriter]::new($random); $writer.WriteBytes($memory.ToArray())
    [void](Wait-HeaderTitle ($writer.StoreAsync()) ([uint32]))
    [void](Wait-HeaderTitle ($writer.FlushAsync()) ([bool]))
    [void]$writer.DetachStream(); $writer.Dispose(); $writer=$null; $random.Seek(0)
    $decoder=Wait-HeaderTitle ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software=Wait-HeaderTitle ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
    if ($null -eq $engine) { return $false }
    $reading=Wait-HeaderTitle ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    $lines=@($reading.Lines | ForEach-Object { [Text.RegularExpressions.Regex]::Replace(([string]$_.Text).Normalize([Text.NormalizationForm]::FormKC),'\s+','') } | Where-Object { $_ })
    $expected=[Text.RegularExpressions.Regex]::Replace($expectedTitle.Normalize([Text.NormalizationForm]::FormKC),'\s+','')
    return $expected.Length -gt 0 -and $lines.Count -eq 1 -and $lines[0] -ceq $expected
  } catch { return $false } finally {
    foreach ($resource in @($software,$writer,$random,$memory,$scaleGraphics,$scaled,$graphics,$bitmap)) {
      if ($null -ne $resource) { $resource.Dispose() }
    }
  }
}
`;
module.exports = { WECHAT_HEADER_TITLE_POWERSHELL };
