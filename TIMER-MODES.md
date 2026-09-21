# Timer modes and rundown text

## Timer modes (Duration / End at)

The mode is **server state**, not a browser setting. Every controller, every reload and
every server restart sees the same mode. Logic lives in [timerModes.js](timerModes.js);
`server.js` handlers (Socket.IO, REST/Companion, admin) only delegate to it.

| Field | Meaning |
| --- | --- |
| `timerMode` | `'duration'` or `'endAt'` - which configuration Start and Reset use |
| `configDurationMs` | The operator's Duration value. Kept while End at is active. |
| `endAtTarget` | `'HH:MM'` or `null`. Kept while Duration is active, and across Reset. |
| `endAtTzOffsetMin` | The operator's `Date#getTimezoneOffset()`. `HH:MM` is the *operator's* wall clock even if the server runs in UTC (Railway). |
| `runEndAtMs` | Epoch ms an End-at run must finish at (set at Start, cleared by Reset / rundown Take; `null` for Duration runs). Which resume behaviour applies is fixed by how the run *started*, not by the mode configured later. |
| `durationMs` | (existing) length of the current/next run. While stopped it always equals what Start would run. |

All new fields are additive; display, Companion and the CDEther bridge only read the
pre-existing fields and are unaffected.

### Transitions

| Action | Duration mode | End at mode |
| --- | --- | --- |
| Edit Duration field (stopped) | sets duration | switches to Duration (last edit wins) |
| Set End-at time (**Set** / Enter, see below) | stopped: commits, switches to End at, re-derives time-to-target | same |
| Set End-at time on a **running/paused** timer | re-targets the live run to the new absolute target after a confirmation (current remaining, proposed remaining, proposed end time) | same |
| Mode button (stopped) | switches; each mode restores its own value | |
| Mode button / Duration edits (running or paused) | changes the *configuration only*; the live run is never touched. Applies at next Start/Reset. | |
| Start | runs `configDurationMs` | runs time-to-target computed from the server clock at Start |
| Pause / Resume | freeze / unfreeze; the pause shifts the finish later by the pause length (existing behaviour, shown as "If resumed, ends at") | pause freezes the display only; **the finish stays the absolute wall-clock target** - on Resume the remaining time is target - now (it drops by the pause length, or goes into overrun if the target passed) |
| Reset | back to `configDurationMs` (a live nudge is *not* kept) | back to time-to-target *now*; target and mode kept |
| Nudge (running/paused) | adjusts this run only | adjusts this run only; the run's absolute finish moves by the same amount, so the nudge survives a pause/resume |
| Nudge (stopped) | adjusts the configured Duration | becomes a fixed Duration of (time-to-target + nudge), so Start does not silently discard it |
| Take / Prev / Next rundown item | item duration becomes the Duration; Duration mode; End-at target cleared (existing behaviour) | same |
| Target already passed | rolls to tomorrow (existing behaviour) | |

### End-at is staged (draft), never live-as-you-type

The End-at field is a draft. Typing, blur and focus changes send nothing to the server, so no display
changes while an operator types. **Set** (or Enter) sends the single `applyEndAt` event
(`timerModes.applyEndAt`): incomplete/invalid values cannot be applied (Set is disabled; the server also
refuses them and changes nothing). Stopped: commits directly. Running/paused: the control page first shows
a confirmation with current remaining, proposed remaining and proposed end time; Cancel sends nothing.
Confirm updates `endAtTarget`, `runEndAtMs` and `durationMs` in one server step (paused: the frozen display
moves to "remaining as of now"; Resume still catches up to the fixed target). `Start` and the End At mode
button use the last *applied* target, never an unapplied draft. ✕ / Escape discards a draft; an unapplied
draft is not overwritten by state updates from the server.

`applyEndAt` is a request/acknowledge call: the server answers `{ok:true}` (after broadcasting the new state) or
`{ok:false, reason: 'observer' | 'invalid' | 'no-room'}`. While waiting the button shows "…"; the draft is
cleared only once the authoritative state contains the applied value. Any failure keeps the draft and shows a
red message beside the field: not the active controller ("use Take Over"), invalid time, not connected, or
**no acknowledgement within 5 s - which means the timer server is running older code and must be restarted**
(the page files are served fresh, but a running `node server.js` keeps the code it started with).

A stopped End-at timer's `durationMs` is a snapshot taken at edit / Reset / (re)connect;
**Start always recomputes it from the clock.**

## Rundown text

Item model: `{ name, durationMs }`. The "time" column is a **MM:SS duration**, not a clock time.
Format ([public/rundownText.js](public/rundownText.js)) - one item per line, the same format
Paste has always accepted, so copy -> edit -> paste is loss-free:

```
Welcome, 05:00
Opening Remarks, 15:00
Smith, John, 20:00      <- names may contain commas; the time is the LAST part
```

Accepted times: `M:SS` / `MM:SS` / `MMM:SS` (seconds 00-59) or plain minutes (`20`, `7.5`). A line with no
comma keeps the historical 30:00 default. Blank lines, surrounding whitespace, CRLF, a BOM and a missing
final newline are ignored/handled.

**Invalid input.** A line whose time cannot be read (`5:75`, `abc`, `-5`, `0`, `Smith, John`) is an error
reported with its line number. Any error aborts the whole paste - nothing is applied, partially or
otherwise (Append and Replace both). Replace with no lines at all is also refused. Over-long names
(>100 chars) are shortened with a warning. Duplicate names/times are kept as given.

**Append** adds after the existing items. **Replace** requires an explicit radio choice plus a confirmation
dialog, validates first, clears the "current item" pointer (the running timer is untouched), and offers a
one-slot "Undo last Replace" (this browser tab only).

## Manual UI checklist (no browser test infra in the repo)

1. Timer mode: type an End-at time (+10 min): nothing changes anywhere until you press **Set** (or Enter);
   blur does not apply. Set -> Reset -> preview shows ~10:00 and End At stays active. Refresh the page: End At +
   target still shown. Type a duration: mode flips to Duration. On a running timer, Set shows the
   current/proposed remaining + end-time confirmation; Cancel changes nothing.
2. Running timer: switch mode; the countdown does not change; hint "applies at next Start or Reset" shows.
3. Rundown -> Edit: click a name, press Tab: only the `MM` of the time is selected; type `12` -> `12:xx`.
   Click into a time with the mouse: normal caret, nothing force-selected.
4. 40+ items, panel open: the `+ Add / Paste / Text / Edit` bar stays at the bottom of the window while
   scrolling the page (desktop and phone width). `+ Add` focuses the new row's name field.
5. `Text`: whole rundown appears selected; `Copy` copies (works on plain-http LAN pages too).
6. `Paste` -> Replace: reordered text applies exactly in pasted order; a bad line shows "Nothing was changed"
   and the rundown is untouched; Cancel on the confirmation leaves it untouched; `Undo last Replace` restores.

Known pre-existing issue (not part of this change): below ~433px window width the whole control page
scrolls horizontally (grid `minmax(320px, 1fr)` + card padding).
