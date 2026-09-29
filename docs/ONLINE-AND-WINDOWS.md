# Foxy Timer Online ↔ Foxy Timer for Windows

How the hosted system and the show-laptop app relate, what each owns, and the rules for any future
link between them. Written 2026-09-29 from the code as it stands (`ba88878`); the basis for the
"prepare online, run on the laptop" work. Nothing described under *Future* exists yet.

## The one rule

**A live show must keep running on the laptop if the internet disappears.** Foxy Timer for Windows
never needs Foxy Timer Online for anything in the command path: timer actions, displays, Companion
and CDEther all talk only to the laptop.

## What each is

| | Foxy Timer Online | Foxy Timer for Windows |
|---|---|---|
| Where the engine runs | Railway (foxytimer.com) | The show laptop (`FOXY_MODE=local`) |
| Code | `server.js` and friends | **The same code**, plus local-mode extras |
| Storage | SQLite on the Railway volume | SQLite in `%LOCALAPPDATA%\Foxy Timer\data` |
| Accounts | Clients, users, sessions, platform admin | None; a built-in "Local show" client; no login on the laptop itself |
| Reached by | The internet | The venue network (LAN) only |
| Online-only features | Front page, contact form, "Try it now" demo rooms | Switched off (404) |
| Local-only features | — | This laptop panel, firewall check/fix, Companion key window, Stop/Restart, LAN links, starter room |

The two are **separate systems today**: a room on one does not exist on the other, links differ
(different address, different secret tokens), and nothing is exchanged.

## How the pieces talk (both versions)

- **Control and Display pages**: Socket.IO to the engine; the room and role come from the secret
  token in the link, resolved server-side. One control panel is in control, others observe until
  *Take over*; a dropped controller's seat is held 30 minutes.
- **Companion**: REST (`/api/rooms/:room/…`) with a client API key (`Authorization: Bearer`).
- **CDEther bridge**: a separate program connecting like a Display (server URL + display token),
  sending UDP to the LED clock on the LAN.

## What survives a restart

Stored (survives engine restart and laptop reboot): accounts, rooms, links, and each room's whole
timer state, including a *running* timer (stored as "started at clock time X", so it carries on at
the right time). In memory only: who is in control, rate limits, device list. In the browser only:
quick presets, message history, device names, the control page's own saved settings.

## Data categories

| Category | What it is in the code |
|---|---|
| **A: configuration** (could come Online → laptop) | Room name; rundown (`name`, `durationMs`); Duration / End at setting; warning thresholds; colours (incl. overrun); background; display size; which lines show; count style. Presets are A in spirit but live only in the browser today. |
| **B: live state** (laptop-authoritative during a show) | `mode`, `startTime`, `pauseTime`, `accumulatedPauseMs`, `runEndAtMs`, `rundownIndex`, the on-screen message, timer/clock output, live nudges |
| **C: results** (could go laptop → Online) | Nothing yet. Near-term candidate: a per-session log (planned vs actual start/finish, overrun). |
| **D: machine-specific** (never cloud data) | LAN addresses, launcher PID/log files, the laptop's Companion key and "Local show" client, firewall state, CDEther settings, device names, controller seats, each system's link tokens |

**Prerequisite for any sync:** A and B are stored together in one `state_json` per room. They must be
separated before anything is imported, or an import could overwrite a running timer. Rooms also
need a **shared identity** (a UUID) and a **revision number**: today rooms are numbered separately
in each database, so an Online room and its laptop copy can't know they are the same room.

## Authority

- **Before the show**: Online is the convenient place to prepare rooms and rundowns.
- **During the show**: the laptop is authoritative for everything live. Online never pushes to it.
- **After the show**: results (category C) may be sent up when there is a connection.

## Rules for the future link

1. **Manual, not automatic.** "Import show from Foxy Timer Online" is an operator action on the
   laptop; nothing syncs in the background.
2. **Only category A moves.** Live state, machine settings and tokens are never imported or exported.
3. **Never over a running room.** Import is refused (or warned about) for any room that is running
   or paused.
4. **Clashes are the operator's choice.** One revision number per room: "Online is at revision 7,
   this laptop has 5 with local edits: replace?" No merging.
5. **Outbound only.** The laptop contacts Online, using a client API key kept in its data folder
   (as the Companion key is now). Online never connects in; the laptop never accepts commands from
   the internet.
6. **Online status is separate from local health.** If shown, "Foxy Timer Online: Connected /
   Offline" never affects "Running" and every check has a short timeout.

## Security boundary (local)

- The engine listens on the LAN. Control needs a control link; displays a display link; Companion
  the API key; the dashboard is open without a login only to the laptop itself (loopback or its own
  address, a Host naming the laptop, same-origin requests: see `auth.isLocalOperatorRequest`).
- Links travel as plain HTTP on the venue network. Anyone on shared Wi-Fi who captures a control
  link can run that room; use a private show network where that matters.
- The installer adds a Windows Firewall rule for its own Node on every network type (venue Wi-Fi is
  often "Public"); the dashboard checks it and can fix it.

## Future work in order

1. Split room configuration (A) from live state (B); add room UUID + revision.
2. Events visible in the UI (they exist in the database; every account has one default event).
3. Manual "Import show from Foxy Timer Online" on the laptop, following the rules above.
4. Optional Online status line; then results (C) sent up after a show.
