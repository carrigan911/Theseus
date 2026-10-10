# Built-in voice (PublicVersion_Spec): speaks lines with the Windows voices (System.Speech) when the External voice add-on
# is off. One long-lived process; JSON lines in, one reply per line out:
#   {"id":1,"cmd":"say","text":"...","rate":0,"voice":""}  -> {"id":1,"ok":true} after the line has played
#   {"id":2,"cmd":"voices"}                                -> {"id":2,"ok":true,"voices":[...]}
# While a line plays it keeps <State>\speaking_<pid>.flag (playback start, Unix ms) and .txt (the line), the same talking
# state EchoStatus writes, so the core's glow and the caption work the same.
param([string]$State)
try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
Add-Type -AssemblyName System.Speech
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
$syn.SetOutputToDefaultAudioDevice()
if ($State) { New-Item -ItemType Directory -Force $State | Out-Null }
$base = if ($State) { Join-Path $State "speaking_$PID" } else { '' }
[Console]::Out.WriteLine('{"event":"ready"}'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $c = $line.Trim([char]0xFEFF, [char]0x20) | ConvertFrom-Json } catch { continue }
  $res = @{ id = $c.id; ok = $true }
  try {
    switch ([string]$c.cmd) {
      'voices' { $res.voices = @($syn.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }) }
      'say' {
        if ($c.voice) { try { $syn.SelectVoice([string]$c.voice) } catch {} }
        $syn.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$c.rate))
        if ($base) {
          [IO.File]::WriteAllText("$base.txt", [string]$c.text)
          [IO.File]::WriteAllText("$base.flag", [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        }
        try { $syn.SetOutputToDefaultAudioDevice(); $syn.Speak([string]$c.text) }
        finally { if ($base) { Remove-Item "$base.flag", "$base.txt" -ErrorAction SilentlyContinue } }
      }
      default { $res.ok = $false; $res.why = 'unknown' }
    }
  } catch { $res.ok = $false; $res.why = "$_" }
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}
