# Multi-Tenant Product Status

Tracks progress converting Presentation Timer from a single-operator web app into a
licensable multi-tenant product. See project memory / conversation history for the
full design brief this work follows.

## Completed phases

### Phase 6c.1 — Platform Admin client-management UI (read-only)
- New pages `/admin/clients` (list) and `/admin/clients/:id` (detail), reachable
  only by a logged-in Platform Administrator - no create/edit/suspend/reset/
  rotate actions yet (6c.2/6c.3). "Manage Clients" nav entry added to the
  Master Dashboard, shown only when `isPlatformAdmin` (same gating already
  used for the existing platform-admin badge/Start-All logic).
- New `requireAdminSession` middleware (`auth.js`) - session-cookie-only, with
  **no Bearer branch at all**, so a client API key (even a platform-admin
  client's own key) can never reach this UI or its endpoints. Chained with the
  existing `requirePlatformAdmin`. This is deliberately stricter than
  `requireDashboardAuth`'s Bearer-or-session fallback used everywhere else in
  the app - verified directly with a valid platform-admin Bearer key against
  `/api/admin/clients`, confirmed 401.
- The two page routes also get a server-side redirect gate (defense-in-depth
  beyond `/dashboard`'s looser existing precedent, deliberate for this more
  sensitive cross-tenant-data area): no session → `/login`; a valid session
  that isn't a platform admin → `/dashboard` (never reveals the admin pages
  exist). The API layer independently re-gates every byte of real data
  regardless of how the page was reached.
- `db.js`: `getClientsWithCounts()` (list + user/event/room counts via
  correlated subqueries, avoiding the join-multiplication a naive multi-table
  JOIN would cause) and `getClientDetail(id)` (profile + users + events/rooms
  for one client) - both deliberately exclude `password_hash`,
  `control_token`, `display_token`, `api_key_hash`, and `state_json`; this is
  an administrative overview, not a place that should surface bearer
  credentials. Verified directly: the detail JSON response for a real client
  has no `password_hash`/`control_token` keys at all.
- `audit_log` table + append-only `recordAuditLog()`/`getAuditLogForTarget()`
  helpers added as the foundation for Phase 6c.2/6c.3's mutations - schema is
  `id, actor_user_id, action, target_type, target_id, target_label,
  created_at`, deliberately never holds passwords, temporary passwords, API
  keys, session tokens, or room tokens. Nothing in the app calls
  `recordAuditLog()` yet (no mutations exist in 6c.1); verified directly via a
  standalone insert/read round-trip. The client detail page's "Recent
  activity" section is intentionally deferred to 6c.2, once there are real
  entries to show.
- A **non-functional** "Licence / plan: Not configured" line is shown on the
  client detail page, per explicit instruction - no `clients.plan` column, no
  schema change, no enforcement. Purely a labelled placeholder pending
  Phase 8's actual entitlement design.
- Responsive from the start (not retrofitted, learning from Phase 6b): client
  list is a card grid with the same 700px breakpoint convention as every
  earlier phase; client detail's users/rooms lists use a div-based
  "data-table" that collapses to labelled stacked rows below 700px rather
  than a `<table>` that could overflow.
- Verified (21/21 Playwright + 8/8 curl security checks): platform-admin
  session succeeds on both endpoints; normal-client session gets 403; no
  session gets 401; a valid Bearer API key gets 401 (proves the no-Bearer
  requirement); a nonexistent client id gets 404, not 403/500; page-route
  redirects correct for all three auth states; cross-client isolation
  confirmed (a client's detail page shows only that client's own users/
  events/rooms, verified against 4 seeded clients including one with zero
  users); no horizontal overflow at 360/390/430px or 1400px on either page;
  "Manage Clients" nav entry visible only for platform admins; normal Master
  Dashboard regression-checked and confirmed unaffected.
- **Browser-tested and approved locally; Railway deployment pending.**

### Phase 6b — Master Dashboard responsive redesign
- Root causes of mobile overflow, found by inspection (same method as the
  Phase 4 control.html fix): `.rooms-grid`'s `minmax(400px, 1fr)` never
  shrank below 400px per card regardless of viewport; `body` had a flat 20px
  padding on every side; `.header-info` and `.nav-links` were flex with no
  `flex-wrap` of their own (only the outer `.header` wrapped); `#createRoomRow`/
  `#newRoomSlug` used inline `style=""` attributes, which would have silently
  defeated any later `@media` override (inline styles beat any selector short
  of `!important`) - converted to CSS classes (`.create-room-row`) first.
- Room-card actions restructured into an explicit three-tier visual hierarchy,
  per approved decision - every action stays visible and reachable on mobile,
  nothing hidden behind a menu: (1) primary timer action (Start/Pause/Resume)
  full-width and boldest; (2) Control Panel/Display on their own row, easy to
  reach, keeping their existing distinct colours; (3) New Links/Delete smaller
  and muted, with Delete keeping its red `.danger` colour so it still reads as
  destructive.
- `@media (max-width: 700px)` block added (same breakpoint convention as the
  Phase 4 control.html fix): reduced body/header padding, `.rooms-grid`
  collapses to a single column, header info/nav/bulk-action controls wrap and
  compact, room-creation input/button stack vertically. Desktop rules above
  the media query are untouched.
- Verified with Playwright (22/22 checks passed): no horizontal overflow at
  360px/390px/430px in both normal-client and Platform-Administrator dashboard
  views; 1400px desktop grid confirmed still multi-column and visually
  unchanged; full functionality regression - room creation, individual timer
  Start/Pause/Resume (state-toggle-aware, not a fixed-target assertion),
  Control Panel/Display links, New Links (regenerate), Delete, Start All/Stop
  All/Start Selected, and drag-reorder - all confirmed working, plus
  Phase 3's "Start All doesn't exist for Platform Admin" rule confirmed still
  intact. A pre-existing, unrelated quirk was found (not a Phase 6b
  regression - the drag-reorder JS was not touched by this phase): dragging a
  card onto its immediate right-hand neighbour is a no-op because
  `handleDrop` re-inserts the dragged item *before* the target, which lands
  it back in its original slot when there are only two cards; dragging onto a
  left-hand neighbour works correctly. Not fixed as part of this phase (out
  of the approved scope).
- Did not build the Platform Admin client-management area (Phase 6c) or the
  licence/entitlement system (Phase 8), per explicit instruction.
- **Browser-tested and approved locally; Railway deployment pending.** Will be
  marked fully complete once deployed and verified in production, consistent
  with every earlier phase's completion criteria.

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

- ~~Master Dashboard mobile responsive layout~~ **FIXED** (Phase 6b). See
  Phase 6b above for root causes and verification detail.
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
- ~~A client details page~~ **DONE (Phase 6c.1)**.
- ~~A client list view for Platform Admin (currently CLI-only via
  `list-clients.js`/`list-users.js`)~~ **DONE (Phase 6c.1)**.
- Client profile/status/API key management from the UI (currently CLI-only:
  create/rotate via scripts). **Not started** - Phase 6c.2/6c.3 candidate.
- ~~Events and rooms shown under each client in the UI~~ **DONE (Phase 6c.1)**,
  on the client detail page.

## Remaining planned phases

- **Phase 5 - Active Rooms visibility.** Fold fully into the authenticated
  dashboard (largely already true post-Phase 2/3); add an optional per-room
  "hidden from Active Rooms" operational flag (not a security control).
- **Phase 6c.2 (approved, not started) - Client and user management.** Create
  Client from the UI (Platform Admin only - not public signup), guided
  create-client-then-create-first-user flow, edit client name, create/list
  users per client, reset password, change email - each wrapping the
  already-proven `db.js` functions the CLI scripts use today. Temporary
  passwords and new API keys shown exactly once via a custom in-app result
  modal with a Copy button, never logged or stored again. All mutations write
  an `audit_log` entry (table already exists, from 6c.1). `create-client.js`
  and `create-platform-admin.js` stay CLI-only for platform-admin-granting/
  initial-bootstrap reasons; existing CLI scripts remain as emergency tools
  even once the UI actions exist.
- **Phase 6c.3 (approved, not started) - Client status and API key
  management.** Suspend/reactivate (no data deletion; invalidates all human
  sessions and rejects API-key/control-token/display-token access immediately,
  including currently-connected sockets, not just new connections;
  reactivation restores access without regenerating any credentials) and API
  key rotation (old key dead immediately, new key shown once via the same
  custom modal pattern). Highest-risk slice of Phase 6c since it touches live
  auth enforcement - saved for last once the surrounding UI is already
  trusted. Requires fixing a real gap found during the Phase 6c design review:
  `getSessionUser()` currently checks only session expiry, not `users.status`
  or the linked client's `status` - only the API-key path
  (`getClientByApiKey`) enforces `status === 'active'` today, so a suspended
  client's already-logged-in session-authenticated users would otherwise keep
  working until their session naturally expires (up to 30 days).
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
- **Phase 8 (candidate) - Client licence / entitlement system.** Captured only
  (this message), not designed in detail, not implemented, not scheduled. The
  product may be offered commercially, free, or on a limited-time trial, so a
  licence/entitlement concept is needed - **architecturally separate from
  login authentication and user roles** (Phase 6a's `users`/`sessions`/
  `is_platform_admin`). Authentication answers "who is this"; entitlement
  answers "what are they allowed to have" - conflating the two would make
  both harder to reason about independently. The natural home is almost
  certainly on `clients` (the billing/licensing unit) rather than on
  individual users, but the actual schema is deliberately not designed yet.
  Requirements to design against when this phase is taken up:
  - **Client plan**: Trial / Free / Standard / Pro (or equivalent) - a named
    tier per client.
  - **Licence status**: Trial / Active / Expired / Suspended / Cancelled -
    distinct from plan (a client can be on the Pro plan but Suspended).
  - Trial start and expiry dates; optional subscription/licence expiry
    (not every plan need expire).
  - Configurable limits: rooms, events, users (per-client caps, presumably
    enforced at the same points that already create these entities today -
    `POST /api/rooms`, `scripts/create-user.js`, etc.).
  - Future feature entitlements - potentially Companion access, Shared
    Control (Phase 7 above), branding, or other premium functionality. Not
    designed now; flagged so Phase 7/Phase 6c work doesn't accidentally
    assume universal access to every client.
  - Clear in-app display of current plan/status and trial time remaining -
    visible to the client, not just inferred from a 403 error.
  - Platform Administrator visibility and management of each client's
    licence - likely belongs alongside the Phase 6c client-management UI
    once that exists, though the two are separate phases.
  - **Graceful trial/licence expiry**: login and existing data must remain
    accessible - only restricted actions (creating/operating rooms) get
    blocked, with a clear renewal/contact message, not a hard lockout of the
    account or a data-loss risk.
  - **Manual licence activation initially** - no self-service billing flow,
    consistent with the "manually provisioned" philosophy the rest of the
    product already follows.
  - **Payment-provider integration and pricing are explicitly deferred** -
    not part of this phase's design scope until the commercial model itself
    is decided.
