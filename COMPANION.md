# Bitfocus Companion Integration

This timer app provides a REST API for controlling timers via [Bitfocus Companion](https://bitfocus.io/companion) and hardware button decks (Stream Deck, etc.).

## HTTP API Overview

All endpoints use the base URL of your deployed app:
- **Local**: `http://localhost:3000`
- **Production**: `https://presentation-timer-production.up.railway.app`

Each timer room has its own isolated state. Use `default` as the room ID for a single timer, or create named rooms (e.g., `stage1`, `greenroom`, etc.).

## API Endpoints

### GET /api/rooms/:roomId/state
Get current timer state (read-only).

**Example URL**: `http://localhost:3000/api/rooms/default/state`

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": {
    "mode": "stopped",
    "durationMs": 1800000,
    "startTime": null,
    "pauseTime": null,
    "accumulatedPauseMs": 0,
    "speed": 1.0,
    "amberThresholdMs": 300000,
    "redThresholdMs": 120000,
    "endAtTarget": null,
    "countUp": false,
    "showClock": false,
    "outputMode": "timer"
  }
}
```

---

### POST /api/rooms/:roomId/start
Start the timer from the preset duration.

**Example URL**: `http://localhost:3000/api/rooms/default/start`

**Request Body**: None

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": { ... }
}
```

---

### POST /api/rooms/:roomId/pause
Pause a running timer.

**Example URL**: `http://localhost:3000/api/rooms/default/pause`

**Request Body**: None

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": { ... }
}
```

---

### POST /api/rooms/:roomId/resume
Resume a paused timer.

**Example URL**: `http://localhost:3000/api/rooms/default/resume`

**Request Body**: None

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": { ... }
}
```

---

### POST /api/rooms/:roomId/reset
Reset the timer to stopped state with preset duration.

**Example URL**: `http://localhost:3000/api/rooms/default/reset`

**Request Body**: None

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": { ... }
}
```

---

### POST /api/rooms/:roomId/nudge
Adjust the timer by adding or subtracting milliseconds.

**Example URL**: `http://localhost:3000/api/rooms/default/nudge`

**Request Body**:
```json
{
  "ms": 60000
}
```
Use positive values to add time, negative to subtract.
- Add 1 minute: `{"ms": 60000}`
- Subtract 30 seconds: `{"ms": -30000}`

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": { ... }
}
```

---

### POST /api/rooms/:roomId/set-duration
Set the preset timer duration (in milliseconds).

**Example URL**: `http://localhost:3000/api/rooms/default/set-duration`

**Request Body**:
```json
{
  "durationMs": 1800000
}
```
Example durations:
- 5 minutes: `300000`
- 15 minutes: `900000`
- 30 minutes: `1800000`
- 45 minutes: `2700000`

**Response**:
```json
{
  "ok": true,
  "roomId": "default",
  "state": { ... }
}
```

---

## Companion Button Examples

### Setup in Companion

1. **Add Connection**: In Companion, add a **Generic HTTP** module
2. **Configure Base URL**: Set the base URL to your server (e.g., `http://localhost:3000`)
3. **Create Buttons**: Use the examples below for each button

### Example Button: Start Timer

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/start`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: (leave empty)

**Button Text**: ▶️ START

---

### Example Button: Pause Timer

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/pause`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: (leave empty)

**Button Text**: ⏸️ PAUSE

---

### Example Button: Resume Timer

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/resume`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: (leave empty)

**Button Text**: ▶️ RESUME

---

### Example Button: Reset Timer

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/reset`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: (leave empty)

**Button Text**: 🔄 RESET

---

### Example Button: Add 1 Minute

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/nudge`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: 
```json
{"ms": 60000}
```

**Button Text**: +1 MIN

---

### Example Button: Subtract 30 Seconds

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/nudge`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: 
```json
{"ms": -30000}
```

**Button Text**: -30 SEC

---

### Example Button: Set 15 Minute Preset

**Action**: Generic HTTP: POST
- **URL**: `/api/rooms/default/set-duration`
- **Method**: POST
- **Headers**: `Content-Type: application/json`
- **Body**: 
```json
{"durationMs": 900000}
```

**Button Text**: 15:00

---

## Multi-Room Setup

To control multiple independent timers (e.g., different rooms or stages):

1. **Room 1 (Main Stage)**: Replace `default` with `stage1` in all URLs
   - Start: `/api/rooms/stage1/start`
   - Pause: `/api/rooms/stage1/pause`
   - etc.

2. **Room 2 (Green Room)**: Replace `default` with `greenroom`
   - Start: `/api/rooms/greenroom/start`
   - Pause: `/api/rooms/greenroom/pause`
   - etc.

Each room maintains completely independent timer state.

---

## Testing with cURL

Test endpoints from command line:

```bash
# Start timer
curl -X POST http://localhost:3000/api/rooms/default/start

# Pause timer
curl -X POST http://localhost:3000/api/rooms/default/pause

# Add 1 minute
curl -X POST http://localhost:3000/api/rooms/default/nudge \
  -H "Content-Type: application/json" \
  -d '{"ms": 60000}'

# Set 30 minute duration
curl -X POST http://localhost:3000/api/rooms/default/set-duration \
  -H "Content-Type: application/json" \
  -d '{"durationMs": 1800000}'

# Get current state
curl http://localhost:3000/api/rooms/default/state
```

---

## Notes

- **Browser controls still work**: The REST API runs alongside the existing WebSocket system. Browser control panels and displays continue to work normally.
- **Real-time updates**: All changes via the REST API are broadcast to connected browsers via Socket.IO, so displays update instantly.
- **Room creation**: Rooms are created automatically when first accessed (via API or browser).
- **Error responses**: Failed requests return `{"ok": false, "error": "reason"}` with appropriate HTTP status codes.

---

## Troubleshooting

**Button doesn't work**:
- Verify the base URL is correct in Companion's Generic HTTP module settings
- Check the URL path starts with `/api/rooms/`
- Ensure Content-Type header is set to `application/json` for POST requests
- Test the endpoint with cURL first to verify server is reachable

**Timer doesn't update on display**:
- Check that the display browser is connected to the correct room (e.g., `http://yourserver/display?room=default`)
- Verify WebSocket connection is working (check browser console for errors)

**Wrong room**:
- Make sure the room ID in the API URL matches the room ID in your display/control URLs
- Room IDs are case-sensitive
