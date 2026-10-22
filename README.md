# Contrail

Live flight tracking for training flights. Pick your aircraft, tap **Start flight**, and the people you've invited get a push notification with a link to a live map. They get another when you land.

## How it works

```
 Aircraft transponder (ADS-B) ─► adsb.lol / adsb.fi ─► server.js (Render) ──────────────┐
                                                                                         ├─► Live map (merges both)
 Pilot phone: GPS backup ─► batch every 30s ─► ntfy.sh topic  contrail-<id> ─────────────┘
 Pilot phone: Start / Landed ──────────────► ntfy.sh topic  contrail-<id>-alerts ─► ntfy app push ─► tap opens map
```

- **Transponder first.** When you start a flight, `server.js` polls the free community ADS-B feeds by tail number (adsb.lol, with adsb.fi as fallback) every 5 seconds. This works with your phone locked in your pocket.
- **Phone GPS as backup** fills gaps where no receiver can see you, such as low in the pattern at small fields. You can turn it off in Settings.
- **Tiny server.** `server.js` has no dependencies. It serves the app and relays ADS-B data, because browsers can't call those feeds directly. [ntfy.sh](https://ntfy.sh) handles push notifications.
- **Your aircraft, flight log and settings** are stored on your phone (`localStorage`).
- **Offline-safe.** If you lose cell coverage, points queue on the phone and send when you're back in range.
- **Private link.** Your channel id is 16 random characters. Anyone with the link can watch, and you can regenerate it in Settings.
- **Map layers:** dark/light street map, FAA VFR sectional, and satellite (tap the layers button).

## Deploy on Render (free)

1. Go to https://dashboard.render.com and sign in with GitHub.
2. Click **New → Blueprint** and pick this repo. Render reads `render.yaml` and creates a free web service named `contrail`.
3. Click **Apply**. A couple of minutes later you get a URL like `https://contrail-xxxx.onrender.com`.

Every `git push` to `main` redeploys automatically.

Free Render services sleep after about 15 minutes with no visitors, so the first visit after a quiet period can take 30–60 seconds. During a flight the server pings itself to stay awake.

To run it locally: `node server.js`, then open http://localhost:3000.

Then, on your phone:
1. Open the URL in Safari (iPhone) or Chrome (Android).
2. Tap Share → **Add to Home Screen**. It installs like an app.
3. Enter your name, add your aircraft, and tap **Invite** to send your people the setup link.

## Things to know

- **Transponder tracking needs ADS-B Out** (nearly every training aircraft has it) and a ground receiver in range. Coverage is usually solid a couple thousand feet up, but can drop out on the ground or low near small fields. The flight screen shows whether your transponder is being picked up.
- **Phone GPS backup only works while Contrail is open with the screen on.** Phones pause web GPS when locked. Once the flight screen says your transponder is tracked, you can lock the phone.
- **Aircraft whose owners opted into FAA privacy programs (PIA/LADD)** may be hidden or anonymized on some feeds. Phone GPS still works for those.
- **Transponder track history lives in the server's memory.** If the server restarts mid-flight, the earlier transponder track is lost, though phone GPS points are kept in ntfy.
- **Cell coverage at altitude is spotty**, which only affects phone GPS. The track catches up when you reconnect.
- **ntfy.sh free tier is about 250 messages/day.** At the default 30s update rate, a flight uses about 120 messages per hour. For long days, use 60s updates or get an ntfy supporter plan.
- Watchers can see the last 12 hours of flights (ntfy.sh's message retention).
- Altitude is GPS altitude (MSL, approximate), not pressure altitude.
- Not for navigation, ATC or emergency use.

## Try it without flying

Settings → **Demo mode** simulates a flight circling near Martin State (KMTN). It sends real notifications, so it's a good way to show your people how it works.
