# Foxy's Presentation Timer

A web-based presentation timer with **multi-room support**, separate control and display screens, and real-time synchronization. Built for conferences, workshops and live events with several sessions running at once. Runs hosted (Railway) or as a local show server on a venue LAN.

## ✨ Features

- **🏢 Multi-room, multi-client**: each client account manages its own rooms from the Master Dashboard
- **🎛️ Separate control and display screens**, linked by secret per-room links (no guessable room names)
- **⏰ Duration or End at**: count down a length of time, or to a clock time; both server-authoritative
- **📱 Phone-first control page**: timer, Start/Pause/Reset, ±1/±5 and Timer Setup fit on one phone screen
- **👥 Multiple control panels per room**: one is in control, the others are view-only until they tap Take over
- **🏷️ Device names**: each browser gets a friendly name ("Calm Raven") so panels can see who is in control
- **💬 Messages to the display**: full-screen or ticker, with one-tap Clear from the top of the control page
- **📋 Programme / rundown**: a running order of sessions with Prev / Take / Next
- **🎨 Warning colours**: green → amber → red, with configurable thresholds, colours and background (incl. chromakey)
- **⚡ Speed control**, count-up after zero, clock mode
- **🎚️ Bitfocus Companion** integration via REST API (see [COMPANION.md](COMPANION.md))
- **💾 Persistent**: rooms and timer state are stored in SQLite and survive server restarts

## 📨 Landing page enquiries

The landing page's contact / trial form posts to `/api/contact` (rate-limited, honeypot spam trap). Every enquiry is stored and listed on the Platform Admin **Clients** page, where it can be marked handled. Email notification is optional, via [Resend](https://resend.com) (Railway blocks outbound SMTP):

| Env var | Default |
|---|---|
| `RESEND_API_KEY` | unset = store only, no email |
| `CONTACT_EMAIL_TO` | `foxytimer@bizshows.co.uk` |
| `CONTACT_EMAIL_FROM` | `Foxy Timer <foxytimer@bizshowsapp.co.uk>` (must be on a domain verified in Resend) |

## 🚀 Quick Start

```bash
npm install
npm start
```

Then open http://localhost:3000 → **Master Dashboard** → sign in → **Create Room**. The dashboard gives each room a **Control** link and a **Display** link (both contain a secret token - share them like passwords). Accounts are provisioned with the scripts in [`scripts/`](scripts/) (e.g. `create-client.js`, `create-user.js`); see [MULTI_TENANT_STATUS.md](MULTI_TENANT_STATUS.md) for the account model.

## 🖥️ Local Show Server (Windows, show days)

Double-click **`Foxy-Local-Show-Server.bat`** to start/stop/restart the server, open the Control and
Display pages, see the LAN address for other devices, and get a warning if an old server process is
still running older code than the files on disk. See [tools/local-server/README.md](tools/local-server/README.md).

## 🎮 Using the Control Page

**Top of the page (live operation)**
- **Room card**: room name and this device's name chip. The chip shows whether you're **in control** (green dot, or the CONTROLLER pill on desktop) or **observing**, and how many devices are connected; tap it to see the connected panels or rename this device.
- **Preview**: the real display, scaled down, with Now / Ends at. When a message is on the display, a slim **"message active"** bar with a **Clear** button appears here.
- **Start / Pause / Resume** (big) and **Reset** (outlined), plus **−5 −1 +1 +5 min** nudges.

**Timer Setup**
- **Duration | End at** switch over a single editor. Type a value and press **Apply** (or Enter). Tapping into the Duration box selects the whole value so you can just type.
- A **LIVE** row shows what the server is running; a **NEW** row shows a draft you haven't applied. Nothing you type changes the display until you apply it.
- While something is pending, **Reset** (and Start, when stopped) shows what it will load, e.g. **RESET → 23:00**. Changing End at on a running timer asks for confirmation first.
- **Display Shows** Timer / Clock, **Count up** after zero, and eight **Quick Presets** (Ctrl+Click a preset to save the current duration into it).

**Further down**: Programme / Rundown, Warning Thresholds, Display Appearance (size, speed 0.5×–1.5×, colours, background, what's shown), and **Message to Display Screen** - its Full Screen / Ticker buttons say what a press does (**SHOW**, **● LIVE**, amber **UPDATE** when you've edited a live message, **SWITCH**).

**Several control panels on one room**
- The first panel is in control; others are **view-only**: an orange frame, greyed controls and a pinned **"View only - Calm Raven is in control · Take over"** strip.
- Control belongs to a panel, not a connection: a refresh, a phone sleeping or a network blip keeps your seat (held for 30 minutes), and the newest tab on the controlling device takes over from older ones. Anyone can Take over at any time.

**Keyboard shortcuts**: `Space` start/pause/resume · `R` reset · `+`/`-` ±1 min (Shift for ±5) · with the rundown open: `↑`/`↓` browse, `Enter` take.

See [TIMER-MODES.md](TIMER-MODES.md) for the exact Duration / End at behaviour and a manual test checklist.

## 🖥️ Display Screen

- Large countdown that fits any screen (portrait or landscape, fit-to-width), H:MM:SS past an hour
- Colour warnings: green → amber → red, purple when overrunning
- Speaker name and "up next" lines from the rundown (each can be hidden)
- Full-screen and ticker messages
- Home / Fullscreen buttons that fade out when not in use
- Also drives a physical CDEther/Hive display via the bridge in [tools/cdether-bridge](tools/cdether-bridge)

## 💻 Portable Version (Windows)

```bash
npm install --save-dev pkg
npm run build:portable
```

Creates a `portable/` folder with a standalone `presentation-timer.exe` (Node.js bundled), the `public/` web interface and a `START.bat`. Copy the folder to any Windows PC and double-click `START.bat` - no installation or admin rights needed.

## ☁️ Cloud Deployment

### Railway (current hosting)

- WebSocket support (required), automatic HTTPS, GitHub integration
- Pushing to `main` redeploys; `railway.toml` and `Procfile` are included
- The port comes from `process.env.PORT`; set `DATABASE_PATH` to a persistent volume path so the SQLite database survives redeploys

Other WebSocket-capable Node hosts (Render, Fly.io, DigitalOcean App Platform) also work. **Not compatible**: Netlify, Vercel (WebSocket limitations).

## 🏗️ Technical Details

- **Backend**: Node.js + Express + Socket.IO; timer logic in [timerModes.js](timerModes.js), accounts/rooms in SQLite via [db.js](db.js)
- **Frontend**: vanilla HTML/CSS/JavaScript in [public/](public/) (no framework)
- **Real-time**: one Socket.IO room per timer room; the server is authoritative for all timer state
- **Access**: control and display links carry separate secret tokens; the dashboard and REST/Companion API use client accounts / API keys
- **Dependencies**: `express`, `socket.io`, `better-sqlite3`, `bcryptjs`, `cors`

### Tests

```bash
npm test
```

Unit, integration (real server + real Socket.IO clients) and static guard tests in [test/](test/).

## 🌐 Browser Compatibility

Current Chrome / Edge / Firefox / Safari, including mobile (iOS Safari, Chrome Android). WebSocket support required.

## 🐛 Troubleshooting

- **Display not updating**: check the display link is the one for this room; check WebSockets aren't blocked by a firewall; reload.
- **"Server is running older code" banner** (local show server): restart the server from the launcher.
- **Control page says View only**: another panel is in control - tap **Take over** on the strip at the bottom.
- **Port already in use**: `PORT=3001 npm start`.

## 📝 License

MIT License - feel free to use and modify for your presentations!
