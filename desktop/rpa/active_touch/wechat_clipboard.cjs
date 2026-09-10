// Materialize clipboard data before replacing it: GetDataObject alone can keep
// a lazy reference to the clipboard owner which becomes invalid after a write.
const WECHAT_CLIPBOARD_POWERSHELL = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public static class WechatClipboardVersion {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@
function Copy-WechatClipboardData([System.Windows.Forms.IDataObject]$source) {
  if ($null -eq $source) { return $null }
  $snapshot = New-Object System.Windows.Forms.DataObject
  foreach ($format in $source.GetFormats($false)) {
    $value = $source.GetData($format, $false)
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
