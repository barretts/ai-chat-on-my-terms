param([Parameter(Mandatory = $true)][ValidateSet("probe", "close")][string]$Action)
# probe: print FOUND=1 when a visible Win32 common dialog (#32770, the class
# shared by the GetSaveFileNameW dialog rfd opens) belongs to locallab-desktop.
# close: WM_CLOSE those dialogs. Used by the desktop export smoke step.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32Dialogs {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$targetPids = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($proc in (Get-Process locallab-desktop -ErrorAction SilentlyContinue)) {
  [void]$targetPids.Add([uint32]$proc.Id)
}
$found = New-Object 'System.Collections.Generic.List[IntPtr]'
$callback = [Win32Dialogs+EnumProc] {
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ([Win32Dialogs]::IsWindowVisible($hWnd)) {
    $windowPid = 0
    [void][Win32Dialogs]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
    if ($targetPids.Contains($windowPid)) {
      $class = New-Object System.Text.StringBuilder 64
      [void][Win32Dialogs]::GetClassName($hWnd, $class, 64)
      if ($class.ToString() -eq "#32770") { $found.Add($hWnd) }
    }
  }
  return $true
}
[void][Win32Dialogs]::EnumWindows($callback, [IntPtr]::Zero)
if ($Action -eq "probe") { Write-Output ("FOUND=" + $found.Count) }
else {
  Write-Output ("FOUND=" + $found.Count)
  foreach ($hWnd in $found) {
    [void][Win32Dialogs]::SendMessage($hWnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
