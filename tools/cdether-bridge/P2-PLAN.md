# P2 — local control panel + in-app status: design proposal

**Status: DESIGN ONLY, proposed 2026-09-10, awaiting approval. No code yet.**
Scope reference: `NEXT-STEPS.md` §18. Supersedes nothing in P1 (`0a1b581`,
physically verified) or P1.1 (paused, unrelated).

This document is the deliverable for the P2 design pass: current-state
confirmation, recommended architecture, the bridge↔Railway heartbeat design and
its security analysis, UX for both the Control page and the local operator
app, configuration/storage design, exact file lists, rollout sequencing, test
plans, risks, and a slice breakdown. Nothing below has been built.

---

## 1. Current-state confirmation

Read directly from the repo before designing anything:

- P1 is committed at `0a1b5817ea0d15203a8220dd0ccf3a9622f1cf4f`, physically
  verified on real CDEther/XLR/Hive hardware (`RIG-REGRESSION.md`).
- Bridge core (`tools/cdether-bridge/lib/`): `cdether.js` (frame encode +
  `UdpSender`), `net.js` (adapter enumeration, `directedBroadcast`,
  `resolveInterface`), `config.js` (env/flag loading), `status.js`
  (`StatusModel` — a pure PT-state × output-state × derived-overall state
  machine, already emitting exactly the vocabulary §18 asks for: `idle` /
  `connecting`(via `PT_TRANSIENT`) / `live` / `degraded` / `error`, each with a
  human-readable `reason`), `engine.js` (`BridgeEngine` — owns the 1 Hz loop,
  Start/Stop/dispose, wires `PtClient` + `StatusModel` + `UdpSender` together),
  `ptClient.js` (read-only Socket.IO client — connects with `auth: { token:
  displayToken }`, **never emits anything to the server today**), `log.js`
  (bounded `RingLog`). 70 unit/integration tests pass.
- Server (`server.js` + `auth.js` + `db.js` + `urls.js`): `auth.resolveSocketAccess(token)`
  looks the token up against `db.getRoomByToken()`, matching either
  `control_token` or `display_token`, and returns `{ room, role, roomId }` —
  **role is derived server-side from which column matched, never from
  anything client-declared** (`auth.js:47`). `io.on('connection', ...)`
  (`server.js:145`) stores `socket.clientType` / `socket.roomId` from that
  result; every mutating handler is gated by `requireActiveController()`
  (`server.js:199`), which checks `socket.clientType !== 'control'` first.
  A display-token socket is structurally incapable of reaching any of those
  branches — this is the guarantee P2 must preserve.
- `urls.js` `buildRoomLinks()` produces
  `{ controlUrl: ".../control?token=<control_token>", displayUrl: ".../display?token=<display_token>" }`.
  **The Display link already contains everything the local helper needs** — its
  origin is the server URL, its `token` query param is the display token — so
  "paste the Display link" (P2 AIM step 2) is a pure client-side parse, no new
  server endpoint required.
- `public/control.html`'s room header (`.room-header`, lines 393–404) already
  holds a small right-aligned flex group of compact pills/buttons
  (`controllerStatusBadge`, `controllerStatusCount`, `controllerTakeOverBtn`,
  Share Links) that wraps on narrow viewports. This is the existing "compact
  indicator" slot §18 asks for — no new layout region needed, one more pill in
  this group.
- Nothing today lets the bridge talk *to* the server. `PtClient` only listens.
  This is the one new capability P2 introduces, and the reason the brief asks
  for a dedicated security analysis (§4 below).
- P1.1 (protocol-extension investigation) is **paused** (2026-09-10, pending
  resolution of a persistent dim-display state with Hive/Interspace support)
  and was already designed to not block P2 — nothing in this plan depends on
  any P1.1 outcome.

---

## 2. Recommended P2 architecture

Three independently-shippable pieces, in dependency order:

```
┌─────────────────────────┐      existing display-token       ┌──────────────────┐
│  Bridge core (lib/*)     │◄──────  Socket.IO (read-only) ───►│  Railway server   │
│  unchanged +             │      NEW: bridgeStatus event ────►│  (server.js)      │
│  lib/reporter.js (new)   │      (same socket, same auth)     │  in-memory only   │
└───────────┬──────────────┘                                   └────────┬─────────┘
            │ used as a library by                                      │ bridgeStatusUpdate
┌───────────▼──────────────┐                                            │ (room broadcast)
│  Local operator app (new)│                                            ▼
│  tray + loopback web UI  │                                  ┌──────────────────┐
│  ui/  (new directory)    │                                  │ public/control.html│
└──────────────────────────┘                                  │ compact status pill│
                                                                └──────────────────┘
```

1. **Bridge core** stays exactly as proven; gains one small additive reporter
   that piggybacks the *existing* display-token socket to send a narrow,
   whitelisted status heartbeat. No new dependency, no new credential.
2. **Server** gains a tiny, purely additive, in-memory (never persisted)
   per-room status map fed by that heartbeat, with a stale-timeout sweep, and
   rebroadcasts a sanitized snapshot to the room.
3. **Local operator app** is new: a tray icon + loopback-only web panel that
   wraps the bridge core as a library, adds first-run setup (paste Display
   link, pick adapter, see broadcast address, Test Display, Start Output), a
   compact normal-use view, and local config persistence.

### Why ride the existing display-token socket instead of a new status token

Weighed two options:

- **Option A (recommended): reuse the display-token socket**, add one new,
  strictly-typed, rate-limited `bridgeStatus` event that the server accepts
  only from a `role === 'display'` socket and attributes only to that socket's
  server-resolved `roomId` (never a client-supplied room id). No DB change, no
  new secret type, no rotation/revocation UI to build.
- **Option B: a separate status-only token** (new `rooms.status_token` column,
  new issuance/rotation/rendering in the Share Links UI, a dedicated endpoint
  or socket role). Genuinely cleaner *credential-separation* in the abstract,
  but the credential it would separate already has an equivalent blast radius
  to the one it protects: a display token already lets its holder see the
  room's live timer state; letting the same socket additionally *say* "the
  bridge here is Live/Degraded" adds no meaningful new capability — it cannot
  mutate anything, cannot read anything it doesn't already read, and the
  Control page's honesty constraint (never claims the physical display is
  connected) already caps the damage a spoofed status string could do to
  "an operator sees an inaccurate pill they can cross-check by looking at the
  screen." Option B would also mean a second secret per room for the operator
  to manage, cutting against the "paste one link" P2 AIM.

**Recommendation: Option A.** Revisit Option B only if a future capability
genuinely needs a *more* powerful channel than status reporting — not for v1.

---

## 3. Bridge ↔ Railway heartbeat design

**Event:** `bridgeStatus`, client→server, sent over the *same* already-authenticated
`PtClient.socket` connection (the one already carrying the display token in
`auth: { token }`). No new connection, no new port, no new endpoint.

**Payload (exhaustive — anything else is dropped):**

```js
{
  v: 1,                    // schema version, for future-safe evolution
  bridgeId: 'a1b2c3d4e5f6a7b8',   // random 16-hex, generated once, persisted locally;
                                   // a display/correlation label ONLY — never used for authorization
  bridgeVersion: '0.2.0',  // from package.json, capped to 32 chars
  overall: 'off' | 'connecting' | 'live' | 'degraded' | 'error',  // fixed enum
  reason: 'Live - following room "keynote"',  // capped to 160 chars, plain text
  output: 'stopped' | 'running' | 'send-error',                  // fixed enum
  ptConnected: true | false,
  interfaceName: 'Ethernet' | null,   // capped to 64 chars, a label only
  ts: 1234567890123,       // bridge's own Date.now() — informational only,
                            // NEVER used by the server for TTL (see below)
}
```

This maps directly onto `StatusModel.snapshot()` — the bridge already computes
every one of these fields today for its own local status; `lib/reporter.js`
just projects the snapshot into this fixed wire shape.

**Send cadence:** on every `StatusModel` `'change'` event (already de-duplicated
— state *transitions* only, not chatter) **plus** an unconditional heartbeat
every 10s regardless of change, so a steady "Live" doesn't go quiet between
transitions. On intentional `stop()`/`dispose()`, send one final `bridgeStatus`
with `overall: 'off'` immediately before closing the socket, as a courtesy —
belt-and-braces, since the server's own disconnect handler (§ below) clears the
entry regardless, covering the crash/unplug case where no goodbye message can
be sent at all.

**Server-side handling** (new, in `server.js`, inside the existing
`io.on('connection', ...)` block):

- `socket.on('bridgeStatus', (payload) => { ... })`. Guard: no-op unless
  `socket.clientType === 'display'` (defense in depth; only display-role
  sockets would sensibly send this, but the check makes the read-only
  guarantee structural, not incidental).
- Strict validation before anything is stored: enum fields checked against the
  fixed sets above; strings length-capped and control-character-stripped;
  `bridgeId`/`bridgeVersion` regex-constrained (hex / semver-ish); anything
  failing validation is dropped silently (server never crashes or disconnects
  the socket over a malformed heartbeat — a bug in a future bridge version
  should degrade to "no status shown," never take the room offline).
- Rate limit: max ~2 accepted heartbeats/sec per socket; excess dropped. Cheap
  per-socket counter, no new dependency.
- Storage: `bridgeStatusByRoom: Map<roomId, Map<socketId, { payload, receivedAt }>>`,
  declared near the existing `timerRooms`/`roomControllers` Maps
  (`server.js:40`/`:48`). **In-memory only, never written to SQLite** — this
  is inherently ephemeral, heartbeat-driven state; persisting it would make a
  server restart able to resurrect a stale "Live" claim, which is exactly the
  dishonesty this feature exists to avoid.
- Keyed by `socket.id`, not by the client-supplied `bridgeId` — `socket.id` is
  server-assigned and unforgeable; `bridgeId` is carried through purely for
  human/log correlation across reconnects, never trusted for identity or
  authorization.
- On accept: update the entry, recompute the room's *effective* status
  (§5 below), and if it changed, broadcast `io.to(roomId).emit('bridgeStatusUpdate', sanitizedSnapshot)`
  — same broadcast pattern already used for `emitState`/`controllerCount`, so
  both control- and display-role sockets in the room receive it (display.html
  simply won't listen for it — no behaviour change there).
- On a fresh control-role connection (inside the existing initial-state block
  around `server.js:162-175`), include the room's current bridge-status
  snapshot (if any live entries exist) alongside `roomInfo`, so a freshly
  loaded/reloaded Control page shows the correct pill immediately instead of
  waiting for the next heartbeat.

---

## 4. Security analysis of the reporting mechanism

**What's genuinely new:** for the first time, a display-token holder can cause
the server to store and re-broadcast a small piece of state. Everything else
about the trust model is unchanged.

- **Credential:** unchanged — the existing per-room display token,
  server-validated exactly as today via `resolveSocketAccess`, including the
  existing Phase 6c.3 suspended-client rejection (`client_status !== 'active'`)
  and the existing `disconnectAllSocketsForClient()` path on suspension. No new
  credential is introduced, so no new provisioning/rotation/revocation surface.
- **Authorization is structural, not policy:** the handler reads only
  `socket.roomId`, a value set once at connection time from the server's own
  token lookup (`server.js:158`) and never re-derived from anything in the
  `bridgeStatus` payload. There is no `roomId` field in the payload at all —
  cross-room or cross-tenant spoofing isn't merely disallowed, it's
  inexpressible; a display token for room A cannot cause any write to room B's
  entry no matter what the socket sends.
- **No mutation capability added:** the new handler never touches
  `getRoomState()`, `timerState`, `roomControllers`, or any `emitState` path.
  It is entirely parallel to, not layered on, the existing control-gated
  mutation handlers. A malicious display-token holder still cannot start,
  pause, reset, or nudge the timer — verified by construction (the handler
  doesn't call any of those functions), not just by convention.
- **Worst-case abuse — a compromised or malicious display-token holder spams
  fake status:** bounded by (a) strict enum/length validation preventing
  injection or oversized payloads, (b) the per-socket rate limit preventing
  flood, and (c) the Control page's existing honesty constraint that it *never*
  claims the physical Hive display is connected — the ceiling of what a spoof
  can achieve is "an operator is told the bridge software claims Live," which
  they can trivially cross-check by looking at the actual screen. This is a
  nuisance-class risk, not a privilege-escalation or data-exposure one.
- **Rendering safety:** the `reason` string (and any other bridge-supplied
  text) must be set via `.textContent`, never `innerHTML`, in
  `public/control.html` — same discipline the page already applies to
  `roomInfo.slug` (`control.html:788`). Server-side stripping of control
  characters is defense-in-depth on top of that, not a substitute for it.
- **No persistence, no retention obligation:** because nothing is written to
  SQLite, there's no new row that could leak a token, no new backup/GDPR
  surface, and a server restart always starts every room at "no bridge status
  known" rather than replaying a possibly-stale claim.
- **Tenant isolation:** identical to every existing socket handler — proven by
  the same mechanism (`resolveSocketAccess` + server-held `socket.roomId`)
  that already isolates `startTimer`/`pauseTimer`/etc. per room. No new test
  category is needed beyond "does this new handler also respect the existing
  boundary," which is testable directly (§13).
- **Why Option B (a separate token) was not chosen:** it would add a real
  implementation surface (schema, issuance, rotation, UI) to guard against a
  threat that's already nuisance-class under Option A. It remains the fallback
  if a future requirement needs the channel to carry more authority than
  status reporting — explicitly not needed here.

---

## 5. Multiple-bridge behaviour

Realistic scenario: an operator leaves an old bridge instance running (e.g. on
a second laptop, or a stale terminal) while starting a new one for the same
room — or genuinely runs two by mistake. Since CDEther is a UDP broadcast with
no arbitration, two live senders racing 1 Hz frames at the one Hive display is
a real foot-gun (whichever frame lands last each tick "wins" unpredictably).

- The server's map is `Map<roomId, Map<socketId, entry>>` — **multiplicity is
  representable by construction**, not bolted on. Each display-token socket
  gets its own slot; nothing is silently overwritten by a second connection.
- Effective per-room status: if exactly one entry exists, its state is shown
  directly. If more than one entry exists, the *reason* deliberately does not
  invent a sixth public state — it stays within the required vocabulary
  (Off/Connecting/Live/Degraded/Error) but reports `degraded` with an explicit
  reason such as `"2 Physical Display Output sources reporting for this room —
  stop one to avoid conflicting output"`, even if both individually claim
  `live`. This is the more honest read: two independent senders is itself a
  degraded operating condition for the physical output, regardless of each
  sender's own health.
- Not hard-blocked: an operator legitimately swapping bridges (starting a new
  one before stopping the old) shouldn't be prevented from doing so — the
  warning is advisory, matching the "smallest" instruction rather than adding
  a lock/lease mechanism.
- Server logs a throttled warning the first time multiplicity is detected per
  room, for support diagnosis (each entry's `bridgeId`/`bridgeVersion` help
  distinguish "the same bridge reconnecting" from "a genuine second bridge").

---

## 6. Stale/heartbeat timeout behaviour

- **Cadence:** bridge sends on every `StatusModel` change + an unconditional
  10s keepalive (§3).
- **Server TTL:** `STALE_MS = 20000` (2× the keepalive interval, with margin
  for a slow tick or brief GC pause) — recommend implementing generously
  rather than tightly, since the cost of a slightly-late "Off" is near zero
  and the cost of a flappy pill is real annoyance.
- **Sweep:** one global `setInterval` (unref'd, mirroring the existing
  `roomCleanupTimers` pattern at `server.js:438`) every 5s, walking
  `bridgeStatusByRoom` and dropping any entry older than `STALE_MS`; if that
  changes a room's effective status, rebroadcast `bridgeStatusUpdate`. Expected
  cardinality is tiny (a handful of bridges platform-wide), so an O(rooms ×
  bridges) walk every 5s is trivially cheap.
- **Immediate clear on disconnect:** the existing `socket.on('disconnect', ...)`
  handler (`server.js:385`) gets one more branch — if `socket.clientType ===
  'display'`, delete that socket's entry from its room's map right away and
  rebroadcast if the effective status changed. This means a clean Stop/Quit
  (which disconnects the socket) reflects as "Off" within the normal socket
  disconnect latency, not waiting the full 20s TTL; only a hard crash/unplug
  (no disconnect event reaches the server) falls back to the TTL sweep.
- **Reload behaviour:** covered in §3 — a freshly-connecting control socket
  gets the room's current snapshot immediately, so a page reload during a
  "Live" period doesn't show a false "Off" until the next heartbeat arrives.

---

## 7. Control-page status UX

- **Location:** one more compact pill in the existing `.room-header` right-hand
  group in `public/control.html` (next to `controllerStatusBadge`, around
  lines 398–403) — exactly the slot §18 asks for, no new row.
- **Visibility:** rendered only once the room has ever reported a bridge status
  this session (either from the initial snapshot on connect, or the first
  `bridgeStatusUpdate`) — a room with no Physical Display Output configured
  shows nothing extra, ever.
- **Label/colour** (reusing the existing badge colour language already defined
  for `.status-badge.running/paused/stopped`):
  - `CDEther: Live` — green
  - `CDEther: Connecting` — grey/blue
  - `CDEther: Degraded` — amber
  - `CDEther: Error` — red
  - `CDEther: Off` — grey
- **Detail on demand:** a native `title` tooltip (zero new UI chrome) carrying
  the fuller `reason` string, selected interface, bridge version, and — when
  relevant — the multiplicity warning. A richer popover is an easy later
  addition (§16) but isn't needed for v1.
- **Wiring:** one more `socket.on('bridgeStatusUpdate', ...)` in
  `control.html`'s existing script block, mirroring the already-present
  `socket.on('controllerStatus', ...)` handler (`control.html:902`) — same
  pattern, same file, no new page or route.
- **Hard constraint respected:** copy is always about the bridge/CDEther
  output (`"CDEther output Live"` style), never `"Hive display connected"` —
  matches `StatusModel`'s own `reason` strings, which already never claim
  hardware acknowledgement (`status.js` header comment: "the physical display
  CANNOT be blanked once connectivity is lost... an honest status surface is
  the primary safety mechanism").

---

## 8. Local helper / tray / web-panel UX

A new Node process (not Electron), reusing `lib/*` as a library, unchanged.

- **Loopback web panel:** bound to `127.0.0.1` only, on a fixed or
  auto-selected high port — never reachable from the CDEther LAN or the
  internet. This bind restriction *is* the panel's access control, since it
  has no login of its own — the same trust model as e.g. a local dev server.
- **Tray:** icon + menu (Open Control Panel → opens the loopback URL in the
  default browser; Start Output; Stop Output; Test Display; Quit — Quit
  triggers `engine.dispose()` before exiting, so the proven "one OFF frame on
  intentional stop" behaviour is preserved even from the tray). Exact
  Windows-tray-from-plain-Node library choice is an implementation-time spike
  (§15 risk), not an architecture decision.
- **First-run / setup wizard** (P2 AIM steps 1–6, no PowerShell/npm/env vars):
  1. **Paste Display Link** — a single text field. On submit, parse
     client-side with `new URL(pasted)`: origin → server URL, `?token=` →
     display token (this is exactly what `urls.js buildRoomLinks()` already
     produces server-side, so no new server contract is needed to make this
     work). **Validate** opens a short probe connection (the same
     `PtClient`) and shows the resolved room name/slug from the first
     `timerState.roomInfo.slug`, or a clear error if the link is invalid,
     expired, or points at a suspended client's room.
  2. **Choose Ethernet adapter** — a dropdown populated from the already-built
     `lib/net.js listInterfaces()`, each row showing name + CIDR.
  3. **Derived broadcast address** — shown read-only immediately on selection,
     via the already-built `directedBroadcast()`/`resolveInterface()`, exactly
     matching P2 AIM step 4 ("app derives and clearly shows...").
  4. **Test Display** button (see §"Start/Stop semantics" below).
  5. **Start Output** button.
- **Normal-use compact view** (shown on subsequent launches once configured):
  room name/slug; "Presentation Timer: <state>"; "CDEther output: <state +
  reason>" (the same `StatusModel` snapshot the Control page pill uses — one
  source of truth, two renderings); selected interface (with a "Change
  adapter" link back into setup); Start/Stop Output (mutually exclusive per
  `engine.outputActive`); Test Display; a short recent-log tail (surfacing the
  already-built `lib/log.js` `RingLog` — no new logging infra needed); a way to
  re-run setup (change room/adapter) without reinstalling.
- **Error copy:** reuses the existing `StatusModel` `reason` strings verbatim
  where possible (they're already specific and honest, e.g. the
  "holding its last value... will resume automatically" wording) rather than
  inventing new copy for the same conditions.
- No admin rights, no installer, no service — a foreground process with a tray
  icon, runnable today on our own machines.

---

## 9. Configuration/storage design

- **What persists:** server URL + display token (or just the pasted Display
  link, from which both are derivable), the chosen adapter name (already
  re-resolvable if DHCP changes its IP, via the existing
  `net.resolveInterface({ name })`), a persisted `bridgeId` (generated once),
  and small UI prefs (setup-completed flag, last window state).
- **Location:** `%APPDATA%\FoxyCDEtherBridge\config.json` — per-user, no admin
  rights, survives a rebuild of the executable, never lives in the repo or
  next to it (so it's never at risk of an accidental commit).
- **Token secrecy — investigated honestly, not glossed over:** Windows offers
  DPAPI (`CryptProtectData`) to encrypt-at-rest, tying decryption to the
  logged-in Windows user profile. That's a real improvement over plaintext
  against another user profile or a casual copy of the file, but it does
  **not** protect against malware running as the same Windows user — that's
  the honest ceiling of DPAPI, not a limitation of this design specifically.
  **Recommendation:** ship plain-JSON storage first (matches "smallest first"),
  with an explicit one-line doc note telling the operator to treat the file
  like a password, and add the honest mitigating fact that a display token
  alone still cannot control the timer — only view it — which meaningfully
  caps the blast radius of a leak. DPAPI wrapping is a good fast-follow
  hardening slice (§16), not a blocker for v1.
- **Never logged:** `lib/log.js` entries and any console output must redact
  the token (e.g. first/last 4 chars only) — the same discipline the server
  already applies to API keys and session tokens.
- The `bridgeStatus` heartbeat payload (§3) never restates the token — it
  rides the already-authenticated socket, so it doesn't need to.

---

## 10. Exact server/app files P2 would modify

- **`server.js`:**
  - Add `bridgeStatusByRoom = new Map()` near the existing `timerRooms`
    (`:40`) / `roomControllers` (`:48`) declarations.
  - Inside `io.on('connection', ...)`, after the existing role/roomId setup
    (`:145-160`): add `socket.on('bridgeStatus', (payload) => { ... })`
    (validate → store → recompute → conditionally broadcast, per §3–§5).
  - Extend the initial-state emit (`:162-175`) to include the room's current
    bridge-status snapshot alongside `roomInfo`, for control-role sockets.
  - Extend the existing `socket.on('disconnect', ...)` handler (`:385-417`)
    with a branch for `socket.clientType === 'display'` (immediate entry
    removal + rebroadcast, per §6).
  - Add one small unref'd `setInterval` stale-sweep near the existing
    `roomCleanupTimers` (`:438`).
  - **Not touched:** `auth.js`, `db.js` — no new middleware, no new token type,
    no schema change, in this recommended design.
- **`public/control.html`:**
  - New pill markup in `.room-header`'s right-hand group (near `:399-401`) +
    a few lines of CSS reusing the existing `.status-badge` colour pattern.
  - New `socket.on('bridgeStatusUpdate', ...)` handler mirroring the existing
    `controllerStatus` handler (`:902`), updating the pill via `.textContent`.
- **Not touched at all:** `display.html`, root `package.json`, any
  admin/dashboard page (a Master Dashboard column is explicitly deferred, per
  §18's own text), Companion.

---

## 11. Exact bridge files P2 would modify/add

- **`lib/engine.js`:** wire `status.on('change', ...)` and a 10s interval to
  call a new `sendStatus()` helper; skip silently (no queueing) when the
  socket isn't currently connected — the next successful heartbeat naturally
  catches up since this is state, not an event log.
- **`lib/ptClient.js`:** add a narrow `sendStatus(payload)` method (guarded on
  `this.socket && this.socket.connected`) rather than having `engine.js` reach
  into `.socket` directly, and update the file's header comment (currently
  "This client also never emits anything to the server") to describe this one
  narrow, intentional exception.
- **New `lib/reporter.js`:** pure function
  `buildBridgeStatusPayload(statusSnapshot, { bridgeId, bridgeVersion, interfaceName })`
  → the whitelisted shape in §3. Kept pure and separate from `engine.js` so
  it's trivially unit-testable without a real socket.
- **New `lib/bridgeId.js`** (or folded into a new local-config module): 
  generate-once-and-persist `crypto.randomBytes(8).toString('hex')`.
- **New `ui/` directory** (separate slice, §16): loopback HTTP server, tray
  integration, first-run wizard, local config persistence — kept clearly
  separate from the proven `lib/` core so `bridge.js`'s terminal-run path
  keeps working unchanged throughout rollout.
- **`test/`:** new unit tests for `lib/reporter.js` (payload shaping, enum/
  length enforcement mirrored client-side); an extension proving `engine.js`
  emits `bridgeStatus` on every `StatusModel` change and on the heartbeat
  timer, and does *not* throw or queue when the socket is down.
- **Not touched:** `lib/cdether.js`, `lib/state.js`, `lib/net.js`, the CDEther
  frame semantics, or `bridge.js`'s core loop — P2 is additive around the
  already-proven core.

---

## 12. Deployment sequencing (P1 bridge stays usable throughout)

The `bridgeStatus` event is purely additive server-side: a P1 bridge (already
committed, unaware of this event) simply never sends it, so its room's map
entry stays empty and the Control page shows no pill — **zero behaviour change
for anyone still running the committed P1 bridge, at every step below.**

1. **Server first.** Ship the `bridgeStatus` handler + stale sweep + Control
   page pill, deploy to Railway, verify with a small hand-scripted
   `socket.io-client` test connection (no bridge code change needed) emitting
   a few `bridgeStatus` events using a real room's display token. De-risks the
   server change independently of the bridge.
2. **Bridge heartbeat next.** Add `lib/reporter.js` + `ptClient.sendStatus` +
   `engine.js` wiring, still terminal-run (`bridge.js`, no UI). Re-run the full
   existing 70-test suite plus new heartbeat tests, then a short rig re-check
   confirming the Control page pill correctly tracks Live/Degraded/Off against
   real hardware — no need to redo the full `RIG-REGRESSION.md` checklist,
   since CDEther frame behaviour itself is untouched.
3. **Local UI last.** Build the tray/loopback panel on top, since it depends
   on the engine already reporting correctly.
4. At every step, `node bridge.js` (env vars/flags, exactly as today) keeps
   working exactly as documented in the current `README.md`/`RIG-REGRESSION.md`
   — an operator mid-event on the P1 bridge is never forced to upgrade.

**Rollback:** the server change reverts independently (delete the handler +
Map + pill), with no data migration to undo since nothing is persisted. The
bridge change reverts to commit `0a1b581` at any point with zero server-side
impact — the two sides are provably decoupled by design.

---

## 13. Automated testing plan

- **Bridge:** unit tests for `lib/reporter.js` (correct shape; enum/length
  enforcement so bad local state can't even be sent); `engine.js` tests
  (fake timers) asserting `bridgeStatus` fires on every `StatusModel` change
  and on the 10s heartbeat, and does *not* fire/throw/queue while the PtClient
  socket is disconnected.
- **Server:** extending the same "real socket.io, fake/real PT server" style
  already proven in the bridge's own `test/integration.test.js`:
  - a display-token socket's `bridgeStatus` reaches only control-role sockets
    in the *same* room, never a different room's;
  - malformed/oversized/wrong-enum payloads are dropped without crashing the
    socket or process;
  - a control-role socket sending `bridgeStatus` is ignored (structural
    read-only guarantee holds);
  - the stale sweep removes an entry and rebroadcasts "Off" after the TTL with
    no heartbeat;
  - disconnect clears the entry immediately, not waiting for the TTL;
  - two simultaneous display-token sockets for one room both register, and the
    multiplicity/"Degraded — multiple sources" rule triggers;
  - a suspended client's bridge socket is rejected/dropped exactly like every
    other suspended-client socket today (reuses the existing Phase 6c.3 test
    pattern).
- **End-to-end (Playwright,** matching the style already used across earlier
  phases): load a Control page, script a fake heartbeat over a raw
  `socket.io-client` connection using that room's real display token, assert
  the pill renders/updates/expires correctly in the live DOM.

---

## 14. Physical / non-developer acceptance test plan

A short numbered checklist, in the style of `RIG-REGRESSION.md`, run by someone
who is **not** the developer:

1. Launch the helper by double-clicking — no terminal. Tray icon appears.
2. Open Control Panel from the tray. First-run wizard appears.
3. Paste a real room's Display link (copied from the room's Share Links).
   Validate → the correct room name appears, with no server URL or token ever
   typed by hand.
4. Select the correct Ethernet adapter from a dropdown (not typed). The shown
   broadcast address matches what's expected for that LAN.
5. Test Display → Hive shows the agreed safe test pattern.
6. Start Output → Hive follows the live timer; a separately-opened Control
   page shows the compact status reach "Live" within a few seconds.
7. Unplug the CDEther Ethernet cable → within ~20s Control page status flips to
   "Degraded" with an honest reason; the physical display still shows its last
   value (expected — not a bug, matches the proven P1 behaviour).
8. Re-plug → status returns to "Live" automatically, no relaunch needed.
9. Stop Output (or Quit from the tray) → Hive goes blank (OFF frame); Control
   page status flips to "Off" quickly.
10. Relaunch the helper later — previous room/adapter selection is remembered,
    no need to re-paste the link.
11. Confirm no unredacted token appears in any visible log/console.

**Sign-off:** every row passes with a non-developer operating it from written
instructions alone, with no PowerShell/npm/env-var step anywhere — directly
validates the P2 AIM.

---

## 15. Risks and rollback

- **Compromised/buggy bridge spams a room** — mitigated by rate-limiting +
  strict validation (§4); rollback is deleting the handler, no data to unwind.
- **DPAPI/native-dependency complexity delays the UI slice** — mitigated by
  shipping plain-JSON config first, explicitly documented as such, treating
  encryption-at-rest as a fast-follow (§9).
- **Tray library choice in plain Node (Electron explicitly rejected) has weak
  Windows support** — an implementation-time spike, not a design blocker;
  worst case, ship the loopback panel with tray deferred to the next slice
  (a "keep this window open" fallback), which still satisfies "no
  PowerShell/npm/env vars" even without a tray icon on day one.
- **Multiple bridges causing frame collisions on the physical display** —
  mitigated by explicit multiplicity detection (§5) as a warning, not a hard
  block (a lock/lease mechanism would be more machinery than "smallest" asks
  for; revisit only if real-world use shows it's needed).
- **First time the bridge talks *to* the server** — the main new surface;
  mitigated by a fixed, tiny, enum-heavy schema with zero client-trusted
  identity fields, and treated as the explicit focus of the P2 security
  review, per the brief.
- **Rollback at any point** is independent on each side (§12) with nothing
  persisted to migrate back, and the terminal `bridge.js` P1 path is never
  removed — a rollback of the UI/heartbeat work leaves operators exactly where
  P1 already left them.

---

## 16. Recommended P2 implementation slices

- **P2.0 (docs)** — record the P1.1 pause; this proposal. *(this session)*
- **P2.1 (server)** — `bridgeStatus`/`bridgeStatusUpdate` handler, in-memory
  map, stale sweep, tests. Deploy and verify with a hand-scripted fake client —
  no bridge or UI change yet.
- **P2.2 (Control page)** — the compact pill + its socket listener, verified
  against the P2.1 scripted fake client — confirms the UX before real hardware
  is wired to it.
- **P2.3 (bridge heartbeat)** — `lib/reporter.js` + `ptClient.sendStatus` +
  `engine.js` wiring + tests, verified against the real rig — confirms the
  honest states actually reflect real hardware events end-to-end. Still
  terminal-run only, no UI.
- **P2.4 (local config + loopback panel, no tray)** — first-run wizard,
  adapter picker, Test Display, Start/Stop, config persistence. Runnable
  directly (`node ui/server.js` or similar), browser-tested locally.
- **P2.5 (tray)** — wrap P2.4 with a tray icon/menu once the loopback panel is
  proven on its own.
- **P2.6 (polish, optional)** — multiplicity UX refinement, log-viewer panel,
  DPAPI hardening spike.

Packaging/installer/signing remains explicitly out of scope for all of the
above, per the brief — P2 stays runnable on our own machines without an
installer throughout.

---

## Start/Stop/Test semantics (carried forward from P1, unchanged, restated for P2's UI)

- **Intentional Stop / Quit:** one OFF frame, then cease — already proven,
  `engine.stop()`/`dispose()` unchanged.
- **Unexpected loss (PT/network/NIC):** cease transmission, report Degraded,
  never attempt an OFF (cannot reach disconnected hardware), physical display
  holds its last value, automatic recovery from fresh authoritative state on
  reconnect — already proven, unchanged.
- **Test Display (new UI affordance, proposed behaviour):** send a clearly
  recognisable, obviously-not-a-real-time pattern — recommend `88:88` amber
  (all-segments-lit is the traditional display self-test pattern; amber reads
  as distinct from both a real green countdown and a real red urgent state) for
  a short fixed duration (e.g. 3s) or until the operator dismisses it, **then**:
  if output was already running live, resume sending the current authoritative
  frame; if output was stopped, send one OFF frame and return to stopped. This
  keeps Test Display side-effect-free with respect to whatever state the
  bridge was actually in before the test.
