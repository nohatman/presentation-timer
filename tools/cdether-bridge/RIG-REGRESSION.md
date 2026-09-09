# CDEther rig regression — P1

> **RESULT: PASSED — 2026-09-09.** All rows verified on the real rig
> (Railway PT → laptop bound to Ethernet `192.168.8.238` → directed broadcast
> `192.168.8.255:36700`, Wi-Fi still connected → CDEther → XLR → Hive). No
> unexpected behaviour. Rows 13/15/16/17/20 (the P1 semantic changes) all
> confirmed: Ctrl+C → OFF; unexpected Ethernet loss → display holds last value,
> no OFF attempted; reconnect → auto-restores the correct current value without
> restarting the bridge; overlay stays browser-only; clock mode → OFF. P1 is
> physically verified and approved.

Run against the real Railway Presentation Timer → laptop → CDEther → XLR → Hive
display.

## Setup

1. Laptop on the CDEther LAN. `cd tools/cdether-bridge && npm install`.
2. `node bridge.js --list-adapters` → confirm the CDEther adapter is listed with
   the expected directed broadcast (rig LAN: `Ethernet … 192.168.8.255`).
3. Make a `.env`:
   ```
   SERVER_URL=https://<railway-host>
   DISPLAY_TOKEN=<the room's DISPLAY token>
   CDETHER_INTERFACE=<adapter name from step 2>
   ```
4. Have the room's **control** screen open on another device to drive the timer.

## Checklist

| # | Action | Expected on the Hive display |
|---|---|---|
| 1 | `node tools/send-frame.js 12:34 green --interface <name>` | shows `12:34` green |
| 2 | `… 12:34 red` / `… 12:34 amber` / `… 00:00 off` | red, then amber, then blank |
| 3 | `node --env-file=.env bridge.js` | log shows `--list-adapters`-style dest line, `bind <NIC ip>` (not `0.0.0.0`), `STATUS LIVE`, room name |
| 4 | Start a 1:00 countdown (amber 30s, red 10s) from control | counts `01:00 → 00:00`, green → amber at 0:30 → red at 0:10, holds `00:00` |
| 5 | Change amber/red thresholds mid-run | colour switch points move to match |
| 6 | Pause | display freezes on the current value |
| 7 | Resume | continues from the frozen value |
| 8 | Nudge +30s / −30s | value jumps by the nudge amount |
| 9 | Switch the room to clock / time-of-day mode | display goes **OFF** (blank) |
| 10 | Switch back to timer mode | timer reappears at the correct value |
| 11 | Set an **overlay** message on the room | display goes **OFF** |
| 12 | Clear the message | timer reappears |
| 13 | **Ctrl+C** the bridge | one OFF frame → display goes blank; process exits cleanly (exit 0) |
| 14 | Restart the bridge | reconnects, `STATUS LIVE`, display resumes at the correct current value |
| 15 | **Unplug the CDEther Ethernet** mid-countdown | display **holds its last value**; bridge log shows `STATUS DEGRADED … holding its last value`; **no OFF is sent / attempted** |
| 16 | Re-plug the Ethernet | bridge auto-recovers (no restart); display **jumps to the correct current value**; `STATUS LIVE` |
| 17 | Kill the bridge hard (close the terminal / `taskkill /F`) mid-countdown | display **holds its last value** (no OFF — expected); relaunch → recovers |
| 18 | In the Presentation Timer dashboard, **regenerate the room's tokens** while the bridge runs | bridge log shows `room-unavailable`, retries periodically; **no OFF**; display holds |
| 19 | Run bridge with a deliberately wrong `DISPLAY_TOKEN` | best-effort OFF (display blanks), clear error printed, process exits with code 2 |
| 20 | Multi-homed check: with Wi-Fi (internet) + Ethernet (CDEther) both up, run normally | frames reach the display — confirms the socket bound to the right NIC |
| 21 | Soak: leave a countdown + idle room running ~30–60 min | steady 1 Hz, no drift vs the room's own display screen, no crash |

## Report back

For each row: pass / fail + any surprise. Particular attention to **13, 15, 16,
17, 20** — these are the P1 semantic changes. If all pass, we prepare the first
CDEther commit for your review.
