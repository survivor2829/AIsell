const { MOMENTS_SURFACE_PROFILE } = require("./moments_surface_profile.dev.cjs");

const MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL = String.raw`
function Test-MomentsWechatGreenGlyphPixel($pixel) {
  return $pixel -ne $null -and [int]$pixel.g -ge 100 -and
    ([int]$pixel.g - [int]$pixel.r) -ge 25 -and
    ([int]$pixel.g - [int]$pixel.b) -ge 10
}

function Test-MomentsNavigationGlyphPixel($pixel) {
  if ($pixel -eq $null) { return $false }
  $maximum = [Math]::Max([int]$pixel.r, [Math]::Max([int]$pixel.g, [int]$pixel.b))
  $minimum = [Math]::Min([int]$pixel.r, [Math]::Min([int]$pixel.g, [int]$pixel.b))
  $luminance = ([double]$pixel.r + [double]$pixel.g + [double]$pixel.b) / 3.0
  $neutralGlyph = ($maximum - $minimum) -le 32 -and $luminance -ge 28 -and $luminance -le 205
  $wechatGreenGlyph = Test-MomentsWechatGreenGlyphPixel $pixel
  return $neutralGlyph -or $wechatGreenGlyph
}

function Get-MomentsNavigationBackgroundEvidence(
  $frame,
  [int]$left,
  [int]$top,
  [int]$right,
  [int]$bottom
) {
  $buckets = @{}
  $totalPixelCount = 0
  for ($y = $top; $y -lt $bottom; $y++) {
    for ($x = $left; $x -lt $right; $x++) {
      $pixel = Get-MomentsPixel $frame $x $y
      if ($pixel -eq $null) { continue }
      $redBucket = [Math]::Floor([int]$pixel.r / 16.0)
      $greenBucket = [Math]::Floor([int]$pixel.g / 16.0)
      $blueBucket = [Math]::Floor([int]$pixel.b / 16.0)
      $key = "{0}:{1}:{2}" -f $redBucket, $greenBucket, $blueBucket
      if (-not $buckets.ContainsKey($key)) {
        $buckets[$key] = @{ count = 0; redTotal = [long]0; greenTotal = [long]0; blueTotal = [long]0 }
      }
      $bucket = $buckets[$key]
      $bucket.count = [int]$bucket.count + 1
      $bucket.redTotal = [long]$bucket.redTotal + [int]$pixel.r
      $bucket.greenTotal = [long]$bucket.greenTotal + [int]$pixel.g
      $bucket.blueTotal = [long]$bucket.blueTotal + [int]$pixel.b
      $totalPixelCount += 1
    }
  }
  if ($totalPixelCount -eq 0 -or $buckets.Count -eq 0) {
    return @{ ok = $false; pixel = $null; coverage = 0.0 }
  }
  $backgroundBucket = $null
  foreach ($bucket in $buckets.Values) {
    if ($backgroundBucket -eq $null -or [int]$bucket.count -gt [int]$backgroundBucket.count) {
      $backgroundBucket = $bucket
    }
  }
  $backgroundCount = [Math]::Max(1, [int]$backgroundBucket.count)
  return @{
    ok = $true
    pixel = @{
      r = [int][Math]::Round([double]$backgroundBucket.redTotal / $backgroundCount)
      g = [int][Math]::Round([double]$backgroundBucket.greenTotal / $backgroundCount)
      b = [int][Math]::Round([double]$backgroundBucket.blueTotal / $backgroundCount)
    }
    coverage = [double]$backgroundCount / [double]$totalPixelCount
  }
}

function Test-MomentsNavigationForegroundPixel($pixel, $backgroundEvidence) {
  if ($pixel -eq $null) { return $false }
  if (Test-MomentsWechatGreenGlyphPixel $pixel) { return $true }
  if (-not (Test-MomentsNavigationGlyphPixel $pixel)) { return $false }
  if ($backgroundEvidence -eq $null -or -not [bool]$backgroundEvidence.ok -or
    $backgroundEvidence.pixel -eq $null) {
    return $true
  }
  $background = $backgroundEvidence.pixel
  $maximumChannelDelta = [Math]::Max(
    [Math]::Abs([int]$pixel.r - [int]$background.r),
    [Math]::Max(
      [Math]::Abs([int]$pixel.g - [int]$background.g),
      [Math]::Abs([int]$pixel.b - [int]$background.b)
    )
  )
  return $maximumChannelDelta -ge 24
}

function Test-MomentsDiscoverTopologyEvidence(
  [double]$cornerRatio,
  [double]$diagonalContrast
) {
  return $cornerRatio -le 0.12 -and $diagonalContrast -ge 0.08
}

function Test-MomentsDiscoverShapeMatch($candidate, [double]$scale) {
  $minimumActivePixels = [Math]::Max(32, [Math]::Round(52.0 * $scale * $scale))
  $maximumActivePixels = [Math]::Round(360.0 * $scale * $scale)
  $minimumDimension = 14.0 * $scale
  $maximumDimension = 30.0 * $scale
  return [int]$candidate.activePixelCount -ge $minimumActivePixels -and
    [int]$candidate.activePixelCount -le $maximumActivePixels -and
    [double]$candidate.bounds.width -ge $minimumDimension -and [double]$candidate.bounds.width -le $maximumDimension -and
    [double]$candidate.bounds.height -ge $minimumDimension -and [double]$candidate.bounds.height -le $maximumDimension -and
    [double]$candidate.fillRatio -ge 0.14 -and [double]$candidate.fillRatio -le 0.82 -and
    [double]$candidate.aspectRatio -ge 0.78 -and [double]$candidate.aspectRatio -le 1.28 -and
    (Test-MomentsDiscoverTopologyEvidence ([double]$candidate.cornerRatio) ([double]$candidate.diagonalContrast))
}

function Test-MomentsSelectedDiscoverRecoveryMatch($candidate, [double]$scale) {
  $minimumActivePixels = [Math]::Max(32, [Math]::Round(52.0 * $scale * $scale))
  $maximumActivePixels = [Math]::Round(360.0 * $scale * $scale)
  $minimumDimension = 14.0 * $scale
  $maximumDimension = 30.0 * $scale
  return [int]$candidate.activePixelCount -ge $minimumActivePixels -and
    [int]$candidate.activePixelCount -le $maximumActivePixels -and
    [double]$candidate.bounds.width -ge $minimumDimension -and [double]$candidate.bounds.width -le $maximumDimension -and
    [double]$candidate.bounds.height -ge $minimumDimension -and [double]$candidate.bounds.height -le $maximumDimension -and
    [double]$candidate.fillRatio -ge 0.14 -and [double]$candidate.fillRatio -le 0.82 -and
    [double]$candidate.aspectRatio -ge 0.78 -and [double]$candidate.aspectRatio -le 1.28 -and
    [double]$candidate.greenRatio -ge 0.80 -and [double]$candidate.cornerRatio -le 0.12
}

function Get-MomentsDiscoverShapeEvidence(
  $frame,
  [int]$left,
  [int]$top,
  [int]$right,
  [int]$bottom,
  [double]$scale,
  $backgroundEvidence = $null
) {
  $activePixelCount = 0
  $greenPixelCount = 0
  $minimumX = [int]::MaxValue
  $minimumY = [int]::MaxValue
  $maximumX = -1
  $maximumY = -1
  for ($y = $top; $y -lt $bottom; $y++) {
    for ($x = $left; $x -lt $right; $x++) {
      $pixel = Get-MomentsPixel $frame $x $y
      if (-not (Test-MomentsNavigationForegroundPixel $pixel $backgroundEvidence)) { continue }
      $activePixelCount += 1
      if (Test-MomentsWechatGreenGlyphPixel $pixel) { $greenPixelCount += 1 }
      $minimumX = [Math]::Min($minimumX, $x)
      $minimumY = [Math]::Min($minimumY, $y)
      $maximumX = [Math]::Max($maximumX, $x)
      $maximumY = [Math]::Max($maximumY, $y)
    }
  }
  if ($activePixelCount -eq 0) { return $null }

  $bounds = @{
    left = [double]$minimumX
    top = [double]$minimumY
    width = [double]($maximumX - $minimumX + 1)
    height = [double]($maximumY - $minimumY + 1)
  }
  $shapeArea = [double]$bounds.width * [double]$bounds.height
  $discoverShapeFillRatio = $(if ($shapeArea -gt 0) { [double]$activePixelCount / $shapeArea } else { 0.0 })
  $centerX = [double]$bounds.left + ([double]$bounds.width / 2.0)
  $centerY = [double]$bounds.top + ([double]$bounds.height / 2.0)
  $shapeCenterX = [double]$bounds.left + (([double]$bounds.width - 1.0) / 2.0)
  $shapeCenterY = [double]$bounds.top + (([double]$bounds.height - 1.0) / 2.0)
  $halfWidth = [Math]::Max(1.0, [double]$bounds.width / 2.0)
  $halfHeight = [Math]::Max(1.0, [double]$bounds.height / 2.0)
  $cornerPixels = 0
  $cornerTotal = 0
  $ringPixels = 0
  $ringTotal = 0
  $positiveDiagonalPixels = 0
  $positiveDiagonalTotal = 0
  $negativeDiagonalPixels = 0
  $negativeDiagonalTotal = 0
  for ($y = [int]$minimumY; $y -le [int]$maximumY; $y++) {
    for ($x = [int]$minimumX; $x -le [int]$maximumX; $x++) {
      $normalizedX = ([double]$x - $shapeCenterX) / $halfWidth
      $normalizedY = ([double]$y - $shapeCenterY) / $halfHeight
      $radiusSquared = ($normalizedX * $normalizedX) + ($normalizedY * $normalizedY)
      $active = Test-MomentsNavigationForegroundPixel (Get-MomentsPixel $frame $x $y) $backgroundEvidence
      if ($radiusSquared -gt 1.05) {
        $cornerTotal += 1
        if ($active) { $cornerPixels += 1 }
      }
      if ($radiusSquared -ge 0.45 -and $radiusSquared -le 1.10) {
        $ringTotal += 1
        if ($active) { $ringPixels += 1 }
      }
      if ([Math]::Abs($normalizedX + $normalizedY) -lt 0.18) {
        $positiveDiagonalTotal += 1
        if ($active) { $positiveDiagonalPixels += 1 }
      }
      if ([Math]::Abs($normalizedX - $normalizedY) -lt 0.18) {
        $negativeDiagonalTotal += 1
        if ($active) { $negativeDiagonalPixels += 1 }
      }
    }
  }
  $cornerRatio = $(if ($cornerTotal -gt 0) { [double]$cornerPixels / [double]$cornerTotal } else { 1.0 })
  $ringRatio = $(if ($ringTotal -gt 0) { [double]$ringPixels / [double]$ringTotal } else { 0.0 })
  $positiveDiagonalRatio = $(if ($positiveDiagonalTotal -gt 0) {
    [double]$positiveDiagonalPixels / [double]$positiveDiagonalTotal
  } else { 0.0 })
  $negativeDiagonalRatio = $(if ($negativeDiagonalTotal -gt 0) {
    [double]$negativeDiagonalPixels / [double]$negativeDiagonalTotal
  } else { 0.0 })
  $diagonalContrast = [Math]::Abs($positiveDiagonalRatio - $negativeDiagonalRatio)
  $aspectRatio = [double]$bounds.width / [Math]::Max(1.0, [double]$bounds.height)
  $greenRatio = $(if ($activePixelCount -gt 0) { [double]$greenPixelCount / [double]$activePixelCount } else { 0.0 })
  $candidate = @{
    bounds = $bounds
    centerX = $centerX
    centerY = $centerY
    activePixelCount = $activePixelCount
    fillRatio = $discoverShapeFillRatio
    aspectRatio = $aspectRatio
    cornerRatio = $cornerRatio
    ringRatio = $ringRatio
    diagonalContrast = $diagonalContrast
    greenRatio = $greenRatio
    selected = $greenRatio -ge 0.55
    matched = $false
  }
  $candidate["matched"] = [bool](Test-MomentsDiscoverShapeMatch $candidate $scale)
  return $candidate
}

function Get-IntegratedDiscoverEntryEvidence($frame, $relativeSurfaceBounds, [double]$scale) {
  if ($frame -eq $null -or -not [bool]$frame.ok -or $scale -lt 0.75 -or $scale -gt 5.0) {
    return @{ ok = $false; reason = "moments_discover_entry_not_found"; exactMatchCount = 0; entries = @() }
  }
  $logical = @{
    left = ${MOMENTS_SURFACE_PROFILE.integratedPrimaryRailScanLogicalBounds.left.toFixed(1)}
    top = ${MOMENTS_SURFACE_PROFILE.integratedPrimaryRailScanLogicalBounds.top.toFixed(1)}
    width = ${MOMENTS_SURFACE_PROFILE.integratedPrimaryRailScanLogicalBounds.width.toFixed(1)}
    height = ${MOMENTS_SURFACE_PROFILE.integratedPrimaryRailScanLogicalBounds.height.toFixed(1)}
  }
  $region = @{
    left = [Math]::Max([double]$relativeSurfaceBounds.left, [double]$relativeSurfaceBounds.left + ($logical.left * $scale))
    top = [Math]::Max([double]$relativeSurfaceBounds.top, [double]$relativeSurfaceBounds.top + ($logical.top * $scale))
    width = [Math]::Min(
      $logical.width * $scale,
      ([double]$relativeSurfaceBounds.left + [double]$relativeSurfaceBounds.width) -
        ([double]$relativeSurfaceBounds.left + ($logical.left * $scale))
    )
    height = [Math]::Min(
      $logical.height * $scale,
      ([double]$relativeSurfaceBounds.top + [double]$relativeSurfaceBounds.height) -
        ([double]$relativeSurfaceBounds.top + ($logical.top * $scale))
    )
  }
  [int]$left = [Math]::Max(0, [Math]::Floor([double]$region.left))
  [int]$top = [Math]::Max(0, [Math]::Floor([double]$region.top))
  [int]$right = [Math]::Min([int]$frame.width, [Math]::Ceiling([double]$region.left + [double]$region.width))
  [int]$bottom = [Math]::Min([int]$frame.height, [Math]::Ceiling([double]$region.top + [double]$region.height))
  if ($right -le $left -or $bottom -le $top) {
    return @{ ok = $false; reason = "moments_discover_entry_not_found"; region = $region; exactMatchCount = 0; entries = @() }
  }

  $backgroundEvidence = Get-MomentsNavigationBackgroundEvidence $frame $left $top $right $bottom

  $activeRows = New-Object System.Collections.Generic.List[int]
  $totalActivePixelCount = 0
  for ($y = $top; $y -lt $bottom; $y++) {
    $rowActive = $false
    for ($x = $left; $x -lt $right; $x++) {
      if (Test-MomentsNavigationForegroundPixel (Get-MomentsPixel $frame $x $y) $backgroundEvidence) {
        $rowActive = $true
        $totalActivePixelCount += 1
      }
    }
    if ($rowActive) { [void]$activeRows.Add($y) }
  }
  if ($activeRows.Count -eq 0) {
    return @{
      ok = $true
      region = $region
      exactMatchCount = 0
      selectedMatchCount = 0
      entries = @()
      candidateCount = 0
      candidateDiagnostics = @()
      activePixelCount = 0
    }
  }

  $rowGroups = New-Object System.Collections.Generic.List[object]
  $maximumRowGap = [Math]::Max(2, [Math]::Round(4.0 * $scale))
  [int]$groupStart = $activeRows[0]
  [int]$previousRow = $activeRows[0]
  for ($index = 1; $index -lt $activeRows.Count; $index++) {
    [int]$currentRow = $activeRows[$index]
    if (($currentRow - $previousRow) -gt $maximumRowGap) {
      [void]$rowGroups.Add(@{ top = $groupStart; bottom = $previousRow + 1 })
      $groupStart = $currentRow
    }
    $previousRow = $currentRow
  }
  [void]$rowGroups.Add(@{ top = $groupStart; bottom = $previousRow + 1 })

  $entries = New-Object System.Collections.Generic.List[object]
  $candidateDiagnostics = New-Object System.Collections.Generic.List[object]
  foreach ($group in $rowGroups) {
    $candidate = Get-MomentsDiscoverShapeEvidence $frame $left ([int]$group.top) $right ([int]$group.bottom) $scale $backgroundEvidence
    if ($candidate -eq $null) { continue }
    [void]$candidateDiagnostics.Add($candidate)
    if ([bool]$candidate.matched) { [void]$entries.Add($candidate) }
  }

  # Newer WeChat builds can leave only a few blank rows between adjacent rail
  # glyphs. The row projection above then joins the whole rail into one tall
  # candidate even though the selected Discover glyph is still an isolated
  # green shape. Recover that shape from its own colour projection instead of
  # guessing a fixed y coordinate.
  if ($entries.Count -eq 0) {
    $greenRows = New-Object System.Collections.Generic.List[int]
    for ($y = $top; $y -lt $bottom; $y++) {
      $rowGreen = $false
      for ($x = $left; $x -lt $right; $x++) {
        if (Test-MomentsWechatGreenGlyphPixel (Get-MomentsPixel $frame $x $y)) {
          $rowGreen = $true
          break
        }
      }
      if ($rowGreen) { [void]$greenRows.Add($y) }
    }
    if ($greenRows.Count -gt 0) {
      $greenGroups = New-Object System.Collections.Generic.List[object]
      $maximumGreenRowGap = [Math]::Max(1, [Math]::Round(2.0 * $scale))
      [int]$greenGroupStart = $greenRows[0]
      [int]$previousGreenRow = $greenRows[0]
      for ($index = 1; $index -lt $greenRows.Count; $index++) {
        [int]$currentGreenRow = $greenRows[$index]
        if (($currentGreenRow - $previousGreenRow) -gt $maximumGreenRowGap) {
          [void]$greenGroups.Add(@{ top = $greenGroupStart; bottom = $previousGreenRow + 1 })
          $greenGroupStart = $currentGreenRow
        }
        $previousGreenRow = $currentGreenRow
      }
      [void]$greenGroups.Add(@{ top = $greenGroupStart; bottom = $previousGreenRow + 1 })

      foreach ($greenGroup in $greenGroups) {
        [int]$greenTop = [int]$greenGroup.top
        [int]$greenBottom = [int]$greenGroup.bottom
        $candidate = Get-MomentsDiscoverShapeEvidence $frame $left $greenTop $right $greenBottom $scale $backgroundEvidence
        if ($candidate -eq $null) { continue }
        $candidate["source"] = "selected_green_recovery"
        $candidate["matched"] = [bool](Test-MomentsSelectedDiscoverRecoveryMatch $candidate $scale)
        [void]$candidateDiagnostics.Add($candidate)
        if ([bool]$candidate.matched -and [bool]$candidate.selected) {
          [void]$entries.Add($candidate)
        }
      }
    }
  }
  $matchedEntries = @($entries.ToArray())
  $selectedEntries = @($matchedEntries | Where-Object { [bool]$_.selected })
  return @{
    ok = $true
    region = $region
    exactMatchCount = $matchedEntries.Count
    selectedMatchCount = $selectedEntries.Count
    entries = $matchedEntries
    candidateCount = $candidateDiagnostics.Count
    candidateDiagnostics = @($candidateDiagnostics.ToArray())
    activePixelCount = $totalActivePixelCount
  }
}

function Test-MomentsSelectedGreenComponents([int]$red, [int]$green, [int]$blue) {
  return $green -ge 105 -and ($green - $red) -ge 30 -and ($green - $blue) -ge 12
}

function Test-MomentsSelectedGreenPixel($pixel) {
  return $pixel -ne $null -and
    (Test-MomentsSelectedGreenComponents ([int]$pixel.r) ([int]$pixel.g) ([int]$pixel.b))
}

function Test-MomentsSelectedGreenFramePixel($frame, [int]$x, [int]$y) {
  if ($frame -eq $null -or $x -lt 0 -or $y -lt 0 -or
    $x -ge [int]$frame.width -or $y -ge [int]$frame.height) { return $false }
  [int]$offset = ($y * [int]$frame.stride) + ($x * 4)
  return (Test-MomentsSelectedGreenComponents ([int]$frame.bytes[$offset + 2]) ([int]$frame.bytes[$offset + 1]) ([int]$frame.bytes[$offset]))
}

function Get-MomentsSelectedGreenRatio($frame, $rect) {
  [int]$left = [Math]::Max(0, [Math]::Floor([double]$rect.left))
  [int]$top = [Math]::Max(0, [Math]::Floor([double]$rect.top))
  [int]$right = [Math]::Min([int]$frame.width, [Math]::Ceiling([double]$rect.left + [double]$rect.width))
  [int]$bottom = [Math]::Min([int]$frame.height, [Math]::Ceiling([double]$rect.top + [double]$rect.height))
  if ($right -le $left -or $bottom -le $top) { return 0.0 }
  $selected = 0
  $total = 0
  for ($y = $top; $y -lt $bottom; $y += 2) {
    for ($x = $left; $x -lt $right; $x += 2) {
      $pixel = Get-MomentsPixel $frame $x $y
      if (Test-MomentsSelectedGreenPixel $pixel) {
        $selected += 1
      }
      $total += 1
    }
  }
  if ($total -eq 0) { return 0.0 }
  return [double]$selected / [double]$total
}

function Get-MomentsSelectedGreenRunEvidence($frame, $textBounds, $bandBounds, $relativeSurfaceBounds, [double]$scale) {
  [int]$scanLeft = [Math]::Max(0, [Math]::Floor([double]$relativeSurfaceBounds.left))
  [int]$scanRight = [Math]::Min(
    [int]$frame.width - 1,
    [Math]::Ceiling([double]$relativeSurfaceBounds.left + [double]$relativeSurfaceBounds.width) - 1
  )
  [int]$scanTop = [Math]::Max(0, [Math]::Floor([double]$bandBounds.top))
  [int]$scanBottom = [Math]::Min(
    [int]$frame.height - 1,
    [Math]::Ceiling([double]$bandBounds.top + [double]$bandBounds.height) - 1
  )
  if ($scanRight -le $scanLeft -or $scanBottom -le $scanTop) {
    return @{ ok = $false; reason = "moments_integrated_content_boundary_not_proven"; runs = @() }
  }

  [double]$minimumColumnRatio = 0.45
  [int]$maximumGap = [Math]::Max(4, [Math]::Round(8.0 * $scale))
  [double]$minimumRunWidth = [Math]::Max(120.0 * $scale, [double]$textBounds.width + (32.0 * $scale))
  $runs = New-Object System.Collections.Generic.List[object]
  [int]$runLeft = -1
  [int]$lastGreen = -1
  for ($x = $scanLeft; $x -le $scanRight; $x++) {
    $green = 0
    $total = 0
    for ($y = $scanTop; $y -le $scanBottom; $y += 2) {
      if (Test-MomentsSelectedGreenPixel (Get-MomentsPixel $frame $x $y)) { $green += 1 }
      $total += 1
    }
    $isGreenColumn = $total -gt 0 -and ([double]$green / [double]$total) -ge $minimumColumnRatio
    if (-not $isGreenColumn) { continue }
    if ($runLeft -lt 0) {
      $runLeft = $x
    } elseif (($x - $lastGreen - 1) -gt $maximumGap) {
      [void]$runs.Add(@{ left = [double]$runLeft; right = [double]$lastGreen; width = [double]($lastGreen - $runLeft + 1) })
      $runLeft = $x
    }
    $lastGreen = $x
  }
  if ($runLeft -ge 0) {
    [void]$runs.Add(@{ left = [double]$runLeft; right = [double]$lastGreen; width = [double]($lastGreen - $runLeft + 1) })
  }

  [double]$textCenterX = [double]$textBounds.left + ([double]$textBounds.width / 2.0)
  $wideRuns = @($runs.ToArray() | Where-Object { [double]$_.width -ge $minimumRunWidth })
  $matches = @($wideRuns | Where-Object {
    [double]$_.left -le $textCenterX -and [double]$_.right -ge $textCenterX
  })
  if ($wideRuns.Count -ne 1 -or $matches.Count -ne 1) {
    return @{
      ok = $false
      reason = "moments_integrated_content_boundary_not_proven"
      runs = @($runs.ToArray())
      wideRunCount = $wideRuns.Count
      candidateCount = $matches.Count
    }
  }
  $run = $matches[0]
  [double]$contentLeft = [double]$run.right + 1.0
  [double]$surfaceRight = [double]$relativeSurfaceBounds.left + [double]$relativeSurfaceBounds.width
  if ($contentLeft -le ([double]$textBounds.left + [double]$textBounds.width) -or
    ($surfaceRight - $contentLeft) -lt (120.0 * $scale)) {
    return @{
      ok = $false
      reason = "moments_integrated_content_boundary_not_proven"
      runs = @($runs.ToArray())
      candidateCount = $matches.Count
    }
  }
  return @{
    ok = $true
    contentLeft = $contentLeft
    bounds = @{
      left = [double]$run.left
      top = [double]$scanTop
      width = [double]$run.width
      height = [double]($scanBottom - $scanTop + 1)
    }
  }
}

function Get-MomentsStructuralSelectedBandEvidence($frame, $region, $relativeSurfaceBounds, [double]$scale) {
  if ($frame -eq $null -or $frame.bytes -eq $null -or [int]$frame.stride -le 0) {
    return @{ entries = @(); selectedRowCount = 0; groups = @(); rejectedRunCount = 0; rejectedBoundaryCount = 0; boundaryDiagnostics = @() }
  }
  [int]$left = [Math]::Max(0, [Math]::Floor([double]$region.left))
  [int]$top = [Math]::Max(0, [Math]::Floor([double]$region.top))
  [int]$right = [Math]::Min([int]$frame.width - 1, [Math]::Ceiling([double]$region.left + [double]$region.width) - 1)
  [int]$bottom = [Math]::Min([int]$frame.height - 1, [Math]::Ceiling([double]$region.top + [double]$region.height) - 1)
  if ($right -le $left -or $bottom -le $top) {
    return @{ entries = @(); selectedRowCount = 0; groups = @(); rejectedRunCount = 0; rejectedBoundaryCount = 0 }
  }

  $selectedRows = New-Object System.Collections.Generic.List[int]
  for ($y = $top; $y -le $bottom; $y++) {
    $green = 0
    $total = 0
    for ($x = $left; $x -le $right; $x += 4) {
      [int]$offset = ($y * [int]$frame.stride) + ($x * 4)
      [int]$blue = [int]$frame.bytes[$offset]
      [int]$greenChannel = [int]$frame.bytes[$offset + 1]
      [int]$red = [int]$frame.bytes[$offset + 2]
      if ($greenChannel -ge 105 -and ($greenChannel - $red) -ge 30 -and ($greenChannel - $blue) -ge 12) {
        $green += 1
      }
      $total += 1
    }
    if ($total -gt 0 -and ([double]$green / [double]$total) -ge 0.55) {
      [void]$selectedRows.Add($y)
    }
  }
  if ($selectedRows.Count -eq 0) {
    return @{ entries = @(); selectedRowCount = 0; groups = @(); rejectedRunCount = 0; rejectedBoundaryCount = 0 }
  }

  $groups = New-Object System.Collections.Generic.List[object]
  [int]$groupTop = $selectedRows[0]
  [int]$previousRow = $selectedRows[0]
  # White label text and the Moments glyph split a solid selected row into
  # upper/lower green projections. Merge only gaps that can fit inside one
  # DPI-scaled navigation row; the final height and boundary checks still
  # reject separate selected surfaces.
  [int]$maximumRowGap = [Math]::Max(2, [Math]::Round(20.0 * $scale))
  for ($index = 1; $index -lt $selectedRows.Count; $index++) {
    [int]$currentRow = $selectedRows[$index]
    if (($currentRow - $previousRow) -gt $maximumRowGap) {
      [void]$groups.Add(@{ top = $groupTop; bottom = $previousRow })
      $groupTop = $currentRow
    }
    $previousRow = $currentRow
  }
  [void]$groups.Add(@{ top = $groupTop; bottom = $previousRow })

  $entries = New-Object System.Collections.Generic.List[object]
  $groupDiagnostics = New-Object System.Collections.Generic.List[object]
  $boundaryDiagnostics = New-Object System.Collections.Generic.List[object]
  $rejectedRunCount = 0
  $rejectedBoundaryCount = 0
  [double]$minimumHeight = 28.0 * $scale
  [double]$maximumHeight = 72.0 * $scale
  foreach ($group in $groups) {
    [double]$height = [double]$group.bottom - [double]$group.top + 1.0
    [void]$groupDiagnostics.Add(@{ top = [double]$group.top; bottom = [double]$group.bottom; height = $height })
    if ($height -lt $minimumHeight -or $height -gt $maximumHeight) { continue }
    $bandBounds = @{
      left = [double]$region.left
      top = [double]$group.top
      width = [double]$region.width
      height = $height
    }
    $syntheticTextBounds = @{
      left = [double]$region.left + (40.0 * $scale)
      top = [double]$group.top
      width = 80.0 * $scale
      height = $height
    }
    $greenRun = Get-MomentsSelectedGreenRunEvidence $frame $syntheticTextBounds $bandBounds $relativeSurfaceBounds $scale
    if (-not $greenRun.ok) { $rejectedRunCount += 1; continue }
    [double]$runLeft = [double]$greenRun.bounds.left
    [double]$contentLeft = [double]$greenRun.contentLeft
    [void]$boundaryDiagnostics.Add(@{
      runLeft = $runLeft
      contentLeft = $contentLeft
    })
    if ($runLeft -gt ([double]$region.left + (24.0 * $scale))) { $rejectedBoundaryCount += 1; continue }
    [void]$entries.Add(@{
      textBounds = $syntheticTextBounds
      bandBounds = $bandBounds
      greenRatio = Get-MomentsSelectedGreenRatio $frame $bandBounds
      selected = $true
      contentBoundaryProven = $true
      contentLeft = $contentLeft
      selectedGreenRunBounds = $greenRun.bounds
      ocrMode = "structural"
    })
  }
  return @{
    entries = @($entries.ToArray())
    selectedRowCount = [int]$selectedRows.Count
    groups = @($groupDiagnostics.ToArray())
    rejectedRunCount = [int]$rejectedRunCount
    rejectedBoundaryCount = [int]$rejectedBoundaryCount
    boundaryDiagnostics = @($boundaryDiagnostics.ToArray())
  }
}

function Get-MomentsVisualViewportBounds($renderPaneBounds, $surfaceProof, [string]$surfaceMode) {
  if ($renderPaneBounds -eq $null -or [double]$renderPaneBounds.width -le 0 -or [double]$renderPaneBounds.height -le 0) {
    return @{ ok = $false; reason = "moments_render_pane_bounds_invalid" }
  }
  if ($surfaceMode -ceq "standalone") {
    return @{
      ok = $true
      bounds = @{
        left = [double]$renderPaneBounds.left
        top = [double]$renderPaneBounds.top
        width = [double]$renderPaneBounds.width
        height = [double]$renderPaneBounds.height
      }
    }
  }
  if ($surfaceMode -cne "integrated" -or $surfaceProof -eq $null -or -not [bool]$surfaceProof.ok -or
    $null -eq $surfaceProof.contentLeft) {
    return @{ ok = $false; reason = "moments_integrated_content_boundary_not_proven" }
  }
  [double]$paneLeft = [double]$renderPaneBounds.left
  [double]$paneRight = $paneLeft + [double]$renderPaneBounds.width
  [double]$contentLeft = [double]$surfaceProof.contentLeft
  if ([double]::IsNaN($contentLeft) -or [double]::IsInfinity($contentLeft)) {
    return @{ ok = $false; reason = "moments_integrated_content_boundary_not_proven" }
  }
  if ($contentLeft -lt $paneLeft -or $contentLeft -ge $paneRight) {
    return @{ ok = $false; reason = "moments_integrated_content_boundary_not_proven" }
  }
  [double]$visualLeft = $contentLeft
  return @{
    ok = $true
    contentLeft = $contentLeft
    bounds = @{
      left = $visualLeft
      top = [double]$renderPaneBounds.top
      width = $paneRight - $visualLeft
      height = [double]$renderPaneBounds.height
    }
  }
}

function Get-IntegratedMomentsEntryEvidence($frame, $relativeSurfaceBounds, [double]$scale) {
  $primaryRailWidth = 60.0 * $scale
  $sidebarWidth = [Math]::Min(
    [double]$relativeSurfaceBounds.width,
    [Math]::Max(180.0, [Math]::Round([double]$relativeSurfaceBounds.width * ${MOMENTS_SURFACE_PROFILE.integratedSidebarWidthRatio.toFixed(2)}))
  )
  $scanHeight = [Math]::Min(
    [double]$relativeSurfaceBounds.height,
    [Math]::Max(180.0, [Math]::Round(${MOMENTS_SURFACE_PROFILE.integratedSidebarScanLogicalHeight.toFixed(1)} * $scale))
  )
  $region = @{
    left = [double]$relativeSurfaceBounds.left + $primaryRailWidth
    top = [double]$relativeSurfaceBounds.top
    width = [Math]::Max(0.0, $sidebarWidth - $primaryRailWidth)
    height = $scanHeight
  }
  $structuralEvidence = Get-MomentsStructuralSelectedBandEvidence $frame $region $relativeSurfaceBounds $scale
  if (@($structuralEvidence.entries).Count -gt 0) {
    return @{
      ok = $true
      region = $region
      exactMatchCount = @($structuralEvidence.entries).Count
      entries = @($structuralEvidence.entries)
      observedLabels = @()
      structuralDiagnostics = @{
        selectedRowCount = [int]$structuralEvidence.selectedRowCount
        groups = @($structuralEvidence.groups)
        rejectedRunCount = [int]$structuralEvidence.rejectedRunCount
        rejectedBoundaryCount = [int]$structuralEvidence.rejectedBoundaryCount
        boundaryDiagnostics = @($structuralEvidence.boundaryDiagnostics)
      }
    }
  }
  $ocr = Get-MomentsOcrObservation $frame $region
  if (-not $ocr.ok) { return @{ ok = $false; reason = [string]$ocr.reason; entries = @() } }
  $observedLabels = @($ocr.lines | ForEach-Object {
    [Text.RegularExpressions.Regex]::Replace(([string]$_.compact).Normalize([Text.NormalizationForm]::FormKC), "\s+", "")
  })
  $exactMatches = @($ocr.lines | Where-Object {
    $normalized = [Text.RegularExpressions.Regex]::Replace(([string]$_.compact).Normalize([Text.NormalizationForm]::FormKC), "\s+", "")
    $normalized -ceq "朋友圈" -or ($normalized.Length -le 8 -and $normalized.Contains("朋友圈"))
  })
  $ocrMode = "native"
  if ($exactMatches.Count -eq 0) {
    $scaledOcr = Get-MomentsScaledOcrObservation $frame $region
    if ($scaledOcr.ok) {
      $scaledObservedLabels = @($scaledOcr.lines | ForEach-Object {
        [Text.RegularExpressions.Regex]::Replace(([string]$_.compact).Normalize([Text.NormalizationForm]::FormKC), "\s+", "")
      })
      $observedLabels = @($observedLabels + $scaledObservedLabels)
      $scaledMatches = @($scaledOcr.lines | Where-Object {
        $normalized = [Text.RegularExpressions.Regex]::Replace(([string]$_.compact).Normalize([Text.NormalizationForm]::FormKC), "\s+", "")
        $normalized -ceq "朋友圈" -or ($normalized.Length -le 8 -and $normalized.Contains("朋友圈"))
      })
      if ($scaledMatches.Count -gt 0) {
        $exactMatches = $scaledMatches
        $ocrMode = "scaled"
      }
    }
  }
  $entries = New-Object System.Collections.Generic.List[object]
  foreach ($match in $exactMatches) {
    $textBounds = @{
      left = [double]$region.left + [double]$match.bounds.left
      top = [double]$region.top + [double]$match.bounds.top
      width = [double]$match.bounds.width
      height = [double]$match.bounds.height
    }
    $band = @{
      left = [double]$textBounds.left - (24.0 * $scale)
      top = [double]$textBounds.top - (12.0 * $scale)
      width = [double]$match.bounds.width + (108.0 * $scale)
      height = [double]$match.bounds.height + (24.0 * $scale)
    }
    $greenRatio = Get-MomentsSelectedGreenRatio $frame $band
    $greenRun = Get-MomentsSelectedGreenRunEvidence $frame $textBounds $band $relativeSurfaceBounds $scale
    [void]$entries.Add(@{
      textBounds = $textBounds
      bandBounds = $band
      greenRatio = $greenRatio
      selected = $greenRatio -ge 0.42
      contentBoundaryProven = [bool]$greenRun.ok
      contentLeft = $(if ($greenRun.ok) { [double]$greenRun.contentLeft } else { $null })
      selectedGreenRunBounds = $(if ($greenRun.ok) { $greenRun.bounds } else { $null })
      ocrMode = $ocrMode
    })
  }
  return @{
    ok = $true
    region = $region
    exactMatchCount = $entries.Count
    entries = @($entries.ToArray())
    observedLabels = @($observedLabels | Select-Object -First 12)
    structuralDiagnostics = @{
      selectedRowCount = [int]$structuralEvidence.selectedRowCount
      groups = @($structuralEvidence.groups)
      rejectedRunCount = [int]$structuralEvidence.rejectedRunCount
      rejectedBoundaryCount = [int]$structuralEvidence.rejectedBoundaryCount
      boundaryDiagnostics = @($structuralEvidence.boundaryDiagnostics)
    }
  }
}

function Test-IntegratedMomentsSurface($frame, $relativeSurfaceBounds, [double]$scale) {
  $evidence = Get-IntegratedMomentsEntryEvidence $frame $relativeSurfaceBounds $scale
  if (-not $evidence.ok) { return $evidence }
  $selectedMatches = @($evidence.entries | Where-Object { [bool]$_.selected })
  if ([int]$evidence.exactMatchCount -ne 1 -or $selectedMatches.Count -ne 1) {
    return @{
      ok = $false
      reason = "moments_integrated_surface_not_proven"
      exactMatchCount = [int]$evidence.exactMatchCount
      selectedMatchCount = $selectedMatches.Count
      structuralDiagnostics = $evidence.structuralDiagnostics
    }
  }
  if (-not [bool]$selectedMatches[0].contentBoundaryProven -or $null -eq $selectedMatches[0].contentLeft) {
    return @{
      ok = $false
      reason = "moments_integrated_surface_not_proven"
      boundaryReason = "moments_integrated_content_boundary_not_proven"
    }
  }
  return @{
    ok = $true
    mode = "integrated_selected_moments"
    greenRatio = [double]$selectedMatches[0].greenRatio
    contentLeft = [double]$selectedMatches[0].contentLeft
    selectedGreenRunBounds = $selectedMatches[0].selectedGreenRunBounds
  }
}
`;

module.exports = { MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL };
