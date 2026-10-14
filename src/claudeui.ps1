# Theseus helper: drives the Claude desktop window through Windows UI Automation + user32.
# Reads one JSON command per stdin line, writes one JSON reply per line:
#   {"cmd":"snap"}                         -> title, project, mode, sidebar open, nav / routines / pinned names, window rect
#   {"cmd":"invoke","name":"Artifacts"}    -> presses that button (opens the sidebar for a moment when the item lives there)
#   {"cmd":"place","x":..,"y":..,"w":..,"h":..}  -> remembers the window rect once, moves it there, topmost + foreground
#   {"cmd":"restore"}                      -> puts the window back (rect, maximized, not topmost)
#   {"cmd":"sidebar","open":false}         -> shows / hides Claude's sidebar
#   {"cmd":"fg"}                           -> {"claude":bool} whether the Claude window is in front
#   {"cmd":"covered","x":..,"y":..,"pid":..}   -> is another app's window over this screen point
#   {"cmd":"coveredPts","pts":[{x,y}..],"pid":..} -> {"all":bool,"n":count}: every point covered
#   {"cmd":"bottom","hwnd":..}             -> window to the bottom of the z-order (no activation)
#   {"cmd":"under","hwnd":..,"after":..}   -> window just under another one (no activation)
#   {"cmd":"send","title":..,"link":..,"text":..} -> types into that session's reply box and presses Send ("stop":true presses Stop)
#   {"cmd":"hide"}                         -> hides the Claude window (as closing it to the tray does)
#   {"cmd":"ping"}                         -> {"ok":true}
# Every command may carry "id"; the reply repeats it. -Lite: no UI Automation (the z-order helper starts faster).
param([switch]$Lite)
try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
$def = @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool on);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);
[DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WP p);
[DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
// the page's file picker: a visible "#32770" window whose root owner is the Claude window (it sits on a hidden owner dialog)
public static IntPtr FileDialog(IntPtr main) {
  IntPtr r = IntPtr.Zero;
  EnumWindows((h, l) => {
    if (!IsWindowVisible(h) || GetAncestor(h, 3) != main) return true;
    var sb = new System.Text.StringBuilder(16); GetClassName(h, sb, 16);
    if (sb.ToString() == "#32770") { r = h; return false; }
    return true;
  }, IntPtr.Zero);
  return r;
}
public delegate bool EnumProc(IntPtr h, IntPtr l);
public struct PT { public int X, Y; }
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
public struct RECT { public int L, T, R, B; }
public struct WP { public int length, flags, showCmd, minX, minY, maxX, maxY; public RECT normal; }
// the Claude main window: biggest visible titled Chromium top-level window of its processes (several hidden helper windows
// are also titled "Claude"); once found it stays cached, so it is still found after being closed to the tray
public static IntPtr FindMain(int[] pids) { IntPtr h = FindMain(pids, true); return h != IntPtr.Zero ? h : FindMain(pids, false); }
// visible only first; a window closed to the tray (hidden) is found by the second pass
public static IntPtr FindMain(int[] pids, bool vis) {
  IntPtr best = IntPtr.Zero; long area = -1;
  EnumWindows((h, l) => {
    uint pid; GetWindowThreadProcessId2(h, out pid);
    if (Array.IndexOf(pids, (int)pid) < 0 || GetWindowTextLength(h) == 0 || (vis && !IsWindowVisible(h))) return true;
    var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64);
    if (sb.ToString() != "Chrome_WidgetWin_1") return true;
    if ((GetWindowLong(h, -20) & 0x08000020) != 0) return true;   // click-through or no-activate: an overlay (the screen-wide computer-use one), never the main window
    WP p = new WP(); p.length = System.Runtime.InteropServices.Marshal.SizeOf(typeof(WP)); GetWindowPlacement(h, ref p);
    long a = (long)(p.normal.R - p.normal.L) * (p.normal.B - p.normal.T);
    if (a > area) { area = a; best = h; }
    return true;
  }, IntPtr.Zero);
  return best;
}
[DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint GetWindowThreadProcessId2(IntPtr h, out uint pid);
'@
# compiled once into %TEMP%\Theseus (keyed by the source), later starts only load the DLL; a unique temp name per
# process + a move keeps two helpers starting together from clobbering each other
$loaded = $false
try {
  $key = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($def))).Replace('-', '').Substring(0, 12)
  $dir = Join-Path $env:TEMP 'Theseus'; $dll = Join-Path $dir "claudeui_$key.dll"
  if (-not (Test-Path $dll)) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    $tmp = Join-Path $dir "claudeui_$key.$PID.tmp"
    Add-Type -Namespace W -Name U -MemberDefinition $def -OutputAssembly $tmp -OutputType Library
    try { Move-Item $tmp $dll -ErrorAction Stop } catch { Remove-Item $tmp -ErrorAction SilentlyContinue }
    Get-ChildItem $dir -Filter 'claudeui_*.dll' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "claudeui_$key.dll" } | ForEach-Object { Remove-Item $_.FullName -ErrorAction SilentlyContinue }
  }
  Add-Type -Path $dll; $loaded = $true
} catch {}
if (-not $loaded) { Add-Type -Namespace W -Name U -MemberDefinition $def }
# physical pixels (as Electron's dipToScreen* gives): the cover check and the card placement are right at 125%+ scaling
try { if (-not [W.U]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][W.U]::SetProcessDPIAware() } } catch {}
if (-not $Lite) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
  $A = [Windows.Automation.AutomationElement]; $TS = [Windows.Automation.TreeScope]
}
$saved = $null

$script:hw = [IntPtr]::Zero
function Hwnd {
  if ($script:hw -ne [IntPtr]::Zero -and [W.U]::IsWindow($script:hw)) { return $script:hw }
  $pids = [int[]]@(Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $script:hw = if ($pids.Count) { [W.U]::FindMain($pids) } else { [IntPtr]::Zero }
  if ($script:hw -eq [IntPtr]::Zero) { return $null }
  $script:hw
}
function Root { $h = Hwnd; if ($h) { $A::FromHandle($h) } }
function Cond($type, $name) {
  $t = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type)
  if ($null -eq $name) { return $t }
  New-Object Windows.Automation.AndCondition($t, (New-Object Windows.Automation.PropertyCondition($A::NameProperty, $name)))
}
function SidebarGroup($root) {
  $gs = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Group) 'Sidebar'))
  $gs | Where-Object { $_.Current.BoundingRectangle.Width -gt 150 -and $_.Current.BoundingRectangle.Height -gt 300 } | Select-Object -First 1
}
function Find($root, $name) {
  foreach ($t in [Windows.Automation.ControlType]::Button, [Windows.Automation.ControlType]::RadioButton, [Windows.Automation.ControlType]::Hyperlink) {
    $e = $root.FindFirst($TS::Descendants, (Cond $t $name)); if ($e) { return $e }
  }
}
function Press($e) {
  $p = $null
  if ($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
  if ($e.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return $true }
  if ($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return $true }
  if ($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {   # Show / Hide sidebar
    if ($p.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Expand() } else { $p.Collapse() }
    return $true
  }
  # no pattern exposed: click its centre
  $r = $e.Current.BoundingRectangle; if ($r.Width -le 0) { return $false }
  # only when that point shows a Claude window (its main window or one of its menus): behind another app the click would land there
  $c = New-Object W.U+PT; $c.X = [int]($r.X + $r.Width / 2); $c.Y = [int]($r.Y + $r.Height / 2)
  $h = Hwnd; if (-not $h) { return $false }
  $at = [W.U]::GetAncestor([W.U]::WindowFromPoint($c), 2); $p1 = [uint32]0; $p2 = [uint32]0
  if ($at -ne [IntPtr]::Zero) { [void][W.U]::GetWindowThreadProcessId2($at, [ref]$p1) }; [void][W.U]::GetWindowThreadProcessId2($h, [ref]$p2)
  if ($at -eq [IntPtr]::Zero -or $p1 -ne $p2) { return $false }
  $pt = [Windows.Forms.Cursor]::Position
  [Windows.Forms.Cursor]::Position = New-Object Drawing.Point($c.X, $c.Y)
  [W.U]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [W.U]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30   # mouse_event is queued: the cursor goes back only after the click is taken
  [Windows.Forms.Cursor]::Position = $pt
  $true
}
# join the foreground window's input thread so Windows lets us hand the focus over (no Alt tap: that opens the app menu)
# a key to the Claude window only while it is in front (never into whatever the user is typing in) -> sent or not
function KeyTo($h, $keys) { if (-not $h -or [W.U]::GetForegroundWindow() -ne $h) { return $false }; [System.Windows.Forms.SendKeys]::SendWait($keys); $true }
function Front($h) {
  $me = [W.U]::GetCurrentThreadId(); $fg = [W.U]::GetWindowThreadProcessId([W.U]::GetForegroundWindow(), [IntPtr]::Zero)
  if ($fg -and $fg -ne $me) { [void][W.U]::AttachThreadInput($me, $fg, $true) }
  [void][W.U]::BringWindowToTop($h); [void][W.U]::SetForegroundWindow($h)
  if ($fg -and $fg -ne $me) { [void][W.U]::AttachThreadInput($me, $fg, $false) }
}

function Snap {
  $root = Root; if (-not $root) { return @{ ok = $false } }
  $doc = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Document) $null)) | Where-Object { $_.Current.Name } | Select-Object -First 1
  $title = if ($doc) { $doc.Current.Name -replace ' - Claude Code$', '' } else { '' }
  $out = @{ ok = $true; title = $title; project = ''; mode = ''; sidebar = $false; nav = $null; routines = $null; pinned = $null }
  foreach ($m in 'Claude', 'Code') {
    $r = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::RadioButton) $m)); $p = $null
    if ($r -and $r.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p) -and $p.Current.IsSelected) { $out.mode = $m }
  }
  $more = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) "More options for $title"))
  if ($more) { $w = [Windows.Automation.TreeWalker]::ControlViewWalker; $n = $w.GetNextSibling($more); if ($n) { $out.project = $n.Current.Name } }
  $out.sidebar = [bool]($root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Hide sidebar')))
  $g = SidebarGroup $root
  if ($g) {
    $names = @($g.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null)) | ForEach-Object { $_.Current.Name })
    $nav = @(); $rt = @(); $pin = @(); $sec = 'nav'
    for ($i = 0; $i -lt $names.Count; $i++) {
      $n = $names[$i]; $next = if ($i + 1 -lt $names.Count) { $names[$i + 1] } else { '' }
      if ($n -like 'More options for *' -or $n -like 'Create project' -or $n -like 'New from a template') { continue }
      if ($sec -eq 'nav' -and $n -eq 'Routines' -and $nav -contains 'Routines') { $sec = 'routines'; continue }
      if ($n -eq 'Pinned') { $sec = 'pinned'; continue }
      if ($next -like 'New session in *' -or $next -eq 'Filter') { if ($sec -ne 'nav') { break } }
      switch ($sec) { 'nav' { $nav += $n } 'routines' { $rt += $n } 'pinned' { $pin += $n } }
    }
    $out.nav = $nav; $out.routines = $rt; $out.pinned = $pin
  }
  $out
}

function Invoke-Named($name) {
  $root = Root; if (-not $root) { return @{ ok = $false } }
  # never the window's own caption buttons (Close hides Claude to the tray): only a same-named button inside the page,
  # e.g. the Close of the settings dialog
  if ($name -in 'Close', 'Minimize', 'Maximize', 'Restore') {
    $top = $root.Current.BoundingRectangle.Y + 50
    foreach ($e in $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $name))) {
      if ($e.Current.BoundingRectangle.Y -gt $top) { return @{ ok = (Press $e) } }
    }
    return @{ ok = $false; why = 'not found' }
  }
  $e = Find $root $name
  if ($e) { return @{ ok = (Press $e) } }
  # sidebar item while the sidebar is hidden: open it, press, hide again
  $show = Find $root 'Show sidebar'; if (-not $show) { return @{ ok = $false; why = 'not found' } }
  [void](Press $show); $ok = $false
  try {
    for ($k = 0; $k -lt 20 -and -not $e; $k++) { Start-Sleep -Milliseconds 60; $e = Find $root $name }
    $ok = if ($e) { Press $e } else { $false }
  } finally {
    Start-Sleep -Milliseconds 150
    $hide = Find $root 'Hide sidebar'; if ($hide) { [void](Press $hide) }
  }
  @{ ok = $ok }
}

# x, y, w, h = the visible card (physical px). The window is placed so its title bar sits just above the card, where the
# sphere's mask window covers it and rounds the corners (a window region is ignored by Chromium's composited window).
function Place($c) {
  $h = Hwnd; if (-not $h) { return @{ ok = $false } }
  # a helper started fresh while a card is open (the last one was killed) gets the window's own rect back from Node
  if (-not $script:saved -and $c.saved -and $c.saved.rect) { $script:saved = @{ rect = $c.saved.rect; visible = [bool]$c.saved.visible; max = [bool]$c.saved.max; min = [bool]$c.saved.min } }
  if (-not $script:saved) {
    # the window rect as shown (GetWindowPlacement would give the pre-snap size of a window snapped to half the screen)
    $sr = New-Object W.U+RECT; [void][W.U]::GetWindowRect($h, [ref]$sr)
    $script:saved = @{ rect = @{ L = $sr.L; T = $sr.T; R = $sr.R; B = $sr.B }; visible = [W.U]::IsWindowVisible($h); max = [W.U]::IsZoomed($h); min = [W.U]::IsIconic($h) }
  }
  if (-not [W.U]::IsWindowVisible($h) -or [W.U]::IsZoomed($h) -or [W.U]::IsIconic($h)) { [void][W.U]::ShowWindow($h, 9) }
  $wr = New-Object W.U+RECT; $vr = New-Object W.U+RECT; [void][W.U]::GetWindowRect($h, [ref]$wr)
  if ([W.U]::DwmGetWindowAttribute($h, 9, [ref]$vr, 16) -ne 0) { $vr = $wr }     # extended frame bounds = the visible window
  $l = $vr.L - $wr.L; $t = $vr.T - $wr.T; $r = $wr.R - $vr.R; $b = $wr.B - $vr.B
  $th = 36                                                                         # Claude's title bar (to the Primary pane)
  $root = Root; if ($root) { $pp = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Group) 'Primary pane')); if ($pp) { $y = [int]$pp.Current.BoundingRectangle.Y - $vr.T; if ($y -gt 10 -and $y -lt 90) { $th = $y } } }
  $w = [int]$c.w; $hh = [int]$c.h
  [void][W.U]::SetWindowPos($h, [IntPtr](-1), [int]$c.x - $l, [int]$c.y - $t - $th, $w + $l + $r, $hh + $t + $th + $b, 0x40)
  Front $h
  @{ ok = $true; th = $th; saved = $script:saved }
}
# back as before: region off, not topmost, same rect / maximized / minimized, hidden again if it was
function Restore($c) {
  $h = Hwnd; $s = $script:saved; $script:saved = $null
  if (-not $s -and $c.saved -and $c.saved.rect) { $s = $c.saved }   # (kept by Node across a helper restart)
  if (-not $h) { return @{ ok = $false } }
  [void][W.U]::SetWindowRgn($h, [IntPtr]::Zero, $true)
  if ($s) {
    $q = $s.rect
    if ($s.max) { [void][W.U]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x13); [void][W.U]::ShowWindow($h, 3) }
    else { [void][W.U]::SetWindowPos($h, [IntPtr](-2), $q.L, $q.T, $q.R - $q.L, $q.B - $q.T, 0x10) }
    if ($s.min) { [void][W.U]::ShowWindow($h, 6) }
    if (-not $s.visible -or $c.hide) { [void][W.U]::ShowWindow($h, 0) }
  } else { [void][W.U]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x13); if ($c.hide) { [void][W.U]::ShowWindow($h, 0) } }
  @{ ok = $true }
}

# Session Console (Docs/Specs/SessionConsole_Plan.md step 0): type into a session's composer and press Send (or Stop) without
# keeping the Claude window in front. The sidebar row opens the session (it activates the window: focus is handed straight
# back after every step); a minimised or tray window has a frozen UIA tree, so it is shown behind everything first and put
# back afterwards. The session shown before is opened again at the end.
function Hold($fg0) {
  $f = [W.U]::GetForegroundWindow(); if ($fg0 -eq [IntPtr]::Zero -or $f -eq $fg0) { return }
  $me = [W.U]::GetCurrentThreadId(); $t = [W.U]::GetWindowThreadProcessId($f, [IntPtr]::Zero)
  if ($t -and $t -ne $me) { [void][W.U]::AttachThreadInput($me, $t, $true) }
  [void][W.U]::SetForegroundWindow($fg0)
  if ($t -and $t -ne $me) { [void][W.U]::AttachThreadInput($me, $t, $false) }
}
function PageTitle($root) {
  $d = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Document) $null)) | Where-Object { $_.Current.Name } | Select-Object -First 1
  if ($d) { $d.Current.Name -replace ' - Claude Code$', '' } else { '' }
}
# the reply box's text set through UI Automation; the app's editor sometimes drops the first SetValue (a fresh page), so it
# is set again until the box holds it (6 tries) -> $true when it does
function Put-Text($vp, [string]$t, $fg0) {
  for ($k = 0; $k -lt 6; $k++) { $vp.SetValue($t); Hold $fg0; Start-Sleep -Milliseconds 150; if ($vp.Current.Value.Trim() -eq $t.Trim()) { return $true } }
  $false
}
function PageNow { try { $r = Root; if ($r) { PageTitle $r } else { '' } } catch { '' } }
# the sidebar row "<status> <title>" (Idle / Running / Unread response ...); the shortest name wins over longer titles ending the same
function SessionRow($root, $title) {
  # a row whose part before the title is a known status first ("Idle Please Fix bug" must not win over "Awaiting input Fix bug")
  $known = '^(Idle|Running|Unread response|Awaiting input|Failed|Error|Paused|Completed|Done|Archived)$'
  $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null)) | Where-Object {
    $n = try { [string]$_.Current.Name } catch { "" }; $n.EndsWith(" $title") -and $n -notlike 'More options for *' -and $n -notlike 'New session in *' } |
    Sort-Object { $n = try { [string]$_.Current.Name } catch { '' }; if ($n.Substring(0, [Math]::Max(0, $n.Length - $title.Length - 1)) -match $known) { 0 } else { 1 } }, { try { ([string]$_.Current.Name).Length } catch { 999 } } | Select-Object -First 1
}
function Open-Session($root, $title, $fg0, $link) {
  $was = PageTitle $root; if ($was -eq $title) { return $true }
  $hide = $null; $ok = $false; $linked = $false
  # two tries: the sidebar reorders just after a send (that session moves to the top) and a row found then can be
  # redrawn as another session before the press lands; the row's name is read again right before pressing
  for ($try = 0; $try -lt 2 -and -not $ok; $try++) {
    $row = SessionRow $root $title
    if (-not $row -and -not $hide) { $show = Find $root 'Show sidebar'; if ($show) { [void](Press $show); Hold $fg0; for ($k = 0; $k -lt 20 -and -not $row; $k++) { Start-Sleep -Milliseconds 60; $row = SessionRow $root $title }; $hide = $true } }
    if ($row) { $n = try { [string]$row.Current.Name } catch { '' }; if (-not $n.EndsWith(" $title")) { Start-Sleep -Milliseconds 300; continue }; [void](Press $row) }
    elseif ($try -eq 0 -and $link -match '^claude://claude\.ai/epitaxy/[\w-]+$') { Start-Process (Join-Path $env:LOCALAPPDATA 'AnthropicClaude/claude.exe') -ArgumentList $link; $linked = $true }   # not in the sidebar: the deep link
    else { break }
    for ($k = 0; $k -lt 50; $k++) { Hold $fg0; if ((PageTitle $root) -eq $title) { $ok = $true; break }; Start-Sleep -Milliseconds 60 }
  }
  # a deep link that opened another session (the feed still pairing this name with a session the Session manager has since
  # renamed "(old - archive)"): back to the page that was showing, never left on that session
  if ($linked -and -not $ok) { $now = PageTitle $root; if ($now -and $now -ne $was) { $bk = Find $root 'Back'; if ($bk) { [void](Press $bk); Hold $fg0 } } }
  if ($hide) { $b = Find $root 'Hide sidebar'; if ($b) { [void](Press $b) }; Hold $fg0 }
  $ok
}
# after an action: the session shown before opened again (not the New session page, 'Claude'), the window hidden / minimised
# again as it was, focus handed back; each step on its own, so a stale element never hides the action's result or skips the rest
function Put-Back($root, $prev, $title, $h, $vis, $min, $fg0) {
  try { if ($prev -and $prev -ne $title -and $prev -ne 'Claude') { [void](Open-Session $root $prev $fg0) } } catch {}
  try { if (-not $vis) { [void][W.U]::ShowWindow($h, 0) } elseif ($min) { [void][W.U]::ShowWindow($h, 7) } } catch {}
  try { Hold $fg0 } catch {}
}
function Send-To($c) {
  $h = Hwnd; if (-not $h) { return @{ ok = $false; why = 'Claude is not running' } }
  $fg0 = [W.U]::GetForegroundWindow(); $min = [W.U]::IsIconic($h); $vis = [W.U]::IsWindowVisible($h)
  # bg (automatic sends, 10-14): never switch pages under the user (Claude in front = in use: later) and no deep link (it raises the app)
  if ($c.bg -and $fg0 -eq $h) { return @{ ok = $false; why = 'Claude is in use (in front); later' } }
  if ($min -or -not $vis) { [void][W.U]::ShowWindow($h, 4); [void][W.U]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x13); Hold $fg0; Start-Sleep -Milliseconds 300 }
  $root = $null; $prev = ''; $out = @{ ok = $false }
  try {
    $root = Root; $prev = PageTitle $root   # (in the try: a UIA error here still puts the window back)
    if (-not (Open-Session $root $c.title $fg0 $(if ($c.bg) { '' } else { $c.link }))) { $out.why = 'session not found'; return $out }
    if ($c.stop) {
      $b = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Stop'))
      if (-not $b) { $out.why = 'not working'; return $out }
      $out.ok = Press $b; Hold $fg0; return $out
    }
    $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt'))
    if (-not $ed) { $out.why = 'no reply box'; return $out }
    $vp = $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($vp.Current.Value.Trim()) { $out.why = 'a draft is in its reply box'; return $out }   # never overwrite what the user typed there
    [void](Put-Text $vp ([string]$c.text) $fg0)
    for ($k = 0; $k -lt 20; $k++) { Start-Sleep -Milliseconds 50; $b = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Send')); if ($b -and $b.Current.IsEnabled) { break } }
    if (-not ($b -and $b.Current.IsEnabled)) { $vp.SetValue(' '); Hold $fg0; $out.why = 'Send not available'; return $out }
    $out.ok = Press $b; Hold $fg0; $out
  } finally {
    if ($out.ok -and -not $c.stop) { Start-Sleep -Milliseconds 400 }   # let the sidebar reorder (this session moves to the top) before going back
    Put-Back $root $prev $c.title $h $vis $min $fg0
  }
}

# New session (SessionConsole_Plan step 9): New -> folder menu (recent folders as radio buttons) -> model menu -> prompt -> Send.
# Same quiet handling as Send-To (focus handed back, minimised / tray window shown behind everything, view put back).
# -> { ok, title } (title = the new session's page title once the app has named it, else '')
function Pick-Menu($root, $btn, $name) {
  $p = $null; if (-not $btn.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { return $false }
  $p.Expand(); $it = $null
  for ($k = 0; $k -lt 20 -and -not $it; $k++) {
    Start-Sleep -Milliseconds 60
    $all = @($root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::RadioButton) $null)))
    # the exact name first ("Titans" never picks "Titans University"), then one that starts with it ("Opus 4.5 (1M)")
    $it = $all | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1
    if (-not $it) { $it = $all | Where-Object { ([string]$_.Current.Name).StartsWith("$name ", [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 }
  }
  if ($it) { [void](Press $it); return $true }
  try { $p.Collapse() } catch {}
  $false
}
function New-Session($c) {
  $h = Hwnd; if (-not $h) { return @{ ok = $false; why = 'Claude is not running' } }
  $fg0 = [W.U]::GetForegroundWindow(); $min = [W.U]::IsIconic($h); $vis = [W.U]::IsWindowVisible($h)
  if ($min -or -not $vis) { [void][W.U]::ShowWindow($h, 4); [void][W.U]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x13); Hold $fg0; Start-Sleep -Milliseconds 300 }
  $root = $null; $prev = ''; $out = @{ ok = $false; title = '' }
  try {
    $root = Root; $prev = PageTitle $root
    $new = Find $root 'New'; if (-not $new) { $out.why = 'no New button'; return $out }
    [void](Press $new); Hold $fg0
    $ed = $null
    for ($k = 0; $k -lt 40; $k++) { Start-Sleep -Milliseconds 80; Hold $fg0; if ((PageTitle $root) -eq 'Claude') { $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt')); if ($ed) { break } } }
    if (-not $ed) { $out.why = 'the New session page did not open'; return $out }
    $y = $ed.Current.BoundingRectangle.Y
    if ($c.folder) {
      # the folder button: an expandable button in the row above the prompt whose menu lists folders ("Local" is the environment)
      $x = $ed.Current.BoundingRectangle.X - 40
      $btns = @($root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null)) | Where-Object { $r = $_.Current.BoundingRectangle; $r.X -gt $x -and $r.Y -gt $y - 70 -and $r.Y -lt $y - 10 -and $_.Current.Name -ne 'Local' -and $_.Current.Name -ne 'Add another folder' })
      $fb = $btns | Select-Object -First 1
      if (-not $fb) { $out.why = 'no folder button'; return $out }
      if ($fb.Current.Name -ne $c.folder) { if (-not (Pick-Menu $root $fb $c.folder)) { $out.why = "folder $($c.folder) is not in the app's recent list (button $($fb.Current.Name))"; return $out }; Hold $fg0; Start-Sleep -Milliseconds 300 }
    }
    # the app's worktree tick box in the folder row (only for a git folder); $c.worktree true / false sets it, absent leaves it
    if ($null -ne $c.worktree) {
      $wt = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::CheckBox) 'worktree'))
      if (-not $wt) { if ($c.worktree) { $out.why = 'no worktree option here (is the folder a git repository?)'; return $out } }
      else {
        $tp = $wt.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if (($tp.Current.ToggleState -eq 'On') -ne [bool]$c.worktree) { $tp.Toggle(); Hold $fg0; Start-Sleep -Milliseconds 200 }
        if (($tp.Current.ToggleState -eq 'On') -ne [bool]$c.worktree) { $out.why = 'the worktree option did not change'; return $out }
      }
    }
    if ($c.model) {
      $mb = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null)) | Where-Object { $_.Current.Name -like 'Model:*' } | Select-Object -First 1
      if ($mb -and $mb.Current.Name -ne "Model: $($c.model)") { if (-not (Pick-Menu $root $mb $c.model)) { $out.why = "no model $($c.model)"; return $out }; Hold $fg0; Start-Sleep -Milliseconds 200 }
    }
    $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt'))
    [void](Put-Text $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern) ([string]$c.text) $fg0)
    $b = $null; for ($k = 0; $k -lt 20; $k++) { Start-Sleep -Milliseconds 50; $b = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Send')); if ($b -and $b.Current.IsEnabled) { break } }
    if (-not ($b -and $b.Current.IsEnabled)) { $out.why = 'Send not available'; return $out }
    [void](Press $b); Hold $fg0; $out.ok = $true
    for ($k = 0; $k -lt 60; $k++) { Start-Sleep -Milliseconds 150; Hold $fg0; $t = PageTitle $root; if ($t -and $t -ne 'Claude') { $out.title = $t; break } }
    $out
  } finally {
    Put-Back $root $prev 'Claude' $h $vis $min $fg0
  }
}

# tests: open the New session page, list the named controls near the prompt (name, type, offset from the prompt), go back
function Probe-New($c) {
  $h = Hwnd; if (-not $h) { return @{ ok = $false; why = 'Claude is not running' } }
  $fg0 = [W.U]::GetForegroundWindow(); $min = [W.U]::IsIconic($h); $vis = [W.U]::IsWindowVisible($h)
  $root = Root; $prev = PageTitle $root; $out = @{ ok = $false; items = @() }
  try {
    $new = Find $root 'New'; if (-not $new) { $out.why = 'no New button'; return $out }
    [void](Press $new); Hold $fg0
    $ed = $null
    for ($k = 0; $k -lt 40; $k++) { Start-Sleep -Milliseconds 80; Hold $fg0; if ((PageTitle $root) -eq 'Claude') { $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt')); if ($ed) { break } } }
    if (-not $ed) { $out.why = 'the New session page did not open'; return $out }
    Start-Sleep -Milliseconds 400
    $er = $ed.Current.BoundingRectangle
    $out.items = @($root.FindAll($TS::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
      try { $r = $_.Current.BoundingRectangle; $n = [string]$_.Current.Name; $t = $_.Current.ControlType.ProgrammaticName -replace 'ControlType.', ''
        if ($n -and $t -ne 'Text' -and $r.Y -gt $er.Y - 200 -and $r.Y -lt $er.Y + $er.Height + 200) { "$t|$n|$([int]($r.X - $er.X)),$([int]($r.Y - $er.Y))" } } catch {} })
    if ($c.toggle) {   # the worktree tick box: toggle it twice, report the states
      $wt = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::CheckBox) 'worktree'))
      if ($wt) { $tp = $wt.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern); $st = @([string]$tp.Current.ToggleState); 1..2 | ForEach-Object { $tp.Toggle(); Hold $fg0; Start-Sleep -Milliseconds 300; $st += [string]$tp.Current.ToggleState }; $out.toggle = $st -join ',' }
    }
    $out.ok = $true; $out
  } finally {
    Put-Back $root $prev 'Claude' $h $vis $min $fg0
  }
}

# Waiting sessions (SessionConsole_Plan step 8): answer a pop-up question or a permission request in the session's page.
# Same quiet handling as Send-To; $act runs with $root and $fg0 set and returns the reply.
function In-Session($c, [scriptblock]$act) {
  $script:keep = $false   # only Answer's act sets it (a pop-up half answered): one left by an earlier act that threw must not stick
  $h = Hwnd; if (-not $h) { return @{ ok = $false; why = 'Claude is not running' } }
  $fg0 = [W.U]::GetForegroundWindow(); $min = [W.U]::IsIconic($h); $vis = [W.U]::IsWindowVisible($h)
  if ($min -or -not $vis) { [void][W.U]::ShowWindow($h, 4); [void][W.U]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x13); Hold $fg0; Start-Sleep -Milliseconds 300 }
  $root = $null; $prev = ''
  try {
    $root = Root; $prev = PageTitle $root
    if (-not (Open-Session $root $c.title $fg0 $c.link)) { return @{ ok = $false; why = 'session not found' } }
    & $act
  } finally {
    if ($script:keep) { $prev = '' }
    Put-Back $root $prev $c.title $h $vis $min $fg0
  }
}
function Buttons($in) { @($in.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null))) }
# option buttons: plain buttons, or check boxes on a multi-choice question
function Options($in, $y) { @($in.FindAll($TS::Descendants, (New-Object Windows.Automation.OrCondition((Cond ([Windows.Automation.ControlType]::Button) $null), (Cond ([Windows.Automation.ControlType]::CheckBox) $null)))) | Where-Object { $_.Current.BoundingRectangle.Y -ge $y }) }
# the pop-up's counter: Texts "i", "/", "n" in an unnamed group above the options -> @{ i; n; y } (y = the counter's top), or $null
function AskAt($root) {
  $w = [Windows.Automation.TreeWalker]::ControlViewWalker
  foreach ($t in $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Text) '/'))) {
    $pa = $w.GetPreviousSibling($t); $pb = $w.GetNextSibling($t)
    if ($pa -and $pb -and $pa.Current.Name -match '^\d+$' -and $pb.Current.Name -match '^\d+$') { return @{ i = [int]$pa.Current.Name; n = [int]$pb.Current.Name; y = $t.Current.BoundingRectangle.Y - 30 } }
  }
  $null
}
# the question shown is $i of $n? (one question may have no counter: then any pop-up with option buttons)
function AskGroup($root, $i, $n) {
  $p = AskAt $root
  if ($p) { if ($p.i -eq $i -and $p.n -eq $n) { return $p } else { return $null } }
  if ($n -eq 1 -and (Buttons $root | Where-Object { $_.Current.Name -match '^Other \d+$' })) { return @{ i = 1; n = 1; y = 0 } }
  $null
}
# {title, link, answers: [{picks: [{label, description}], other, multi}]}: every question in one pass, then Submit
function Answer($c) {
  $script:keep = $false   # set once a pick is made: a half-answered pop-up must not be left (the app then records odd picks)
  $r = In-Session $c {
    $qs = @($c.answers); $n = $qs.Count
    # left on a later question (an earlier try stopped midway): back to the first
    for ($k = 0; $k -lt 8; $k++) { $at = AskAt $root; if (-not $at -or $at.i -le 1) { break }; $bk = Buttons $root | Where-Object { $_.Current.Name -eq 'Back' -and $_.Current.BoundingRectangle.Y -gt $at.y } | Select-Object -First 1; if (-not $bk) { break }; [void](Press $bk); Hold $fg0; Start-Sleep -Milliseconds 150 }
    for ($i = 0; $i -lt $n; $i++) {
      $ans = $qs[$i]; $g = $null
      for ($k = 0; $k -lt 30 -and -not $g; $k++) { $g = AskGroup $root ($i + 1) $n; if (-not $g) { Start-Sleep -Milliseconds 80; Hold $fg0 } }
      if (-not $g) { $at = AskAt $root; return @{ ok = $false; why = $(if ($at) { "the app shows question $($at.i) of $($at.n), not $($i + 1) of $n" } else { 'no question shown' }) } }
      $btns = Options $root $g.y; $last = $i -eq $n - 1; $moved = $false
      if ([string]$ans.other) {
        $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Other option'))
        if (-not $ed) { $o = $btns | Where-Object { $_.Current.Name -match '^Other \d+$' } | Select-Object -First 1; if ($o) { [void](Press $o); Hold $fg0; Start-Sleep -Milliseconds 150 }; $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Other option')) }
        if (-not $ed) { return @{ ok = $false; why = "no Other box on question $($i + 1)" } }
        $script:keep = $true; $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue([string]$ans.other); Hold $fg0; Start-Sleep -Milliseconds 100
      } else {
        # a check box left on by an earlier try and not picked now: off
        $want = @(@($ans.picks) | ForEach-Object { ([string]$_.label + ' ' + [string]$_.description).Trim() })
        if ($ans.multi) { foreach ($e in $btns) { $tp = $null; if ($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$tp) -and $tp.Current.ToggleState -eq 'On') { $nm = [string]$e.Current.Name -replace ' \d+$', ''; if ($want -notcontains $nm) { $tp.Toggle(); Hold $fg0 } } } }
        foreach ($p in @($ans.picks)) {
          $lab = [string]$p.label; $full = ("$lab $([string]$p.description)").Trim()
          $cand = @($btns | Where-Object { $m = try { [string]$_.Current.Name } catch { '' }; $m -notmatch '^Other( \d+)?$' -and ($m -eq $lab -or $m.StartsWith("$lab ")) })   # "<label> <description> <n>"; a check box has no number
          $b = ($cand | Where-Object { ([string]$_.Current.Name) -match ('^' + [regex]::Escape($full) + '( \d+)?$') } | Select-Object -First 1)
          if (-not $b) { $b = $cand | Sort-Object { ([string]$_.Current.Name).Length } | Select-Object -First 1 }
          if (-not $b) { return @{ ok = $false; why = "no option '$lab' on question $($i + 1)" } }
          $tp = $null; if ($b.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$tp) -and $tp.Current.ToggleState -eq 'On') { continue }   # already on
          $script:keep = $true; [void](Press $b); Hold $fg0; Start-Sleep -Milliseconds 120
        }
        # a single-choice pick moves on by itself
        if (-not $ans.multi -and -not $last) { for ($k = 0; $k -lt 10; $k++) { if (AskGroup $root ($i + 2) $n) { $moved = $true; break }; Start-Sleep -Milliseconds 60 } }
      }
      if ($last) {
        $s = Buttons $root | Where-Object { $_.Current.Name -eq 'Submit' } | Select-Object -First 1
        if ($s) { [void](Press $s); Hold $fg0 }
        elseif ($g -and (AskGroup $root ($i + 1) $n)) { return @{ ok = $false; why = 'no Submit button' } }
      } elseif (-not $moved) {
        $nx = Buttons $root | Where-Object { $_.Current.Name -eq 'Next' } | Select-Object -First 1
        if (-not $nx) { return @{ ok = $false; why = "no Next button on question $($i + 1)" } }
        [void](Press $nx); Hold $fg0
      }
    }
    $script:keep = $false
    @{ ok = $true }
  }
  if ($r -is [array]) { $r = $r[-1] }
  if ($script:keep -and $r -and -not $r.ok) { $r.why = "$($r.why); the pop-up is left open in the Claude app"; $script:keep = $false }
  $r
}
# {title, link, choice: 'Allow once' | 'Always allow' | 'Deny'}: a button of the "Permission request: <verb>" group
function Permit($c) {
  In-Session $c {
    $g = $null
    for ($k = 0; $k -lt 15 -and -not $g; $k++) { $g = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Group) $null)) | Where-Object { $m = try { [string]$_.Current.Name } catch { '' }; $m -like 'Permission request*' } | Select-Object -First 1; if (-not $g) { Start-Sleep -Milliseconds 80 } }
    if (-not $g) { return @{ ok = $false; why = 'no permission request in that session' } }
    $ch = [string]$c.choice
    $b = Buttons $g | Where-Object { $m = try { [string]$_.Current.Name } catch { '' }; $m -eq $ch -or $m -match ('^' + [regex]::Escape($ch) + ' \d+$') } | Select-Object -First 1
    if (-not $b) { return @{ ok = $false; why = "no '$ch' button" } }
    # the allow buttons ignore presses for a moment after the request is drawn (opening the session redraws it); Deny does not
    if ($ch -ne 'Deny') { for ($k = 0; $k -lt 8; $k++) { Start-Sleep -Milliseconds 100; Hold $fg0 } }
    # still asking after 1.5 s: press once more, only when the request on show is the same one (same element, same texts -
    # its name is only "Permission request: run", the texts hold the command); a next request drawn in its place (Chromium
    # may reuse the nodes) is never approved by this retry
    $sig = { param($e) ((@($e.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Text) $null))) | ForEach-Object { try { [string]$_.Current.Name } catch { '' } }) -join '|') }
    $what = [string]$g.Current.Name; $rid = ($g.GetRuntimeId() -join '.'); $txt = & $sig $g
    [void](Press $b); Hold $fg0
    if ($ch -ne 'Deny') {
      Start-Sleep -Milliseconds 1500; Hold $fg0
      try {
        $g2 = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Group) $null)) | Where-Object { $m = try { [string]$_.Current.Name } catch { '' }; $m -like 'Permission request*' } | Select-Object -First 1
        if ($g2 -and ($g2.GetRuntimeId() -join '.') -eq $rid -and [string]$g2.Current.Name -eq $what -and (& $sig $g2) -eq $txt -and $b.Current.IsEnabled -and -not $b.Current.IsOffscreen) { [void](Press $b); Hold $fg0 }
      } catch {}
    }
    @{ ok = $true; what = $what }
  }
}

# sidebar session rows "<status> <title>" -> { ok, rows: [{ s, t }] }; ok false when the window or the sidebar is hidden (no page or focus change)
$script:stat = '^(Awaiting input|Running|Idle|Unread response|Needs attention|Error|Stopped) (.+)$'
function Status {
  $h = Hwnd; if (-not $h -or -not [W.U]::IsWindowVisible($h) -or [W.U]::IsIconic($h)) { return @{ ok = $false; why = 'hidden' } }
  $g = SidebarGroup (Root); if (-not $g) { return @{ ok = $false; why = 'sidebar hidden' } }
  $rows = @()
  foreach ($e in $g.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null))) {
    $n = try { [string]$e.Current.Name } catch { '' }
    if ($n -match $script:stat) { $rows += @{ s = $matches[1]; t = $matches[2] } }
  }
  if (-not $rows.Count) { return @{ ok = $false; why = 'no session rows' } }   # the sidebar mid-animation reads as empty
  @{ ok = $true; rows = $rows }
}

# plan approval (ExitPlanMode): choice accept | auto (Accept and auto mode) | revise (with text) | reject
function Plan($c) {
  In-Session $c {
    $tx = $null
    for ($k = 0; $k -lt 15 -and -not $tx; $k++) { $tx = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Text) 'Claude proposed a plan')); if (-not $tx) { Start-Sleep -Milliseconds 80 } }
    if (-not $tx) { return @{ ok = $false; why = 'no plan waiting in that session' } }
    $y = $tx.Current.BoundingRectangle.Y - 4
    $btn = { param($m) Buttons $root | Where-Object { $n = try { [string]$_.Current.Name } catch { '' }; $n -like $m -and $_.Current.BoundingRectangle.Y -ge $y } | Select-Object -Last 1 }
    switch ([string]$c.choice) {
      'reject' { $b = & $btn 'Reject'; if (-not $b) { return @{ ok = $false; why = "no 'Reject' button" } }; [void](Press $b); Hold $fg0 }
      'revise' {
        $t = ([string]$c.text).Trim(); if (-not $t) { return @{ ok = $false; why = 'say what to change' } }
        # "Revise" + an ellipsis character opens the feedback box with Back / Revise
        $b = & $btn 'Revise?'; if (-not $b) { return @{ ok = $false; why = "no 'Revise' button" } }
        [void](Press $b); Hold $fg0
        $ed = $null; for ($k = 0; $k -lt 20 -and -not $ed; $k++) { Start-Sleep -Milliseconds 80; $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Plan feedback')) }
        if (-not $ed) { return @{ ok = $false; why = 'the feedback box did not open' } }
        $vp = $null; if (-not $ed.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return @{ ok = $false; why = 'cannot type into the feedback box' } }
        $vp.SetValue($t); Start-Sleep -Milliseconds 300
        $go = Buttons $root | Where-Object { $n = try { [string]$_.Current.Name } catch { '' }; $n -eq 'Revise' } | Select-Object -Last 1
        if (-not $go) { return @{ ok = $false; why = "no 'Revise' send button" } }
        [void](Press $go); Hold $fg0
      }
      { $_ -in 'accept', 'auto', 'edits', 'bypass' } {
        $nm = if ($c.choice -eq 'auto') { 'Accept and auto mode' } else { 'Accept' }
        $b = & $btn $nm; if (-not $b) { return @{ ok = $false; why = "no '$nm' button" } }
        if ($c.choice -in 'edits', 'bypass') {   # MenuItems of "More accept options"
          $mo = & $btn 'More accept options'; if (-not $mo) { return @{ ok = $false; why = "no 'More accept options'" } }
          $nm = if ($c.choice -eq 'edits') { 'Accept and allow edits' } else { 'Accept and bypass permissions' }
          for ($k = 0; $k -lt 8; $k++) { Start-Sleep -Milliseconds 100; Hold $fg0 }
          [void](Press $mo); $it = MenuItem $root $nm
          if (-not $it) { [void](KeyTo (Hwnd) '{ESC}'); return @{ ok = $false; why = "no '$nm'" } }
          [void](Press $it); Hold $fg0; Start-Sleep -Milliseconds 1200
          return @{ ok = -not $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Text) 'Claude proposed a plan')) }
        }
        # like Allow: presses right after the page is drawn are ignored
        for ($k = 0; $k -lt 8; $k++) { Start-Sleep -Milliseconds 100; Hold $fg0 }
        [void](Press $b); Hold $fg0
        Start-Sleep -Milliseconds 1500; Hold $fg0
        if ($root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Text) 'Claude proposed a plan'))) { try { [void](Press $b) } catch {}; Hold $fg0 }
      }
      default { return @{ ok = $false; why = 'unknown choice' } }
    }
    @{ ok = $true }
  }
}

# ---- stage 4 (SessionConsole_Stage4_Spec 'Driving them'): settings, housekeeping, attachments ----
# the bar under the reply box (Add, mode, "Model: X", "Effort: X"): buttons within 90 px below the Prompt edit's top, right of
# its left edge (the sidebar rows share that height)
$script:modes = 'Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'
$script:efforts = 'Low', 'Medium', 'High', 'Extra', 'Max', 'Ultracode'
function BarButtons($root) {
  $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt')); if (-not $ed) { return @() }
  $r0 = $ed.Current.BoundingRectangle
  @(Buttons $root | Where-Object { $r = $_.Current.BoundingRectangle; $r.Y -ge $r0.Y -and $r.Y -le $r0.Y + 90 -and $r.X -ge $r0.X - 20 })
}
function ReadBar($root) {
  $o = @{ ok = $true; model = ''; effort = ''; mode = ''; fast = $null }
  foreach ($b in BarButtons $root) {
    $n = try { [string]$b.Current.Name } catch { '' }
    if ($n -like 'Model: *') { $o.model = $n.Substring(7) } elseif ($n -like 'Effort: *') { $o.effort = $n.Substring(8) } elseif ($script:modes -contains $n) { $o.mode = $n }
  }
  $f = $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Text) $null)) | Where-Object { $m = try { [string]$_.Current.Name } catch { '' }; $m -like 'Fast mode o*' } | Select-Object -First 1
  if ($f) { $o.fast = ($f.Current.Name -eq 'Fast mode on') }
  $o
}
function BarButton($root, $like) { BarButtons $root | Where-Object { $n = try { [string]$_.Current.Name } catch { '' }; $n -like $like -or ($like -eq 'mode' -and $script:modes -contains $n) } | Select-Object -First 1 }
function MenuItem($root, $name) {
  $it = $null
  for ($k = 0; $k -lt 20 -and -not $it; $k++) { Start-Sleep -Milliseconds 60; $it = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::MenuItem) $name)) }
  if ($it) { Start-Sleep -Milliseconds 450 }   # items ignore presses right after the menu is drawn
  $it
}
# a dialog window of the page ("Switch model?", "Delete session?") -> its button $btn pressed; $false when it never showed
function Confirm($root, $title, $btn, $tries) {
  $w = $null
  for ($k = 0; $k -lt $tries -and -not $w; $k++) { Start-Sleep -Milliseconds 80; $w = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Window) $title)) }
  if (-not $w) { return $false }
  $b = $w.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $btn)); if (-not $b) { return $false }
  [void](Press $b); $true
}
function Settings($c) { In-Session $c { ReadBar $root } }
# the composer's "/" menu (stage 5 step 3): types "/" into the session's empty reply box, reads the MenuItem names, then
# Esc and clears the box. Keys posted to the window are ignored, so the window comes to the front for about a second
# (once a day; focus is handed back). Descriptions are not read (only the highlighted one shows). -> { ok, names }
function MenuItems($root) { @($root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::MenuItem) $null))) }
function Commands($c) {
  In-Session $c {
    $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt'))
    if (-not $ed) { return @{ ok = $false; why = 'no reply box' } }
    $vp = $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($vp.Current.Value.Trim()) { return @{ ok = $false; why = 'a draft is in its reply box' } }
    $h = Hwnd; $out = @{ ok = $false; why = 'the / menu did not open' }
    try {
      Front $h; try { $ed.SetFocus() } catch {}; if (-not (KeyTo $h '/')) { $out.why = 'Claude did not come to the front'; return $out }
      $mi = @(); for ($k = 0; $k -lt 15 -and -not $mi.Count; $k++) { Start-Sleep -Milliseconds 80; $mi = MenuItems $root }
      if (-not $mi.Count) { return $out }
      $names = @(); foreach ($m in $mi) { $n = try { [string]$m.Current.Name } catch { '' }; if ($n -and $names -notcontains $n) { $names += $n } }
      $out = @{ ok = $true; names = $names }; $out
    } finally {
      if ([W.U]::GetForegroundWindow() -eq $h) { [Windows.Forms.SendKeys]::SendWait('{ESC}') }
      Start-Sleep -Milliseconds 80; $vp.SetValue('')
    }
  }
}

# {title, what: mode | model | effort | fast, value} -> the bar after the change
function Set-Setting($c) {
  In-Session $c {
    $v = [string]$c.value
    switch ([string]$c.what) {
      'mode' {
        $b = BarButton $root 'mode'; if (-not $b) { return @{ ok = $false; why = 'no mode button' } }
        if ($b.Current.Name -ne $v -and -not (Pick-Menu $root $b $v)) { return @{ ok = $false; why = "no mode '$v'" } }
      }
      'model' {
        $b = BarButton $root 'Model: *'; if (-not $b) { return @{ ok = $false; why = 'no model button' } }
        if ($b.Current.Name -notlike "Model: $v*") {
          if (-not (Pick-Menu $root $b $v)) { return @{ ok = $false; why = "no model '$v'" } }
          [void](Confirm $root 'Switch model?' 'Switch model' 12)   # asked when the session is cached for another model
        }
      }
      { $_ -in 'effort', 'fast' } {
        $b = BarButton $root $(if ($c.what -eq 'effort') { 'Effort: *' } else { 'Model: *' }); if (-not $b) { return @{ ok = $false; why = "no $($c.what) button" } }
        $p = $null; if (-not $b.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { return @{ ok = $false; why = 'menu does not open' } }
        $p.Expand(); $e = $null
        try {
          if ($c.what -eq 'effort') {
            $i = [array]::IndexOf($script:efforts, $v); if ($i -lt 0) { return @{ ok = $false; why = "no effort '$v'" } }
            for ($k = 0; $k -lt 20 -and -not $e; $k++) { Start-Sleep -Milliseconds 60; $e = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Slider) 'Effort')) }
            if (-not $e) { return @{ ok = $false; why = 'no effort slider' } }
            $e.GetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern).SetValue($i)
          } else {
            for ($k = 0; $k -lt 20 -and -not $e; $k++) { Start-Sleep -Milliseconds 60; $e = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::CheckBox) 'Enable fast mode')) }
            if (-not $e) { return @{ ok = $false; why = 'no fast mode switch (not offered for this model)' } }
            $t = $e.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            if (($t.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) -ne [bool]$c.value) { $t.Toggle() }
          }
          Start-Sleep -Milliseconds 250
        } finally { try { if ($p.Current.ExpandCollapseState -ne [Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Collapse() } } catch {} }
      }
      default { return @{ ok = $false; why = 'unknown setting' } }
    }
    Hold $fg0; Start-Sleep -Milliseconds 300; ReadBar $root
  }
}
# {title, act: rename (name) | fork | archive | delete} -> { ok, title } (title: the new name / the fork)
function Manage($c) {
  In-Session $c {
    $t = [string]$c.title
    if ($c.act -eq 'rename') {
      $nm = ([string]$c.name).Trim(); if (-not $nm) { return @{ ok = $false; why = 'no name' } }
      $b = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) "$t, rename session")); if (-not $b) { return @{ ok = $false; why = 'no rename button' } }
      [void](Press $b); $ed = $null
      for ($k = 0; $k -lt 20 -and -not $ed; $k++) { Start-Sleep -Milliseconds 60; $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Session name')) }
      if (-not $ed) { return @{ ok = $false; why = 'the name field did not open' } }
      $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($nm)
      # only a real Enter commits it (a lost focus cancels): the window comes to the front for that key
      Front $h; try { $ed.SetFocus() } catch {}; Start-Sleep -Milliseconds 80
      $sent = KeyTo $h '{ENTER}'; Hold $fg0; if (-not $sent) { return @{ ok = $false; why = 'Claude did not come to the front' } }
      $ok = $false; for ($k = 0; $k -lt 25 -and -not $ok; $k++) { Start-Sleep -Milliseconds 80; $ok = [bool]$root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) "$nm, rename session")) }
      if (-not $ok) { return @{ ok = $false; why = 'the new name did not stick' } }
      return @{ ok = $true; title = $nm }
    }
    $m = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) "More options for $t")); if (-not $m) { return @{ ok = $false; why = 'no session menu' } }
    $had = [bool](SessionRow $root $t); $cf = $false; $pg0 = PageTitle $root   # gone only counts if its row was there (a hidden sidebar shows none), the app confirmed, or its page closed
    [void](Press $m)
    $nm = switch ([string]$c.act) { 'fork' { 'Fork' } 'archive' { 'Archive' } 'delete' { 'Delete' } default { '' } }
    $it = if ($nm) { MenuItem $root $nm }
    # a cold window can miss the first press (seen right after a restart): the menu once more
    if ($nm -and -not $it) { [void](KeyTo (Hwnd) '{ESC}'); Start-Sleep -Milliseconds 300; [void](Press $m); $it = MenuItem $root $nm }
    if (-not $it) { [void](KeyTo (Hwnd) '{ESC}'); return @{ ok = $false; why = "no '$($c.act)' item" } }
    [void](Press $it); Hold $fg0
    switch ([string]$c.act) {
      'fork' {
        $f = "$t (fork)"; $ok = $false
        for ($k = 0; $k -lt 40 -and -not $ok; $k++) { Start-Sleep -Milliseconds 80; $ok = (PageTitle $root) -eq $f -or [bool](SessionRow $root $f) }
        return @{ ok = $ok; title = $f; why = $(if (-not $ok) { 'no fork showed up' } else { '' }) }
      }
      'delete' { if (-not (Confirm $root 'Delete session?' 'Delete' 20)) { return @{ ok = $false; why = 'no delete confirm' } }; $cf = $true }
      'archive' { $cf = [bool](Confirm $root 'Archive session?' 'Archive' 6) }
    }
    Hold $fg0; $gone = $false
    for ($k = 0; $k -lt 30 -and -not $gone; $k++) { Start-Sleep -Milliseconds 100; $gone = (($had -or $cf) -and -not (SessionRow $root $t)) -or ($pg0 -and ($pn = PageTitle $root) -and $pn -ne $pg0) }   # (an empty title mid-load is no new page)
    @{ ok = $gone; why = $(if (-not $gone) { 'the session is still listed' } else { '' }) }
  }
}
# message actions (stage 5 step 5): {title, link, text, back, act: copy | fork | rewind, probe}. The message's
# "Show message actions for You said: <text>" button (back = how many identical ones to skip from the newest), then
# Copy / Fork from here / Rewind to here in its toolbar, then the app's confirm if one shows.
# probe: report what appeared after the press (names), and cancel a dialog instead of confirming it.
function Norm($s) { ([string]$s -replace '\s+', ' ').Trim() }
function Names($root) { $n = @{}; foreach ($e in $root.FindAll($TS::Descendants, [Windows.Automation.Condition]::TrueCondition)) { try { $x = $e.Current; if ($x.Name) { $n["$($x.ControlType.ProgrammaticName -replace 'ControlType.','') '$(($x.Name -replace '^(.{80}).*','$1'))'"] = 1 } } catch {} }; $n }
function MsgAct($c) {
  In-Session $c {
    $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt'))
    $draft = { if ($ed) { try { [string]$ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { '' } } else { '' } }
    if ($c.act -eq 'undo') {   # the app's "Undo rewind" (shown until the next message)
      $u = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Undo rewind')); if (-not $u) { return @{ ok = $false; why = 'nothing to undo' } }
      [void](Press $u); Hold $fg0; Start-Sleep -Milliseconds 400; return @{ ok = $true; draft = (& $draft) }
    }
    $want = Norm $c.text; if (-not $want) { return @{ ok = $false; why = 'no message text' } }
    $key = if ($want.Length -gt 60) { $want.Substring(0, 60) } else { $want }
    $pre = 'Show message actions for You said: '
    $hits = @(); for ($k = 0; $k -lt 15 -and -not $hits.Count; $k++) {
      if ($k) { Start-Sleep -Milliseconds 120 }
      # the same text; or the app's label is the message's first sentence ("Rewind test 4." for "Rewind test 4. Reply ...") or
      # cut with an ellipsis; or the console's text was cut. Never an empty label, nor a prefix that ends mid-sentence
      # ("ok" must not match "ok, now rewind ...")
      $hits = @(Buttons $root | Where-Object { $n = try { [string]$_.Current.Name } catch { '' }; if (-not $n.StartsWith($pre)) { return $false }
        $l0 = Norm $n.Substring($pre.Length); $cut = $l0.EndsWith([string][char]0x2026); $l = $l0.TrimEnd([char]0x2026).TrimEnd()
        $l -and ($l -eq $want -or ($want.StartsWith($l) -and ($cut -or ($l -match '[.?!]$' -and $want.Substring($l.Length) -match '^\s'))) -or ($l.Length -ge 40 -and $l.StartsWith($key))) })
    }
    if (-not $hits.Count) { return @{ ok = $false; why = 'that message is not on the app page (rewound, or too far up?)' } }
    $i = $hits.Count - 1 - [int]$c.back; if ($i -lt 0) { $i = 0 }
    $mb = $hits[$i]; try { ([Windows.Automation.ScrollItemPattern]$mb.GetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern)).ScrollIntoView() } catch {}
    $nm = switch ([string]$c.act) { 'copy' { 'Copy' } 'fork' { 'Fork from here' } 'rewind' { 'Rewind to here' } default { '' } }
    # the bar the press opened: of the "Message actions" bars on the page, the one nearest the message's button (another
    # message's bar can be showing too); a busy page can take a while to show it, so the press is made once more after 2 s
    $b = $null
    for ($try = 0; $try -lt 2 -and -not $b; $try++) {
      if ($try) { try { ([Windows.Automation.ScrollItemPattern]$mb.GetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern)).ScrollIntoView() } catch {} }
      [void](Press $mb); Hold $fg0
      $my = try { $mb.Current.BoundingRectangle.Y } catch { 0 }
      for ($k = 0; $k -lt 25 -and -not $b; $k++) {
        Start-Sleep -Milliseconds 80
        $tb = @($root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::ToolBar) 'Message actions'))) | Sort-Object { [math]::Abs($_.Current.BoundingRectangle.Y - $my) } | Select-Object -First 1
        if ($tb) { $b = $tb.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $nm)) }
      }
    }
    if (-not $b) { return @{ ok = $false; why = "no '$nm' button" } }
    $before = if ($c.probe) { Names $root }
    Start-Sleep -Milliseconds 300; [void](Press $b); Hold $fg0
    if ($c.probe) {
      Start-Sleep -Milliseconds 1200; $after = Names $root
      $new = @($after.Keys | Where-Object { -not $before[$_] } | Sort-Object | Select-Object -First 40)
      $w = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Window) $null))
      $cancel = if ($w) { $w.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Cancel')) }
      if ($cancel) { [void](Press $cancel) }
      return @{ ok = $true; probe = $new; dialog = $(if ($w) { [string]$w.Current.Name } else { '' }); cancelled = [bool]$cancel; page = (PageTitle $root); draft = (& $draft) }
    }
    Start-Sleep -Milliseconds 400
    # a rewind puts the message's text in the app's reply box: taken out (returned as draft), so later sends are not blocked
    $d = & $draft
    if ($c.act -eq 'rewind' -and $d.Trim() -and $ed) { try { $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('') } catch {}; Hold $fg0 }
    @{ ok = $true; page = (PageTitle $root); draft = $d }
  }
}
# {title, files: [path], text}: Add > Add files or photos fills the Windows "Open" dialog per file (its name box and Open
# button are not in UIA: WM_SETTEXT on control 1148's Edit, BM_CLICK on control 1), then sends the text with the files
function Close-Dialogs($h) {   # the picker and any message box over it ("The file name is not valid")
  for ($k = 0; $k -lt 6; $k++) { $d = [W.U]::FileDialog($h); if ($d -eq [IntPtr]::Zero) { return }; [void][W.U]::PostMessage($d, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); Start-Sleep -Milliseconds 150 }
}
function Attach($c) {
  In-Session $c {
    $ed = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Edit) 'Prompt')); if (-not $ed) { return @{ ok = $false; why = 'no reply box' } }
    $vp = $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($vp.Current.Value.Trim()) { return @{ ok = $false; why = 'a draft is in its reply box' } }
    foreach ($f in @($c.files)) { $f = ([string]$f).Replace('/', '\'); if (-not (Test-Path -LiteralPath $f)) { return @{ ok = $false; why = "no file $f" } } }   # before any is added
    $n = 0
    foreach ($f in @($c.files)) {
      $f = ([string]$f).Replace('/', '\')   # the dialog calls forward slashes "not valid"
      if (-not (Test-Path -LiteralPath $f)) { return @{ ok = $false; why = "no file $f" } }
      $add = BarButton $root 'Add'; if (-not $add) { return @{ ok = $false; why = 'no Add button' } }
      [void](Press $add); $it = MenuItem $root 'Add files or photos'
      if (-not $it) { [void](KeyTo (Hwnd) '{ESC}'); return @{ ok = $false; why = "no 'Add files or photos'" } }
      Front $h; [void](Press $it); $dlg = $null   # the page opens its file picker only while its window has the focus
      $dh = [IntPtr]::Zero
      for ($k = 0; $k -lt 50 -and $dh -eq [IntPtr]::Zero; $k++) { Start-Sleep -Milliseconds 80; $dh = [W.U]::FileDialog($h) }
      if ($dh -eq [IntPtr]::Zero) { Hold $fg0; return @{ ok = $false; why = 'the file dialog did not open' } }
      Start-Sleep -Milliseconds 300; $box = [W.U]::GetDlgItem($dh, 1148)
      foreach ($cls in 'ComboBox', 'Edit') { $x = [W.U]::FindWindowEx($box, [IntPtr]::Zero, $cls, $null); if ($x -ne [IntPtr]::Zero) { $box = $x } }
      $open = [W.U]::GetDlgItem($dh, 1)
      if ($box -eq [IntPtr]::Zero -or $open -eq [IntPtr]::Zero) { Close-Dialogs $h; return @{ ok = $false; why = 'cannot fill the file dialog' } }
      [void][W.U]::SendMessage($box, 0x000C, [IntPtr]::Zero, ('"' + $f + '"')); Start-Sleep -Milliseconds 100   # WM_SETTEXT
      [void][W.U]::PostMessage($dh, 0x0111, [IntPtr]1, $open)                                                 # WM_COMMAND IDOK
      # done when the picker is gone; a message box over it (another #32770) means it refused the name
      for ($k = 0; $k -lt 40 -and [W.U]::IsWindow($dh); $k++) { Start-Sleep -Milliseconds 80; $d = [W.U]::FileDialog($h); if ($d -ne [IntPtr]::Zero -and $d -ne $dh) { break } }
      if ([W.U]::IsWindow($dh)) { Close-Dialogs $h; return @{ ok = $false; why = "the file dialog refused $f$(if ($n) { " ($n file(s) before it are in the app's reply box: remove them there)" })" } }
      Hold $fg0; Start-Sleep -Milliseconds 400; $n++
    }
    Start-Sleep -Milliseconds 600   # the composer redraws once the files are in; text set before that can be lost
    $t = ([string]$c.text).Trim()
    if ($t) { for ($k = 0; $k -lt 6; $k++) { $vp.SetValue($t); Hold $fg0; Start-Sleep -Milliseconds 150; if ($vp.Current.Value.Trim() -eq $t) { break } } }
    if ($t -and $vp.Current.Value.Trim() -ne $t) { return @{ ok = $false; why = 'the text did not go into the reply box' } }
    $b = $null
    for ($k = 0; $k -lt 40; $k++) { Start-Sleep -Milliseconds 80; $b = $root.FindFirst($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) 'Send')); if ($b -and $b.Current.IsEnabled) { break } }
    if (-not ($b -and $b.Current.IsEnabled)) { return @{ ok = $false; why = 'Send not available' } }
    # sent = the reply box empties; one more press if it has not after 2 s
    for ($n = 0; $n -lt 2; $n++) {
      [void](Press $b); Hold $fg0
      for ($k = 0; $k -lt 20; $k++) { Start-Sleep -Milliseconds 100; if (-not $vp.Current.Value.Trim()) { return @{ ok = $true } } }
      if (-not $t) { return @{ ok = $true } }
    }
    @{ ok = $false; why = 'Send did not take it' }
  }
}

# is another app's window over this screen point? (click-through windows are skipped; the desktop and our own windows are not cover)
function CoverAt($x, $y, $own) {
  $p = New-Object W.U+PT; $p.X = [int]$x; $p.Y = [int]$y
  $r = [W.U]::GetAncestor([W.U]::WindowFromPoint($p), 2); $pid2 = [uint32]0; $cls = ''
  if ($r -ne [IntPtr]::Zero) { [void][W.U]::GetWindowThreadProcessId2($r, [ref]$pid2); $sb = New-Object System.Text.StringBuilder 64; [void][W.U]::GetClassName($r, $sb, 64); $cls = $sb.ToString() }
  @{ covered = ($r -ne [IntPtr]::Zero -and $pid2 -ne [uint32]$own -and $cls -notin @('Progman', 'WorkerW')); cls = $cls }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = $null; $watch = $false; if ($line -match '^\s*\{"id":(\d+)') { $id = [int]$matches[1] }
  $res = try {
    $c = $line.Trim([char]0xFEFF, [char]0x20) | ConvertFrom-Json
    # the page-change log: the session the app shows before and after each action (main logs a difference)
    $watch = $c.cmd -in @('send', 'newsession', 'answer', 'permit', 'plan', 'settings', 'set', 'manage', 'msgact', 'commands', 'attach', 'invoke')
    $pb = if ($watch) { PageNow }
    switch ($c.cmd) {
      'snap' { Snap }
      # sidebar hidden: open it for a moment to read the lists, then hide it again
      'peek' {
        $root = Root; $show = if ($root) { Find $root 'Show sidebar' }
        if (-not $show) { Snap } else {
          [void](Press $show)
          for ($k = 0; $k -lt 20 -and -not (SidebarGroup $root); $k++) { Start-Sleep -Milliseconds 60 }
          Start-Sleep -Milliseconds 150
          $o = Snap; $hide = Find $root 'Hide sidebar'; if ($hide) { [void](Press $hide) }; $o.sidebar = $false; $o
        }
      }
      'invoke' { Invoke-Named $c.name }
      'place' { Place $c }
      'restore' { Restore $c }
      'state' { $h = Hwnd; @{ found = [bool]$h; visible = [bool]($h -and [W.U]::IsWindowVisible($h)) } }
      'sidebar' { $root = Root; $b = if ($root) { Find $root ($(if ($c.open) { 'Show sidebar' } else { 'Hide sidebar' })) }; @{ ok = [bool]($b -and (Press $b)) } }
      # the Artifacts page (open in the card): every artifact row has a "More options for <name>" button
      'artifacts' {
        $root = Root; $n = @()
        if ($root) { foreach ($e in $root.FindAll($TS::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)))) {
          $m = $e.Current.Name; if ($m -like 'More options for *') { $n += $m.Substring(17) } } }
        @{ ok = [bool]$root; names = $n }
      }
      'covered' { $o = CoverAt $c.x $c.y $c.pid; @{ ok = $true; covered = $o.covered; cls = $o.cls } }
      # several points at once: all = every one is covered
      'coveredPts' {
        $n = 0; $tot = 0
        foreach ($q in @($c.pts)) { $tot++; if ((CoverAt $q.x $q.y $c.pid).covered) { $n++ } }
        @{ ok = ($tot -gt 0); all = ($tot -gt 0 -and $n -eq $tot); n = $n }
      }
      # window to the bottom of the z-order (HWND_BOTTOM; NOSIZE | NOMOVE | NOACTIVATE)
      # a window just under another one (the live wallpaper under the folded sphere)
      'under' { $h = [IntPtr][int64]$c.hwnd; $a = [IntPtr][int64]$c.after; @{ ok = ([W.U]::IsWindow($h) -and [W.U]::IsWindow($a) -and [W.U]::SetWindowPos($h, $a, 0, 0, 0, 0, 0x13)) } }
      'bottom' { $h = [IntPtr][int64]$c.hwnd; @{ ok = ([W.U]::IsWindow($h) -and [W.U]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x13)) } }
      # Autonomy part 2: the composer's Usage button names the binding plan window ("Usage: Context ..., Weekly - all models: 86%,
      # Resets Mon 2:00 PM"); read only, nothing is pressed
      'usage' {
        $root = Root; $t = $null
        if ($root) { foreach ($e in $root.FindAll($TS::Descendants, (Cond ([Windows.Automation.ControlType]::Button) $null))) { $n = $e.Current.Name; if ($n -like 'Usage:*') { $t = $n; break } } }
        @{ ok = [bool]$t; text = $t; why = $(if (-not $root) { 'no Claude window' } elseif (-not $t) { 'no usage button' } else { '' }) }
      }
      'send' { Send-To $c }    # {title, text} or {title, stop:true}
      'newsession' { New-Session $c }   # {folder, model, text, worktree}
      'newprobe' { Probe-New $c }          # tests: the New session page's controls
      'answer' { Answer $c }            # {title, link, answers: [{picks: [{label, description}], other, multi}]}
      'permit' { Permit $c }            # {title, link, choice}
      'status' { Status }               # sidebar statuses
      'plan' { Plan $c }                # {title, link, choice: accept | auto | edits | bypass | revise | reject, text}
      'settings' { Settings $c }        # {title, link} -> { model, effort, mode, fast }
      'set' { Set-Setting $c }          # {title, link, what: mode | model | effort | fast, value}
      'manage' { Manage $c }            # {title, link, act: rename | fork | archive | delete, name}
      'msgact' { MsgAct $c }            # {title, link, text, back, act: copy | fork | rewind | undo, probe} -> { page, draft }
      'commands' { Commands $c }        # {title, link} -> { names } (the composer's / menu)
      'attach' { Attach $c }            # {title, link, files: [path], text}
      'hide' { $h = Hwnd; if ($h) { [void][W.U]::ShowWindow($h, 0) }; @{ ok = [bool]$h } }   # to the tray (setting: Keep the Claude app in the tray)
      'ping' { @{ ok = $true } }
      'open' { $root = Root; @{ ok = [bool]($root -and (Open-Session $root $c.title ([W.U]::GetForegroundWindow()) $c.link)) } }   # {title}: show that session and stay (tests)
      'msgs' { In-Session $c { @{ ok = $true; names = @(Buttons $root | ForEach-Object { try { [string]$_.Current.Name } catch { '' } } | Where-Object { $_ -like 'Show message actions*' }) } } }   # {title}: your messages' action buttons (tests)
      'page' { $root = Root; @{ ok = [bool]$root; page = $(if ($root) { PageTitle $root } else { '' }) } }   # the session the app shows (tests)
      'fg' { $f = [W.U]::GetForegroundWindow(); @{ claude = ($f -eq (Hwnd)); fg = [int64]$f; hw = [int64](Hwnd) } }
      default { @{ ok = $false; why = 'unknown' } }
    }
  } catch { @{ ok = $false; why = "$_ (line $($_.InvocationInfo.ScriptLineNumber))" } }
  if ($res -is [array]) { $res = if ($res.Count) { $res[-1] } else { $null } }
  if ($res -isnot [hashtable]) { $res = @{ ok = $false; why = 'bad reply' } }
  if ($watch) { $res['pages'] = @([string]$pb, [string](PageNow)); $watch = $false }
  $res['id'] = $id
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
