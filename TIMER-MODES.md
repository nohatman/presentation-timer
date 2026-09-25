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
| Edit Duration field / click a preset, then **Apply** / Enter (stopped) | commits, selects Duration (last edit wins) | same |
| Edit Duration field / click a preset (running/paused) | only stages - Apply is disabled; Reset or Start commits it (see below) | same |
| Apply an End-at time (**Apply** / Enter, see below) | stopped: commits, switches to End at, re-derives time-to-target | same |
| Apply an End-at time on a **running/paused** timer | re-targets the live run to the new absolute target after a confirmation (current remaining, proposed remaining, proposed end time) | same |
| Mode button (any state) | switches which mode is being edited, *locally only* - see below | |
| Start | runs the Duration box's current value directly | commits a pending valid draft first, then runs time-to-target from the server clock |
| Pause / Resume | freeze / unfreeze; the pause shifts the finish later by the pause length (existing behaviour, shown as "If resumed, ends at") | pause freezes the display only; **the finish stays the absolute wall-clock target** - on Resume the remaining time is target - now (it drops by the pause length, or goes into overrun if the target passed) |
| Reset | commits any pending staged Duration/tab choice first, then resets to it (see below) | commits a pending valid End-at draft first, then resets to time-to-target *now* |
| Nudge (running/paused) | adjusts this run only | adjusts this run only; the run's absolute finish moves by the same amount, so the nudge survives a pause/resume |
| Nudge (stopped) | adjusts the configured Duration | becomes a fixed Duration of (time-to-target + nudge), so Start does not silently discard it |
| Take / Prev / Next rundown item | item duration becomes the Duration; Duration mode; End-at target cleared (existing behaviour) | same |
| Target already passed | rolls to tomorrow (existing behaviour) | |

### Duration and mode-tab selection are staged too, not live-as-you-click

Clicking a preset, typing a duration, or switching the Duration/End At tab used to push to the server
(hence a connected Display/CDEther) immediately, on every click/keystroke - **including while a timer was
running**, where a preset click would silently stop and reconfigure it in one click. That flashed whatever
the operator was trying out onto the live output before they'd decided anything. All three are now
local-only until a deliberate commit, in every run state:

* **Preset click / typing a duration:** only updates the Duration field on this control page and marks it
  a draft (amber border, a hint explaining what will pick it up, **✕** discards it). Nothing reaches the
  server on its own, ever - not even while running/paused (Duration editing was never a *live* thing to
  begin with - the nudge buttons cover that; this box is purely "what Start/Reset use next").
* **Mode button click (Duration | End at):** purely local - it only decides which mode **Apply**/**Reset**/
  **Start** act on next. It never emits `updateSettings({timerMode})` by itself. The two modes share ONE
  editor area (only the selected mode's input is shown; each keeps its own draft, and a dot on the other
  mode's button flags a draft waiting there). End at only becomes the *armed* mode once its field holds a
  *valid* time (committed earlier, or freshly typed): clicking End at with an empty/incomplete field opens
  its editor (amber, "incomplete") and says Start/Reset still use Duration until a complete time is entered,
  which then arms End at locally - so there is always something for Reset/Start to use once it *is* armed.
* **Live vs pending:** under the editor a **Live/Running/Paused** line shows what the server currently holds;
  a separate amber **Pending** line shows any draft and exactly what will make it take effect.
* **Stopped: Apply (or Enter)** is the only thing that pushes a Duration edit to the server directly, exactly
  as before. **Running/paused: Apply is disabled** - there is no live "push this now" for Duration. Instead:
  * **Reset** silently commits whatever is currently staged in the active tab (a switched tab, an edited
    Duration, or a valid End-at draft) *before* it resets - so the stopped preview Reset produces reflects
    what was actually showing, not a stale earlier commit. A plain Reset with nothing staged is unaffected -
    no extra step, exactly as before.
  * **Start** does the same for its own tab: Duration already sends the box's value directly (unchanged);
    End At now also commits a pending *valid* draft first (an invalid/empty one is left alone - Start then
    simply uses the last applied target, same as before).
  * Neither shows a confirmation dialog for this - Reset and Start are themselves the deliberate action
    (Reset always stops the run; Start only ever fires from a stopped timer), so End-at's own "does this
    change the live remaining time?" question doesn't apply.
* An unrelated broadcast (another controller's action, a rundown edit, a threshold change from the same
  tab) does not clobber an unapplied Duration draft or tab selection, the same guarantee End-at already had.

The one asymmetry worth knowing: a *live* "keep running, just change the total" retarget for Duration (the
way End-at can retarget a running timer) does not exist - to change a running Duration timer's value you go
through Reset (stops it) then Start (begins fresh with the staged value), never a single "apply live" click.

### End-at is staged (draft), never live-as-you-type

The End-at field is a draft. Typing, blur and focus changes send nothing to the server, so no display
changes while an operator types. **Apply** (or Enter) sends the single `applyEndAt` event
(`timerModes.applyEndAt`): incomplete/invalid values cannot be applied (Apply is disabled; the server also
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

1. Timer mode: type an End-at time (+10 min): nothing changes anywhere until you press **Apply** (or Enter);
   blur does not apply. Apply -> Reset -> preview shows ~10:00 and End At stays active. Refresh the page: End At +
   target still shown. Type a duration: mode flips to Duration. On a running timer, Apply shows the
   current/proposed remaining + end-time confirmation; Cancel changes nothing.
2. Running timer: switch mode; the countdown does not change; the Pending line says the next Reset will use it.
2b. Stopped: click a preset, or type a duration - a second (Display) screen open elsewhere must NOT
   change. Apply (or Enter) it - the Display updates then. ✕ discards it (Display still unchanged, field
   reverts). Click the Duration/End at buttons back and forth without pressing Apply - the Display never
   changes. Start with a typed-but-un-applied duration still runs with that value.
2c. Running: click a preset - the Display must NOT change and the timer keeps counting down (Apply is
   disabled). Press Reset - it stops and the Display now shows the staged preset value. Same for typing a
   fresh End-at time while running and never pressing Apply: Reset picks it up (End-at mode) instead.
   Separately: while stopped, click End at with nothing applied yet - its editor opens, the hint says
   Start/Reset still use Duration (Start really does). Type a complete time - End at arms - and press
   Start directly: it runs toward that typed target.
2d. Display page: Home/Fullscreen buttons are visible on load, fade out after a few seconds of no mouse/
   touch activity, and reappear immediately on any movement; both still work while visible.
3. Rundown -> Edit: click a name, press Tab: only the `MM` of the time is selected; type `12` -> `12:xx`.
   Click into a time with the mouse: normal caret, nothing force-selected.
4. 40+ items, panel open: the `+ Add / Paste / Text / Edit` bar stays at the bottom of the window while
   scrolling the page (desktop and phone width). `+ Add` focuses the new row's name field.
5. `Text`: whole rundown appears selected; `Copy` copies (works on plain-http LAN pages too).
6. `Paste` -> Replace: reordered text applies exactly in pasted order; a bad line shows "Nothing was changed"
   and the rundown is untouched; Cancel on the confirmation leaves it untouched; `Undo last Replace` restores.

Known pre-existing issue (not part of this change): below ~433px window width the whole control page
scrolls horizontally (grid `minmax(320px, 1fr)` + card padding).
