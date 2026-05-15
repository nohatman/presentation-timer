# Presentation Timer

A modern web-based presentation timer with **multi-room support**, separate control and display screens, and real-time synchronization. Perfect for conferences, workshops, and presentations with multiple simultaneous sessions.

## ✨ Features

- **🏢 Multi-Room Architecture**: Create unlimited independent timers with unique room names
- **🎛️ Dual Screen Interface**: Separate control panel and large display screen
- **⏰ Flexible Timing**: Set duration or end at a specific clock time
- **⚡ Speed Control**: Run timer faster or slower than real-time (great for practice!)
- **🎨 Color Warnings**: Visual feedback with green → amber → red transitions
- **➕ Count Up Option**: Continue timing after zero (elapsed time display)
- **🕐 Clock Mode**: Show current time instead of countdown
- **🔄 Real-time Sync**: All devices in same room stay perfectly synchronized via WebSocket
- **📱 Responsive Design**: Works on desktop, tablet, and mobile
- **🖥️ Fullscreen Support**: Optimized for projection
- **🎯 Improved UI**: Dark theme with smooth animations and better visual feedback

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Locally
```bash
npm start
```

### 3. Open in Browser
- **Home (Room Selector)**: http://localhost:3000
- **Control Panel**: http://localhost:3000/control?room=yourroom
- **Display Screen**: http://localhost:3000/display?room=yourroom
- **Default Room**: http://localhost:3000/control (uses "default" room)

## 🎪 Multi-Room Usage

### Creating and Using Rooms

1. **Navigate to Home Page** - Opens the room selector
2. **Enter a Room Name** - e.g., "presentation1", "workshop-a", "main-stage"
3. **Click "Go"** - Creates or joins that room's control panel
4. **Share Display Link** - Click "Copy Links" button to share with display screen
5. **Multiple Rooms** - Each room operates independently

### Room Examples
- `http://localhost:3000/control?room=keynote` - Keynote presentation control
- `http://localhost:3000/display?room=keynote` - Keynote display screen
- `http://localhost:3000/control?room=workshop-1` - Workshop 1 control
- `http://localhost:3000/display?room=workshop-1` - Workshop 1 display

**Tip**: Room names are case-sensitive. "Room1" and "room1" are different rooms.

## 💻 Portable Version (Windows)

Want to run from a USB stick without installing Node.js?

### Build Portable Version
```bash
npm install --save-dev pkg
npm run build:portable
```

This creates a `portable/` folder with:
- `presentation-timer.exe` (standalone, ~39 MB with Node.js bundled)
- `public/` folder (web interface)
- `START.bat` (quick launch script)
- `README-PORTABLE.txt` (instructions)

### Use on Any PC
1. Copy the entire `portable/` folder to your USB stick
2. On any Windows PC, double-click `START.bat`
3. Open browser to http://localhost:3000
4. No installation or admin rights required!

## 🎮 Usage

### Control Panel

**Room Information**
- Displays current room name
- "Copy Links" button to share control and display URLs

**Timer Setup**
1. **Set Duration**: Enter minutes and seconds, or use quick presets (5, 10, 15, 30, 45, 60 min)
2. **End At Time**: Set a specific clock time to end (auto-calculates remaining duration)
3. **Thresholds**: Configure when amber (warning) and red (urgent) colors appear
4. **Speed**: Adjust timer speed (0.1x to 5x - useful for rehearsals)
5. **Options**: Enable count-up after zero, or show clock instead of timer

**Controls**
- **Start**: Begin countdown
- **Pause**: Pause timer (can resume later)
- **Resume**: Continue from paused state
- **Reset**: Stop and reset to initial state
- **Nudge**: Fine-tune time (±15s, ±1min, ±5min buttons)

**Keyboard Shortcuts**
- `Space`: Start/Pause/Resume
- `R`: Reset timer
- `+/=`: Add 1 minute (Shift+ for 5 minutes)
- `-/_`: Subtract 1 minute (Shift+ for 5 minutes)

### Display Screen

- **Large Timer Display**: 18vw font size for maximum visibility
- **Color-Coded Warnings**: 
  - Green: Normal time remaining
  - Amber: Warning threshold reached
  - Red: Urgent - final countdown (includes pulse animation)
  - Purple: Timer finished
- **Status Indicator**: Shows timer state (Ready, Running, Paused)
- **Fullscreen Mode**: Click "Fullscreen" button or press F11
- **Room Badge**: Shows current room name in corner
- **Smooth Animations**: Enhanced visual effects and transitions

## ☁️ Cloud Deployment

### Railway (Recommended)

**Why Railway?**
- ✅ WebSocket support (required for real-time sync)
- ✅ Free tier available ($5 credit/month)
- ✅ Automatic HTTPS
- ✅ Easy GitHub integration
- ✅ Zero configuration needed

**Deployment Steps**

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Multi-room presentation timer"
   git remote add origin <your-github-url>
   git push -u origin main
   ```

2. **Deploy to Railway**
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub"
   - Select your repository
   - Railway auto-detects Node.js
   - Deployment starts automatically!

3. **Access Your App**
   - Railway provides a URL: `https://your-app.railway.app`
   - Share this URL with your team
   - Example: `https://your-app.railway.app/control?room=conference2024`

**Configuration**
- Port is automatically set via `process.env.PORT`
- No environment variables required
- `railway.toml` and `Procfile` included for optimization

### Other Platforms

#### Render
1. Connect GitHub repository
2. Select "Web Service"
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy!

#### Fly.io
```bash
fly launch
fly deploy
```

#### DigitalOcean App Platform
1. Create new app from GitHub
2. Detect Node.js automatically
3. Deploy

**❌ NOT Compatible**: Netlify, Vercel (WebSocket limitations)

## 🏗️ Technical Details

### Architecture
- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework overhead!)
- **Real-time**: WebSocket communication via Socket.IO rooms
- **State Management**: In-memory per-room state (resets on server restart)
- **Styling**: Modern CSS with animations, transitions, and dark theme

### Dependencies
```json
{
  "express": "^4.18.2",     // Web server
  "socket.io": "^4.7.2",    // WebSocket real-time communication
  "cors": "^2.8.5"          // Cross-origin resource sharing
}
```

### Room Architecture
Each room maintains independent state:
- Timer mode (stopped/running/paused)
- Duration and elapsed time
- Speed multiplier
- Warning thresholds
- Display options

Clients join specific rooms via Socket.IO, ensuring isolated operation.

## 🌐 Browser Compatibility

- ✅ Chrome/Edge (90+)
- ✅ Firefox (88+)
- ✅ Safari (14+)
- ✅ Mobile browsers (iOS Safari, Chrome Android)
- ⚠️ Requires WebSocket support

## 💡 Tips for Presentations

### Multi-Screen Setup
1. **Open control panel** on your laptop or phone
2. **Open display screen** on projector or second monitor
3. **Use same room name** for both
4. Control from your device while audience sees the display

### Remote Presentations
1. **Deploy to Railway** or other cloud platform
2. **Share display link** with audience
3. **Control from anywhere** using control panel link

### Multiple Concurrent Sessions
- **Conference Room A**: `yourapp.railway.app/display?room=room-a`
- **Conference Room B**: `yourapp.railway.app/display?room=room-b`
- **Workshop Area**: `yourapp.railway.app/display?room=workshop`

Each operates independently!

### Practice Runs
- Use **speed control** to run through timing faster (2x, 3x, 5x)
- Test your warning thresholds
- Perfect your pacing

### Q&A Sessions
- Use **"End At Time"** feature
- Set specific end time (e.g., "14:30")
- Timer auto-adjusts for breaks

## 🐛 Troubleshooting

### Port Already in Use
```bash
# Use different port
PORT=3001 npm start
```

### Timer Not Syncing
1. Ensure both screens use same room name (case-sensitive!)
2. Check browser console for WebSocket errors (F12)
3. Verify network connection
4. Refresh both pages

### Display Not Updating
1. Check if WebSockets are blocked by firewall
2. Try different browser
3. Verify server is running

### Mobile Issues
- Some mobile browsers may require user interaction before WebSocket connects
- Try tapping screen once after loading

## 🤝 Contributing

Contributions welcome! This is a simple, dependency-light project perfect for learning:
- Node.js server development
- WebSocket real-time communication
- Modern CSS animations
- Multi-client state management

## 📝 License

MIT License - feel free to use and modify for your presentations!

## 🎯 Roadmap

Potential future enhancements:
- [ ] Persistent storage (database for timer history)
- [ ] User authentication and private rooms
- [ ] Timer templates/presets
- [ ] QR code generation for easy room joining
- [ ] Mobile app (React Native/Capacitor)
- [ ] Analytics and usage tracking
- [ ] Custom themes and branding

## 📚 Use Cases

- **Conferences**: Multiple tracks with independent timers
- **Workshops**: Time-boxed activities and breaks
- **Meetings**: Keep discussions on schedule
- **Presentations**: Professional countdown displays
- **Hackathons**: Track presentation rounds
- **Debates**: Fair time allocation
- **Teaching**: Class activity timing
- **Events**: Session management

---

Built with ❤️ for speakers, presenters, and event organizers everywhere.
- Mobile browsers supported
- WebSocket support required

## Tips for Presentations

1. **Screen Setup**: Open display on a secondary monitor or projector
2. **Remote Control**: Access control panel from phone/tablet via same network
3. **Presets**: Use quick preset buttons for common durations
4. **End Time**: Use "End At" feature for Q&A sessions before breaks
5. **Speed**: Speed up practice runs to save time
6. **Fullscreen**: Use fullscreen mode for better visibility

## Troubleshooting

- **Timer not syncing**: Ensure both devices are on same network
- **Display not updating**: Check browser console for WebSocket errors
- **Mobile issues**: Some mobile browsers may require enabling WebSocket

## License

MIT License - feel free to use and modify for your presentations!
