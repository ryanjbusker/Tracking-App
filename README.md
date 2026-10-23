# Contrail

Live flight tracking for training flights. Pick your aircraft, tap **Start flight**, and the people you've invited get a push notification with a link to a live map. They get another when you land.

**NEW in v2.0**: Native iOS and Android apps with native push notifications! 🎉

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

## 🚀 Ship Checklist: Native Mobile Apps

This checklist covers everything Ryan needs to do himself to publish Contrail to the App Store and Google Play.

### Prerequisites

✅ **Already done in this PR:**
- ✓ Capacitor setup with iOS and Android projects
- ✓ PostgreSQL database schema (tables for device tokens, followers, flight events)
- ✓ Server API endpoints for device registration, following, and push notifications
- ✓ Native push notification integration in the app
- ✓ Tests for all server endpoints
- ✓ GitHub Actions CI

❗ **You need to complete:**

### 1. Set Up Firebase Cloud Messaging (FCM)

FCM provides unified push notifications for both iOS and Android.

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project (or use existing): **Contrail**
3. In Project Settings → Cloud Messaging:
   - Copy the **Server Key** (Legacy)
   - This is your `FCM_SERVER_KEY` for Render
4. For iOS, also upload your APNs certificate/key (see iOS setup below)

**📝 Add to Render:**
```bash
# In Render Dashboard → contrail service → Environment
FCM_SERVER_KEY=AAAA...your-key-here
```

### 2. Set Up Render PostgreSQL Database

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
   # SSH into your Render service or run locally with DATABASE_URL set
   npm run db:migrate
   ```
   
   Or trigger a deploy after setting `DATABASE_URL` — the migration runs automatically on startup (add to `buildCommand`).

### 3. iOS App Store Setup

#### a. Apple Developer Program
1. Enroll in [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. Wait for approval (can take 24-48 hours)

#### b. App Store Connect
1. Log in to [App Store Connect](https://appstoreconnect.apple.com/)
2. Click **Apps** → **+** → **New App**
   - **Platform**: iOS
   - **Name**: Contrail
   - **Primary Language**: English (U.S.)
   - **Bundle ID**: Create new → `com.contrail.app` (must match `capacitor.config.json`)
   - **SKU**: `contrail-ios-001`
   - **User Access**: Full Access
3. Fill out app metadata:
   - **Category**: Navigation or Utilities
   - **Description**: (copy from landing page)
   - **Keywords**: flight tracking, ads-b, aviation, student pilot
   - **Support URL**: Your website or GitHub repo
   - **Privacy Policy URL**: Create a simple privacy policy (required)

#### c. Configure Bundle ID in Xcode
1. Install [Xcode](https://apps.apple.com/app/xcode/id497799835) (Mac required)
2. Open Capacitor iOS project:
   ```bash
   npx cap open ios
   ```
3. In Xcode:
   - Select the **Contrail** project in the sidebar
   - Go to **Signing & Capabilities** tab
   - **Team**: Select your Apple Developer team
   - **Bundle Identifier**: `com.contrail.app` (must match App Store Connect)
   - Enable **Push Notifications** capability (click **+ Capability**)
   - Enable **Background Modes** → check **Remote notifications**

#### d. APNs Authentication Key
1. In [Apple Developer Portal](https://developer.apple.com/account):
   - Go to **Certificates, Identifiers & Profiles**
   - **Keys** → **+** → Create a key
   - **Name**: Contrail Push Key
   - Enable **Apple Push Notifications service (APNs)**
   - Download the `.p8` key file (save it securely)
   - Note the **Key ID** and **Team ID**

2. Upload to Firebase Console:
   - Project Settings → Cloud Messaging → iOS app configuration
   - Upload the APNs Auth Key (.p8), Key ID, and Team ID

#### e. Build and Submit to TestFlight
1. Update version number in `ios/App/App.xcodeproj`:
   - **Version**: `2.0.0`
   - **Build**: `1`

2. Build and archive:
   ```bash
   # Sync web assets to iOS
   npx cap sync ios
   
   # Open Xcode
   npx cap open ios
   
   # In Xcode:
   # 1. Select "Any iOS Device" as target
   # 2. Product → Archive
   # 3. Wait for build to complete
   # 4. Click "Distribute App"
   # 5. Choose "App Store Connect"
   # 6. Upload
   ```

3. Once upload completes:
   - Go to App Store Connect → TestFlight
   - Add internal testers (yourself) or external testers
   - Approve for Beta review (if using external testers)
   - Install TestFlight app on iPhone and test

#### f. Submit for App Review
1. In App Store Connect → Contrail → App Store tab:
   - Add screenshots (see below for how to capture)
   - Add app icon (1024x1024 PNG)
   - Set pricing (Free)
   - Age rating questionnaire
   - App Review Information (contact details)
   - Version Release: Manual or Automatic
2. Click **Submit for Review**
3. Wait 1-3 days for review

### 4. Google Play Setup

#### a. Google Play Console
1. Go to [Google Play Console](https://play.google.com/console)
2. Pay one-time $25 registration fee
3. Click **Create app**
   - **App name**: Contrail
   - **Default language**: English (United States)
   - **App or game**: App
   - **Free or paid**: Free
4. Complete app content questionnaires:
   - Privacy Policy (required)
   - Data safety form
   - Content rating questionnaire (select your region, answer questions)
   - Target audience and content
   - News apps declaration (No)

#### b. Configure Android App
1. Update `android/app/build.gradle`:
   ```gradle
   android {
       defaultConfig {
           applicationId "com.contrail.app"  // Must match Capacitor config
           versionCode 1
           versionName "2.0.0"
       }
   }
   ```

2. Add Firebase config:
   - In Firebase Console, add an Android app
   - Package name: `com.contrail.app`
   - Download `google-services.json`
   - Place in `android/app/` directory

3. Open Android Studio:
   ```bash
   npx cap sync android
   npx cap open android
   ```

4. Generate signing key:
   ```bash
   # On Mac/Linux
   keytool -genkey -v -keystore contrail-release.keystore \
     -alias contrail -keyalg RSA -keysize 2048 -validity 10000
   
   # Save this file securely! You cannot publish updates without it.
   ```

5. Configure signing in `android/app/build.gradle`:
   ```gradle
   android {
       signingConfigs {
           release {
               storeFile file('../../contrail-release.keystore')
               storePassword 'your-keystore-password'
               keyAlias 'contrail'
               keyPassword 'your-key-password'
           }
       }
       buildTypes {
           release {
               signingConfig signingConfigs.release
           }
       }
   }
   ```

#### c. Build Release APK/Bundle
1. In Android Studio:
   - **Build** → **Generate Signed Bundle / APK**
   - Choose **Android App Bundle** (recommended)
   - Select the keystore file
   - Choose **release** build variant
   - Click **Finish**

2. Or via command line:
   ```bash
   cd android
   ./gradlew bundleRelease
   # Output: android/app/build/outputs/bundle/release/app-release.aab
   ```

#### d. Upload to Play Console
1. In Play Console → Contrail → Production:
   - **Create new release**
   - Upload the `.aab` file
   - Add release notes: "Initial release with native push notifications"
   - Click **Review release** → **Start rollout to Production**

2. Or start with **Internal testing** / **Closed testing** first

3. Wait a few hours for review (usually faster than iOS)

### 5. App Screenshots

#### iOS Screenshots
Required sizes (at minimum):
- 6.7" Display (iPhone 14 Pro Max): 1290 x 2796 px
- 6.5" Display (iPhone 11 Pro Max): 1242 x 2688 px

1. Run app in Xcode Simulator:
   ```bash
   npx cap run ios
   ```
2. Take screenshots:
   - **Cmd + S** in Simulator
   - Or use **Xcode** → **Debug** → **Capture Screenshot**

Recommended screens:
1. Home screen with aircraft list
2. Live flight map (pilot view)
3. Live flight tracking (watcher view)
4. Settings screen

#### Android Screenshots
Required: At least 2 screenshots, up to 8

- Phone: 1080 x 1920 px or 1080 x 2340 px

1. Run app in Android Emulator:
   ```bash
   npx cap run android
   ```
2. Take screenshots:
   - **Camera icon** in emulator toolbar
   - Or use Android Studio device screenshot tool

### 6. Testing Push Notifications

#### Test on Device (Development)
1. Run the app on a physical device (push doesn't work in simulators)
   ```bash
   # iOS
   npx cap run ios --target="Your iPhone"
   
   # Android
   npx cap run android --target="your-device-id"
   ```

2. Register your device (happens automatically on app launch)

3. Test endpoint:
   ```bash
   curl -X POST https://contrail-xnd3.onrender.com/api/push/test \
     -H "Content-Type: application/json" \
     -d '{"channel": "your-channel-id"}'
   ```

4. You should receive a "Push notifications are working!" notification

#### Test Full Flow
1. Install app on two devices (or one device + web browser)
2. Device A: Create profile, add aircraft
3. Device B: Open invite link from Device A → tap **Follow**
4. Device A: Start a flight
5. Device B should receive push notification
6. Device A: End flight
7. Device B should receive landed notification

### 7. Post-Launch

#### Update App
1. Increment version numbers:
   - `package.json`: `"version": "2.1.0"`
   - iOS: In Xcode, bump **Version** or **Build** number
   - Android: In `build.gradle`, increment `versionCode` and `versionName`

2. Build and upload to App Store Connect / Play Console

3. Push will auto-deploy from GitHub to Render

#### Monitor
- Check Render logs for server errors
- Check Play Console / App Store Connect for crash reports
- Monitor database size in Render dashboard

#### Support
- Add support email in app and store listings
- Respond to reviews in App Store / Play Store

---

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
export FCM_SERVER_KEY=your-test-key

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
# Add platforms (already done)
npx cap add ios
npx cap add android

# Sync web assets to native projects
npx cap sync

# Open in native IDE
npx cap open ios
npx cap open android

# Run on device
npx cap run ios
npx cap run android
```

### Update Capacitor Dependencies

```bash
npm install @capacitor/core@latest @capacitor/cli@latest
npm install @capacitor/ios@latest @capacitor/android@latest
npx cap sync
```

---

## Architecture

### Web App (PWA)
- Still works as before
- Uses ntfy.sh for web push notifications
- Served from `index.html`, `app.js`, `styles.css`

### Native App (iOS/Android)
- Wraps the web app using Capacitor
- Replaces ntfy.sh with native Firebase Cloud Messaging
- Device registration happens automatically on app launch
- Push notifications open directly into the app's map view

### Server
- Node.js HTTP server (`server.js`)
- PostgreSQL for persistent storage:
  - `devices`: Push tokens by channel
  - `followers`: Pilot → follower relationships
  - `flight_events`: Flight start/end log (debugging)
- ADS-B polling (adsb.lol, adsb.fi)
- Firebase Cloud Messaging integration

### Database Schema

```sql
CREATE TABLE devices (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
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
1. Check that APNs key is uploaded to Firebase
2. Verify Bundle ID matches everywhere (`com.contrail.app`)
3. Ensure Push Notifications capability is enabled in Xcode
4. Check device token is being registered: look for console log "Push token: ..."
5. Test on a real device (not simulator)

**Android:**
1. Verify `google-services.json` is in `android/app/`
2. Check package name matches (`com.contrail.app`)
3. Test on a real device (emulator should work but can be flaky)

**Server:**
1. Check `FCM_SERVER_KEY` is set in Render environment
2. Check database is accessible (`DATABASE_URL` set)
3. Look at Render logs for FCM errors

### Database Connection Issues
- Ensure `DATABASE_URL` is the **Internal** URL from Render PostgreSQL (not External)
- Check that the Postgres instance is running
- Verify the server can reach the database (look for connection errors in logs)

### Build Errors

**iOS:**
- Update CocoaPods: `cd ios && pod install`
- Clean build folder: Xcode → Product → Clean Build Folder
- Check Xcode version (need latest for latest iOS SDK)

**Android:**
- Clean: `cd android && ./gradlew clean`
- Invalidate caches: Android Studio → File → Invalidate Caches
- Check Java version: `java -version` (need Java 11+)

---

## License

MIT — feel free to use, modify, and share.
