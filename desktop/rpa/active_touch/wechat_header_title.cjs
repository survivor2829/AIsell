// Read only the fixed title band, never names in the session list or chat body.
const { WECHAT_SCREEN_PIXELS_POWERSHELL } = require("./wechat_screen_pixels.cjs");
const WECHAT_HEADER_TITLE_POWERSHELL = String.raw`
function Test-WechatHeaderTitle($windowRect, [uint32]$dpi, [string]$expectedTitle) {
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
    $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
    if ($null -eq $engine) { return $false }
${WECHAT_SCREEN_PIXELS_POWERSHELL}
    # OCR lines of one screen area, each with its position in that area (unscaled pixels).
    function Read-HeaderArea([int]$areaLeft, [int]$areaTop, [int]$areaRight, [int]$areaBottom, [int]$scale, [int]$padding) {
      $bitmap=$null; $scaled=$null; $graphics=$null; $memory=$null; $random=$null; $writer=$null; $software=$null
      try {
        $bitmap=[System.Drawing.Bitmap]::new($areaRight-$areaLeft,$areaBottom-$areaTop)
        if (-not [XiaoxiScreenPixels]::Copy($bitmap, $areaLeft, $areaTop)) { throw "screen_copy_failed" }
        $scaled=[System.Drawing.Bitmap]::new($bitmap.Width*$scale+2*$padding,$bitmap.Height*$scale+2*$padding)
        $graphics=[System.Drawing.Graphics]::FromImage($scaled)
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($bitmap,[System.Drawing.Rectangle]::new($padding,$padding,$bitmap.Width*$scale,$bitmap.Height*$scale),0,0,$bitmap.Width,$bitmap.Height,[System.Drawing.GraphicsUnit]::Pixel)
        $graphics.Dispose(); $graphics=$null
        $memory=[IO.MemoryStream]::new(); $scaled.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
        $random=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
        $writer=[Windows.Storage.Streams.DataWriter]::new($random); $writer.WriteBytes($memory.ToArray())
        [void](Wait-HeaderTitle ($writer.StoreAsync()) ([uint32]))
        [void](Wait-HeaderTitle ($writer.FlushAsync()) ([bool]))
        [void]$writer.DetachStream(); $writer.Dispose(); $writer=$null; [void]$random.Seek(0)
        $decoder=Wait-HeaderTitle ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $software=Wait-HeaderTitle ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $reading=Wait-HeaderTitle ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
        return @(foreach ($line in $reading.Lines) {
          $text=[Text.RegularExpressions.Regex]::Replace(([string]$line.Text).Normalize([Text.NormalizationForm]::FormKC),'\s+','')
          if (-not $text) { continue }
          $words=@($line.Words)
          $box=$words[0].BoundingRect
          [pscustomobject]@{ text=$text; x=(([double]$box.X)-$padding)/$scale; y=(([double]$box.Y)-$padding)/$scale; bottom=(([double]$box.Y)+([double]$box.Height)-$padding)/$scale }
        })
      } finally {
        foreach ($resource in @($software,$writer,$random,$memory,$graphics,$scaled,$bitmap)) {
          if ($null -ne $resource) { $resource.Dispose() }
        }
      }
    }
    $left=[int]($windowRect.Left+[Math]::Max(240,$windowRect.Width*0.28))
    $top=[int]($windowRect.Top+34*$dpi/96.0)
    $right=[int]($windowRect.Left+$windowRect.Width*0.78)
    $bottom=[int][Math]::Min($windowRect.Bottom-1,$windowRect.Top+74*$dpi/96.0)
    if ($right-$left -lt 120 -or $bottom-$top -lt 32) { return $false }
    $expected=[Text.RegularExpressions.Regex]::Replace($expectedTitle.Normalize([Text.NormalizationForm]::FormKC),'\s+','')
    if ($expected.Length -eq 0) { return $false }
    # A narrow title strip needs surrounding whitespace for WinRT line detection.
    $lines=@(Read-HeaderArea $left $top $right $bottom 3 (($bottom-$top)*2))
    $matches={ param($found) $found.Count -eq 1 -and $found[0].text -ceq $expected }
    if (-not (& $matches $lines)) {
      # Windows OCR finds no line at all in a strip holding only a short title (a two-character
      # name on the development machine, WeChat 4.2.0.13, 2026-11-05: the chat was open and the
      # title plain, yet every check failed as atomic_conversation_changed), and misreads one
      # character of a three-character title now and then. Read a taller area with the session
      # list beside it and keep only lines inside the title band itself; the title must still
      # match exactly in one of the readings.
      $areaLeft=[int]($windowRect.Left+60*$dpi/96.0)
      $areaBottom=[int][Math]::Min($windowRect.Bottom-1,$top+260*$dpi/96.0)
      if ($areaBottom-$top -lt 64) { return $false }
      $bandLeft=$left-$areaLeft; $bandHeight=$bottom-$top
      # Line detection on this text changes with the scale (3x found it where 2x and 4x
      # did not on the development machine), so a few scales are tried in turn.
      foreach ($attempt in @(@(3, 48), @(4, ($areaBottom-$top)*2), @(2, 24))) {
        $lines=@(Read-HeaderArea $areaLeft $top $right $areaBottom $attempt[0] $attempt[1] | Where-Object { $_.x -ge $bandLeft-2 -and $_.y -ge -2 -and $_.bottom -le $bandHeight+2 })
        if (& $matches $lines) { break }
      }
    }
    return (& $matches $lines)
  } catch { return $false }
}
`;
module.exports = { WECHAT_HEADER_TITLE_POWERSHELL };
