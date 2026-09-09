# CDEther bridge — productisation design & next steps

**Status:** the bridge is [physically proven](./README.md#status) end-to-end
against real CDEther / XLR / Hive hardware (2026-09-09), including the
frame-timeout test in §11. **P1 core hardening is implemented and physically
verified on the rig (2026-09-09) — approved** (`P1-PLAN.md`, `RIG-REGRESSION.md`).
The productisation decisions in §17 were taken on 2026-09-09. Next: prepare the
first CDEther commit for review; then **P2** (§18). No P2 code until approved.

Component name: **Foxy CDEther Bridge** (internal / code). User-facing
terminology: **"Physical Display Output"**, with **CDEther** as the selected
hardware/interface type.

---

## 1. Where we are

**Proven on hardware (2026-09-09):**

- Railway-hosted Presentation Timer → read-only display-token Socket.IO →
  local bridge → UDP subnet-directed broadcast → CDEther → XLR → Hive display.
- UDP destination verified as **subnet-directed broadcast** at
  `192.168.8.255:36700` on the test LAN.
- Frame is **exactly 3 bytes**: byte 1 = minutes, byte 2 = seconds, each as
  **nibble-swapped BCD** (`MM:SS`); byte 3 = state, physically verified as
  `0x01` green / `0x02` red / `0x03` amber / `0x04` off. (8-frame table in
  `lib/cdether.js`.)
- Live countdown; stop / hold at `00:00`; Pause freeze / Resume; time nudge;
  live amber/red threshold changes made in the Presentation Timer; clock /
  time-of-day mode → OFF; Ctrl+C clean shutdown → OFF; Ethernet loss and
  recovery.
- **Frame-timeout behaviour** — see §11. The Hive display retains the last
  valid frame indefinitely when UDP stops.

**Still empirical / unverified — deliberately out of v1 scope:**

- Overtime / minus-sign representation (currently forced to `00:00` red).
- Time-of-day / HH:MM representation (currently OFF).
- Any byte-3 states beyond `0x01`–`0x04`.
- Behaviour above `99:59` (currently clamped to `99:59`).
- Other CDEther / Hive hardware generations and firmware.
- Any further protocol features; min/max frame rate beyond the 1 Hz tested;
  whether unicast to the receiver works as well as broadcast.

This is an **empirically derived implementation, not an official Hive protocol
specification.**

**Structural facts that shape the design:**

- The bridge needs nothing from `server.js` — no DB, no auth stack, no Express.
  It only depends on the shape of the `timerState` Socket.IO event.
- It is read-only by construction (display token; every mutating handler in
  `server.js` is gated on the `control` role).
- It is tiny: 5 source files, one runtime dependency (`socket.io-client`).
- `MULTI_TENANT_STATUS.md` predicted this architecture ("a separate local
  bridge process subscribing to a room as a read-only display-token client …
  keeping USB/serial/XLR code out of the hosted Railway server entirely"). The
  earlier "blocked on obtaining the Ethernet protocol" status is now
  **obsolete** — the CDEther/Ethernet path is decoded and proven.

---

## 2. Goals and non-goals for a supported feature

**Goals**

1. An operator with no developer knowledge can set it up and run it — **no
   terminal, no environment variables, no `npm`, no editing files**.
2. Choose the Presentation Timer server and the specific room.
3. Choose which network adapter / broadcast address CDEther traffic goes out of.
4. See, at a glance, three things: is it talking to the Presentation Timer, is
   it sending to CDEther, and is anything wrong.
5. Explicit Start / Stop of output.
6. **Correct failure behaviour** (see §10):
   - **intentional** Stop / Exit → send `0x04` OFF, then close cleanly;
   - **unexpected** connectivity loss → the physical display keeps its last
     value (it cannot be blanked once the path is broken), the operator UI
     clearly reports the loss, and the bridge recovers automatically when
     connectivity returns.
7. Deletable / abandonable until it has proven itself in real events.

**Non-goals (v1)**

- No control of the timer, ever (read-only is a safety guarantee, not a
  limitation to remove later).
- No changes to `server.js`, `display.html`, room auth, Companion, or the
  hosted Railway deployment.
- No sync with Railway data, no licensing/entitlement logic, no multi-room
  fan-out (one bridge instance = one room = one CDEther LAN).
- **CDEther only.** The older Hive USB Expander is explicitly not implemented.
- No support for >99:59, overtime, or clock-mode HH:MM on the Hive until there
  is a concrete client need *and* rig time to verify it.
- No auto-update in v1.
- Not bundled with any short-link, licensing, Local Event Server, or Hive-USB
  work.

---

## 3. Shape: standalone helper first (decided)

**Decision (2026-09-09): build a standalone Windows helper now — do not wait for
the Phase 10 Local Event Server.** Keep the bridge *core* a self-contained
module so the same code can later be offered as a panel inside the Phase 10
launcher without a rewrite.

Why standalone first:

- **Timeline independence.** Phase 10 is not started and not designed in
  detail. Physical Display Output is proven and wanted now.
- **It already works against Railway.** Folding CDEther *only* into a local
  server would drop the proven Railway-hosted use case.
- **Failure isolation.** A flaky NIC, a bad XLR run, or a Hive firmware quirk
  must not be able to disturb a running Local Event Server that is also driving
  phones and laptops in the room.
- **It shares almost nothing with the server** (no DB/auth/Express).

**Design constraint from day one:** the bridge *core* (`lib/`) stays a
self-contained module with a clean programmatic API and **no dependency on
Presentation Timer server internals**. Then the standalone helper is
`core + a local UI`, and any future launcher integration is `core + a different
host UI` — neither a rewrite of the other.

---

## 4. Architecture of the supported feature

```
┌──────────────────── Foxy CDEther Bridge  (one Windows process) ─────────────────────┐
│                                                                                     │
│  App host                                                                           │
│    • tray icon (show panel / Start-Stop / Quit)                                     │
│    • serves the control panel on 127.0.0.1:<port>  (loopback only)                  │
│    • best-effort OFF on Quit / Windows logoff / shutdown                            │
│                                                                                     │
│  Core  (promoted, hardened lib/ — no server dependency)                             │
│    ptClient   read-only Socket.IO (display token)      ── emits status events       │
│    state      timerState → {mm, ss, colour}  (mirrors display.html; unchanged)      │
│    cdether    3-byte encoder + UDP sender BOUND TO THE CHOSEN INTERFACE              │
│    net        enumerate adapters, compute directed broadcast                        │
│    engine     1 Hz loop, Start/Stop, OFF-on-intentional-stop, status state machine  │
│                                                                                     │
│  Config       %APPDATA%\FoxyCdetherBridge\config.json   (named profiles)            │
│  Panel        small web UI — wizard · live status · Start/Stop · Send test frame     │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**One process, not a supervisor pair.** The frame-timeout test (§11) showed a
watchdog that tries to "fail dark" on unexpected loss is pointless — once the
Ethernet path is broken an OFF packet cannot reach CDEther, and the display
holds its last value regardless. So there is no separate supervisor process
whose job is to send OFF on crash. If the core's internal loop throws, the app
host catches it, surfaces an Error state in the panel, and retries; it does not
pretend it can blank the display.

**UI approach (decided):** a **lightweight tray application** plus a
**loopback-only local web control panel**, **not Electron** — consistent with
`MULTI_TENANT_STATUS.md`'s Phase 10 stance. Reuses the app's existing plain
HTML/CSS conventions.

---

## 5. Operator-friendly setup (zero terminal)

- **First run = a 3-step wizard** in the control panel:
  1. **Presentation Timer** — paste the room's **Display link**
     (`https://…/display?token=…`). The app extracts server URL + token in one
     step, connects, and shows `Connected — room "BALLROOM"` for confirmation.
     A pasted **Control link** is detected and refused with a plain message
     ("Paste the Display link, not the Control link").
  2. **CDEther network** — pick the adapter from a list (name, IPv4, computed
     broadcast). Big **Send test frame** button → display shows `12:34` green
     then OFF. Operator confirms they saw it.
  3. **Done** — review, name the profile, optionally "Start output
     automatically when connected".
- After first run: launch → tray → panel already configured → one **Start
  Output** click (or auto-start).
- Multiple named **profiles** (per venue / per room), switchable from the panel.
- No field ever requires knowing an IP by heart; every value is chosen from a
  list or pasted from something the dashboard already gave the operator.
- **Distribution:** until the operator-friendly version has been proven on our
  own machines, it runs **in place** (an unzipped folder + a double-click
  launcher, no installer). A signed installer comes later — see §12.

---

## 6. Presentation Timer server & room selection

- **Primary path: paste the Display link.** It already contains both server and
  token; it is the artefact operators are handed today.
- **Secondary path:** choose a server (Railway production URL pre-filled;
  "custom URL" for a future Local Event Server address) + paste a bare token.
- On connect, show `roomInfo.slug` so the operator sees *which* room in words.
- Reject control links. (The token is display-only server-side regardless, but
  the app should still refuse — defence in depth and clearer UX.)
- Store the token in the OS credential store or an ACL-restricted config file,
  not plain text in a world-readable location.
- Handle the known failure modes with specific status text (see §8): auth
  failed / server unreachable / room deleted / client suspended.

---

## 7. Dedicated CDEther NIC / broadcast selection

- Enumerate interfaces (`os.networkInterfaces()`); for each IPv4 address show
  adapter name, address, netmask, and computed **directed broadcast**
  (`addr | ~mask`).
- Operator picks the CDEther/venue adapter. App shows the broadcast it will
  use; manual override allowed.
- **Bind the UDP socket to the chosen interface address** (the POC binds
  `0.0.0.0`). On a multi-homed PC — internet NIC + venue NIC, common at venues
  — an unbound broadcast can leave the wrong adapter. Binding fixes routing.
- Match the saved adapter by **name/GUID, not IP**, and re-resolve its current
  address on every start (venue DHCP reassigns).
- Warn if: the chosen CDEther adapter is also the route to the Presentation
  Timer server (usually you want PT over the internet NIC and CDEther over the
  isolated venue NIC); the adapter is down; no non-internal IPv4 adapter exists.
- Keep **Send test frame** available at all times, not just in the wizard.
- Do **not** auto-detect silently — auto-*suggest* the most likely adapter,
  always require a confirmed choice.

---

## 8. Status model — Connected / Output / Error

Because the physical display **cannot** be blanked once connectivity is lost
(§11), a clear, honest status surface is the primary safety mechanism, not a
fail-dark trick. Three independent indicators, always visible:

| Indicator | States |
|---|---|
| **Presentation Timer** | Disconnected · Connecting · **Connected — room "X"** · Auth failed · Server unreachable · Room unavailable |
| **CDEther Output** | Stopped · **Running — N fps, last frame `21 43 01` 12:34 green** · Send error — <NIC reason> |
| **Overall** | **Live** (PT Connected *and* Output Running *and* last send OK) · Degraded (amber, with reason — e.g. "Presentation Timer lost — physical display is holding its last value") · Error (red, with reason) · Idle |

Plus a details area: PT server clock offset (e.g. `+0.3 s`), frames/sec, last
frame (hex + decoded), uptime, current profile, and a rolling event log (last
~200 lines, "Copy log" button for support).

Principle: **"Live" is green only when the whole chain is verified working** —
subscribed, output started, and the last UDP send returned no error. Any loss
is stated in plain language, including the fact that the physical display is
now showing a stale value.

---

## 9. Start / Stop output

- Explicit **Start Output** / **Stop Output**, independent of the PT connection.
- **Stop Output (intentional):** send **one `0x04` OFF frame**, then stop
  sending. The bridge stays subscribed to PT so status stays truthful. (One OFF
  is enough — the display acts on the last frame it receives.)
- **Start Output:** 1 Hz, exactly as proven.
- Per-profile **auto-start when PT connects** toggle.
- Tray-Quit / Windows logoff / Windows shutdown → best-effort OFF, then exit
  (§10). "Best-effort" because a shutdown may not leave time, and that is
  acceptable given §11.

---

## 10. Failure semantics (matches the physical test)

### Intentional stop / exit → send OFF, then close

Send `0x04` OFF once, then stop, on:

- **Stop Output** pressed.
- Tray-Quit / Windows logoff / Windows shutdown (best-effort).
- CDEther adapter changed in settings (OFF on the old adapter before switching).
- PT enters clock / time-of-day mode, or shows an overlay message — the display
  is meant to be blank in these states, and the path is still up, so OFF gets
  through. (Unchanged from the POC.)

### Unexpected connectivity loss → hold, report, auto-recover

On PT socket disconnect, PT auth failure, room gone, client suspended, UDP send
error, NIC down, or bridge-PC crash/power loss:

- **The physical display keeps its last value.** Verified: it held for 5+
  minutes with the Ethernet unplugged. An OFF frame cannot be delivered over a
  broken path, so the bridge does not try.
- **The operator UI clearly reports the loss** — which side (Presentation Timer
  and/or CDEther output), since when, and that the display is now stale.
- **Automatic recovery.** On PT reconnect the bridge waits for a fresh
  `timerState` and resumes; the display jumps straight to the correct current
  value. Verified: no bridge or CDEther restart needed.

**No supervisor/watchdog process** is added to attempt fail-dark on unexpected
loss — the physical test showed it would achieve nothing.

Keep this simple unless real-world use demonstrates a need for more.

---

## 11. Frame-timeout test result (done on hardware, 2026-09-09)

**Question:** what does the Hive display do when CDEther stops receiving UDP
frames?

**Test:** bridge and timer running normally; Ethernet physically unplugged so
no OFF frame could be delivered; observed the display; reconnected Ethernet.

**Result:**

- The display **froze on the last received timer value** and stayed frozen for
  **more than five minutes**.
- On reconnect, the bridge recovered automatically and the display **immediately
  resumed at the correct current Presentation Timer value**.
- **No bridge or CDEther restart was required.**

**Conclusion:** CDEther / the display appears to **retain the last valid frame
indefinitely** when UDP disappears. Design consequences are folded into §4
(no supervisor), §9 (Stop = one OFF), §10 (intentional vs unexpected), and §8
(clear status is the safety mechanism). Still empirically derived, not a Hive
spec.

---

## 12. Packaging

- **Runtime:** Node 20+ (the app's `engines`).
- **Phase 1 of distribution — run in place.** An unzipped folder + a
  double-click launcher (`.cmd`/`.exe` shim) that starts the app host and opens
  the panel. No installer, no signing. This is enough to prove the
  operator-friendly version on our own machines and at our own events.
- **Later — packaged executable.** Recommend **Node SEA (Single Executable
  Applications)** — official, Node 20+, no third-party packer — producing
  `FoxyCdetherBridge.exe`; `pkg` as fallback. Whatever Phase 10 chooses for its
  packaged server, use the same toolchain (this and the stale `portable/`
  `pkg` build should converge).
- **Later — installer + code signing.** NSIS/MSI, `%APPDATA%` config,
  run-at-login, clean uninstall; EV certificate to avoid SmartScreen friction.
  **Deferred spend** — not committed until the operator-friendly version has
  been proven on our own machines. Code signing is a cost/logistics item
  shared with the Phase 10 launcher; decide once, together.
- **Auto-update:** out of scope for v1; manual download. Visible version string
  in the panel.
- **Antivirus:** test for false positives on a clean VM once a packed binary
  exists (raw-socket + packed Node binaries sometimes trip heuristics).

---

## 13. Relationship to the Local Event Server / Windows launcher (Phase 10)

| | Foxy CDEther Bridge | Local Event Server (Phase 10) |
|---|---|---|
| Purpose | venue-side hardware output for one room | internet-independent PT server + launcher for a whole venue |
| Needs PT server internals | no | *is* the server |
| Works against Railway | yes (proven) | n/a |
| Hardware-coupled | yes (NIC / XLR / Hive) | no |
| Started | proven POC, productisation begun | not started, not designed |

**Two stages (decided):**

- **Stage A (now):** standalone Foxy CDEther Bridge, built on the proven core.
  Independent of Phase 10, not blocked on it, not a blocker for it.
- **Stage B (only when Phase 10 exists and is itself proven):** offer CDEther
  as an integrated panel inside the Local Event Server launcher for the
  single-PC case, **reusing the identical core module** — a UI-hosting
  exercise, not a rewrite. Keep the standalone app for setups where CDEther
  runs on a separate machine from the server.

Shared surface area to keep aligned: Windows packaging toolchain, tray UI
patterns, NIC/broadcast handling, "no terminal" philosophy, travel-router
guidance, code signing.

**Unchanged constraint:** no CDEther / UDP / serial code in `server.js` or the
hosted Railway deployment — ever.

---

## 14. Migration path: experimental bridge → supported feature

Each step is independently shippable and independently abandonable. "Easy to
delete" holds until P3.

| Step | Scope | Exit criteria to proceed |
|---|---|---|
| **P0 — done** | experimental bridge, physically proven (incl. frame-timeout test) | ✅ complete |
| **P1 — harden the core** ✅ *physically verified on the rig + approved 2026-09-09* | moved to `tools/cdether-bridge/`; `lib/net.js` (adapter enumeration + directed broadcast); `UdpSender` bind-to-interface; `lib/status.js` (Connected/Output/Error); `lib/log.js` (ring buffer); `lib/engine.js` (clean core API, corrected OFF semantics); `CDETHER_INTERFACE` config; 70 unit/integration tests; rig regression PASSED. Still terminal-run, no server changes. | prepare first CDEther commit → P2 |
| **P2 — local control panel + in-app status** | one app process: tray + loopback web UI (first-run wizard, live status, Start/Stop, Send test frame, profiles); **plus** a compact Physical Display Output status indicator on the PT room Control page fed by a small secure room-scoped, auto-stale status report from the bridge (**§18**). | dogfooded by a non-developer at a real event; P2 security review covers the new bridge→server channel |
| **P3 — operator-friendly, run-in-place** | polish the wizard, error text, profile handling; "run in place" folder + launcher; written setup instructions. **This is the point it is usable as a supported feature by our own operators.** | 2+ real events run by a non-developer using only the written instructions |
| **P4 — packaged executable + installer + signing** | Node SEA build; NSIS/MSI installer; `%APPDATA%`; EV signing; clean-VM install/run/uninstall; SmartScreen + AV check | spend approved; aligned with Phase 10 toolchain |
| **P5 — field hardening** | reconnect edge cases, NIC-change handling, clock/overlay transitions, diagnostics export, soak testing | 3+ events with no operator-visible failure |
| **P6 — launcher integration (optional)** | embed the core as a panel in the Phase 10 launcher | only after Phase 10 v1 is itself proven |

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Protocol is empirical; Hive firmware variants could shift the frame mapping | wrong/garbled display | Send-test-frame button; centralised verified table; log every raw frame; rig regression checklist |
| Multi-homed PC broadcasts out the wrong NIC | display never updates, no error | bind UDP socket to the chosen interface (§7) |
| Venue DHCP changes the CDEther NIC address between sessions | output silently stops | match adapter by name/GUID, re-resolve address on start |
| Venue switch drops directed broadcast / client isolation | no output | travel-router guidance (shared with Phase 10); Send test frame during setup |
| Unexpected connectivity loss mid-show | physical display holds a stale value (cannot be blanked — §11) | this is accepted, documented behaviour; operator UI reports it loudly; auto-recovery on return; operator's physical fallback is to kill the display/CDEther power |
| Operator pastes a Control link | — (token is display-only server-side) but confusing | detect and refuse control links |
| Two bridge instances → one display | conflicting frames, flicker | document "one bridge per display"; later, listen on `:36700` and warn on foreign frames |
| `timerState` shape changes in a future PT release | bridge misreads state | bridge depends only on documented `timerState` fields; visible version; compatibility note; integration tests against the real server |
| Packed binary / unsigned exe (P4) | SmartScreen or AV friction | deferred to P4; EV signing; clean-VM + AV testing then |
| >99:59 / overtime / clock HH:MM needed by a real client | feature gap | currently clamp/OFF; needs new rig work + a protocol answer; scoped only on concrete demand |

---

## 16. Testing plan

**Unit (no hardware, CI-able)**

- Keep/extend encoder tests (the 8 verified frames) and state tests
  (thresholds, pause, nudge, speed, clock-offset, clamp, overlay/clock → OFF).
- New: directed-broadcast computation; bind-to-interface selection;
  one-OFF-on-intentional-stop; status state machine (PT × Output → Overall,
  including the "display is holding a stale value" wording).

**Integration (local `server.js`, no hardware)**

- Scripted PT drive: start / pause / resume / nudge / threshold change /
  rundown / message / clock — assert the emitted frame stream.
- Disconnect/reconnect, auth failure, room deleted, client suspended — assert
  status transitions and that **no** OFF is attempted on unexpected loss, one
  OFF **is** sent on intentional stop.
- UDP loopback capture asserting exact bytes and 1 Hz cadence.

**Rig (hardware) regression checklist** — the set that has passed, plus:

- Send-test-frame button; Start/Stop; auto-start.
- **Frame-timeout (re-confirm):** unplug Ethernet mid-countdown → display holds
  last value; replug → auto-recovers to correct value, no restart.
- Intentional Stop → display goes OFF from a single frame.
- NIC changed mid-session → OFF on old adapter, resume on new adapter.
- App killed (`taskkill /F`) → display holds last value; relaunch → recovers.
- Windows sleep/resume; Windows shutdown → best-effort OFF.
- 2 h+ soak; drift vs `display.html` stays zero.
- Overtime / clock / overlay transitions.
- Two saved profiles, switch between them.

**Acceptance**

- A Business Shows operator (not the developer) sets it up from the run-in-place
  folder using only written instructions and runs two real events (P3 gate).

**Packaging (P4)**

- Fresh Windows VM, no Node: install → run → uninstall. SmartScreen and
  antivirus behaviour recorded.

---

## 17. Decisions taken (2026-09-09)

1. **Shape:** proceed toward a standalone Foxy CDEther Bridge first; do **not**
   wait for the Phase 10 Local Event Server. Keep the core embeddable for a
   later optional launcher panel.
2. **UI:** lightweight tray app + loopback-only local web control panel. **Not
   Electron.**
3. **Packaging spend:** defer the installer and code-signing spend until the
   operator-friendly version has been proven on our own machines. Run in place
   until then.
4. **Naming:** "Foxy CDEther Bridge" as the component/code name; user-facing
   terminology favours **"Physical Display Output"**; **CDEther** is the
   selected hardware/interface type.
5. **v1 hardware scope:** CDEther only. The older Hive USB Expander is **not**
   implemented. Countdown + colour + Pause/Resume + nudge + live threshold
   changes (all proven) are the v1 feature set; >99:59, overtime, and
   clock-mode HH:MM are explicitly deferred until a concrete client need plus
   rig time.
6. **Repository:** stays in `presentation-timer`. Moved
   `experimental/cdether-bridge/` → `tools/cdether-bridge/` during P1 hardening.
7. **Scope discipline:** no short-link, licensing, Local Event Server, or
   Hive-USB work rides along with this.
8. **Failure semantics:** intentional Stop/Exit sends one `0x04` OFF then
   closes; unexpected loss lets the display hold its last value, reports the
   loss in the UI, and auto-recovers — **no supervisor/watchdog** for fail-dark
   (the frame-timeout test proved it futile).

**Still open (not blocking P1):** exact operator-facing wording; where the
double-click launcher lives in the folder; whether profiles are a v1 feature or
P5; the Phase 10 packaging toolchain decision (P4).

---

## 18. P2 scope — in-app Physical Display Output status (requirement, not yet designed)

Added 2026-09-09 after the P1 rig pass. **P2 only — do not start.**

The normal Presentation Timer operator must be able to see Physical Display
Output status **from within the Presentation Timer itself**, on the room
**Control page**, as a **compact indicator integrated into the existing
room/header/status area** — not another large row.

**States** (mirror `lib/status.js`): `Off` · `Connecting` · `Live` · `Degraded`
· `Error`.

**May show:** interface type (`CDEther`); bridge connected / not connected;
output active / stopped; the selected network interface where useful;
`"holding last value"` when connectivity is lost; last heartbeat; bridge
version.

**Honesty constraints:**

- **Never claim the physical Hive display itself is connected** — CDEther gives
  no delivery/link feedback. Status reflects only what the *bridge* genuinely
  knows (its PT connection, its output loop, its last UDP send result).
- The bridge stays **read-only** with respect to timer control — a status
  channel must not become a control channel.

**Server-side design questions for P2:**

- The **smallest secure mechanism** for the local bridge to report status to the
  PT server. Candidates to weigh: a dedicated authenticated `POST
  /api/rooms/:room/display-output/heartbeat` using a **new, status-only,
  room-scoped token** distinct from the display token (so a leaked status
  credential grants nothing else); or riding the existing display-token
  Socket.IO connection with a server-accepted `reportStatus` event that the
  server records but never acts on. Prefer whichever is smallest and keeps the
  read-only guarantee structural.
- **Room-scoped and tenant-safe:** status stored per room; a normal client sees
  status only for its **own** rooms (same ownership resolution as everything
  else). Platform Admin *may eventually* see a compact Physical Display column
  on the Master Dashboard.
- **Auto-stale:** status must expire automatically if the bridge stops
  reporting (heartbeat TTL) — a vanished bridge must not leave a stale "Live".
- This is the first time the bridge would talk *to* the server rather than only
  subscribing; the security review for P2 must treat that as its main surface.

**Out of scope for P2:** changing how the timer is controlled; any bridge
ability to affect room state; Master Dashboard rollout (later).

---

Next: prepare the first CDEther commit for review, then **P2 (§18)**. No P2
code until approved.
