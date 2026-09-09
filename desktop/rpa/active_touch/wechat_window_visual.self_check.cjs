const assert = require("node:assert/strict");
const path = require("node:path");
const { runPowerShell } = require("./wechat_window_driver.cjs");
const { WECHAT_MAIN_WINDOW_VISUAL_CSHARP } = require("./wechat_window_visual.cjs");

// Actual 4.1.13 navigation pixels; avatar, conversations and chat pane were
// removed from this fixture. Replay capture evidence, not generated mask art.
const result = runPowerShell(`
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${WECHAT_MAIN_WINDOW_VISUAL_CSHARP}
'@
$original = [Drawing.Bitmap]::FromFile($env:NAVIGATION_FIXTURE)
$results = @()
try {
  foreach ($dpi in @(96,120,144,192)) {
    $image = [Drawing.Bitmap]::new([int][Math]::Round($original.Width*$dpi/120),[int][Math]::Round($original.Height*$dpi/120))
    try {
      $g=[Drawing.Graphics]::FromImage($image)
      try { $g.DrawImage($original,0,0,$image.Width,$image.Height) } finally { $g.Dispose() }
      $scores=[WechatMainWindowVisual]::Inspect($image,$dpi)
      $results+=@{case="dpi_$dpi";accepted=[WechatMainWindowVisual]::Accepted($scores);scores=$scores}
    } finally {$image.Dispose()}
  }
  foreach($name in @('no_contacts','no_menu','no_sidebar')) {
    $image=[Drawing.Bitmap]$original.Clone()
    try {
      $g=[Drawing.Graphics]::FromImage($image)
      try {
        if($name -eq 'no_contacts') {$g.FillRectangle([Drawing.Brushes]::White,0,170,74,70)}
        elseif($name -eq 'no_menu') {$g.FillRectangle([Drawing.Brushes]::White,0,850,74,91)}
        else {$g.Clear([Drawing.Color]::White)}
      } finally {$g.Dispose()}
      $scores=[WechatMainWindowVisual]::Inspect($image,120)
      $results+=@{case=$name;accepted=[WechatMainWindowVisual]::Accepted($scores);scores=$scores}
    } finally {$image.Dispose()}
  }
  @{ok=$true;results=$results}|ConvertTo-Json -Depth 5 -Compress
} finally {$original.Dispose()}
`, { NAVIGATION_FIXTURE: path.join(__dirname, "fixtures/wechat-main-navigation-4.1.13.png") }, { ensure: false, timeout: 30_000 });
assert.equal(result.ok, true, JSON.stringify(result));
for (const entry of result.results) {
  assert.equal(entry.accepted, entry.case.startsWith("dpi_"), `${entry.case}: ${JSON.stringify(entry.scores)}`);
}
console.log("UIA-less WeChat main-window navigation image replay passed");
