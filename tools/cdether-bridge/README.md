# cdether-bridge

> **P1 committed (`0a1b581`); P2.1 committed (`92cb563`).** Own `package.json` /
> `node_modules` for the bridge process itself, which stays a fully separate,
> deletable program with no `require()` dependency on the main app. As of P2.1,
> `server.js` and `public/control.html` do carry a small, narrowly-scoped
> **status-reporting** addition (see `P2-PLAN.md`) - room-scoped, read-only
> with respect to timer control, and additive (deleting this bridge folder
> would not break the main app; the Control page's status pill would simply
> never receive anything to show). `auth.js`, `db.js`, `display.html`, and
> Companion remain untouched.

Subscribes **read-only** to one Presentation Timer room via that room's
**DISPLAY token** and emits empirically-derived 3-byte CDEther UDP frames on the
LAN, so a Hive / Interspace physical display follows the timer:

```
Presentation Timer room
  -> authenticated read-only Socket.IO (DISPLAY token)
  -> this bridge  (bind UDP to the chosen NIC)
  -> UDP directed broadcast :36700
  -> CDEther -> XLR -> Hive display
```

The display token cannot start / pause / reset the timer — the server derives
the socket role from the token and every control handler is gated on the
`control` role. The bridge also never emits any socket event.

## Status

- **Physically proven** end-to-end on real CDEther / XLR / Hive hardware
  (2026-09-09): live countdown, stop/hold at `00:00`, green/amber/red incl. live
  threshold changes, Pause/Resume, time nudge, clock mode → OFF, Ctrl+C → OFF,
  Ethernet loss + recovery.
- **Frame-timeout test (hardware):** Ethernet unplugged mid-countdown → the
  display **froze on the last value and held it 5+ minutes**; on reconnect the
  bridge auto-recovered and the display jumped straight to the correct current
  value, no restart. **⇒ CDEther retains the last valid frame indefinitely when
  UDP stops.**
- **P1 core hardening — physically verified on the rig and approved,
  2026-09-09** (`RIG-REGRESSION.md`). 70 automated tests pass. NIC bind (Ethernet
  `192.168.8.238` → directed broadcast `192.168.8.255:36700` with Wi-Fi still up),
  status model, corrected failure semantics all confirmed on real hardware.
  Committed as `0a1b581`.
- **P1.1 — time-of-day: DONE, physically proven end-to-end (2026-09-11).**
  Clock mode sends the current `HH:MM` in the bridge computer's own local
  timezone (24-hour, always green), with the clock corrected against the
  Presentation Timer server (same `clockOffsetMs` mechanism as countdown
  accuracy) — reuses the existing BCD encoding, no new frame values.
- **P1.1 — negative/overtime and `>99:59`: PAUSED.** Investigation-only, no
  bridge behaviour change (still `00:00` red / `99:59` clamp). Paused because
  an undocumented `byte3` value left the Hive display persistently dimmed
  during raw probing (a change to its own retained configuration, not a
  one-frame glitch); a documented brightness-reset command was successfully
  sent via PowerShell → UDP → CDEther → XLR to restore full brightness. The
  `--raw` sender and `sniff.js` remain for controlled investigation only —
  `P1.1-PROTOCOL-INVESTIGATION.md`.
- **P2.1 — bridge status heartbeat + Control page indicator: IMPLEMENTED,
  COMMITTED** (`92cb563`). The room Control page now shows a compact Physical
  Display Output status pill (Off/Connecting/Live/Degraded/Error). Local
  operator UI (tray app, loopback web panel) remains future work — **P2.2 has
  not started.** Productisation plan: `NEXT-STEPS.md`.

## ⚠️ The CDEther protocol here is EMPIRICAL

Derived from our own rig, **not** an official Hive spec. Verified frames:

| Frame (hex) | Display       |
|-------------|---------------|
| `99 95 01`  | `99:59` green |
| `98 95 01`  | `89:59` green |
| `21 43 01`  | `12:34` green |
| `21 43 02`  | `12:34` red   |
| `21 43 03`  | `12:34` amber |
| `21 43 04`  | display off   |

Structure (`lib/cdether.js`): byte 1 = minutes, byte 2 = seconds, each as
nibble-swapped BCD (low nibble = tens digit); byte 3 = `01` green · `02` red ·
`03` amber · `04` off. UDP **subnet-directed broadcast** to port 36700.

Conservative handling of the unverified cases: `>99:59` → clamp to `99:59`;
overtime → hold `00:00` red; overlay message → OFF; ticker message → timer
still shown. Clock / time-of-day mode is **no longer** one of these — see
below.

**Time-of-day (P1.1, done):** clock mode sends the current time as `HH:MM`
in the bridge computer's own local timezone (24-hour, always green), with
the clock itself corrected against the Presentation Timer server, using the
exact same BCD encoding above — no new frame values. Physically proven
end-to-end on the rig (2026-09-11). Overlay message still overrides clock
mode (→ OFF).

**Still unverified:** overtime / minus-sign representation, byte-3 states
beyond `01`–`04`, `>99:59`, min/max frame rate, unicast vs broadcast, other
Hive hardware generations.

**P1.1 — protocol-extension investigation (negative/overtime and `>99:59`
only; time-of-day is done, see above):** negative/overtime count and
`>99:59` remain under experimental investigation on the rig, currently
**paused** — an undocumented `byte3` value sent during raw probing left the
Hive display persistently dimmed (a change to its own retained
configuration state, not a one-frame glitch); a documented brightness-reset
command was successfully sent via PowerShell → UDP → CDEther → XLR and
restored full brightness, confirming the dimming was recoverable, not
physical damage. Further raw sweeps of unknown byte values stay paused until
this is better understood, in coordination with Hive/Interspace support. The
bridge's conservative handling for these two does **not** change until an
encoding is physically proven. The `--raw` sender, `sniff.js`, and their
tests remain in the tree for controlled, deliberate investigation only.
Experiment procedures and the results log:
[`P1.1-PROTOCOL-INVESTIGATION.md`](./P1.1-PROTOCOL-INVESTIGATION.md).

## Config

Environment variables (or matching `--flags`). Copy `.env.example` to `.env`.

| Var | Notes |
|---|---|
| `SERVER_URL` | **required** — Presentation Timer origin |
| `DISPLAY_TOKEN` | **required** — the room's **DISPLAY** token (not control) |
| `CDETHER_INTERFACE` | adapter **name** — derives the directed broadcast **and** binds the UDP socket to that NIC. List names: `node bridge.js --list-adapters` |
| `BROADCAST_ADDRESS` | alternative to `CDETHER_INTERFACE`: an explicit directed-broadcast address. Binds to a matching adapter if one exists, else unbound (warned). |
| `CDETHER_PORT` | default `36700` |
| `FRAME_INTERVAL_MS` | default `1000` |
| `IDLE_BEHAVIOUR` | `duration` (green, shows armed time — matches display.html) \| `off` |
| `DRY_RUN` | `true` = compute + log frames, open no UDP socket |

One of `CDETHER_INTERFACE` / `BROADCAST_ADDRESS` is required unless `DRY_RUN=true`.
Prefer `CDETHER_INTERFACE` — an unbound broadcast can leave the wrong adapter on
a multi-homed PC.

## Run

```bash
cd tools/cdether-bridge
npm install
npm test                                   # 105 unit + integration tests, no hardware

node bridge.js --list-adapters             # see adapter names / computed broadcasts
node --env-file=.env bridge.js             # the bridge (connects + starts output)
node --env-file=.env bridge.js --dry-run   # compute + log frames, send nothing
```

Graceful stop: **Ctrl+C** (SIGINT), SIGTERM, `SIGBREAK` (Windows), the line
`shutdown` on stdin, or `{ cmd: 'shutdown' }` over an IPC channel — all send one
OFF frame and exit 0.

### Manual frame tool (rig bring-up, no Presentation Timer)

```bash
node tools/send-frame.js 12:34 green --interface Ethernet
node tools/send-frame.js 12:34 amber --interface Ethernet
node tools/send-frame.js 00:00 off   --interface Ethernet
node tools/send-frame.js --list-adapters
# repeat a frame once per second:
node tools/send-frame.js 01:00 green --interface Ethernet --count 60 --interval 1000
```

## Failure semantics (P1 — matches the frame-timeout test)

- **While connected:** remaining time is derived locally each second from the
  latest authoritative `timerState` anchors + the server clock offset (mirrors
  `display.html`). Not an independent countdown — a new `timerState` re-anchors.
- **Intentional Stop / Ctrl+C / SIGTERM / shutdown request:** send **one** OFF
  frame, then cease, exit 0.
- **Unexpected loss** (PT socket drop, Ethernet loss, UDP/NIC failure): **cease
  transmitting; report `degraded`; do NOT attempt an OFF** (it cannot reach
  disconnected hardware, and the display holds its last value anyway).
- **Reconnect:** wait for a fresh authoritative `timerState`, then resume — the
  display jumps straight to the correct current value.
- **Bad / expired / suspended display token:** best-effort OFF while the path
  still exists, print the error, exit 2.
- **Server closes the socket** (room deleted / tokens regenerated / client
  suspended): status `room-unavailable`; the bridge retries periodically and
  resumes if access returns.
- No supervisor process, no grace window, no post-disconnect extrapolation.

## Core API (for the later operator UI)

`lib/` is a self-contained module with no dependency on Presentation Timer
server internals:

| Module | Purpose |
|---|---|
| `lib/net.js` | `listInterfaces()`, `directedBroadcast(addr, mask)`, `resolveInterface({name, address})` |
| `lib/cdether.js` | `encodeFrame()`, `describeFrame()`, `OFF_FRAME`, `UdpSender({address, port, bindAddress})` |
| `lib/state.js` | `deriveFrame(timerState, nowMs, clockOffsetMs, opts)` → `{minutes, seconds, colour}` (pure; mirrors display.html) |
| `lib/status.js` | `StatusModel` — Connected / Output / Error state machine, emits `change` with an immutable snapshot |
| `lib/log.js` | `RingLog` — bounded event log (`push` / `tail` / `toText`) |
| `lib/ptClient.js` | `PtClient` — read-only socket.io-client wrapper; events `connecting` / `connected` / `state` / `disconnected` / `connectError` / `fatal` |
| `lib/engine.js` | `BridgeEngine` — owns the 1 Hz loop, `connect()` / `start()` / `stop()` / `dispose()`; emits `status` / `frame` / `log` / `fatal` |

`bridge.js` is a thin terminal host over `BridgeEngine`. A UI host would build
the same engine and render its `status` / `frame` events.

## Files

```
bridge.js              thin terminal host (config -> engine -> stdout -> signals)
lib/config.js          env + --flag config; resolves NIC -> broadcast + bind address
lib/net.js             adapter enumeration + directed-broadcast maths
lib/cdether.js         verified 3-byte encoder + UDP sender (bind-to-interface)
lib/state.js           pure timerState -> {minutes, seconds, colour} (mirrors display.html)
lib/status.js          Connected / Output / Error state machine
lib/log.js             bounded event-log ring buffer
lib/ptClient.js        read-only socket.io-client wrapper
lib/engine.js          1 Hz loop + Start/Stop + failure semantics + status wiring
tools/send-frame.js    manual frame sender (rig bring-up)
test/*.test.js         encode · state · net · status · engine · integration · instruments  (105 tests)
NEXT-STEPS.md          productisation design + phased plan + decisions
P1-PLAN.md             the P1 hardening plan (this milestone)
RIG-REGRESSION.md      the hardware checklist to run before the first commit
CHANGELOG.md
```
