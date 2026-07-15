# Multi-Tenant Product Status

Tracks progress converting Presentation Timer from a single-operator web app into a
licensable multi-tenant product. See project memory / conversation history for the
full design brief this work follows.

## Completed phases

### Phase 6c.3 — Client status and API key rotation
- Suspend/reactivate: `db.suspendClient(id)`/`db.reactivateClient(id)`, exposed
  via `POST /api/admin/clients/:id/suspend` and `.../reactivate`
  (`adminClientAuth`-gated, audit-logged as `client.suspend`/
  `client.reactivate`). No data is deleted - only `clients.status` changes.
  Session rows are deliberately left in place (not deleted) on suspend:
  `db.getSessionUser()` independently enforces `users.status = 'active' AND
  clients.status = 'active'` on every lookup, not just session expiry - this
  alone closes the exact gap this phase existed to fix (a suspended client's
  already-logged-in users stop working on their very next request, not after
  up to 30 days) - and leaving the row in place is what lets the app explain
  *why* to a still-cookied browser (see the UX correction below) instead of
  it just looking like a dead cookie. It also means reactivation quietly
  resumes the same already-open browser session, no re-login required. New
  human logins are blocked too: `verifyUserPassword()` now checks the linked
  client's status, not just the user's.
- **UX correction, made after initial browser approval**: a suspended
  client's user was getting an unexplained "invalid" login or a bare
  logged-out redirect, indistinguishable from a broken password. Fixed
  without weakening login security - `verifyUserPassword()` now always runs
  the bcrypt password check first for a known email, *regardless* of
  status, and only branches to `reason: 'account_suspended'` after the
  password has verified correct; a wrong password or unknown email is
  therefore identical whether or not the account happens to be suspended, so
  this can never be used to enumerate accounts. `db.isSessionSuspended()`
  gives the same explanation for an already-logged-in session, but is only
  reachable by whoever already holds that exact (unguessable) session
  cookie. The frontend shows this as a calm, non-alarming in-page notice
  (`.notice`, distinct from the red `.error` style) on `/login` - "Access
  currently paused / Your organisation's access to the app is currently
  paused. Your rooms and settings remain safely stored. Please contact
  Business Shows for assistance. Once access has been restored, you can sign
  in again as normal." (exact wording finalised after review) - never a
  native `alert()`. Reached either via a `reason=account_suspended` query
  param (session redirect) or directly in the login response body (fresh
  login attempt).
  Also renamed every user-facing string for this feature to calmer language
  at the same time (Platform Admin buttons: "Pause Access" / "Restore
  Access"; status badge: "Access Paused") - **presentation only**, the
  underlying `clients.status` value, route paths, function names, and audit
  action names all remain `suspend`/`suspended`/`reactivate` unchanged, no
  migration.
- Socket-level enforcement: `auth.resolveSocketAccess()` (the single function
  `io.on('connection')` calls to gate every handshake) now rejects a
  suspended client's control/display tokens - `db.getRoomByToken()` joins in
  the owning client's status for this. Already-connected sockets are handled
  separately: the suspend route calls a new `disconnectAllSocketsForClient()`,
  mirroring the existing regenerate-tokens/delete-room disconnect pattern.
- API key rotation promoted from CLI-only (`scripts/rotate-client-key.js`,
  still works unchanged) to `POST /api/admin/clients/:id/rotate-key`
  (audit-logged as `client.rotate_api_key`, never logging the raw key). New
  key shown once via a calmly-worded result modal on the client detail page
  ("For security, this key cannot be viewed again...") - Copy-only, no Share
  button, matching the current admin secret-result pattern (Share is Phase 9
  scope, not this phase).
- API key timestamp metadata, decided during this phase's approval: two
  nullable columns, `clients.api_key_created_at` and
  `clients.api_key_rotated_at` (via `ensureColumn()`, no backfill). New
  clients/keys get an accurate `api_key_created_at`; every rotation (CLI or
  UI) stamps `api_key_rotated_at`; a client that predates these columns shows
  both as `null`, rendered as "Not recorded" in the UI - never invented from
  `clients.created_at`.
- Client detail page: a Suspend/Reactivate button in the header (toggles by
  current status, Suspend has its own confirm step explaining the
  consequences), and a new "API Key" section showing both timestamps plus a
  Rotate API Key button with its own confirm step.
- Verified against a live server on a disposable scratch database (not the
  shared dev/production database): a 39-check HTTP-level script covering
  login/session/suspend/reactivate/rotate/audit-log/timestamp behaviour plus
  the anti-enumeration properties above (wrong password and unknown email on
  a suspended account both get the identical generic error), and a 7-check
  direct verification of `auth.resolveSocketAccess()` before/after
  suspension and after reactivation. All 46 checks passed. Also confirmed: a
  normal client user gets 403 from every Platform Admin client-management
  endpoint; a Bearer API key (even with no cookie at all) gets 401 from the
  same endpoints, since `requireAdminSession` still has no Bearer branch; no
  raw API key appears in the audit log or any GET response. A first version
  of suspend/reactivate (without the login-message correction above) was
  separately confirmed correct in your own browser before this correction
  was requested.
- **Browser-tested and approved locally**: suspension/reactivation behaviour
  confirmed correct; the login-message correction above verified by
  automated script only so far, not yet re-confirmed in your browser.
  Railway deployment pending.

### Phase 6c.2 — Client and user management
- New mutations, all behind the same `adminClientAuth` (`requireAdminSession` +
  `requirePlatformAdmin`) chain as 6c.1's reads, so the no-Bearer/CSRF/404-not-
  403 guarantees apply uniformly: `POST /api/admin/clients` (create),
  `POST /api/admin/clients/:id/rename`, `POST /api/admin/clients/:id/users`
  (create user), `POST /api/admin/users/:id/reset-password`,
  `POST /api/admin/users/:id/change-email`. Duplicate-name/email checks live
  in the route handlers, not inside the `db.js` mutators - matches the
  existing convention already used by `create-client.js`/`create-user.js`.
- Session invalidation, password hashing, and email normalisation are **not
  new logic** - every mutation is a thin wrapper around the same `db.js`
  functions the CLI scripts already use and Phase 6a already tested
  (`createUser`, `resetUserPassword`, `changeUserEmail`). Verified directly
  against the live server this session, not just re-read from code: reset a
  user's password via the API, confirmed their prior session cookie got 401
  on the very next request.
- Guided **Create Client → Create First User** flow (`admin-clients.html`):
  name → one-time API key result modal (explicitly labelled for
  Companion/API integrations, not human login) → create-first-user form (or
  Skip) → one-time temp-password result modal. The two secrets are never
  shown together or combined - each gets its own modal, and `closeModal()`
  clears `#modalContent`'s innerHTML (not just hides it) so neither lingers
  in the DOM after its modal closes. If first-user creation fails, the client
  is kept (never rolled back) and a recovery message links to the client's
  detail page rather than losing track of it.
- Client detail page (`admin-client-detail.html`) gained: Edit Name (inline
  form, no confirmation needed - non-disruptive), Add User (form → temp
  password result modal, reusable per client), Change Email (single form
  that states the session-invalidation effect inline rather than a separate
  confirm step), Reset Password (two-step: confirmation modal naming the
  effect, then the temp-password result modal).
- All custom in-app modals (Phase 4's Take Over modal pattern, never
  `window.confirm()`/`alert()`/`prompt()`): focus moves into the dialog on
  open, Escape and click-outside both cancel safely with no side effects,
  focus returns to the triggering element on close.
- `audit_log` (schema built in 6c.1) now actually receives entries: one per
  successful mutation (`client.create`, `client.rename`, `user.create`,
  `user.reset_password`, `user.change_email`), `actor_user_id` always from
  the session (never client-supplied), `target_label` a human-readable
  non-secret identifier (e.g. `"old name → new name"`). Verified directly by
  inspecting the table after a full mutation run: exactly the expected 5 rows,
  and grepped the temp passwords and the new API key against the entire
  table's JSON - zero matches.
- Verified end-to-end (26/26 Playwright + 12/12 curl checks): the full
  wizard happy path including a real clipboard-copy assertion (not just that
  a button exists); Escape/click-outside cancel with no data created;
  duplicate-name/email → 409, invalid email → 400, unknown id → 404; Bearer
  API key (even a valid one) → 401 on every mutation, not just the 6c.1
  reads; a cross-origin `Origin` header with a valid session cookie → 403 on
  a mutation (new proof - 6c.1 was read-only and couldn't exercise this); no
  API key or temp password appears in any subsequent `GET` response; no
  horizontal overflow at 360/390/430px on either page, including with the
  modals open.
- **Browser-tested and approved locally; Railway deployment pending.**

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
- ~~Client profile management from the UI (create, edit name, users)~~ **DONE
  (Phase 6c.2)**.
- ~~Client status/API key rotation still CLI-only~~ **DONE (Phase 6c.3)**.
- ~~Events and rooms shown under each client in the UI~~ **DONE (Phase 6c.1)**,
  on the client detail page.

## Remaining planned phases

- **Phase 5 - Active Rooms visibility.** Fold fully into the authenticated
  dashboard (largely already true post-Phase 2/3); add an optional per-room
  "hidden from Active Rooms" operational flag (not a security control).
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
  - **Local-edition implication (noted, not designed):** a future Local Event
    Server (Phase 10) will need offline-capable entitlement checking - most
    likely activate-once online with a locally cached, signed entitlement, so
    a licence-server outage never disables a live event. Exact offline grace
    period, trial-tamper-resistance, and schema are deliberately left to this
    phase's own design work, not decided here.
- **Phase 9 (candidate) - UX consistency pass.** Not yet started. Four small,
  independently-shippable items, deliberately kept separate from Phase 6c.3:
  - Show/hide controls on every password field (`login.html`,
    `change-password.html`) - accessible toggle with clear "Show
    password"/"Hide password" labelling, not a browser-native prompt,
    preserves the entered value and focus when toggled, doesn't touch
    validation/authentication/storage.
  - Consistent custom Copy/Share treatment across room links, temporary
    passwords, and API-key result surfaces - porting the dashboard's Room
    Links modal pattern (readonly input + Copy + `navigator.share`
    feature-detected Share, not UA-sniffed) to `control.html`'s Share Links
    button and the Platform Admin secret-result modals, both of which
    currently fall short of that pattern.
  - Replacing remaining native `alert()`/`confirm()`/`prompt()` calls in
    those same affected flows, where appropriate.
  - Companion setup guidance and documentation (install/connect steps,
    Server URL vs Client API Key fields, how Railway-hosted and future
    local-server URLs differ, connection-status meaning, troubleshooting) -
    documentation only, no application code.
- **Phase 10 (candidate) - Local Event Server.** Not yet started, not
  designed in detail. Goal: an internet-independent Windows edition that
  operates across a private venue LAN without Railway, with no terminal, npm
  command, or manual `localhost` entry required from end users. A July 2026
  repository review confirmed the large majority of the existing app already
  supports this unchanged - dynamic control/display link generation from the
  request host, an environment-aware session-cookie `Secure` flag (already
  works over plain local HTTP), no CDN dependencies anywhere in the frontend,
  and no hardcoded Railway hostnames anywhere in the codebase. Recommended
  architecture:
  - Same existing application/codebase - not a rewrite.
  - v1 uses an independent local SQLite database, with no relationship to any
    hosted/Railway data (no sync in v1).
  - A packaged Node server (repairing/replacing the existing `portable/`
    `pkg` build, which is currently stale - targets Node 18 against an
    `engines: 20.x` app and predates all session-auth work, so it cannot
    authenticate against the current server) plus a lightweight Windows
    launcher/tray interface. Not Electron, not Tauri, not a Windows Service -
    none offer enough benefit over this codebase's existing plain
    Express/Socket.IO/better-sqlite3 shape to justify their added complexity.
  - A `/health` endpoint is an early prerequisite (doesn't exist today) so
    the launcher can detect successful startup.
  - Automatic dashboard opening in the default browser on launch.
  - LAN IP and server-status display in the launcher/tray.
  - Later refinements once v1 is proven: QR-code access, safe SQLite backup
    (online backup API / WAL-checkpoint-safe, not a raw file copy - a prior
    test found raw copies can miss recent writes still sitting in the
    `-wal`/`-shm` files), restart/stop controls, and clear network guidance.
  - A dedicated travel router/access point is the recommended configuration
    for dependable venue use - venue Wi-Fi client isolation can silently
    defeat LAN discovery even when devices are "on the same network," and
    mDNS (`*.local` hostnames) is not reliable enough across Android/iOS/
    Windows to depend on.
  - Model 2 (prepare an event online, sign in locally while internet is
    available, download an event package, operate offline, optionally
    upload afterward) is explicitly deferred until independent local v1 has
    been proven in real use - not part of this phase.
  - Model 3 (automatic Railway-to-local failover) is explicitly deferred
    indefinitely, not merely sequenced later - split-brain risk from
    conflicting live timer commands makes this a net-negative feature unless
    a specific, concrete need justifies the server-authority/reconciliation
    work it would require.

## Deferred / research-only items (not phases)

- **Physical Hive Industries display support (research only).** No
  implementation phase is proposed. Likely eventual architecture, if the
  external unknowns below resolve favourably: a separate local bridge
  process subscribing to a room as a specialised read-only display-token
  client (the same mechanism `display.html` already uses), translating
  Socket.IO timer state to whatever the hardware protocol turns out to
  require - keeping USB/serial/XLR code out of the hosted Railway server
  entirely. Confirmed via repository search: no existing code, docs, or
  comments reference Hive Industries, Irisdown, XLR, or a hardware bridge
  anywhere in this repo or the Companion module repo - this is unexplored
  territory. Blocked on external information before any phase can be scoped:
  USB/serial protocol to the Hive Expander, Ethernet protocol for Connect
  Ether (port, packet format, and whether it's documented/open or
  proprietary even when targeting Hive hardware from third-party software),
  any available SDK/API, supported hardware/firmware models, and licensing
  terms for interfacing with the hardware from third-party software.
- **Short room-link aliases - deferred.** Existing secure token URLs
  (`/control?token=...`, `/display?token=...`) plus the Phase 9 Copy/Share
  consistency work and future QR codes are considered sufficient. Revisit
  only if that combination proves insufficient in practice; human-readable
  slugs remain unsuitable as a sole credential since they are guessable and
  already exist only as a display label, not a security boundary.
