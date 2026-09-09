# Changelog

All notable changes to the cdether-bridge. Empirically derived; not an official
Hive protocol implementation.

## [0.1.0] — P1 core hardening — 2026-09-09

Physically verified on the CDEther/XLR/Hive rig and approved 2026-09-09
(`RIG-REGRESSION.md`). Uncommitted pending first-commit file-list review.

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
