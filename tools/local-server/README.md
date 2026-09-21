# Foxy Local Show Server launcher

Runs the timer server on a Windows PC for a show, on the private LAN, without typing Node
commands or wondering whether an old process is still alive. This is an explicit **local**
operating mode; it does not change the hosted (Railway) deployment.

## Operator workflow

Double-click **`Foxy-Local-Show-Server.bat`** (repo root). You get:

```
=== FOXY LOCAL SHOW SERVER ===
Status:   RUNNING
          Server is running and healthy
Port:     3000    PID: 12345    Up: 5m    Mode: local
This PC:  http://localhost:3000/
Other devices on the LAN:  http://192.168.1.42:3000/   (Ethernet)
Build:    running 21afd41 / a1b2c3d4e5   on disk 21afd41 / a1b2c3d4e5

  [1] Open Control page        [4] Stop server
  [2] Open Display page        [5] Refresh status
  [3] Start / Restart server   [6] Show links for other devices
  [Q] Quit  (the server keeps running)
```

* The server runs **detached** with its output in `data/local-server/server.log`; closing the
  launcher window does not stop it. Reopen the launcher any time to see/stop it.
* Start never creates a second copy; Restart replaces the process (PID changes) and saves room
  state first; Stop is a clean shutdown (state flushed), forced only if it does not exit.
* "Other devices" shows the address a tablet/laptop on the show network should use. Any private
  IPv4 network works (10.x, 172.16-31.x, 192.168.x); loopback, link-local (169.254), IPv6,
  public/VPN addresses are skipped, and virtual adapters (Hyper-V/WSL, VirtualBox, VMware,
  Docker) are listed last. Option `[6]` prints Control/Display links for other devices.
* Default port 3000; use `--port 3001` (or `FOXY_PORT`) if it is taken.
* Windows Firewall must allow Node.js inbound on private networks for other devices to connect.

Scriptable form (same code): `Foxy-Local-Show-Server.bat status|start|stop|restart|links`,
`open-control [--room name]`, `open-display [--room name]`, `status --json`.
`status` exit code: 0 healthy, 3 stopped, 2 anything needing attention.

## Status meanings

| Status | Meaning | Do |
| --- | --- | --- |
| STOPPED | nothing on the port | Start |
| RUNNING | started by the launcher, answering, current code | - |
| **STALE BUILD** | running, but the server-side files on disk changed since it started | **Restart** |
| UNHEALTHY | launcher's process is alive but not answering | Restart; read the log |
| RUNNING - NOT STARTED BY THIS LAUNCHER | a Foxy server (e.g. `npm start`) is on the port | Stop it, then Start here |
| PORT IN USE BY ANOTHER PROCESS | something else holds the port - possibly an **old** Foxy with no `/api/health` | Inspect PID/command line shown; `[K]` (asks first) only if it is an old Foxy |

The screen also lists any other `node ... server.js` processes on the PC so a forgotten one is
visible. They are information only and are never stopped implicitly.

## Stale-server protection

`node server.js` keeps running the code it started with while browsers get the *current* page
files - after an update the two silently disagree and buttons appear dead.

* `GET /api/health` (server) returns the build the process **started** with (git commit +
  a fingerprint of the server-side files: `server.js`, `db.js`, `auth.js`, `urls.js`,
  `bridgeStatus.js`, `timerModes.js`, `buildInfo.js`) and the fingerprint of those files on
  disk **now**. Different => `stale: true`. (The commit id is for humans; the fingerprint also
  catches uncommitted edits.) Pages under `public/` are not fingerprinted - they never need a restart.
* The launcher status compares the same two values.
* The **Control page** shows a red banner when the server is stale, when the server has been
  restarted with a different build since the page was loaded ("reload this page"), or when the
  server has no `/api/health` at all (older than this feature). It checks on load, on every
  reconnect and every 30 s, and shows `Server build: ...` at the bottom of the page.

## Process safety

Nothing is ever stopped on a PID alone, and there is no "kill node.exe":

1. PID file `data/local-server/server.pid.json` written by the launcher (pid, port, one-off token).
2. The OS process for that PID must be `node` and its command line must name **this repo's**
   `server.js` (the launcher starts it with the absolute path).
3. If the server answers, `/api/health` must report the same PID.

Stale PID files (dead process) are ignored and removed; a PID reused by another program fails
check 2 and is left alone. A graceful stop uses `POST /api/local/shutdown`, which exists only
when the launcher started the process (`FOXY_MODE=local` + random `FOXY_SHUTDOWN_TOKEN`), only
answers from the same machine, and needs the token - inert on hosted deployments.
Stopping a server the launcher did **not** start needs an explicit request (`stop
--force-unmanaged` or `[K]` + typing YES) and is limited to a `node` process running a
`server.js` that owns the port; it cannot save state first, so a change in the last half
second may be lost.

## Files

`foxy-local.js` (menu/CLI) · `lib/supervisor.js` (start/stop/status) · `lib/status.js`,
`lib/procsafe.js`, `lib/lan.js` (pure decision logic, unit-tested) · `lib/osproc.js`
(PowerShell/netstat wrappers) · `lib/rooms.js` (read-only room lookup for Control/Display links) ·
root `buildInfo.js` (fingerprint, shared with the server). Tests: `test/localServer.*.test.js`.
