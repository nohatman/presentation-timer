# P1 — core hardening implementation plan

**Status: implemented, physically verified on the rig, and approved —
2026-09-09.** All items below are done; 70 automated unit/integration tests pass
(`npm test`); the full hardware regression passed (`RIG-REGRESSION.md`).
**Uncommitted** pending file-list review for the first CDEther commit.

P1 turns the proven-but-ad-hoc experimental bridge into a **stable, documented,
well-tested core module** with a clean programmatic API that P2's UI can consume
without touching internals, and corrects the failure semantics to match the
frame-timeout finding. It stays **terminal-run** (env vars / flags, exactly as
today) so the rig regression set still applies and there is no UI surface yet.

Scope reference: `NEXT-STEPS.md` §14, row **P1**.

---

## In scope

1. **Repo move** `experimental/cdether-bridge/` → `tools/cdether-bridge/`
   (pure move + path fixups, no behaviour change). Signals "no longer
   throwaway"; still wired into nothing.
2. **`lib/net.js`** (new, pure) — adapter enumeration + directed-broadcast maths.
3. **`lib/cdether.js`** — `UdpSender` gains **bind-to-interface**.
4. **`lib/status.js`** (new, pure) — the Connected / Output / Error state machine.
5. **`lib/log.js`** (new) — small ring buffer for the event log P2 will render.
6. **`lib/ptClient.js`** — distinguish **intentional stop** from **unexpected
   disconnect**; best-effort classification of connect errors.
7. **`lib/engine.js`** (new) — extract orchestration from `bridge.js`;
   implement the **corrected OFF semantics**.
8. **`bridge.js`** — slims to config → engine → log/signals; adds
   `CDETHER_INTERFACE` config.
9. **`tools/send-frame.js`** — add `--interface <name>` (bind); otherwise
   unchanged.
10. **Tests** — new unit suites for `net`, `status`, `engine`, extended
    `cdether`; an integration test against a local `server.js`.
11. **Docs** — README run/config updates; a documented **Core API** section;
    start a `CHANGELOG.md`.

## Explicitly NOT in P1 (P2 and later)

- No tray app, web control panel, first-run wizard, profiles, `%APPDATA%`
  config, packaging, or installer.
- **No changes to `server.js`, `auth.js`, `db.js`, `display.html`,
  `control.html`, or Companion.** Nothing committed to production code.
- No change to the remaining-time calculation in `lib/state.js` (proven,
  mirrors `display.html`).
- No new runtime dependency. Node stdlib only (`dgram`, `os`, `events`) plus the
  existing `socket.io-client`.
- No silent NIC auto-detection (auto-*suggest* only; explicit choice required).

---

## Module design

### `lib/net.js` (pure, no I/O beyond reading `os.networkInterfaces()`)

```
listInterfaces({ includeInternal = false }) -> [{
  name, address, netmask, family:'IPv4', internal, cidr, broadcast
}]

directedBroadcast(address, netmask) -> string        // pure; e.g.
                                                     // ('192.168.8.238','255.255.255.0') -> '192.168.8.255'

resolveInterface({ name, address }) -> iface | null  // re-resolve a saved
                                                     // adapter by NAME first
                                                     // (address may have changed
                                                     // via DHCP), address as
                                                     // fallback
```

Windows note: `os.networkInterfaces()` keys are friendly adapter names
("Ethernet", "Wi-Fi"). Match on those. GUID-level matching would need
PowerShell/`wmic` — deferred unless name matching proves unstable in the field.

### `lib/cdether.js` — `UdpSender` change

```
new UdpSender({ address, port, bindAddress })
```

- `bindAddress` (the chosen NIC's current IPv4) is passed to `socket.bind()` so
  broadcasts egress the right adapter on a multi-homed PC. Optional and
  backward-compatible (unbound if omitted); the bridge always passes it.
- `setBroadcast(true)` unchanged. `send()` unchanged (errors via `onError`,
  never throws). Add an exported `OFF_FRAME` buffer constant for clarity.

### `lib/status.js` (pure, event-emitting, no timers/I/O)

```
setPt(state, { room })      // 'disconnected'|'connecting'|'connected'
                            // |'auth-failed'|'server-unreachable'|'room-unavailable'
setOutput(state, { fps, lastFrame, reason })  // 'stopped'|'running'|'send-error'
noteSend(ok)                // last UDP send outcome

// emits 'change' with an immutable snapshot:
{
  pt:      { state, room, since },
  output:  { state, fps, lastFrame, since },
  overall: 'idle'|'live'|'degraded'|'error',
  reason:  '<plain-language>',   // includes "physical display is holding its
                                 // last value" when PT lost while output ran
  detail:  { clockOffsetMs, lastFrameHex, ... }
}
```

`overall` truth table (PT × output) is the core unit test.

### `lib/log.js`

```
push(level, msg); tail(n) -> string[]; toText() -> string   // ring buffer, ~500 lines
```

Bridge logs through this **and** to stdout (terminal behaviour unchanged; P2
renders `tail()`).

### `lib/ptClient.js` changes

- `stop()` marks the next disconnect **intentional**; emit
  `disconnected({ intentional })` (or a distinct `stopped` event) so the engine
  can apply the right OFF rule.
- Best-effort map `connect_error` → `server-unreachable` where the cause is
  clear; generic fallback otherwise.
- Unchanged: `fatal` on `authError`; `lastState` cleared on disconnect so
  reconnect waits for a fresh `timerState` (proven correct).

### `lib/engine.js` (new — orchestration extracted from `bridge.js`)

Owns the 1 Hz tick, the last authoritative `timerState`, output `start()` /
`stop()`, and `dispose()`. Uses `lib/state.js` (unchanged) for the maths.

**Corrected failure semantics:**

| Trigger | Action |
|---|---|
| `stop()` — **intentional** | send **one** `0x04` OFF, then cease transmitting; stay subscribed |
| SIGINT / SIGTERM — intentional | `stop()` semantics (one OFF), then exit 0 |
| Unexpected PT disconnect / UDP send error / NIC down | **cease transmitting; update status; do NOT attempt OFF**; resume automatically on reconnect + fresh `timerState` |
| PT `authError` | attempt one OFF (socket is usually still up as the server closes it), surface `fatal`, exit 2 |
| PT clock mode / overlay message (path still up) | send OFF (unchanged from POC) |

Emits `status`, `frame`, `log` events for `bridge.js` (and later the UI).

### `bridge.js` (slimmed)

`config → net.resolveInterface / directedBroadcast → engine → wire events to
log + stdout → signal handlers`. No orchestration of its own.

Config additions:

| Var | Meaning |
|---|---|
| `CDETHER_INTERFACE` | adapter **name**; if set, `net` derives both the broadcast address and the bind address |
| `BROADCAST_ADDRESS` | still supported (explicit address); bind address derived if a matching adapter is found, else unbound |

Still explicit; still no silent auto-detect.

---

## Test plan (all `node --test`, no hardware)

| Suite | Covers |
|---|---|
| `net.test.js` (new) | `directedBroadcast` for /24 /16 /25 /30; `resolveInterface` matches by name when the IP has changed (mock `os.networkInterfaces`) |
| `status.test.js` (new) | full PT × output → `overall` table; "holding last value" wording; `since` timestamps; snapshot immutability |
| `cdether.test.js` (extended) | bound sender delivers on loopback; bogus `bindAddress` rejects `ready`; `OFF_FRAME` == `encodeFrame({colour:'off'})` for `00:00` |
| `engine.test.js` (new) | fake ptClient + fake sender: 1 Hz cadence; **intentional stop → exactly one OFF then silence**; **unexpected disconnect → silence, no OFF, status `degraded`**; reconnect + fresh state → resumes at correct value; UDP error → status `error`, tick survives |
| `encode.test.js`, `state.test.js` | unchanged, still green |
| integration (local `server.js`) | scripted drive (start/pause/resume/nudge/threshold/rundown/message/clock) asserting the frame stream **and** the new OFF semantics (one OFF on intentional stop; none on simulated unexpected loss) |

**Rig regression pass = the P1 exit gate.** Re-run the `NEXT-STEPS.md` §16
hardware checklist, with particular attention to:

- intentional Stop / Ctrl+C → display goes OFF from a single frame;
- unplug Ethernet mid-countdown → display holds; **bridge makes no OFF attempt**;
  replug → auto-recovers to the correct current value, no restart;
- CDEther NIC selected by name; DHCP address change between runs still resolves;
- directed broadcast still egresses the bound interface on the rig.

---

## Sequencing (small reviewable commits within P1)

1. Repo move + path fixups (no behaviour change).
2. `lib/net.js` + `net.test.js`.
3. `UdpSender` bind-to-interface + `cdether.test.js`; `send-frame --interface`.
4. `lib/status.js` + `status.test.js`.
5. `lib/log.js`.
6. `lib/ptClient.js` intentional-vs-unexpected split.
7. `lib/engine.js` extraction + corrected OFF semantics + `engine.test.js`.
8. `bridge.js` slim-down; `CDETHER_INTERFACE`.
9. Integration test; README/Core-API docs; `CHANGELOG.md`.
10. Rig regression pass → P1 exit.

---

## P1 exit criteria

- `tools/cdether-bridge/` with a documented Core API (`engine`, `status`, `net`)
  a UI could consume without importing anything else.
- Corrected failure semantics implemented and unit-tested.
- UDP socket bound to the selected interface.
- All unit + integration tests green; rig regression checklist re-passed.
- Still terminal-run; still **zero** production-code changes; no new dependency.

---

## Risks / notes

- **Repo move** touches paths in this folder's README/NEXT-STEPS/package.json
  and the session memory note — low risk, all localised; done as commit 1 with
  no behaviour change so it bisects cleanly.
- **Windows adapter naming** — matching by friendly name should be stable;
  GUID matching deferred. Flagged for the field-hardening phase if it bites.
- **Bound broadcast on Windows** — binding a broadcast socket to a specific
  interface address should still egress that NIC; confirmed only on the rig
  during the P1 regression pass, not in unit tests.
- **connect_error classification** is best-effort — socket.io does not always
  expose a clean cause; status text falls back to a generic message.

Estimated size: ~5 new + ~3 changed source files, ~4 new test files;
~700–1000 LOC net including tests. No new runtime dependency.
