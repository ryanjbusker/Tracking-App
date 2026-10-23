# Quick Start: Testing the Native iOS App

## For Ryan: Try It Out in 20 Minutes

### Step 1: Set Up Render Database (5 min)

1. Go to https://dashboard.render.com
2. Click **New +** → **PostgreSQL**
3. Settings:
   - **Name**: `contrail-db`
   - **Database**: `contrail`
   - **User**: `contrail`
   - **Region**: Same as your web service (Oregon)
   - **Plan**: Free (or Starter for production)
4. Click **Create Database**
5. Once created, click on it and copy the **Internal Database URL** (starts with `postgresql://...`)
6. Go to your `contrail` web service → **Environment** tab
7. Add new variable:
   - **Key**: `DATABASE_URL`
   - **Value**: (paste the Internal URL)
8. Click **Save Changes** (this will trigger a deploy)
9. Wait for deploy to complete (~2 min)
10. Check logs - you should see "✓ Migration complete"

### Step 2: Get APNs Key from Apple (10 min)

1. Enroll in Apple Developer Program if you haven't: https://developer.apple.com/programs/ ($99/year)
2. Go to https://developer.apple.com/account
3. **Certificates, Identifiers & Profiles** → **Keys**
4. Click **+** to create a new key
5. **Name**: Contrail Push Key
6. Check **Apple Push Notifications service (APNs)**
7. Click **Continue** → **Register**
8. **Download** the `.p8` file (you can only do this once!)
9. Note the **Key ID** (10 characters, shown on download page)
10. Note your **Team ID** (top right, or Account → Membership, also 10 characters)

### Step 3: Configure Render Environment (5 min)

Go to Render → contrail service → **Environment** and add:

```bash
APNS_KEY_ID=ABC123XYZ          # Your Key ID from Apple
APNS_TEAM_ID=DEF456UVW         # Your Team ID from Apple
APNS_BUNDLE_ID=com.contrail.app
APNS_ENV=sandbox               # Use 'sandbox' for dev, 'production' for TestFlight/App Store
```

For `APNS_KEY`, open the `.p8` file in a text editor, copy the entire contents, and paste:

```bash
APNS_KEY=-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...
(entire key)
-----END PRIVATE KEY-----
```

Click **Save Changes**. Wait for deploy to complete.

### Step 4: Test on Your iPhone (10 min)

**On your Mac:**
```bash
# Clone the repo (if you haven't already)
git clone https://github.com/ryanjbusker/Tracking-App.git
cd Tracking-App

# Checkout the branch
git checkout cursor/native-app-push-notifications-90c8

# Install dependencies
npm install

# Add iOS platform (first time only)
npx cap add ios

# Sync web code to iOS
npx cap sync ios

# Open in Xcode
npx cap open ios
```

In Xcode:
1. Select **App** target (not Pods or AppExtension)
2. **Signing & Capabilities** tab:
   - **Team**: Select your Apple Developer team
   - Add capability: **Push Notifications** (click + Capability)
   - Add capability: **Background Modes** → check **Remote notifications**
3. Connect your iPhone via cable
4. Select your iPhone as the target (top toolbar)
5. Click the Play button (or Cmd+R)
6. App installs and opens on your phone
7. Create your profile, add an aircraft

**Test push:**
```bash
# Get your channel ID from Settings in the app
# Then test:
curl -X POST https://contrail-xnd3.onrender.com/api/push/test \
  -H "Content-Type: application/json" \
  -d '{"channel": "your-channel-id-here"}'
```

You should receive a notification: "Push notifications are working!"

**Test follow flow:**
1. Device A (your iPhone with the app): Settings → copy invite link
2. Device B (another iPhone or open link in Safari): Open link → should see "Follow" button
3. Tap Follow (in native app) or use ntfy.sh (on web)
4. Device A: Start a flight
5. Device B: Should receive push notification
6. Tap notification → opens to live map

## What You'll See

### In the Native App:
- When you open an invite link, you see a big "Follow [Name]" button
- Tap it → "Following!" confirmation
- No need to install ntfy

### When Testing:
1. **Device A** (iPhone with app): Start a flight
2. **Device B** (any device that followed): Gets native push notification
3. Tap the notification → opens directly to the live map
4. **Device A**: End flight
5. **Device B**: Gets "landed" notification

### In Render Logs:
```
Database connected
✓ Migration complete
✓ Tables created: devices, followers, flight_events
Contrail on :3000
```

## Troubleshooting

**"Database not available" errors:**
- Check DATABASE_URL is set in Render environment
- Verify it's the **Internal** URL (not External)
- Make sure PostgreSQL instance is running

**"Push not working":**
- Check all APNs environment variables are set (5 variables)
- Verify APNS_KEY includes the BEGIN and END lines
- Make sure you're testing on a real device (not simulator)
- Check APNS_ENV matches your build (sandbox for dev)
- Look at Render logs for APNs errors

**"Can't build iOS app":**
- Need Xcode installed (Mac only)
- Need to connect a real iPhone (simulators don't support push)
- If signing errors, select your Apple ID in Xcode project settings
- Make sure Push Notifications capability is enabled

## Next: Full App Store Submission

Once you've tested and it works, follow the full guide in README.md:
- Create App Store Connect listing
- Configure bundle ID and signing
- Build for TestFlight
- Submit for review

Takes 2-3 hours first time, then updates are quick.

---

Questions? Everything is documented in README.md and IMPLEMENTATION_SUMMARY.md
