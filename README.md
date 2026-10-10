# Session Sphere

A desktop sphere of your Claude Code sessions, for Windows.

![Session Sphere with demo sessions](docs/screenshot.png)

**Unofficial.** Session Sphere is not made, endorsed or supported by Anthropic. It reads the session files Claude Code
writes on your PC. When you turn on App control, it can also press buttons in the Claude desktop app for you.

## What it does
- Shows your recent Claude Code sessions as tiles on a sphere. They are read from `~/.claude/projects` on your PC,
  and nothing is uploaded.
- Opens a session in a read-only console on the desktop, or in the Claude app (Open in Claude).
- Speaks status lines with a built-in Windows voice. The assistant's name, which is also its wake word, is set in
  Setup. The default name is Theseus.
- Records the screen to your recordings folder. This needs ffmpeg.
- Includes extra tools for a working repository: worktrees, git status and MCP servers.

## Privacy
Session Sphere reads Claude Code's session files on your PC (`~/.claude/projects`) and keeps its settings in
`%APPDATA%`. It has no account, no telemetry and no server: nothing is uploaded. Opening a session in the Claude app uses
the app's own `claude://` link.

## Requirements
- Windows 10 or 11.
- Claude Code sessions on this PC: the Claude desktop app, or the `claude` CLI.
- Optional:
  - git and the GitHub CLI (`gh`), for the repository tools.
  - Windows Terminal.
  - ffmpeg on PATH, or set under Paths, for recording.

## Install
1. Run `Session Sphere Setup x.y.z.exe`. The installer is unsigned, so Windows SmartScreen warns the first time.
   Choose **More info → Run anyway**.
2. The Setup card opens on first start. There you set:
   - the assistant name;
   - the recordings folder;
   - App control.

   The card also lists the tools it found. All of these can be changed later under General settings.
3. Start with Windows is a switch in General settings.

To uninstall, use Windows Settings → Apps → Session Sphere.

## App control (off by default)
When App control is on, you can do these things from the sphere: reply to a session, answer its questions, and start,
rename, fork or archive sessions. It works by pressing buttons in the Claude app for you, the way a person would.

Anthropic's terms restrict automated access to its services, so use App control at your own risk. It can also stop
working when the Claude app updates. While it is off, the console is read-only.

## License
MIT, see [LICENSE](LICENSE).

## Build from source
```
npm install
npm start          # run
npm run dist       # dist/Session Sphere Setup x.y.z.exe
```
