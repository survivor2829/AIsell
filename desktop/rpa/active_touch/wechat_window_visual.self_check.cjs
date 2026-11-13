const assert = require("node:assert/strict");
const path = require("node:path");
const { runPowerShell } = require("./wechat_window_driver.cjs");
const { WECHAT_MAIN_WINDOW_VISUAL_CSHARP } = require("./wechat_window_visual.cjs");

// Actual navigation pixels (4.1.13, and 4.2.0.13 from a 125% field capture); avatar, conversations
// and chat pane were removed from the fixtures. Replay capture evidence, not generated mask art.
// `dpi` is the capture's own scale; the boxes blank out Contacts, the menu, or the whole strip. The 4.2
// mask was sampled from the 125% field capture; the 100% dev-machine capture (Windows 11 translucent
// sidebar) checks it independently: the 4.1 mask alone scores 0.753 there.
const FIXTURES = [
  { file: "wechat-main-navigation-4.1.13.png", dpi: 120, contacts: "0,170,74,70", menu: "0,850,74,91" },
  { file: "wechat-main-navigation-4.2.0.13.png", dpi: 120, contacts: "0,165,84,72", menu: "0,725,84,84" },
  { file: "wechat-main-navigation-4.2.0.13-100.png", dpi: 96, contacts: "0,132,68,56", menu: "0,690,68,60" }
];
for (const fixture of FIXTURES) {
const result = runPowerShell(`
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${WECHAT_MAIN_WINDOW_VISUAL_CSHARP}
'@
$original = [Drawing.Bitmap]::FromFile($env:NAVIGATION_FIXTURE)
$results = @()
try {
  foreach ($dpi in @(96,120,144,192)) {
    $image = [Drawing.Bitmap]::new([int][Math]::Round($original.Width*$dpi/[int]$env:SOURCE_DPI),[int][Math]::Round($original.Height*$dpi/[int]$env:SOURCE_DPI))
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
        if($name -eq 'no_contacts') {$c=$env:CONTACTS_BOX.Split(','); $g.FillRectangle([Drawing.Brushes]::White,[int]$c[0],[int]$c[1],[int]$c[2],[int]$c[3])}
        elseif($name -eq 'no_menu') {$m=$env:MENU_BOX.Split(','); $g.FillRectangle([Drawing.Brushes]::White,[int]$m[0],[int]$m[1],[int]$m[2],[int]$m[3])}
        else {$g.Clear([Drawing.Color]::White)}
      } finally {$g.Dispose()}
      $scores=[WechatMainWindowVisual]::Inspect($image,[int]$env:SOURCE_DPI)
      $results+=@{case=$name;accepted=[WechatMainWindowVisual]::Accepted($scores);scores=$scores}
    } finally {$image.Dispose()}
  }
  @{ok=$true;results=$results}|ConvertTo-Json -Depth 5 -Compress
} finally {$original.Dispose()}
`, { NAVIGATION_FIXTURE: path.join(__dirname, "fixtures", fixture.file), CONTACTS_BOX: fixture.contacts, MENU_BOX: fixture.menu, SOURCE_DPI: String(fixture.dpi) }, { ensure: false, timeout: 60_000 });
assert.equal(result.ok, true, JSON.stringify(result));
for (const entry of result.results) {
  assert.equal(entry.accepted, entry.case.startsWith("dpi_"), `${fixture.file} ${entry.case}: ${JSON.stringify(entry.scores)}`);
}
}
console.log("UIA-less WeChat main-window navigation image replay passed");
