# Presentation Timer

A simple web-based presentation timer with separate control and display screens. Perfect for speakers who need visual countdown timers with color-coded warnings.

## Features

- **Dual Screen Interface**: Control panel for settings, display screen for the timer
- **Flexible Timing**: Set duration or end at a specific clock time (great for Q&A sessions)
- **Speed Control**: Run timer faster or slower than real time
- **Color Warnings**: Amber and red thresholds with visual feedback
- **Count Up Option**: Continue timing after zero (elapsed time display)
- **Clock Mode**: Show current time instead of countdown
- **Real-time Sync**: Multiple devices stay synchronized via WebSocket
- **Responsive Design**: Works on different screen sizes
- **Fullscreen Support**: Display screen optimized for presentations

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Locally
```bash
npm start
```

### 3. Open in Browser
- **Control Panel**: http://localhost:3000/control
- **Display Screen**: http://localhost:3000/display
- **Home**: http://localhost:3000

## Usage

### Control Panel
1. **Set Duration**: Enter minutes and seconds, or choose a preset
2. **End At Time**: Set a specific clock time to end (auto-calculates duration)
3. **Thresholds**: Set when amber (warning) and red (urgent) colors appear
4. **Speed**: Adjust timer speed (1.0 = normal, 1.5 = 50% faster)
5. **Options**: Enable count-up after zero, or show clock instead of timer
6. **Controls**: Start, pause, resume, reset

### Display Screen
- Large, easy-to-read timer display
- Color changes at warning thresholds
- Optional blinking when timer reaches zero
- Fullscreen mode for presentations
- Clock mode for time-of-day display

## Deployment

This app can be deployed to any hosting service that supports Node.js:

### Netlify (Recommended for free hosting)
1. Connect your GitHub repository to Netlify
2. Set build command: `npm run build` (or just deploy from the root)
3. Publish directory: `.` (root)
4. Environment variables: None required

### Other Platforms
- **Railway**: Connect GitHub repo and deploy
- **Render**: Connect GitHub repo, specify Node.js runtime
- **Vercel**: Deploy from GitHub with Vercel CLI
- **Heroku**: Add a `Procfile` with `web: npm start`

## Technical Details

- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Real-time**: WebSocket communication for synchronization
- **Responsive**: CSS Grid/Flexbox for mobile compatibility

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Safari, Edge)
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
