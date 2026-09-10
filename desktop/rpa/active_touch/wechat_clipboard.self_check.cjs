const assert = require("node:assert/strict");
const { runPowerShell } = require("./wechat_window_driver.cjs");
const { WECHAT_CLIPBOARD_POWERSHELL } = require("./wechat_clipboard.cjs");

// Real WinForms data objects, but no access to the user's system clipboard.
const result = runPowerShell(`
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${WECHAT_CLIPBOARD_POWERSHELL}
$data = New-Object System.Windows.Forms.DataObject
$data.SetText("测试文字", [System.Windows.Forms.TextDataFormat]::UnicodeText)
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add('C:\\fixture\\photo.png')
$data.SetFileDropList($files)
$bitmap = New-Object System.Drawing.Bitmap 2, 2
$bitmap.SetPixel(0, 0, [System.Drawing.Color]::Red)
$data.SetImage($bitmap)
$stream = New-Object System.IO.MemoryStream
$stream.WriteByte(42); $stream.Position = 1
$data.SetData("CustomBytes", $false, $stream)
$snapshot = Copy-WechatClipboardData $data
$stream.Position = 0; $stream.WriteByte(99)
$bitmap.SetPixel(0, 0, [System.Drawing.Color]::Blue)
$files.Clear()
$copiedStream = $snapshot.GetData("CustomBytes", $false)
$unsupported = New-Object System.Windows.Forms.DataObject
$unsupported.SetData("Unsupported", $false, (New-Object System.Object))
$rejected = $false
try { Copy-WechatClipboardData $unsupported | Out-Null }
catch { $rejected = $_.Exception.Message -eq "wechat_clipboard_restore_unsupported" }
@{
  ok=$true
  text=$snapshot.GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
  fileCount=$snapshot.GetFileDropList().Count
  red=$snapshot.GetImage().GetPixel(0,0).R
  streamByte=$copiedStream.ReadByte()
  formatCount=$snapshot.GetFormats($false).Length
  sourceFormatCount=$data.GetFormats($false).Length
  empty=(Copy-WechatClipboardData $null) -eq $null
  unsupported=$rejected
} | ConvertTo-Json -Compress
`, {}, { ensure: false, timeout: 15000 });
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.text, "测试文字");
assert.equal(result.fileCount, 1);
assert.equal(result.red, 255);
assert.equal(result.streamByte, 42, "Snapshot must own stream bytes before clipboard replacement");
assert.equal(result.formatCount, result.sourceFormatCount);
assert.equal(result.empty, true);
assert.equal(result.unsupported, true);
console.log("WeChat clipboard snapshot passed: text, image, files, detached stream, empty and unsupported data");
