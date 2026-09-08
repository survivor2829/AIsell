const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT } = require("./moments_visual_dry_run.dev.cjs");
const stableFunctions = MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.slice(
  MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.indexOf("function Test-VisualBoundsInside"),
  MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.indexOf("function Get-LocalStableInteractionRead")
);
const readingSelection = MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.slice(
  MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.indexOf("$stableReading = @()"),
  MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.indexOf("$observedCandidateCount =")
);

const program = `${MOMENTS_VISUAL_READONLY_POWERSHELL}
function New-FixtureFrame([int]$width, [int]$height) {
  $bytes = New-Object byte[] ($width * $height * 4)
  for ($offset = 0; $offset -lt $bytes.Length; $offset += 4) {
    $bytes[$offset] = 240
    $bytes[$offset + 1] = 240
    $bytes[$offset + 2] = 240
    $bytes[$offset + 3] = 255
  }
  return @{ width = $width; height = $height; stride = $width * 4; bytes = $bytes }
}

function Set-FixtureRect($frame, [int]$left, [int]$top, [int]$right, [int]$bottom, [byte]$value) {
  for ($y = $top; $y -le $bottom; $y++) {
    for ($x = $left; $x -le $right; $x++) {
      $offset = ($y * $frame.stride) + ($x * 4)
      $frame.bytes[$offset] = $value
      $frame.bytes[$offset + 1] = $value
      $frame.bytes[$offset + 2] = $value
      $frame.bytes[$offset + 3] = 255
    }
  }
}

function Set-FixtureAvatar($frame, [int]$left, [int]$top, [int]$size) {
  for ($localY = 0; $localY -lt $size; $localY += 4) {
    for ($localX = 0; $localX -lt $size; $localX += 4) {
      if ((([int]($localX / 4) + [int]($localY / 4)) % 3) -eq 0) { continue }
      Set-FixtureRect $frame ($left + $localX) ($top + $localY) ([Math]::Min($left + $size - 1, $left + $localX + 3)) ([Math]::Min($top + $size - 1, $top + $localY + 3)) 55
    }
  }
}

function Set-FixtureMenu($frame, [int]$left, [int]$top) {
  Set-FixtureRect $frame $left $top ($left + 3) ($top + 3) 80
  Set-FixtureRect $frame ($left + 9) $top ($left + 12) ($top + 3) 80
}

function Set-FixtureTextEllipsis($frame, [int]$left, [int]$top) {
  foreach ($offset in @(0, 5, 10)) {
    Set-FixtureRect $frame ($left + $offset) $top ($left + $offset + 1) ($top + 1) 80
  }
}

function Get-MomentsOcrObservation($frame, $rect) {
  return @{
    ok = $true
    text = "author stable moments body content"
    layoutHash = ("a" * 64)
    lines = @(
      @{ compact = "author stable"; bounds = @{ left = 55.0; top = 8.0; width = 100.0; height = 12.0 } },
      @{ compact = "moments body content"; bounds = @{ left = 55.0; top = 25.0; width = 180.0; height = 14.0 } }
    )
  }
}

function Invoke-FixtureCase(
  [int]$frameWidth,
  [int]$frameHeight,
  $viewport,
  [int]$avatarLeft,
  [int]$avatarTop,
  [int]$avatarSize,
  [int]$menuLeft,
  [int]$menuTop
) {
  $frame = New-FixtureFrame $frameWidth $frameHeight
  Set-FixtureAvatar $frame $avatarLeft $avatarTop $avatarSize
  Set-FixtureMenu $frame $menuLeft $menuTop
  $read = Get-MomentsVisualPostCandidates $frame $viewport
  $readingPosts = @(Get-MomentsVisualReadingCandidates $frame $viewport ($read.visibleAvatars))
  $posts = @($read.posts)
  $post = $(if ($posts.Count -eq 1) { $posts[0] } else { $null })
  return [pscustomobject]@{
    menuCount = @($read.menus).Count
    postCount = $posts.Count
    readingPostCount = $readingPosts.Count
    providedAvatarCount = @($read.visibleAvatars).Count
    avatarAligned = [bool]($post -and [Math]::Abs([double]$post.avatarBounds.left - $avatarLeft) -le ($avatarSize * 0.25))
    menuAligned = [bool]($post -and [Math]::Abs([double]$post.menuBounds.left - ($menuLeft - 12.0)) -le 4.0)
  }
}

function Invoke-TextEllipsisCase {
  $viewport = @{ left = 384.0; top = 0.0; width = 1008.0; height = 941.0 }
  $frame = New-FixtureFrame 1400 950
  Set-FixtureAvatar $frame 620 100 52
  Set-FixtureTextEllipsis $frame 1080 420
  $read = Get-MomentsVisualPostCandidates $frame $viewport
  return [pscustomobject]@{
    menuCount = @($read.menus).Count
    postCount = @($read.posts).Count
    readingPostCount = @(Get-MomentsVisualReadingCandidates $frame $viewport ($read.visibleAvatars)).Count
  }
}

function Invoke-LocalAnchorCase([bool]$occupyWhitespace) {
  $viewport = @{ left = 384.0; top = 0.0; width = 1008.0; height = 941.0 }
  $frame = New-FixtureFrame 1400 950
  $avatar = @{ left = 620.0; top = 100.0; width = 52.0; height = 52.0 }
  Set-FixtureAvatar $frame 620 100 52
  if ($occupyWhitespace) {
    Set-FixtureRect $frame 1167 345 1203 402 80
  }
  Set-FixtureMenu $frame 1179 420
  $avatarHash = Get-MomentsPixelHash $frame $avatar
  $resolved = Resolve-MomentsInteractionAnchor $frame $viewport @{ left = 1167.0; top = 408.0; width = 36.0; height = 24.0 } $avatar $avatarHash 12.0
  return [pscustomobject]@{
    ok = [bool]$resolved.ok
    reason = [string]$resolved.reason
    rawCandidateCount = [int]$resolved.diagnostics.rawCandidateCount
    acceptedCandidateCount = [int]$resolved.diagnostics.acceptedCandidateCount
  }
}

${stableFunctions}
function Invoke-TrailingBodyCase {
  $script:momentsVisualStabilityTolerancePx = 12
  $frame = New-FixtureFrame 700 400
  Set-FixtureAvatar $frame 332 220 35
  $firstFrame = $frame; $secondFrame = $frame
  $firstViewport = @{ bounds = @{ left = 311.0; top = 0.0; width = 389.0; height = 400.0 } }
  $secondViewport = $firstViewport
  $firstRead = @{
    menus = @(@{ centerY = 170.0 })
    visibleAvatars = @(
      @{left=332.0;top=220.0;width=35.0;height=35.0;score=0.9},
      @{left=380.0;top=220.0;width=35.0;height=35.0;score=0.4}
    )
  }
  $secondRead = $firstRead
  $stablePosts = @(@{contentText="";identityText="8 days ago"})
  $allowBodyOnly = $true
  ${readingSelection}
  return @{ fullPostCount = $stablePosts.Count; readingCount = $stableReading.Count; avatarLeft = $stableReading[0].avatarBounds.left }
}
@{
  trailingBody = Invoke-TrailingBodyCase
  localAnchor = Invoke-LocalAnchorCase $false
  occupiedLocalAnchor = Invoke-LocalAnchorCase $true
  legacy = Invoke-FixtureCase 700 400 @{ left = 311.0; top = 0.0; width = 389.0; height = 400.0 } 332 80 35 655 220
  textEllipsis = Invoke-TextEllipsisCase
  wideCentered = Invoke-FixtureCase 1400 950 @{ left = 384.0; top = 0.0; width = 1008.0; height = 941.0 } 620 100 52 1179 420
  centeredAvatarLeftOfEstimate = Invoke-FixtureCase 1381 940 @{ left = 374.0; top = 0.0; width = 1007.0; height = 940.0 } 554 136 52 1168 502
} | ConvertTo-Json -Depth 6 -Compress
`;

const result = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source",
], {
  input: Buffer.from(program, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  // Seven full-frame PowerShell fixtures are CPU-bound on hosted Windows runners.
  // Keep the geometry assertions identical and bound the complete harness run.
  timeout: 180_000,
});

assert.equal(result.status, 0, result.stderr || result.error?.stack || "geometry harness must run");
assert.deepEqual(JSON.parse(result.stdout.trim()), {
  trailingBody: { fullPostCount: 0, readingCount: 1, avatarLeft: 332 },
  centeredAvatarLeftOfEstimate: {
    avatarAligned: true,
    menuCount: 1,
    menuAligned: true,
    postCount: 1,
    providedAvatarCount: 1,
    readingPostCount: 1,
  },
  localAnchor: {
    acceptedCandidateCount: 1,
    ok: true,
    rawCandidateCount: 1,
    reason: "",
  },
  legacy: {
    avatarAligned: true,
    menuCount: 1,
    menuAligned: true,
    postCount: 1,
    providedAvatarCount: 1,
    readingPostCount: 1,
  },
  occupiedLocalAnchor: {
    acceptedCandidateCount: 0,
    ok: false,
    rawCandidateCount: 1,
    reason: "moments_menu_not_found",
  },
  textEllipsis: {
    menuCount: 0,
    postCount: 0,
    readingPostCount: 1,
  },
  wideCentered: {
    avatarAligned: true,
    menuCount: 1,
    menuAligned: true,
    postCount: 1,
    providedAvatarCount: 1,
    readingPostCount: 1,
  },
});

console.log("moments visual geometry self-check passed");
