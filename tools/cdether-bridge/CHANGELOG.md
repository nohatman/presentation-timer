# Changelog

All notable changes to the cdether-bridge. Empirically derived; not an official
Hive protocol implementation.

## Unreleased

### P2.1 — bridge status heartbeat + Control page indicator — IMPLEMENTED, COMMITTED (2026-09-10)
- Design: `P2-PLAN.md` — architecture, heartbeat wire format, and security
  analysis for the bridge-to-server status channel.
- Implemented and **committed to `main` at `92cb563`** (pushed to origin):
  `bridgeStatus.js` (server-side in-memory, room-scoped, ephemeral status
  registry), a narrowly-scoped `bridgeStatus` socket event from display-role
  connections only, and a compact Physical Display Output status pill on the
  room Control page. 131 automated tests pass (unit + a real in-process
  server/socket.io integration suite); also verified visually in a real
  browser (Playwright against the system Edge) against a locally-run server.
  **Live Railway/production deployment validation has not yet been evidenced
  in this session** — that check remains outstanding.
- Local operator UI (tray app, loopback web panel, first-run wizard, Test
  Display/Start/Stop UI, persistent config storage, DPAPI, packaging) remains
  future work. **P2.2 has not started.**

### P1.1 — time-of-day / clock mode — IMPLEMENTED, physically proven end-to-end (2026-09-11)
- `lib/state.js`'s `deriveFrame()`: clock mode (`showClock` / `outputMode ===
  'clock'`) now outputs the current time as `HH:MM` (24-hour, always green)
  instead of sending `OFF`. Uses the bridge computer's own local timezone,
  with the underlying clock corrected against the Presentation Timer server
  (the same `clockOffsetMs` mechanism already used for countdown accuracy) -
  not the bridge machine's uncorrected system clock. Reuses the already-proven
  4-digit nibble-swapped BCD encoding
  unchanged — no new `lib/cdether.js` frame values, no colon/blink/brightness
  behaviour. Overlay message still takes priority over clock mode (unchanged
  `OFF`); countdown, pause/resume, nudge, threshold colours, negative/overtime
  (`00:00` red), intentional-stop `OFF`, and degraded/reconnect semantics are
  all unaffected.
- New unit tests (`test/state.test.js`): `00:00`, `09:05` (native leading-zero
  suppression accepted), `12:00`, `23:59`, server-clock-offset applied to
  clock mode, always-green regardless of thresholds, overlay-still-overrides-
  clock. Updated `test/engine.test.js`'s clock-mode test to expect green
  frames instead of `OFF`. 105 automated tests pass.
- **Physically proven end-to-end on the rig (2026-09-11)**: PT clock mode →
  bridge → CDEther → Hive shows the correct 24-hour `HH:MM` in green.
  Switching Timer → Time of Day and Time of Day → Timer both restore the
  correct output immediately in either direction, with no bridge restart
  required. Overlay override and clearing both work, Ctrl+C still sends one
  OFF frame and exits cleanly, and normal countdown behaviour is confirmed
  unchanged. See `P1.1-PROTOCOL-INVESTIGATION.md` §3.2/§7.

### P1.1 — negative/overtime and `>99:59` — investigation only, no code, PAUSED
- Added `P1.1-PROTOCOL-INVESTIGATION.md`: rig experiment procedures + route
  recommendation + results log for negative/overtime count and `>99:59`.
  **No behaviour change** — the bridge keeps holding `00:00` red and clamping
  to `99:59` until an encoding is physically proven.
- **Paused 2026-09-10**: sending an undocumented `byte3` value during raw
  probing left the Hive display persistently dimmed - a change to the
  display's own retained configuration, not a one-frame glitch. Further
  raw-frame sweeps of unknown byte values are paused until this is better
  understood, in coordination with Hive/Interspace support. **Recovery
  confirmed:** a documented brightness-reset command (from Dave's reference
  PDF) was sent via PowerShell → UDP → CDEther → XLR and successfully
  restored full display brightness - the dimming was recoverable, not
  physical damage. Does not block P2. (Time-of-day was unaffected by this
  pause and is now done — see above.) The `--raw` sender, `sniff.js`, and
  their tests remain in the tree for controlled, deliberate investigation
  only - not for casual use.

## [0.1.0] — P1 core hardening — 2026-09-09

Physically verified on the CDEther/XLR/Hive rig and approved 2026-09-09
(`RIG-REGRESSION.md`). Committed as `0a1b581` (first CDEther commit).

### Moved
- `experimental/cdether-bridge/` → `tools/cdether-bridge/`.

### Added
- `lib/net.js` — `listInterfaces()`, `directedBroadcast(addr, mask)` (contiguity-
  checked, rejects /31–/32), `resolveInterface({name, address})` (re-resolves a
  saved adapter by name when DHCP has changed its IP).
- `CDETHER_INTERFACE` config (adapter name) — derives the directed broadcast and
  the UDP **bind address**. `node bridge.js --list-adapters`.
- `UdpSender` now accepts `bindAddress` and binds the socket to the chosen NIC so
  directed broadcasts egress the CDEther adapter on a multi-homed PC.
- `UdpSender.send()` returns `{ ok, error }` (still never throws).
- `lib/status.js` — `StatusModel`: Connected / Output / Error state machine,
  emits `change` with an immutable snapshot; "physical display is holding its
  last value" wording on unexpected loss.
- `lib/log.js` — `RingLog` bounded event log.
- `lib/engine.js` — `BridgeEngine`: owns the 1 Hz loop and Start/Stop; clean
  `connect/start/stop/dispose` API; emits `status` / `frame` / `log` / `fatal`.
- `send-frame.js --interface <name>` and `--list-adapters`.
- Graceful-stop triggers: `SIGBREAK` (Windows), stdin `shutdown`/`quit`, and
  `{ cmd: 'shutdown' }` over IPC — in addition to SIGINT/SIGTERM.
- Tests: `net`, `status`, `engine` unit suites; `integration.test.js` (real
  socket.io ↔ real PtClient ↔ real UDP). 70 tests total.
- `socket.io` as a devDependency (fake PT server for the integration test).

### Changed — failure semantics (to match the frame-timeout hardware test)
- **Intentional** Stop / Ctrl+C / SIGTERM / shutdown request → send **one** OFF
  frame, then cease.
- **Unexpected** PT disconnect / Ethernet loss / UDP-NIC failure → cease
  transmitting and report `degraded`; **no OFF attempt** (previously the POC
  tried to send OFF on every disconnect).
- Server-initiated disconnect (room deleted / tokens regenerated / client
  suspended) → `room-unavailable` + periodic manual reconnect (socket.io does
  not auto-reconnect from that).
- Auth/token failure → best-effort OFF while the path exists, then fatal (exit 2).
- `bridge.js` reduced to a thin host over `BridgeEngine`.

### Unchanged
- The verified 3-byte frame table and `lib/state.js` remaining-time maths
  (mirrors `display.html`; room amber/red thresholds).
- Read-only, display-token-only Presentation Timer access.
- No new runtime dependency (`socket.io-client` only). No changes to
  `server.js` / `auth.js` / `db.js` / `display.html` / Companion.

## [0.0.1] — POC — 2026-09-09 (uncommitted)
- Initial proof of concept; physically proven end-to-end incl. the
  frame-timeout test. See git-none / `NEXT-STEPS.md` history.
