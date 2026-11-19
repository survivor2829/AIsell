// Read only the fixed title band, never names in the session list or chat body.
const { WECHAT_SCREEN_PIXELS_POWERSHELL } = require("./wechat_screen_pixels.cjs");
const WECHAT_HEADER_TITLE_POWERSHELL = String.raw`
function Test-WechatHeaderTitle($windowRect, [uint32]$dpi, [string]$expectedTitle, [bool]$allowCutTitle = $true) {
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
    # Without the Windows Chinese OCR language only Windows' reading is impossible; the chat-title
    # reader below does not need it (review 2026-11-17), so the engine is only required further down.
    $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
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
    # OCR reads "-" as "一" or "·": when the name itself has a dash, those count as it.
    $expectedHasDash=$expectedTitle -match '[-‐‑‒–—―－]'
    $fold={ param([string]$value)
      $folded=$value.Normalize([Text.NormalizationForm]::FormKC)
      if ($expectedHasDash) { $folded=[Text.RegularExpressions.Regex]::Replace($folded,'[一·・•]','') }
      [Text.RegularExpressions.Regex]::Replace($folded,'[\p{P}\p{S}\p{Cs}\p{Cf}\p{Mn}\s]','').ToLowerInvariant() }
    $expectedFolded=& $fold $expectedTitle
    # One Chinese character misread still confirms the chat (user decision 2026-11-17, first in
    # 1.3.27, dropped with the new reader in 1.3.30, back in 1.3.35: the new reader still misread
    # rare characters such as 燚 and 70 opened chats were skipped on one computer). Only a title
    # of 4+ characters, full length, exactly one differing position with a Chinese character on
    # both sides, never for strict callers, and only when no other contact in the address book is
    # within one character of the reading (XIAOXI_TITLE_NEAR_NAMES; without the list it is off).
    $nearCjkNames=$null
    $nearRaw=[Environment]::GetEnvironmentVariable("XIAOXI_TITLE_NEAR_NAMES")
    if (-not [string]::IsNullOrWhiteSpace($nearRaw) -and -not $expectedHasDash) {
      # Windows PowerShell 5.1 passes a parsed JSON array down the pipeline as ONE object.
      try { $nearParsed=ConvertFrom-Json -InputObject $nearRaw; $nearCjkNames=@(foreach ($nearItem in $nearParsed) { & $fold ([string]$nearItem) }) } catch { $nearCjkNames=$null }
    }
    $nearCjkMatch={ param([string]$reading)
      if ($null -eq $nearCjkNames -or -not $allowCutTitle -or $expectedFolded.Length -lt 4 -or $reading.Length -ne $expectedFolded.Length) { return $false }
      $position=-1
      for ($k=0; $k -lt $reading.Length; $k++) {
        if ($reading[$k] -ceq $expectedFolded[$k]) { continue }
        if ($position -ge 0) { return $false }
        $position=$k
      }
      if ($position -lt 0) { return $false }
      $cjk='^\p{IsCJKUnifiedIdeographs}$'
      if (-not [regex]::IsMatch([string]$reading[$position],$cjk) -or -not [regex]::IsMatch([string]$expectedFolded[$position],$cjk)) { return $false }
      foreach ($near in $nearCjkNames) {
        if ($near.Length -ne $reading.Length) { continue }
        $distance=0
        for ($k=0; $k -lt $near.Length -and $distance -le 1; $k++) { if ($near[$k] -cne $reading[$k]) { $distance++ } }
        if ($distance -le 1) { return $false }
      }
      return $true }
    $script:headerTitleEvidence=@{ lines=0; expected_length=$expectedFolded.Length }
    # The chat-title reader first (PP-OCRv4 recognition, served by the desktop app). Windows' own
    # OCR read 26 of 64 field titles exactly, this reader 58 (2026-11-17); most skipped contacts had
    # the right chat open with an unreadable title. Its reading must equal the name exactly (only
    # symbols, punctuation, spaces and case ignored); otherwise, or when the reader is not there,
    # Windows' reading below decides as before.
    $lineOcrUrl=[Environment]::GetEnvironmentVariable("XIAOXI_LINE_OCR_URL")
    $lineOcrToken=[Environment]::GetEnvironmentVariable("XIAOXI_LINE_OCR_TOKEN")
    if ($lineOcrUrl -match '^http://127\.0\.0\.1:\d+/read$' -and $lineOcrToken.Length -ge 32 -and $expectedFolded.Length -ge 2) {
      $band=$null; $pngStream=$null
      try {
        $band=[System.Drawing.Bitmap]::new($right-$left,$bottom-$top)
        if ([XiaoxiScreenPixels]::Copy($band, $left, $top)) {
          $pngStream=[IO.MemoryStream]::new(); $band.Save($pngStream,[System.Drawing.Imaging.ImageFormat]::Png)
          $request=[System.Net.HttpWebRequest]::Create($lineOcrUrl)
          $request.Method='POST'; $request.Timeout=4000; $request.ReadWriteTimeout=4000; $request.Proxy=$null
          $request.ContentType='image/png'; $request.Headers.Add('X-Xiaoxi-Token',$lineOcrToken)
          # No 100-continue round trip: the reader never sends one, so each request waited ~350 ms.
          $request.ServicePoint.Expect100Continue=$false
          $payload=$pngStream.ToArray(); $request.ContentLength=$payload.Length
          $requestStream=$request.GetRequestStream(); $requestStream.Write($payload,0,$payload.Length); $requestStream.Close()
          $response=$request.GetResponse()
          try { $reader=[IO.StreamReader]::new($response.GetResponseStream(),[Text.Encoding]::UTF8); $reading=($reader.ReadToEnd() | ConvertFrom-Json) } finally { $response.Close() }
          $readFolded=& $fold ([string]$reading.text)
          $script:headerTitleEvidence.line_ocr=@{ read=$true; observed_length=$readFolded.Length; score=[double]$reading.score; match=($readFolded -ceq $expectedFolded) }
          if ($readFolded -ceq $expectedFolded) { return $true }
          if (& $nearCjkMatch $readFolded) { $script:headerTitleEvidence.line_ocr.near_cjk=$true; return $true }
        }
      } catch {
        $script:headerTitleEvidence.line_ocr=@{ read=$false; error=$_.Exception.GetType().Name }
      } finally {
        foreach ($resource in @($pngStream,$band)) { if ($null -ne $resource) { $resource.Dispose() } }
      }
    }
    if ($null -eq $engine) { return $false }
    # A narrow title strip needs surrounding whitespace for WinRT line detection.
    $lines=@(Read-HeaderArea $left $top $right $bottom 3 (($bottom-$top)*2))
    # Customer names carry emoji, punctuation and spaces that OCR drops or misreads,
    # and a long name is cut with "…": an exact match skipped about half of the
    # opened chats (customer 1.2.71, 2026-11-07). Letters and digits must be
    # identical; only symbols/punctuation/spaces are ignored, and a cut title must
    # show at least the first 4 letters/digits of the name. The one-Chinese-character
    # rule above is the only other tolerance (look-alike digits stay off).
    $foldKeepCase={ param([string]$value)
      $folded=$value.Normalize([Text.NormalizationForm]::FormKC)
      if ($expectedHasDash) { $folded=[Text.RegularExpressions.Regex]::Replace($folded,'[一·・•]','') }
      [Text.RegularExpressions.Regex]::Replace($folded,'[\p{P}\p{S}\p{Cs}\p{Cf}\p{Mn}\s]','') }
    $expectedCase=& $foldKeepCase $expectedTitle
    # True when the reading equals the name from its start.
    $readsAsName={ param([string]$reading)
      if ($reading.Length -gt $expectedCase.Length) { return $false }
      for ($k=0; $k -lt $reading.Length; $k++) {
        if ([string]$expectedCase[$k] -ine [string]$reading[$k]) { return $false }
      }
      return $true }
    # Where a mismatch is, without the name itself: lengths, the first differing
    # position and the kind of character on each side (customer 1.2.72 skips left no
    # way to tell which characters OCR got wrong).
    $charClass={ param([string]$s, [int]$i)
      if ($i -ge $s.Length) { return 'end' }
      $c=$s[$i]
      if ([char]::IsDigit($c)) { return 'digit' }
      if ($c -match '[a-z]') { return 'latin' }
      if ($c -match '\p{IsCJKUnifiedIdeographs}') { return $(if ($c -eq [char]0x4E00) { 'han_yi' } else { 'han' }) }
      return 'other' }
    $matches={ param($found)
      # Several readings are tried; keep the one that saw a single title line.
      if ($found.Count -ne 1) {
        if ($script:headerTitleEvidence.lines -ne 1) { $script:headerTitleEvidence=@{ lines=[int]$found.Count; expected_length=$expectedFolded.Length; line_ocr=$script:headerTitleEvidence.line_ocr } }
        return $false
      }
      $text=[string]$found[0].text
      if ($text -ceq $expected) { return $true }
      if ($expectedFolded.Length -lt 2) { return $false }
      $textFolded=& $fold $text
      $diff=0; while ($diff -lt $textFolded.Length -and $diff -lt $expectedFolded.Length -and $textFolded[$diff] -ceq $expectedFolded[$diff]) { $diff++ }
      $script:headerTitleEvidence=@{ lines=1; line_ocr=$script:headerTitleEvidence.line_ocr; expected_length=$expectedFolded.Length; observed_length=$textFolded.Length; first_diff_index=$diff
        expected_class=(& $charClass $expectedFolded $diff); observed_class=(& $charClass $textFolded $diff)
        cut=[bool]($text -match '(…|\.\.\.|。。。)$') }
      $textCase=& $foldKeepCase $text
      $cut=$text -match '(…|\.\.\.|。。。)$'
      # The whole name, or (not for strict callers) a "…"-cut title of 4+ letters/digits.
      if ((($textCase.Length -eq $expectedCase.Length) -or ($allowCutTitle -and $cut -and $textCase.Length -ge 4)) -and (& $readsAsName $textCase)) { return $true }
      if (-not $cut -and (& $nearCjkMatch $textFolded)) { $script:headerTitleEvidence.near_cjk=$true; return $true }
      return $false
    }
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
// The title check's own folding (see $fold above), for names compared in JavaScript.
function foldTitle(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\p{P}\p{S}\p{Cs}\p{Cf}\p{Mn}\s]/gu, "").toLowerCase();
}

// Other contacts' names a one-character OCR misread of this customer's title could equally be:
// same folded length, at most two characters apart. Only touch passes them; without the list
// (auto-reply, older callers) the near-character rule is off.
function titleNearNames(contacts, customer) {
  const expected = foldTitle(customer?.name);
  if (expected.length < 4) return [];
  const near = new Set();
  for (const row of Array.isArray(contacts) ? contacts : []) {
    if (!row || String(row.id ?? "") === String(customer?.id ?? "")) continue;
    for (const value of [row.name, row.remark, row.nickname]) {
      const folded = foldTitle(value);
      if (folded.length !== expected.length) continue;
      let diff = 0;
      for (let index = 0; index < folded.length && diff <= 2; index++) if (folded[index] !== expected[index]) diff++;
      if (diff <= 2) near.add(folded);
    }
  }
  return [...near].slice(0, 200);
}

function titleNearNamesEnvironment(names) {
  return Array.isArray(names) ? JSON.stringify(names.map(String).slice(0, 200)) : "";
}

// UIA elements in the chat header band that are window controls, not a chat title: buttons, menu
// items and the like, or the few labels WeChat gives its own window and toolbar. Field 2026-11-19
// (one PC at 225%): "微信" and "更多" sat in the band and blocked the OCR title read.
const WECHAT_TITLE_CHROME_POWERSHELL = String.raw`
function Test-WechatTitleChrome([string]$name, [string]$controlType) {
  if ($controlType -match '\.(Button|MenuItem|MenuBar|Menu|TitleBar|ToolBar|SplitButton|Hyperlink|Image|TabItem|Tab|CheckBox|ScrollBar|Thumb)$') { return $true }
  return @("微信", "WeChat", "Weixin", "更多", "置顶", "取消置顶", "最小化", "最大化", "还原", "关闭", "聊天信息", "视频聊天", "语音聊天") -contains $name.Trim()
}
`;

module.exports = { WECHAT_HEADER_TITLE_POWERSHELL, WECHAT_TITLE_CHROME_POWERSHELL, foldTitle, titleNearNames, titleNearNamesEnvironment };
