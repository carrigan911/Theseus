# Theseus audio + voice helper (one long-lived PowerShell with inline C#, started by audio.js with -MTA).
# Reads one JSON command per stdin line, writes one JSON reply per line (the reply repeats the command's "id").
# Pushed lines (no id) have an "event": state | command | listening | heard | error | ready.
#   {"cmd":"get"}                                      -> {"state":{out:{id,name,vol,mute},mic:{..},outs:[{id,name}],mics:[..]}}
#   {"cmd":"setDefault","dev":"<endpoint id>","role":"out"|"mic"}   all three roles (console, multimedia, communications)
#   {"cmd":"next","role":"out"|"mic","cycle":["id",..]}  -> next id in cycle (all active devices when empty); state + changed + picked
#   {"cmd":"volume","role":..,"value":0..1}  {"cmd":"mute","role":..,"value":true|false|"toggle"}
#   {"cmd":"listen","mode":"off"|"ptt"|"wake"|"always"}  voice commands (System.Speech, en-US, fixed grammar)
#   {"cmd":"ask","on":true}  questions: "Theseus" + anything not a command -> {"event":"question","wav":..,"sec":..}  (Voice Ask)
#   {"cmd":"follow","ms":8000}  for ms after an answer a phrase without the wake word is a question too (0 closes)
#   {"cmd":"testWav","path":"x.wav","mode":"always"}     recognise a wave file with the same grammar and rules (tests)
#   {"cmd":"testKey","down":true}  {"cmd":"testInput","path":"x.wav"|null}   (tests: simulated push-to-talk key, wave file instead of the mic)
#   {"cmd":"ping"}
# -Lite: no voice (listen answers ok:false); the safety refresh is off.
param([switch]$Lite, [string]$Wake = 'Theseus')   # -Wake: the assistant's name (the wake word)
try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
$src = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

namespace SsAudio
{
    enum EDataFlow { Render = 0, Capture = 1, All = 2 }
    enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey { public Guid fmtid; public int pid; public PropertyKey(Guid g, int p) { fmtid = g; pid = p; } }

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(EDataFlow flow, int stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        void RegisterEndpointNotificationCallback(IMMNotificationClient client);
        void UnregisterEndpointNotificationCallback(IMMNotificationClient client);
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out uint count);
        void Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object o);
        void OpenPropertyStore(int access, out IPropertyStore store);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out int count);
        void GetAt(int i, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
    }

    [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMNotificationClient
    {
        void OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, int state);
        void OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
        void OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
        void OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string id);
        void OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify(IAudioEndpointVolumeCallback cb);
        void UnregisterControlChangeNotify(IAudioEndpointVolumeCallback cb);
        void GetChannelCount(out uint n);
        void SetMasterVolumeLevel(float db, ref Guid ctx);
        void SetMasterVolumeLevelScalar(float v, ref Guid ctx);
        void GetMasterVolumeLevel(out float db);
        void GetMasterVolumeLevelScalar(out float v);
        void SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
        void SetChannelVolumeLevelScalar(uint ch, float v, ref Guid ctx);
        void GetChannelVolumeLevel(uint ch, out float db);
        void GetChannelVolumeLevelScalar(uint ch, out float v);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolumeCallback { void OnNotify(IntPtr data); }

    // undocumented, stable since Windows 7 (SoundSwitch / EarTrumpet use it)
    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        void GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr f);
        void GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int def, IntPtr f);
        void ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        void SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a, IntPtr b);
        void GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int def, IntPtr a, IntPtr b);
        void SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a);
        void GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a);
        void SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a);
        void GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr k, IntPtr v);
        void SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr k, IntPtr v);
        void SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, ERole role);
        void SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }
    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClientCo { }

    // ---- output: every line to stdout goes through one lock (events come from several threads) ----
    public static class J
    {
        static readonly object L = new object();
        public static void Line(string s) { lock (L) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
        public static string S(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
        public static string N(double d) { return Math.Round(d, 3).ToString("0.###", CultureInfo.InvariantCulture); }
        public static string F(float f) { return f.ToString("R", CultureInfo.InvariantCulture); }
        public static string B(bool b) { return b ? "true" : "false"; }
        public static void Reply(object id, string tail)
        {
            Line("{\"id\":" + (id == null ? "null" : Convert.ToString(id, CultureInfo.InvariantCulture)) + ",\"ok\":true" + (string.IsNullOrEmpty(tail) ? "" : "," + tail) + "}");
        }
        public static void Fail(object id, string why)
        {
            Line("{\"id\":" + (id == null ? "null" : Convert.ToString(id, CultureInfo.InvariantCulture)) + ",\"ok\":false,\"why\":" + S(why) + "}");
        }
    }

    class Dev { public string Id, Name; }

    class Ep
    {
        public bool Capture; public string Id = ""; public string Name = ""; public float Vol; public bool Mute;
        public IAudioEndpointVolume V;
        public Ep(bool capture) { Capture = capture; }
    }

    // Windows' callbacks (any thread): only raise a flag for the worker, never call back into the audio API from here
    class Notify : IMMNotificationClient, IAudioEndpointVolumeCallback
    {
        public void OnDeviceStateChanged(string id, int state) { Core.Dirty(false); }
        public void OnDeviceAdded(string id) { Core.Dirty(false); }
        public void OnDeviceRemoved(string id) { Core.Dirty(false); }
        public void OnDefaultDeviceChanged(EDataFlow flow, ERole role, string id) { Core.Dirty(flow == EDataFlow.Capture && role == ERole.Multimedia); }
        public void OnPropertyValueChanged(string id, PropertyKey key) { }
        public void OnNotify(IntPtr data) { Core.Dirty(false); }
    }

    public static class Core
    {
        static readonly object sync = new object();
        static readonly PropertyKey FriendlyName = new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
        static Guid VolIid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static Guid Ctx = Guid.Empty;
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);

        static IMMDeviceEnumerator en;
        static Notify notify;
        static readonly Ep EOut = new Ep(false), EMic = new Ep(true);
        static List<Dev> outs = new List<Dev>(), mics = new List<Dev>();
        static string lastJson = "";
        static readonly AutoResetEvent wake = new AutoResetEvent(false);
        static volatile bool micDefaultChanged, quit;
        static bool lite;
        public static bool LastChanged; public static string LastPicked = "";

        public static void Init(bool isLite)
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.MTA) throw new Exception("helper must run in an MTA PowerShell (-MTA)");
            lite = isLite;
            en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
            notify = new Notify();
            Refresh(false);
            en.RegisterEndpointNotificationCallback(notify);
            var t = new Thread(Worker); t.IsBackground = true; t.Name = "audio-worker"; t.Start();
        }

        public static void Shutdown()
        {
            quit = true; wake.Set();
            try { Voice.Teardown(); } catch { }
            try { en.UnregisterEndpointNotificationCallback(notify); } catch { }
            lock (sync) { Unhook(EOut); Unhook(EMic); }
        }

        public static void Dirty(bool micDefault) { if (micDefault) micDefaultChanged = true; wake.Set(); }

        // change events -> one refresh after a short pause (a default switch fires several callbacks); a slow safety refresh as well
        static void Worker()
        {
            while (!quit)
            {
                bool sig = wake.WaitOne(lite ? Timeout.Infinite : 10000);
                if (quit) break;
                if (sig) Thread.Sleep(60);
                try { Refresh(true); } catch (Exception ex) { J.Line("{\"event\":\"error\",\"where\":\"refresh\",\"why\":" + J.S(ex.Message) + "}"); }
                if (micDefaultChanged) { micDefaultChanged = false; try { Voice.Rebind(); } catch { } }
            }
        }

        static string NameOf(IMMDevice d)
        {
            IPropertyStore ps; d.OpenPropertyStore(0, out ps);
            PropertyKey k = FriendlyName; PropVariant v;
            ps.GetValue(ref k, out v);
            string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "?";
            PropVariantClear(ref v);
            Marshal.ReleaseComObject(ps);
            return s;
        }

        static List<Dev> Devices(bool capture)
        {
            var list = new List<Dev>();
            IMMDeviceCollection col; en.EnumAudioEndpoints(capture ? EDataFlow.Capture : EDataFlow.Render, 1, out col); // active only
            uint n; col.GetCount(out n);
            for (uint i = 0; i < n; i++)
            {
                IMMDevice d; col.Item(i, out d); string id; d.GetId(out id);
                list.Add(new Dev { Id = id, Name = NameOf(d) });
                Marshal.ReleaseComObject(d);
            }
            Marshal.ReleaseComObject(col);
            return list;
        }

        static void Unhook(Ep e)
        {
            if (e.V != null) { try { e.V.UnregisterControlChangeNotify(notify); } catch { } e.V = null; }
        }

        static void Load(Ep e)
        {
            IMMDevice d = null;
            try { en.GetDefaultAudioEndpoint(e.Capture ? EDataFlow.Capture : EDataFlow.Render, ERole.Multimedia, out d); } catch { }
            if (d == null) { Unhook(e); e.Id = ""; e.Name = ""; e.Vol = 0; e.Mute = false; return; }
            string id; d.GetId(out id);
            if (id != e.Id || e.V == null)
            {
                Unhook(e); e.Id = id;
                try
                {
                    object o; d.Activate(ref VolIid, 23, IntPtr.Zero, out o);
                    e.V = (IAudioEndpointVolume)o; e.V.RegisterControlChangeNotify(notify);
                }
                catch { e.V = null; }
            }
            e.Name = NameOf(d);
            Marshal.ReleaseComObject(d);
            e.Vol = 0; e.Mute = false;
            if (e.V != null) { try { float v; e.V.GetMasterVolumeLevelScalar(out v); e.Vol = v; bool m; e.V.GetMute(out m); e.Mute = m; } catch { } }
        }

        static string EpJ(Ep e)
        {
            return "{\"id\":" + J.S(e.Id) + ",\"name\":" + J.S(e.Name) + ",\"vol\":" + J.F(e.Vol) + ",\"mute\":" + J.B(e.Mute) + "}";
        }
        static string DevsJ(List<Dev> l)
        {
            var sb = new StringBuilder("[");
            for (int i = 0; i < l.Count; i++) { if (i > 0) sb.Append(','); sb.Append("{\"id\":").Append(J.S(l[i].Id)).Append(",\"name\":").Append(J.S(l[i].Name)).Append('}'); }
            return sb.Append(']').ToString();
        }

        // re-reads Windows; pushes a "state" line when asked and when something changed since the last state seen (reply or event)
        static string Refresh(bool emit)
        {
            string json; bool changed;
            lock (sync)
            {
                Load(EOut); Load(EMic); outs = Devices(false); mics = Devices(true);
                json = "{\"out\":" + EpJ(EOut) + ",\"mic\":" + EpJ(EMic) + ",\"outs\":" + DevsJ(outs) + ",\"mics\":" + DevsJ(mics) + "}";
                changed = json != lastJson; lastJson = json;
            }
            if (changed && emit) J.Line("{\"event\":\"state\",\"state\":" + json + "}");
            return json;
        }

        static Ep Pick(string role)
        {
            if (role == "out") return EOut;
            if (role == "mic") return EMic;
            throw new Exception("role must be out or mic");
        }

        public static string Get() { return Refresh(false); }

        public static string SetDefault(string dev, string role)
        {
            lock (sync)
            {
                Ep e = Pick(role);
                var list = Devices(e.Capture);
                bool found = false; foreach (var d in list) if (string.Equals(d.Id, dev, StringComparison.OrdinalIgnoreCase)) { found = true; dev = d.Id; }
                if (!found) throw new Exception("device not found or not active");
                var pc = (IPolicyConfig)new PolicyConfigClientCo();
                try
                {
                    pc.SetDefaultEndpoint(dev, ERole.Console);
                    pc.SetDefaultEndpoint(dev, ERole.Multimedia);
                    pc.SetDefaultEndpoint(dev, ERole.Communications);
                }
                finally { Marshal.ReleaseComObject(pc); }
                return Refresh(false);
            }
        }

        public static string Next(string role, string[] ids)
        {
            lock (sync)
            {
                Ep e = Pick(role);
                Refresh(false);
                var active = e.Capture ? mics : outs;
                var pool = new List<Dev>();
                if (ids == null || ids.Length == 0) pool = active;
                else foreach (var id in ids) foreach (var d in active) if (string.Equals(d.Id, id, StringComparison.OrdinalIgnoreCase)) pool.Add(d);
                LastChanged = false; LastPicked = e.Id;
                if (pool.Count == 0) throw new Exception("no active device in the cycle list");
                int at = pool.FindIndex(d => string.Equals(d.Id, e.Id, StringComparison.OrdinalIgnoreCase));
                var next = pool[(at + 1) % pool.Count];
                if (next.Id == e.Id) return lastJson;
                string s = SetDefault(next.Id, role);
                LastChanged = true; LastPicked = next.Id;
                return s;
            }
        }

        public static string SetVolume(string role, double v)
        {
            lock (sync)
            {
                Ep e = Pick(role);
                if (e.V == null) throw new Exception("no volume control on this device");
                v = Math.Max(0, Math.Min(1, v));
                e.V.SetMasterVolumeLevelScalar((float)v, ref Ctx);
                return Refresh(false);
            }
        }

        // mode: 0 unmute, 1 mute, 2 toggle
        public static string SetMute(string role, int mode)
        {
            lock (sync)
            {
                Ep e = Pick(role);
                if (e.V == null) throw new Exception("no mute control on this device");
                bool cur; e.V.GetMute(out cur);
                e.V.SetMute(mode == 2 ? !cur : mode == 1, ref Ctx);
                return Refresh(false);
            }
        }
    }

    // ---- voice commands ----
    public static class Voice
    {
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

        static readonly string[][] Table = {
            new[] { "system status", "status", "" },
            new[] { "mute mic", "muteMic", "" }, new[] { "mute microphone", "muteMic", "" },
            new[] { "unmute mic", "unmuteMic", "" }, new[] { "unmute microphone", "unmuteMic", "" },
            new[] { "next output", "nextOut", "" }, new[] { "next mic", "nextMic", "" }, new[] { "next microphone", "nextMic", "" },
            new[] { "start recording", "recStart", "" }, new[] { "stop recording", "recStop", "" },
            new[] { "save replay", "saveReplay", "" },
            new[] { "screenshot", "screenshot", "" }, new[] { "take a screenshot", "screenshot", "" },
            new[] { "stop talking", "hush", "" }, new[] { "be quiet", "hush", "" }, new[] { "quiet please", "hush", "" },
            new[] { "shush", "hush", "" }, new[] { "that's enough", "hush", "" }, new[] { "shut up", "hush", "" },
            new[] { "that's all", "chatEnd", "" }, new[] { "thanks that's all", "chatEnd", "" }, new[] { "goodbye", "chatEnd", "" },
            new[] { "bye", "chatEnd", "" }, new[] { "stop listening", "chatEnd", "" },
            new[] { "mode normal", "mode", "normal" }, new[] { "mode worker", "mode", "worker" },
            new[] { "mode night", "mode", "night" }, new[] { "mode weekend", "mode", "weekend" },
            new[] { "mode max performance", "mode", "performance" }, new[] { "mode max efficiency", "mode", "efficiency" }
        };
        public static string Wake = "Theseus";   // set from -Wake / the wake command before the grammar is built
        // the phrase begins with the wake word (the assistant's name, any case)
        static bool IsWake(string t) { return (t ?? "").Trim().StartsWith(Wake, StringComparison.OrdinalIgnoreCase); }
        // minimum confidence to act per mode (always on is 0.6 by spec; the others are engine-gated and need only a low floor)
        public static double MinAlways = 0.6, MinWake = 0.5, MinPtt = 0.4;
        public const int TailMs = 400;

        static readonly object vl = new object();
        static string mode = "off";
        static SpeechRecognitionEngine eng;
        static bool active, stopping, wantOpen, wakeOn;
        static string testInput;
        public static volatile bool TestKey;
        static Thread poller; static volatile bool pollRun;

        static Grammar MakeGrammar(string m)
        {
            var ch = new Choices();
            foreach (var r in Table) ch.Add(r[0]);
            var gb = new GrammarBuilder();
            if (m == "wake") gb.Append(Wake); else gb.Append(Wake, 0, 1);
            gb.Append(ch);
            var g = new Grammar(gb); g.Name = "theseus-" + m;
            return g;
        }

        static bool Parse(string text, out string cmd, out string arg)
        {
            cmd = null; arg = "";
            string t = (text ?? "").Trim().ToLowerInvariant();
            if (IsWake(t)) t = t.Substring(Wake.Length).Trim();
            foreach (var r in Table) if (r[0] == t) { cmd = r[1]; arg = r[2]; return true; }
            return false;
        }

        static double MinFor(string m) { return m == "always" ? MinAlways : m == "wake" ? MinWake : MinPtt; }

        // Voice Ask: "Theseus" + anything that is not a command (push-to-talk: any phrase) is a question for Claude; its audio
        // goes to a wave file for Whisper. Follow-up: for a while after an answer a phrase without the wake word counts too
        public static volatile bool AskOn;
        public const double SureCmd = 0.85;   // a command under this goes past Whisper first (with Ask on)
        public const double MinQuestionS = 1.2;   // "Theseus" alone is about 0.8 s
        static DateTime followUntil = DateTime.MinValue;
        static Grammar qFree, chatG; static Timer followT; static DateTime wakeHint = DateTime.MinValue;

        static SpeechRecognitionEngine NewEngine(string m) { Grammar f, c; return NewEngine(m, out f, out c); }
        static SpeechRecognitionEngine NewEngine(string m, out Grammar free, out Grammar chat)
        {
            var e = new SpeechRecognitionEngine(new CultureInfo("en-US"));
            var g = MakeGrammar(m); g.Priority = 1;          // a known command beats a question
            e.LoadGrammar(g);
            free = null; chat = null;
            // voice chat (VoiceChat_Spec): in wake mode the commands also work without the wake word while the follow window is open
            if (m == "wake") { chat = MakeGrammar("chat"); chat.Name = "theseus-chat"; chat.Priority = 1; chat.Enabled = DateTime.UtcNow < followUntil; e.LoadGrammar(chat); }
            if (AskOn)
            {
                var gb = new GrammarBuilder();
                if (m == "ptt") gb.Append(Wake, 0, 1); else gb.Append(Wake);
                gb.AppendWildcard();
                e.LoadGrammar(new Grammar(gb) { Name = "theseus-q", Priority = 0 });
                if (m != "ptt")
                {
                    var fb = new GrammarBuilder(); fb.AppendWildcard();
                    free = new Grammar(fb) { Name = "theseus-qf", Priority = -1, Enabled = DateTime.UtcNow < followUntil };
                    e.LoadGrammar(free);
                }
                e.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(1000);   // a question ends after about a second of quiet
            }
            return e;
        }

        public static void SetAsk(bool on)
        {
            if (AskOn == on) return;
            AskOn = on;
            string m; lock (vl) { m = mode; }
            if (m != "off") Listen(m);
        }

        // follow-up window: phrases without the wake word count as questions for ms (0 closes it)
        public static void Follow(int ms)
        {
            lock (vl)
            {
                followUntil = DateTime.UtcNow.AddMilliseconds(Math.Max(0, ms));
                if (qFree != null) qFree.Enabled = AskOn && ms > 0;
                if (chatG != null) chatG.Enabled = ms > 0;
                if (followT != null) followT.Dispose();
                followT = ms > 0 ? new Timer(delegate { lock (vl) { if (DateTime.UtcNow >= followUntil) { if (qFree != null) qFree.Enabled = false; if (chatG != null) chatG.Enabled = false; } } }, null, ms + 50, Timeout.Infinite) : null;
            }
        }

        // a question: long enough and heard well enough -> its audio in %TEMP%\SessionSphere\q_<ticks>.wav
        static string Question(RecognitionResult r, string m, out double sec)
        {
            var a = r.Audio; sec = a == null ? 0 : a.Duration.TotalSeconds;
            if (a == null || sec < MinQuestionS || r.Confidence < MinFor(m) * 0.75) return null;
            string dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "SessionSphere");
            System.IO.Directory.CreateDirectory(dir);
            string p = System.IO.Path.Combine(dir, "q_" + DateTime.UtcNow.Ticks + ".wav");
            using (var fs = System.IO.File.Create(p)) a.WriteToWaveStream(fs);
            return p;
        }
        static bool IsQuestion(RecognitionResult r) { return r.Grammar != null && r.Grammar.Name != null && r.Grammar.Name.StartsWith("theseus-q"); }

        static void SetInput(SpeechRecognitionEngine e)
        {
            if (testInput != null) e.SetInputToWaveFile(testInput); else e.SetInputToDefaultAudioDevice();
        }

        static void Listening(bool on) { J.Line("{\"event\":\"listening\",\"on\":" + J.B(on) + "}"); }

        public static string Listen(string m)
        {
            if (m != "off" && m != "ptt" && m != "wake" && m != "always") throw new Exception("mode must be off, ptt, wake or always");
            StopPoller();
            lock (vl)
            {
                Teardown();
                mode = m;
                if (m == "off") return "\"mode\":\"off\"";
                eng = NewEngine(m, out qFree, out chatG);
                var me = eng;
                me.SpeechRecognized += OnRecognized;
                me.SpeechRecognitionRejected += OnRejected;
                me.SpeechHypothesized += OnHypothesis;
                me.RecognizeCompleted += OnCompleted;
                if (m == "ptt") StartPoller(); else { try { StartRec(); } catch { Teardown(); mode = "off"; throw; } }
            }
            return "\"mode\":" + J.S(m);
        }

        // caller holds vl; opens the mic (or the test file) and starts recognising
        static void StartRec()
        {
            if (eng == null) return;
            wantOpen = true;
            if (stopping || active) return;
            SetInput(eng);
            eng.RecognizeAsync(RecognizeMode.Multiple);
            active = true;
        }

        // caller holds vl; finishes the utterance in progress, then OnCompleted lets the mic go
        static void StopRec()
        {
            wantOpen = false;
            if (eng == null || !active || stopping) return;
            stopping = true;
            try { eng.RecognizeAsyncStop(); } catch { stopping = false; active = false; }
        }

        public static void Teardown()
        {
            StopPoller();
            bool was;
            lock (vl)
            {
                was = wakeOn || (mode == "ptt" && (wantOpen || active));
                var e = eng; eng = null;
                if (e != null)
                {
                    e.SpeechRecognized -= OnRecognized; e.SpeechRecognitionRejected -= OnRejected; e.SpeechHypothesized -= OnHypothesis; e.RecognizeCompleted -= OnCompleted;
                    try { if (active) e.RecognizeAsyncCancel(); } catch { }
                    try { e.SetInputToNull(); } catch { }
                    try { e.Dispose(); } catch { }
                }
                active = false; stopping = false; wantOpen = false; wakeOn = false; mode = "off";
            }
            if (was) Listening(false);
        }

        // default mic changed under a running always / wake recogniser: bind to the new one
        public static void Rebind()
        {
            string m;
            lock (vl) { m = mode; if (testInput != null || (m != "always" && m != "wake") || eng == null) return; }
            Listen(m);
        }

        static void OnHypothesis(object s, SpeechHypothesizedEventArgs e)
        {
            lock (vl)
            {
                if (s != eng) return;
                bool th = IsWake(e.Result.Text);
                if (th && AskOn && DateTime.UtcNow > wakeHint) { wakeHint = DateTime.UtcNow.AddSeconds(5); J.Line("{\"event\":\"wake\"}"); }   // Voice Ask: warm Whisper up
                if (mode != "wake" || wakeOn) return;
                if (th) { wakeOn = true; Listening(true); }
            }
        }

        static void OnRejected(object s, SpeechRecognitionRejectedEventArgs e)
        {
            lock (vl)
            {
                if (s != eng) return;
                if (wakeOn) { wakeOn = false; Listening(false); }
            }
        }

        static void OnRecognized(object s, SpeechRecognizedEventArgs e)
        {
            string m;
            lock (vl)
            {
                if (s != eng) return;
                m = mode;
                if (wakeOn) { wakeOn = false; Listening(false); }
            }
            if (IsQuestion(e.Result))
            {
                double sec; string wav = Question(e.Result, m, out sec);
                J.Line(wav == null
                    ? "{\"event\":\"heard\",\"question\":true,\"text\":" + J.S(e.Result.Text) + ",\"sec\":" + J.N(sec) + ",\"confidence\":" + J.N(e.Result.Confidence) + ",\"accepted\":false}"
                    : "{\"event\":\"question\",\"wav\":" + J.S(wav) + ",\"sec\":" + J.N(sec) + ",\"confidence\":" + J.N(e.Result.Confidence) + ",\"follow\":" + J.B(e.Result.Grammar.Name == "theseus-qf") + "}");
                return;
            }
            string cmd, arg;
            if (!Parse(e.Result.Text, out cmd, out arg)) return;
            double conf = e.Result.Confidence;
            string txt = e.Result.Text;
            bool viaChat = e.Result.Grammar != null && e.Result.Grammar.Name == "theseus-chat";
            if (conf < (viaChat ? MinAlways : MinFor(m))) { J.Line("{\"event\":\"heard\",\"text\":" + J.S(txt) + ",\"confidence\":" + J.N(conf) + ",\"accepted\":false}"); return; }
            // wake: the phrase began with the wake word (always mode accepts phrases with or without it; main acts on stop / save only with it)
            bool wk = IsWake(txt);
            // not sure of it (the grammar picks its nearest phrase: "start a new session" came out "screenshot" at 0.69): with
            // Ask on, Whisper hears it first and main runs the guess only if Whisper agrees (or cannot answer)
            if (AskOn && conf < SureCmd && cmd != "hush" && e.Result.Audio != null)   // a wrong hush only ends speech: no check, no delay
            {
                string dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "SessionSphere"); System.IO.Directory.CreateDirectory(dir);
                string p = System.IO.Path.Combine(dir, "q_" + DateTime.UtcNow.Ticks + ".wav");
                using (var fs = System.IO.File.Create(p)) e.Result.Audio.WriteToWaveStream(fs);
                J.Line("{\"event\":\"question\",\"wav\":" + J.S(p) + ",\"sec\":" + J.N(e.Result.Audio.Duration.TotalSeconds) + ",\"confidence\":" + J.N(conf) + ",\"follow\":false,\"guess\":{\"cmd\":" + J.S(cmd) + ",\"arg\":" + J.S(arg) + ",\"text\":" + J.S(txt) + ",\"confidence\":" + J.N(conf) + ",\"wake\":" + J.B(wk) + "}}");
                return;
            }
            J.Line("{\"event\":\"command\",\"cmd\":" + J.S(cmd) + (arg != "" ? ",\"arg\":" + J.S(arg) : "") + ",\"text\":" + J.S(txt) + ",\"confidence\":" + J.N(conf) + ",\"wake\":" + J.B(wk) + (viaChat ? ",\"chat\":true" : "") + "}");
        }

        // recognition ended: the stop we asked for (ptt key released), or the end of a wave file; the mic is let go
        static void OnCompleted(object s, RecognizeCompletedEventArgs e)
        {
            lock (vl)
            {
                if (s != eng) return;
                active = false;
                try { eng.SetInputToNull(); } catch { }
                bool again = stopping && wantOpen;
                stopping = false;
                if (again) { try { StartRec(); } catch { } }
            }
        }

        static void StartPoller()
        {
            pollRun = true;
            poller = new Thread(Poll); poller.IsBackground = true; poller.Name = "ptt-poll"; poller.Start();
        }
        static void StopPoller()
        {
            var t = poller; pollRun = false;
            if (t != null && t != Thread.CurrentThread) { try { t.Join(3000); } catch { } }
            poller = null;
        }

        static bool KeyDown()
        {
            if (TestKey) return true;
            return (GetAsyncKeyState(0xA3) & 0x8000) != 0 && (GetAsyncKeyState(0x12) & 0x8000) == 0 && (GetAsyncKeyState(0x10) & 0x8000) == 0;   // Right Ctrl alone (Ctrl+Alt+Space is Claude's quick entry)
        }

        // ptt: the mic is open from the key press until TailMs after the release (the engine finishes the last words)
        static void Poll()
        {
            bool was = false; DateTime tail = DateTime.MinValue; bool tailing = false;
            while (pollRun)
            {
                bool down = KeyDown();
                try
                {
                    if (down && !was)
                    {
                        lock (vl) { if (eng == null || mode != "ptt") break; tailing = false; StartRec(); }
                        Listening(true);
                    }
                    else if (!down && was) { tailing = true; tail = DateTime.UtcNow.AddMilliseconds(TailMs); }
                    else if (down && tailing) tailing = false;
                    if (tailing && DateTime.UtcNow >= tail)
                    {
                        tailing = false;
                        lock (vl) { StopRec(); }
                        Listening(false);
                    }
                }
                catch (Exception ex) { J.Line("{\"event\":\"error\",\"where\":\"ptt\",\"why\":" + J.S(ex.Message) + "}"); }
                was = down;
                Thread.Sleep(30);
            }
        }

        public static void SetTestKey(bool down) { TestKey = down; }
        public static void SetTestInput(string path) { lock (vl) { testInput = string.IsNullOrEmpty(path) ? null : path; } }

        // recognise a wave file with the grammar and thresholds of a mode (own engine, the mic is not touched)
        public static string TestWav(string path, string m)
        {
            if (m != "ptt" && m != "wake" && m != "always") throw new Exception("mode must be ptt, wake or always");
            var results = new List<string>(); var rejected = new List<string>();
            using (var e = NewEngine(m))
            {
                e.SpeechRecognitionRejected += delegate(object s, SpeechRecognitionRejectedEventArgs a) { rejected.Add(J.S(a.Result == null ? "" : a.Result.Text)); };
                e.SetInputToWaveFile(path);
                for (int i = 0; i < 12; i++)
                {
                    RecognitionResult r = null;
                    try { r = e.Recognize(); } catch (InvalidOperationException) { break; }     // the stream is used up
                    if (r == null) break;
                    if (IsQuestion(r))
                    {
                        double sec; string wav = Question(r, m, out sec);
                        results.Add("{\"question\":true,\"wav\":" + J.S(wav) + ",\"text\":" + J.S(r.Text) + ",\"sec\":" + J.N(sec) + ",\"confidence\":" + J.N(r.Confidence) + ",\"grammar\":" + J.S(r.Grammar.Name) + "}");
                        continue;
                    }
                    string cmd, arg; bool known = Parse(r.Text, out cmd, out arg);
                    string gn = r.Grammar == null ? "" : r.Grammar.Name;
                    bool ok = known && r.Confidence >= (gn == "theseus-chat" ? MinAlways : MinFor(m));
                    results.Add("{\"cmd\":" + J.S(cmd) + ",\"arg\":" + J.S(arg) + ",\"text\":" + J.S(r.Text) + ",\"confidence\":" + J.N(r.Confidence) + ",\"wake\":" + J.B(IsWake(r.Text)) + ",\"accepted\":" + J.B(ok) + ",\"grammar\":" + J.S(gn) + "}");
                }
            }
            return "\"results\":[" + string.Join(",", results.ToArray()) + "],\"rejected\":[" + string.Join(",", rejected.ToArray()) + "]";
        }
        // the command phrases (Voice Ask: a question whose transcript is a command runs the command)
        public static string Phrases() { var l = new List<string>(); foreach (var r in Table) l.Add("[" + J.S(r[0]) + "," + J.S(r[1]) + "," + J.S(r[2]) + "]"); return "\"phrases\":[" + string.Join(",", l.ToArray()) + "]"; }
        public static string Info() { lock (vl) { return "\"mode\":" + J.S(mode) + ",\"active\":" + J.B(active) + ",\"wantOpen\":" + J.B(wantOpen); } }
    }
}
'@
# compiled once into %TEMP%\SessionSphere (keyed by the source); a unique temp name per process + a move keeps two helpers
# starting together from clobbering each other
$loaded = $false
try {
  $key = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($src))).Replace('-', '').Substring(0, 12)
  $dir = Join-Path $env:TEMP 'SessionSphere'; $dll = Join-Path $dir "audio_$key.dll"
  if (-not (Test-Path $dll)) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    $tmp = Join-Path $dir "audio_$key.$PID.tmp"
    Add-Type -TypeDefinition $src -ReferencedAssemblies System.Speech -OutputAssembly $tmp -OutputType Library
    try { Move-Item $tmp $dll -ErrorAction Stop } catch { Remove-Item $tmp -ErrorAction SilentlyContinue }
    Get-ChildItem $dir -Filter 'audio_*.dll' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "audio_$key.dll" } | ForEach-Object { Remove-Item $_.FullName -ErrorAction SilentlyContinue }
  }
  Add-Type -Path $dll; $loaded = $true
} catch {}
if (-not $loaded) { Add-Type -TypeDefinition $src -ReferencedAssemblies System.Speech }

if ($Wake) { [SsAudio.Voice]::Wake = $Wake }
try { [SsAudio.Core]::Init([bool]$Lite) } catch { [SsAudio.J]::Line('{"event":"error","where":"init","why":' + [SsAudio.J]::S("$_") + '}'); exit 1 }
[SsAudio.J]::Line('{"event":"ready","lite":' + $(if ($Lite) { 'true' } else { 'false' }) + '}')

function Role($c) { [string]$c.role }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = $null
  try {
    $c = $line.Trim([char]0xFEFF, [char]0x20) | ConvertFrom-Json
    $id = $c.id
    $tail = switch ($c.cmd) {
      'get' { '"state":' + [SsAudio.Core]::Get() }
      'setDefault' { '"state":' + [SsAudio.Core]::SetDefault([string]$c.dev, (Role $c)) }
      'next' {
        $s = [SsAudio.Core]::Next((Role $c), [string[]]@($c.cycle | Where-Object { $_ }))
        '"state":' + $s + ',"changed":' + $(if ([SsAudio.Core]::LastChanged) { 'true' } else { 'false' }) + ',"picked":' + [SsAudio.J]::S([SsAudio.Core]::LastPicked)
      }
      'volume' { '"state":' + [SsAudio.Core]::SetVolume((Role $c), [double]$c.value) }
      'mute' {
        $m = if ($c.value -is [string]) { 2 } elseif ($c.value) { 1 } else { 0 }
        '"state":' + [SsAudio.Core]::SetMute((Role $c), $m)
      }
      'listen' { if ($Lite) { throw 'lite helper has no voice' }; [SsAudio.Voice]::Listen([string]$c.mode) }
      'testWav' { if ($Lite) { throw 'lite helper has no voice' }; [SsAudio.Voice]::TestWav([string]$c.path, [string]$c.mode) }
      'wake' { [SsAudio.Voice]::Wake = [string]$c.name; '' }   # takes effect at the next listen
      'ask' { if ($Lite) { throw 'lite helper has no voice' }; [SsAudio.Voice]::SetAsk([bool]$c.on); '' }
      'follow' { [SsAudio.Voice]::Follow([int]$c.ms); '' }
      'phrases' { [SsAudio.Voice]::Phrases() }
      'testKey' { [SsAudio.Voice]::SetTestKey([bool]$c.down); '"down":' + $(if ($c.down) { 'true' } else { 'false' }) }
      'testInput' { [SsAudio.Voice]::SetTestInput([string]$c.path); '' }
      'voice' { [SsAudio.Voice]::Info() }
      'ping' { '"apt":"' + [Threading.Thread]::CurrentThread.GetApartmentState() + '"' }
      default { throw "unknown command" }
    }
    [SsAudio.J]::Reply($id, [string]$tail)
  } catch { $m = "$_"; if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }; [SsAudio.J]::Fail($id, $m) }
}
[SsAudio.Core]::Shutdown()
