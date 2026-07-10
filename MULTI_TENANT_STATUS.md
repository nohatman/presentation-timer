# Multi-Tenant Product Status

Tracks progress converting Presentation Timer from a single-operator web app into a
licensable multi-tenant product. See project memory / conversation history for the
full design brief this work follows.

## Completed phases

### Phase 6a — Session authentication backend + human login
- New `users` table: every user (including platform admins) links to a `client_id`
  NOT NULL - a platform-admin user is linked to whichever client already carries
  `is_platform_admin = 1` (Phase 3), so `req.client` is structurally identical
  regardless of auth method and `requirePlatformAdmin` needed zero changes.
- New `sessions` table: `token_hash` only, never the raw token - same SHA-256
  principle as `api_key_hash`. Session tokens are high-entropy random values, unlike
  passwords (bcryptjs, cost 10 - deliberately not native bcrypt, avoiding a second
  native-module Railway build after Phase 1's `better-sqlite3` saga).
- Login: `POST /api/auth/login`, rate-limited (8/5min per IP, in-memory). Unknown
  email and wrong password return an identical response - verified directly, not
  just by code inspection.
- Sessions are DB-backed (not stateless JWT) specifically so logout and password
  reset can genuinely revoke them server-side - verified: an old cookie is
  rejected immediately after logout, not just cleared client-side.
- `HttpOnly` + `SameSite=Lax` always; `Secure` added automatically only when
  `req.secure` is true (respects the existing `trust proxy` setting, so it
  self-adjusts to Railway's HTTPS in production vs local HTTP in dev) -
  confirmed both ways directly, including simulating Railway's
  `X-Forwarded-Proto: https` header.
- Forced first-login password change (`must_change_password`): enforced
  server-side, not just a client-side redirect suggestion - every dashboard
  route rejects a flagged session with 403 until `/api/auth/change-password`
  clears it. Self-service password change keeps the current session alive but
  invalidates every other one for that user; admin-triggered reset (CLI) 
  invalidates ALL sessions including the current one and re-flags the account.
- Origin/Referer check on state-changing session-authenticated requests
  (lightweight CSRF mitigation) - Bearer-key requests are exempt by construction
  (a cross-site page can't attach an arbitrary Authorization header) and verified
  to remain unaffected by a mismatched Origin.
- `requireDashboardAuth` accepts Bearer API key (tried first, identical to the
  old `requireClientAuth` behaviour) OR session cookie - a strict superset, so
  every existing Bearer-authenticated caller (Companion, curl, existing tests)
  is provably unaffected. The dashboard's normal human workflow no longer
  prompts for or stores an API key at all (removed `getApiKey()`/`prompt()`);
  Bearer auth remains fully available server-side for Companion/API use, just
  no longer surfaced as a browser UI affordance.
- `BOOTSTRAP_ADMIN_USER_EMAIL` env var: same proven pattern as
  `BOOTSTRAP_PLATFORM_ADMIN` (Phase 3) - creates a login for that email linked
  to the existing platform-admin client, prints a temp password once, never
  touches the Legacy client or the Platform Administrator API key. Errors
  clearly (doesn't guess) if no platform-admin client exists yet.
- CLI: `scripts/create-user.js`, `scripts/reset-user-password.js`,
  `scripts/list-users.js` (never prints password hashes).
- `scripts/change-user-email.js` (local DB) / `RENAME_USER_EMAIL_FROM` +
  `RENAME_USER_EMAIL_TO` env vars (production, same boot-time bootstrap
  pattern as `BOOTSTRAP_ADMIN_USER_EMAIL`) - corrects a login email in place:
  same user id/password/client link (so platform-admin status, derived
  transitively through that link, survives too - verified directly), rejects
  a target email already used by another user or the user's own current
  email, invalidates that user's existing sessions, never touches client API
  keys or room tokens. Idempotent on repeat boots with the vars left set
  (checks whether the target email already exists before acting).
- Verified end-to-end (not just unit-level): login success/failure, rate
  limiting, forced password change gating and clearing, session persistence
  across requests, logout revocation, admin-reset revocation, cross-client
  session isolation (a normal client session cannot see or reach another
  client's rooms, direct slug access included), platform-admin session
  cross-client visibility, Bearer API-key path fully unaffected, Companion
  endpoint fully unaffected, control/display token socket auth fully
  unaffected, CSRF/Origin rejection, and cookie `Secure` behaviour in both
  simulated-production and local-HTTP conditions.
- **Deployed to Railway and browser-tested - approved.** Human login, forced
  password change, session persistence (reload/new tab), and logout all
  confirmed working in the real deployed environment, not just locally.
- **Phase 6b (dashboard mobile responsive pass) not started** - explicitly
  deferred until after the email-correction script below is deployed and
  confirmed.

### Phase 1 — Data model & persistence (SQLite)
- Replaced the flat `rooms.json` file with SQLite (`better-sqlite3`), via `db.js`.
- Schema: `clients` → `events` → `rooms` (one default event per client for now,
  no Event CRUD yet), plus a `meta` key/value table for one-off migration flags.
- `DATABASE_PATH` env var selects the DB file (Railway: `/data/presentation-timer.sqlite`
  on a mounted volume; local dev: `./data/presentation-timer.sqlite`, gitignored).
- `LEGACY_ROOMS_JSON_PATH` env var drove a one-time import of the old flat-file
  rooms into a synthetic "Legacy" client/event. Runs at most once, guarded by a
  meta flag; a missing file just logs a warning and continues - existing room data
  did not need to be preserved.
- Timer engine (drift correction, rundown, messaging) untouched; only the
  persistence backend changed. Same debounced (500ms) save as before.
- Railway build required `engines.node: "20.x"` (package.json) and `nixpacks.toml`
  (`nodejs_20`, `python3`, `gcc`, `gnumake`) for the native `better-sqlite3` addon
  to build under Nixpacks.

### Phase 2 — Ownership & token-based authentication
- Every room has a `control_token` and `display_token` (opaque, unguessable,
  generated at creation). Browser access is via `/control?token=...` and
  `/display?token=...` - the old `?room=<name>` links no longer work (deliberate
  cutover, approved; no legacy-link compatibility was required).
- Every client has an `api_key` (shown once at creation/rotation, stored only as
  a SHA-256 hash). Sent as `Authorization: Bearer <key>` on all REST/dashboard/
  Companion requests.
- Socket.IO role (`control` vs `display`) is derived server-side from which
  token matched the connection - never trusted from a client-declared param.
  Non-control sockets are rejected on every mutation event.
- In-memory timer-state Map is keyed by the room's numeric database id, not its
  slug - slugs are only unique per-client, not globally, so two clients can
  legitimately reuse the same room name with zero bleed (verified directly).
- All REST endpoints (room CRUD, Companion-style start/pause/rundown/message
  actions) are authenticated and ownership-scoped.
- Companion module updated to v1.2.0: sends the client API key as a Bearer
  header; a rejected key surfaces as a distinct `AuthenticationFailure` status.
- CLI: `scripts/create-client.js`, `scripts/rotate-client-key.js`,
  `scripts/list-room-links.js` (list/regenerate a client's room links).

### Phase 4 — Room controller exclusivity / collaboration model
- One active controller per room at a time (per control-token socket); additional
  control-token connections become observers. Role is server-derived per socket,
  not per token - two people sharing the same control link get distinct roles.
- Take Over is always available - no approval step, no hard lock, so an operator
  can always recover if the controlling device crashes, disconnects, or becomes
  unavailable. Custom in-app confirmation modal (not `window.confirm()`): Cancel/
  Take Control, click-outside and Escape both close without changing control,
  focus moves into the modal on open and returns to the Take Over button on close.
- REST/dashboard/Companion actions are exempt entirely - a separate, higher trust
  tier (client API key) than a shared browser control-token session. Verified
  directly: REST actions kept working while sockets were mid observer/controller
  handoff.
- Controller/Observer status is integrated into the existing Room header card
  (compact badge + connection count + conditional Take Over button) rather than
  a separate full-width notice row.
- Mobile layout fixed as part of this phase: `.container`'s
  `grid-template-columns: repeat(2, minmax(320px, 1fr))` and
  `.timer-control-row`'s fixed `185px 155px 1fr` columns never collapsed below
  ~650-700px regardless of viewport; fixed via a `max-width: 700px` media query
  collapsing both to a single column, plus `flex-wrap` on the nav row and room
  header. Verified with Playwright: no horizontal overflow at 360/390/430px in
  both Controller and Observer states and with the modal open; desktop (1400px)
  layout confirmed unchanged.
- Related bug fixed in the same pass: `setOutputMode('timer')` ran unconditionally
  on page load and always emitted to the server, so an observer got an unprompted
  rejection notice before touching anything. Split into a UI-only update and the
  emitting user action.
- Shared Control (opt-in, all control-token holders can act concurrently) was
  analyzed but deliberately not built - see "Known future admin/client UI
  improvements" below for the binding constraints if it's ever implemented.
- **Approved and complete**, per direct browser testing (not just automated checks).

### Phase 3 — RBAC roles & client-scoped Master Dashboard
- `clients.is_platform_admin` flag (migrated onto the existing table via
  `ALTER TABLE`, safe on an already-populated DB - verified against a live
  test database with existing clients).
- Platform Admin (BizShows-only) sees and can act on every client's rooms;
  a normal client key is completely unaffected - sees only its own rooms,
  exactly as in Phase 2 (regression-tested directly).
- `GET /api/whoami` tells the dashboard which view to render.
- `/api/admin/rooms/:id/*` routes (start/pause/resume/reset/delete/
  regenerate-tokens) - addressed by numeric id, not slug, since slugs collide
  across clients by design once you're looking platform-wide.
- Dashboard: client-name badge per room in platform-admin view; platform-wide
  "Start All" does not exist (client-scoped Start All is unaffected); "Stop
  All"/Delete/Regenerate get an extra confirmation naming the affected client
  when acting cross-client.
- CLI: `scripts/create-platform-admin.js`, `scripts/list-clients.js`. Client
  management is deliberately CLI-only for now - no web UI for creating/listing
  clients (see "Known future admin/client UI improvements" below).
- `BOOTSTRAP_PLATFORM_ADMIN` env var: since the production DB only exists on
  Railway's volume (unreachable from a local script run), setting this var and
  redeploying creates the named platform admin and prints its key once to the
  boot log - reuses the same pattern already proven for Legacy-client key
  recovery. Inert unless set; safe to leave set (no-ops once the client exists).

## Current login / API key behaviour

As of Phase 6a, the normal human workflow is a real login, not an API key:

1. **Human dashboard login** (`users` + `sessions` tables) - email/password at
   `/login`, bcrypt-hashed password, DB-backed session behind an `HttpOnly`,
   `SameSite=Lax` cookie (`Secure` automatically added in production). 30-day
   fixed expiry, server-side revocation on logout/reset. Forced password
   change on first login for newly-provisioned accounts. No API key is ever
   shown to, entered by, or stored by a human user anymore - the dashboard's
   `prompt()`/`localStorage` API-key flow was removed from the UI entirely.
2. **Client API key** - unchanged, still used by Companion and any other
   machine-to-machine/API integration exactly as before. `requireDashboardAuth`
   accepts it as an emergency-compatibility fallback alongside the session
   cookie, but it is no longer part of the browser UI.
3. **Room control/display tokens** - completely unchanged, unaffected by any
   of the above (control-token/display-token socket auth was not touched in
   Phase 6a and was re-verified directly to confirm that).

No self-service signup, no self-service password reset (no email dependency
yet - deliberately deferred) - every human account is provisioned manually via
`scripts/create-user.js`, with `scripts/reset-user-password.js` as the manual
recovery path (mirrors `rotate-client-key.js`'s pattern exactly, and
invalidates all of that user's existing sessions).

## Railway volume / database assumptions

- The SQLite file must live on a Railway-mounted persistent volume
  (`DATABASE_PATH=/data/presentation-timer.sqlite`), not the ephemeral app
  filesystem - confirmed working via Phase 1 deploy + redeploy test.
- Local dev falls back to `./data/presentation-timer.sqlite` (gitignored).
- WAL journal mode is enabled. This is safe for the current single
  application-process model; it is **not** designed for multiple app
  instances writing to the same file concurrently - horizontal scaling of
  the web process would need further work.
- The production database is **not reachable from a local machine**. Any
  one-off admin action against production must run inside the Railway
  environment itself. The established pattern for this is an env-var-gated
  bootstrap checked at boot, logging its result once to Railway's deploy
  logs - not a Railway CLI/SSH command (deliberately avoided since volume
  access from `railway run` was not confirmed).
- `nixpacks.toml` pins `nodejs_20` + `python3`/`gcc`/`gnumake` because
  supplying a custom `[phases.setup]` replaces (not merges with) Nixpacks'
  default package set - needed for better-sqlite3's native build.
- **No backup/restore process exists yet for the volume.** Not addressed by
  any phase so far - worth flagging as a real gap, not yet planned.

## Known bugs / UX issues (captured, not fixed)

- **Master Dashboard mobile responsive layout.** On initial mobile load, the
  dashboard renders wider than the viewport and appears partially cropped/
  zoomed; elements then shift and the layout settles into a better position
  after a moment. Header controls and room cards need a proper responsive
  layout for small screens. Not a Phase 4 regression - pre-existing. Deferred
  as its own future UI/UX task; deliberately not bundled into any phase to
  avoid a broad dashboard redesign as a side effect of unrelated work.
- ~~Control panel mobile responsive layout~~ **FIXED** (Phase 4 mobile pass).
  Root cause was `.container`'s `grid-template-columns: repeat(2,
  minmax(320px, 1fr))` and `.timer-control-row`'s fixed `185px 155px 1fr`
  columns, neither of which collapsed on narrow viewports; a secondary cause
  was the top nav row (`h1` + links) lacking `flex-wrap`. Fixed via a
  `@media (max-width: 700px)` override collapsing both grids to a single
  column, plus `flex-wrap: wrap` on the nav row and the room header. Desktop
  layout (grid definitions above the media query) is untouched. Verified with
  Playwright: `document.documentElement.scrollWidth <= clientWidth` at 360px,
  390px, and 430px, in both Controller and Observer states, and with the
  Take Over modal open; desktop (1400px) confirmed still 2-column/3-column.
  A related bug found and fixed in the same pass: `setOutputMode('timer')`
  was called unconditionally in the page's `load` handler (to set initial
  button highlighting) and always emitted to the server - for an observer,
  this fired an unprompted rejection notice on every page load before any
  user action. Fixed by splitting UI-update from server-emit (mirrors the
  existing `emitSettings()` on-load exclusion already in the code).

## Known future admin/client UI improvements (captured, not started)

- ~~Proper client login: email/password, replacing API-key-in-a-`prompt()`~~
  **DONE (Phase 6a)**.
- ~~Persistent session/cookie-based login, replacing the raw API key sitting
  in `localStorage`~~ **DONE (Phase 6a)**.
- A client details page. **Not started** - Phase 6c candidate.
- A client list view for Platform Admin (currently CLI-only via
  `list-clients.js`/`list-users.js`). **Not started** - Phase 6c candidate.
- Client profile/status/API key management from the UI (currently CLI-only:
  create/rotate via scripts). **Not started** - Phase 6c candidate.
- Events and rooms shown under each client in the UI (currently: one default
  event per client, not surfaced anywhere in the UI). **Not started**.

## Remaining planned phases

- **Phase 5 - Active Rooms visibility.** Fold fully into the authenticated
  dashboard (largely already true post-Phase 2/3); add an optional per-room
  "hidden from Active Rooms" operational flag (not a security control).
- **Phase 6b - Dashboard mobile responsive pass.** Not started - explicitly
  deferred until 6a is deployed and browser-tested. Same method as the
  control.html mobile fix in Phase 4: identify the actual offending
  grid/width rules via inspection, not guesswork, then a scoped media-query
  fix. Also removes the (now session-login-redundant) header space the old
  API-key button used to occupy.
- **Phase 6c (candidate) - Platform Admin client-management UI.** Client list
  view, client detail page, client profile/API-key management from the UI
  (currently CLI-only). Not started, not yet approved as its own phase - the
  `users` table design from 6a is already forward-compatible with it
  (multiple users per client, already-resolved platform-admin status) with
  no rework needed when it's picked up.
- **Phase 7 (candidate) - Optional per-room Shared control mode.** Analysis
  given (not implemented), decided **not** to build now. Binding constraints
  for whenever it is built:
  - Store `controlMode` in the room's `state_json` (alongside `displayScale`/
    `messageMode` etc.), **defaulting to `"exclusive"`** - no schema
    migration needed, same pattern as every other per-room setting.
  - Exclusive Control remains the default and only current mode; Shared
    Control must always be **explicitly opt-in** per room, never a global
    default or an implicit side effect of anything else.
  - The control interface must **clearly indicate** which mode a room is in
    at all times (not just when something goes wrong).
  - The UI must **warn users about the risk of conflicting simultaneous
    commands** before/while Shared mode is active - not just documented here,
    visible to the client at the point they opt in.
  - Real operational risk if built (conflicting simultaneous commands, no
    per-operator audit trail) - a legitimate feature for customers who want
    co-piloted control, but a genuine event-day risk. Deliberately kept
    separate from Phase 4 rather than folded in, so Phase 4's actual fix
    isn't muddied by simultaneously shipping an opt-out of it.
  - **Explicitly out of scope even within this future phase**: a more
    granular per-capability operator model (timer control / rundown control /
    messaging-only / observer as separate grants, rather than a blanket
    controller/observer binary) - would likely require real per-operator
    identity, not just a shared control token. Noted as a distinct, larger,
    undesigned idea - not part of the Shared Control candidate phase above.
