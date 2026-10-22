# Contrail

Live flight tracking for training flights. Pick your aircraft, tap **Start flight**, and the people you've invited get a push notification with a link to a live map. They get another when you land.

## How it works

```
 Pilot phone (Contrail)                ntfy.sh (free, no account)          Watchers
 ─────────────────────                 ──────────────────────────          ────────
 GPS ─► batch every 30s ─────────────► topic  contrail-<id>        ─────► Live map (streams the topic)
 Start / Landed ─────────────────────► topic  contrail-<id>-alerts ─────► ntfy app push ─► tap opens live map
```

- **No backend.** A static site, plus [ntfy.sh](https://ntfy.sh) for push notifications and as the live data feed.
- **Your aircraft, flight log and settings** are stored on your phone (`localStorage`).
- **Offline-safe.** If you lose cell coverage, points queue on the phone and send when you're back in range.
- **Private link.** Your channel id is 16 random characters. Anyone with the link can watch, and you can regenerate it in Settings.
- **Map layers:** dark/light street map, FAA VFR sectional, and satellite (tap the layers button).

## Deploy (pick one, both free)

Location access requires HTTPS, so the app must be hosted. Opening the file directly won't work.

**Netlify Drop (2 minutes):** go to https://app.netlify.com/drop and drag this whole folder onto the page. You get a URL like `https://something.netlify.app`.

**GitHub Pages:** push this folder to a repo, then go to Settings → Pages → Deploy from branch `main` / root.

Then, on your phone:
1. Open the URL in Safari (iPhone) or Chrome (Android).
2. Tap Share → **Add to Home Screen**. It installs like an app.
3. Enter your name, add your aircraft, and tap **Invite** to send your people the setup link.

## Things to know

- **Keep the app open with the screen on during the flight.** A web app's GPS pauses when the phone locks or the app goes to the background. Contrail asks the phone to keep the screen awake, so a phone mount plus a charger is ideal. If background tracking is a must, the next step is a native app wrapper (Expo/Capacitor).
- **Cell coverage at altitude is spotty.** Watchers see "Signal lost" and the track catches up when you reconnect.
- **ntfy.sh free tier is about 250 messages/day.** At the default 30s update rate, a flight uses about 120 messages per hour. For long days, use 60s updates or get an ntfy supporter plan.
- Watchers can see the last 12 hours of flights (ntfy.sh's message retention).
- Altitude is GPS altitude (MSL, approximate), not pressure altitude.
- Not for navigation, ATC or emergency use.

## Try it without flying

Settings → **Demo mode** simulates a flight circling near Martin State (KMTN). It sends real notifications, so it's a good way to show your people how it works.
