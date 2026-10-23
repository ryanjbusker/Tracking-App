# Contrail

Live flight tracking for training flights. Pick your aircraft, tap **Start flight**, and the people you've invited get a push notification with a link to a live map. They get another when you land.

**NEW in v2.0**: Native iOS app with native push notifications! 🎉

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

---

## 🚀 Ship Checklist: Native iOS App

This checklist covers everything Ryan needs to publish Contrail to the App Store.

### Prerequisites

✅ **Already done in this PR:**
- ✓ Capacitor setup with iOS project
- ✓ PostgreSQL database schema (tables for device tokens, followers, flight events)
- ✓ Server API endpoints for device registration, following, and push notifications
- ✓ Direct APNs integration (no Firebase)
- ✓ Native push notification integration in the app
- ✓ Tests for all server endpoints
- ✓ GitHub Actions CI

❗ **You need to complete:**

### 1. Set Up Render PostgreSQL Database

1. In [Render Dashboard](https://dashboard.render.com):
   - Click **New +** → **PostgreSQL**
   - Name: `contrail-db`
   - Choose a plan (Free tier works for testing, Starter $7/mo for production)
   - Click **Create Database**

2. Once created, copy the **Internal Database URL**

3. Go to your `contrail` web service → Environment:
   ```bash
   DATABASE_URL=postgresql://user:pass@dpg-xxx.oregon-postgres.render.com/contrail_db
   ```

4. Run the migration:
   ```bash
   # The migration runs automatically on next deploy
   # Or run manually via SSH: npm run db:migrate
   ```

### 2. Apple Developer Program

1. Enroll in [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. Wait for approval (can take 24-48 hours)

### 3. Create APNs Authentication Key

1. Go to [Apple Developer Portal](https://developer.apple.com/account)
2. Navigate to **Certificates, Identifiers & Profiles**
3. Click **Keys** in the left sidebar
4. Click the **+** button
5. **Name**: Contrail Push Key
6. **Enable**: Apple Push Notifications service (APNs)
7. Click **Continue**, then **Register**
8. **Download** the `.p8` key file (you can only download it once!)
9. Note the **Key ID** (shows on the download page)
10. Note your **Team ID** (top right of the portal, or Account → Membership)

### 4. Configure Render Environment Variables

In Render Dashboard → contrail service → Environment, add:

```bash
# Database (from step 1)
DATABASE_URL=postgresql://user:pass@dpg-xxx.oregon-postgres.render.com/contrail_db

# APNs Configuration
APNS_KEY_ID=ABC123XYZ      # Key ID from Apple (10 characters)
APNS_TEAM_ID=DEF456UVW     # Team ID from Apple (10 characters)
APNS_BUNDLE_ID=com.contrail.app
APNS_ENV=production        # Use 'sandbox' for development, 'production' for TestFlight/App Store

# APNs Key (.p8 file contents - see below for how to set this)
APNS_KEY=-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...
...entire key here...
-----END PRIVATE KEY-----
```

**Setting the APNS_KEY value:**
1. Open the downloaded `.p8` file in a text editor
2. Copy the entire contents (including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`)
3. Paste into the APNS_KEY environment variable in Render

**Save** and wait for the deployment to complete.

### 5. App Store Connect Setup

1. Log in to [App Store Connect](https://appstoreconnect.apple.com/)
2. Click **Apps** → **+** → **New App**
   - **Platform**: iOS
   - **Name**: Contrail
   - **Primary Language**: English (U.S.)
   - **Bundle ID**: Create new → `com.contrail.app` (must match capacitor.config.json)
   - **SKU**: `contrail-ios-001`
   - **User Access**: Full Access
3. Fill out app metadata:
   - **Category**: Navigation
   - **Description**: Live flight tracking for student pilots. Your people get notified when you start a flight and can follow along in real time.
   - **Keywords**: flight tracking, aviation, student pilot, ads-b, flight training
   - **Support URL**: Your website or this GitHub repo
   - **Privacy Policy URL**: Create a simple privacy policy (required - see below)

**Privacy Policy (simple example):**
```
Contrail Privacy Policy

Contrail collects:
- Your name and aircraft information (stored on your device)
- Your device push notification token (stored on our server to send you notifications)
- Flight tracking data (GPS position, altitude, speed when you start a flight)

This data is used only to provide the flight tracking service. We do not sell or share your data with third parties.

Contact: [your email]
```

Host this somewhere (GitHub Pages, your website, etc.) and link to it.

### 6. Configure Xcode Project

1. Install [Xcode](https://apps.apple.com/app/xcode/id497799835) (Mac required)

2. Generate iOS project:
   ```bash
   cd /path/to/Tracking-App
   git checkout cursor/native-app-push-notifications-90c8
   npm install
   npx cap add ios
   npx cap sync ios
   ```

3. Open in Xcode:
   ```bash
   npx cap open ios
   ```

4. In Xcode, select the **App** target (not AppExtension or Pods)

5. **Signing & Capabilities** tab:
   - **Team**: Select your Apple Developer team
   - **Bundle Identifier**: `com.contrail.app` (must match App Store Connect)
   - Xcode will automatically create/update provisioning profiles

6. Add **Push Notifications** capability:
   - Click **+ Capability** button
   - Search for "Push Notifications"
   - Add it

7. Add **Background Modes** capability (if not already present):
   - Click **+ Capability**
   - Search for "Background Modes"
   - Check **Remote notifications**

8. **General** tab:
   - **Display Name**: Contrail
   - **Version**: 2.0.0
   - **Build**: 1

### 7. Build and Upload to TestFlight

1. In Xcode, select **Any iOS Device (arm64)** as the build target (top toolbar)

2. Menu: **Product** → **Archive**

3. Wait for the build to complete (5-10 minutes first time)

4. The **Organizer** window opens automatically

5. Select your archive, click **Distribute App**

6. Choose **App Store Connect** → **Upload**

7. **Distribution Certificate**: Automatic signing

8. Click **Upload**

9. Wait for upload to complete (5-10 minutes)

### 8. TestFlight Testing

1. Once upload completes, go to [App Store Connect](https://appstoreconnect.apple.com/)

2. Your app → **TestFlight** tab

3. The build will say "Processing" for 5-15 minutes (Apple scans it)

4. Once it says "Ready to Submit":
   - Click the build number
   - Add "What to Test" notes (optional)
   - Add yourself as an **Internal Tester**
   - Click **Save**

5. Install **TestFlight** app on your iPhone (from App Store)

6. Open TestFlight, you'll see Contrail

7. Tap **Install**

8. **Test the app**:
   - Register your device (happens automatically on launch)
   - Test the follow flow
   - Test receiving push notifications:
     ```bash
     curl -X POST https://contrail-xnd3.onrender.com/api/push/test \
       -H "Content-Type: application/json" \
       -d '{"channel": "your-channel-id"}'
     ```

### 9. Submit for App Review

Once testing is complete:

1. In App Store Connect → Your app → **App Store** tab

2. **App Information**:
   - Confirm bundle ID, category, etc.

3. **Pricing and Availability**:
   - **Price**: Free
   - **Availability**: All countries (or select specific ones)

4. **App Privacy**:
   - Click **Get Started**
   - Answer questions:
     - **Collect data?** Yes
     - **Location?** Yes (for flight tracking)
     - **Contact Info?** No
     - **Identifiers?** Yes (device token for push notifications)
   - **How is data used?** App Functionality
   - **Linked to user?** No
   - Save

5. **Version 2.0.0** → **+** (if not already created)

6. **Screenshots**:
   - See "Taking Screenshots" section below

7. **App Preview** (optional video): Skip for now

8. **Promotional Text** (optional): Skip

9. **Description**: Copy from above

10. **Keywords**: `flight tracking, aviation, student pilot, ads-b, flight training, live map, transponder`

11. **Support URL**: Link to GitHub or your site

12. **Marketing URL** (optional): Skip

13. **Version**: 2.0.0

14. **Copyright**: 2026 Ryan Busker

15. **Build**: Select the TestFlight build you tested

16. **App Review Information**:
    - **First Name**: Ryan
    - **Last Name**: Busker
    - **Email**: Your email
    - **Phone**: Your phone
    - **Demo Account** (if login required): N/A

17. **Notes**:
    ```
    Contrail is a flight tracking app for student pilots.
    To test:
    1. Create a profile
    2. Add an aircraft (e.g. N12345)
    3. Settings → Demo Mode ON
    4. Start Flight
    5. View the live map
    ```

18. **Version Release**: **Manually release this version** (so you control the launch)

19. Click **Add for Review**

20. Click **Submit for Review**

21. Wait 1-3 days for review

### 10. Taking Screenshots

**Required sizes:**
- 6.7" Display (iPhone 14 Pro Max): 1290 x 2796 px (required)
- 6.5" Display (iPhone 11 Pro Max): 1242 x 2688 px (optional but recommended)

**Recommended screens:**
1. Home screen with aircraft list
2. Flight in progress (live map with plane icon)
3. Live tracking (watcher view)
4. Settings screen

**How to capture:**

1. Run app in Xcode Simulator:
   ```bash
   npx cap run ios
   ```

2. In Simulator menu: **Device** → Choose iPhone 14 Pro Max

3. Navigate to each screen in the app

4. Take screenshots:
   - **Cmd + S** in Simulator
   - Or **Simulator menu** → **File** → **Save Screen**

5. Screenshots save to Desktop

6. Upload to App Store Connect

### 11. After Approval

1. You'll receive an email: "Contrail is Ready for Sale"

2. In App Store Connect, click **Release This Version**

3. The app goes live within 24 hours

4. Share the link: `https://apps.apple.com/app/contrail/id[your-app-id]`

### 12. Updates

For future updates:

1. Make changes to code
2. Increment version in Xcode:
   - **Version**: 2.1.0 (or 2.0.1 for bug fixes)
   - **Build**: 2 (increment for each TestFlight upload)
3. **Product** → **Archive**
4. Upload to TestFlight
5. Test
6. Submit new version for review

---

## Future: Android Support

Android support was removed to simplify the initial launch. To add it later:

1. Set up Firebase Cloud Messaging (FCM)
2. Add FCM server key to Render environment
3. Modify server to support FCM tokens in addition to APNs
4. Add Android platform: `npx cap add android`
5. Follow Google Play setup guide

## Development

### Local Setup

```bash
# Install dependencies
npm install

# Set up local PostgreSQL (optional, for testing push features)
# On Mac with Homebrew:
brew install postgresql
brew services start postgresql
createdb contrail_dev

# Set environment variables
export DATABASE_URL=postgresql://localhost/contrail_dev
export APNS_KEY_ID=ABC123XYZ
export APNS_TEAM_ID=DEF456UVW
export APNS_BUNDLE_ID=com.contrail.app
export APNS_KEY="$(cat /path/to/AuthKey_ABC123XYZ.p8)"
export APNS_ENV=sandbox

# Run migrations
npm run db:migrate

# Start server
npm start
```

### Run Tests

```bash
# Unit tests (requires server running)
npm test

# Or with database
DATABASE_URL=postgresql://localhost/contrail_dev npm test
```

### Capacitor Commands

```bash
# Add iOS platform (first time only)
npx cap add ios

# Sync web assets to iOS project
npx cap sync

# Open in Xcode
npx cap open ios

# Run on device
npx cap run ios
```

### Update Capacitor Dependencies

```bash
npm install @capacitor/core@latest @capacitor/cli@latest
npm install @capacitor/ios@latest
npx cap sync
```

---

## Architecture

### Web App (PWA)
- Still works as before
- Uses ntfy.sh for web push notifications
- Served from `index.html`, `app.js`, `styles.css`

### Native App (iOS)
- Wraps the web app using Capacitor
- Replaces ntfy.sh with native Apple Push Notifications (APNs)
- Device registration happens automatically on app launch
- Push notifications open directly into the app's map view

### Server
- Node.js HTTP server (`server.js`)
- PostgreSQL for persistent storage:
  - `devices`: Push tokens by channel
  - `followers`: Pilot → follower relationships
  - `flight_events`: Flight start/end log (debugging)
- ADS-B polling (adsb.lol, adsb.fi)
- Direct APNs integration via HTTP/2 (token-based auth with .p8 key)

### Database Schema

```sql
CREATE TABLE devices (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(10) NOT NULL CHECK (platform = 'ios'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE followers (
  id SERIAL PRIMARY KEY,
  pilot_channel VARCHAR(32) NOT NULL,
  follower_channel VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pilot_channel, follower_channel)
);

CREATE TABLE flight_events (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('start', 'end')),
  tail VARCHAR(10),
  pilot_name VARCHAR(50),
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Troubleshooting

### Push Notifications Not Working

**iOS:**
1. Check that APNs environment variables are set correctly in Render:
   - `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY`, `APNS_ENV`
2. Verify Bundle ID matches everywhere (`com.contrail.app`)
3. Ensure Push Notifications capability is enabled in Xcode
4. Check device token is being registered: look for console log "Push token: ..."
5. Test on a real device (push doesn't work in simulator)
6. Check APNS_ENV: use `sandbox` for development builds, `production` for TestFlight/App Store

**Server:**
1. Check all APNs environment variables are set in Render
2. Check database is accessible (`DATABASE_URL` set)
3. Look at Render logs for APNs errors (410 = invalid token)
4. Verify the .p8 key contents are correctly pasted (including BEGIN/END lines)

### Database Connection Issues
- Ensure `DATABASE_URL` is the **Internal** URL from Render PostgreSQL (not External)
- Check that the Postgres instance is running
- Verify the server can reach the database (look for connection errors in logs)

### Build Errors

**iOS:**
- Update CocoaPods: `cd ios && pod install`
- Clean build folder: Xcode → Product → Clean Build Folder
- Check Xcode version (need Xcode 14+ for iOS 16+ SDK)
- Verify you're building for a real device or Generic iOS Device (not simulator)

---

## License

MIT — feel free to use, modify, and share.
