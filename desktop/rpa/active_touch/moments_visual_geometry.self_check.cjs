const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");

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

@{
  legacy = Invoke-FixtureCase 700 400 @{ left = 311.0; top = 0.0; width = 389.0; height = 400.0 } 332 80 35 655 220
  textEllipsis = Invoke-TextEllipsisCase
  wideCentered = Invoke-FixtureCase 1400 950 @{ left = 384.0; top = 0.0; width = 1008.0; height = 941.0 } 620 100 52 1080 420
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
  timeout: 30_000,
});

assert.equal(result.status, 0, result.stderr || result.error?.stack || "geometry harness must run");
assert.deepEqual(JSON.parse(result.stdout.trim()), {
  legacy: {
    avatarAligned: true,
    menuCount: 1,
    menuAligned: true,
    postCount: 1,
    providedAvatarCount: 1,
    readingPostCount: 1,
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
