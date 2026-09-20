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
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public class RawClipboardFixture : System.Windows.Forms.DataObject, System.Runtime.InteropServices.ComTypes.IDataObject {
  public bool Unavailable;
  public RawClipboardFixture() { SetData("FixtureRawBytes", false, new object()); }
  public override object GetData(string format, bool autoConvert) { return null; }
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
  public void GetData(ref FORMATETC format, out STGMEDIUM medium) {
    if (Unavailable) throw new COMException("Format cannot be materialized", unchecked((int)0x80040064));
    var handle = GlobalAlloc(0x42, (UIntPtr)2);
    var pointer = GlobalLock(handle);
    Marshal.Copy(new byte[] { 42, 7 }, 0, pointer, 2);
    GlobalUnlock(handle);
    medium = new STGMEDIUM { tymed = TYMED.TYMED_HGLOBAL, unionmember = handle, pUnkForRelease = null };
  }
  public int QueryGetData(ref FORMATETC f) { return 0; }
  public void GetDataHere(ref FORMATETC f, ref STGMEDIUM m) { throw new NotSupportedException(); }
  public int GetCanonicalFormatEtc(ref FORMATETC f, out FORMATETC o) { o=f; return 1; }
  public void SetData(ref FORMATETC f, ref STGMEDIUM m, bool release) { throw new NotSupportedException(); }
  public IEnumFORMATETC EnumFormatEtc(DATADIR d) { throw new NotSupportedException(); }
  public int DAdvise(ref FORMATETC f, ADVF a, IAdviseSink s, out int c) { c=0; return -1; }
  public void DUnadvise(int c) { }
  public int EnumDAdvise(out IEnumSTATDATA e) { e=null; return -1; }
}
"@
$rawSnapshot = Copy-WechatClipboardData (New-Object RawClipboardFixture)
$rawStream = $rawSnapshot.GetData("FixtureRawBytes", $false)
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
$unsupported = New-Object RawClipboardFixture
$unsupported.Unavailable = $true
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
  rawBytes=@($rawStream.ToArray())
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
assert.deepEqual(result.rawBytes, [42, 7], "Private clipboard formats must survive even when WinForms cannot decode them");
console.log("WeChat clipboard snapshot passed: text, image, files, detached stream, empty and unsupported data");
