// Materialize clipboard data before replacing it: GetDataObject alone can keep
// a lazy reference to the clipboard owner which becomes invalid after a write.
const WECHAT_CLIPBOARD_POWERSHELL = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class WechatClipboardVersion {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr GlobalSize(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
  [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref STGMEDIUM medium);

  // Registered formats are opaque bytes. WinForms may return null because it
  // cannot decode the owner's format; OLE can still supply its native HGLOBAL.
  // Never reinterpret bitmap/metafile/owner-display handles as memory blocks.
  public static MemoryStream CopyRawFormat(System.Windows.Forms.IDataObject source, string name) {
    int id = System.Windows.Forms.DataFormats.GetFormat(name).Id;
    var native = source as System.Runtime.InteropServices.ComTypes.IDataObject;
    if (id < 0xC000 || native == null) return null;
    var format = new FORMATETC { cfFormat = unchecked((short)id), dwAspect = DVASPECT.DVASPECT_CONTENT,
      lindex = -1, ptd = IntPtr.Zero, tymed = TYMED.TYMED_HGLOBAL };
    STGMEDIUM medium = new STGMEDIUM();
    try {
      native.GetData(ref format, out medium);
      if (medium.tymed != TYMED.TYMED_HGLOBAL || medium.unionmember == IntPtr.Zero) return null;
      ulong size = GlobalSize(medium.unionmember).ToUInt64();
      if (size == 0 || size > int.MaxValue) return null;
      IntPtr pointer = GlobalLock(medium.unionmember);
      if (pointer == IntPtr.Zero) return null;
      try {
        byte[] bytes = new byte[(int)size];
        Marshal.Copy(pointer, bytes, 0, bytes.Length);
        return new MemoryStream(bytes, false);
      } finally { GlobalUnlock(medium.unionmember); }
    } catch (COMException) { return null; }
      catch (NotSupportedException) { return null; }
    finally { if (medium.tymed != TYMED.TYMED_NULL) ReleaseStgMedium(ref medium); }
  }
}
"@
function Copy-WechatClipboardData([System.Windows.Forms.IDataObject]$source) {
  if ($null -eq $source) { return $null }
  $snapshot = New-Object System.Windows.Forms.DataObject
  foreach ($format in $source.GetFormats($false)) {
    try { $value = $source.GetData($format, $false) } catch { $value = $null }
    if ($null -eq $value -or ($value -isnot [System.IO.Stream] -and
        $value -isnot [System.Drawing.Image] -and $value -isnot [byte[]] -and
        $value -isnot [string[]] -and $value -isnot [System.Collections.Specialized.StringCollection] -and
        $value -isnot [string] -and -not $value.GetType().IsPrimitive)) {
      $value = [WechatClipboardVersion]::CopyRawFormat($source, $format)
    }
    if ($null -eq $value) { throw "wechat_clipboard_restore_unsupported" }
    if ($value -is [System.IO.Stream]) {
      if (-not $value.CanSeek) { throw "wechat_clipboard_restore_unsupported" }
      $position = $value.Position
      $copy = New-Object System.IO.MemoryStream
      try { $value.Position = 0; $value.CopyTo($copy); $copy.Position = 0 }
      finally { $value.Position = $position }
      $value = $copy
    } elseif ($value -is [System.Drawing.Image]) {
      $value = $value.Clone()
    } elseif ($value -is [byte[]] -or $value -is [string[]]) {
      $value = $value.Clone()
    } elseif ($value -is [System.Collections.Specialized.StringCollection]) {
      $copy = New-Object System.Collections.Specialized.StringCollection
      foreach ($item in $value) { [void]$copy.Add($item) }
      $value = $copy
    } elseif ($value -isnot [string] -and -not $value.GetType().IsPrimitive) {
      throw "wechat_clipboard_restore_unsupported"
    }
    $snapshot.SetData($format, $false, $value)
  }
  return $snapshot
}
function Get-WechatClipboardSnapshot {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      $version = [WechatClipboardVersion]::GetClipboardSequenceNumber()
      $snapshot = Copy-WechatClipboardData ([System.Windows.Forms.Clipboard]::GetDataObject())
      if ($version -ne [WechatClipboardVersion]::GetClipboardSequenceNumber()) { throw "wechat_clipboard_changed" }
      return $snapshot
    } catch {
      if ($_.Exception.Message -eq "wechat_clipboard_restore_unsupported") { throw }
      if ($attempt -eq 2) { throw "wechat_clipboard_read_failed" }
      Start-Sleep -Milliseconds 100
    }
  }
}
function Restore-WechatClipboardSnapshot([System.Windows.Forms.IDataObject]$snapshot) {
  if ($null -eq $snapshot -or $snapshot.GetFormats($false).Length -eq 0) {
    [System.Windows.Forms.Clipboard]::Clear()
  } else {
    [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true, 5, 100)
  }
}
`;

module.exports = { WECHAT_CLIPBOARD_POWERSHELL };
