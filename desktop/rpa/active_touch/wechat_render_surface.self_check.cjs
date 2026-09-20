const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WECHAT_RENDER_SURFACE_POWERSHELL } = require("./wechat_render_surface.cjs");

// Exercise the actual UIA/Win32 boundary on disposable off-screen windows.
// This never opens or operates WeChat, reads a contact, or sends anything.
if (process.platform === "win32") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-surface-"));
  try {
    const file = path.join(dir, "check.ps1");
    fs.writeFileSync(file, WECHAT_RENDER_SURFACE_POWERSHELL + String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
public class SurfaceCheckForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}
"@
$form = New-Object SurfaceCheckForm
$form.Text = "Surface validation"
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point -15000,-15000
$form.Size = New-Object System.Drawing.Size 700,600
$form.ShowInTaskbar = $false
try {
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($form.Handle)
  $empty = Get-MomentsRenderPaneEvidence $root $PID
  if (-not $empty.ok -or $empty.pane.controlType -cne "Win32.Client") { throw ("empty_tree_failed:" + ($empty | ConvertTo-Json -Depth 5 -Compress)) }
  $wrongPid = Get-MomentsRenderPaneEvidence $root ($PID + 1)
  if ($wrongPid.ok) { throw "wrong_pid_accepted" }
  $panel = New-Object System.Windows.Forms.Panel
  $panel.AccessibleName = "MMUIRenderSubWindowHW"
  $panel.Text = "MMUIRenderSubWindowHW"
  $panel.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Pane
  $panel.Size = New-Object System.Drawing.Size 500,400
  $form.Controls.Add($panel)
  [System.Windows.Forms.Application]::DoEvents()
  $legacy = Get-MomentsRenderPaneEvidence $root $PID
  if (-not $legacy.ok -or $legacy.pane.controlType -cne "ControlType.Pane") { throw ("legacy_failed:" + ($legacy | ConvertTo-Json -Depth 5 -Compress)) }
  $panel.AccessibleName = "Other panel"
  $panel.Text = "Other panel"
  [System.Windows.Forms.Application]::DoEvents()
  $partial = Get-MomentsRenderPaneEvidence $root $PID
  if ($partial.ok) { throw "partial_tree_was_downgraded" }
  @{ empty_tree=$empty.pane.controlType; legacy=$legacy.pane.controlType; wrong_pid_rejected=(-not $wrongPid.ok); partial_tree_rejected=(-not $partial.ok) } | ConvertTo-Json -Compress
} finally { $form.Close(); $form.Dispose() }
`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
      encoding: "utf8", windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.empty_tree, "Win32.Client");
    assert.equal(evidence.legacy, "ControlType.Pane");
    assert.equal(evidence.wrong_pid_rejected, true);
    assert.equal(evidence.partial_tree_rejected, true);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
