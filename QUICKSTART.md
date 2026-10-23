# Quick Start: Testing the Native App

## For Ryan: Try It Out in 15 Minutes

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

### Step 2: Set Up Firebase (5 min)

1. Go to https://console.firebase.google.com/
2. Click **Create a project** (or use existing)
   - **Name**: Contrail
   - Disable Google Analytics (optional)
3. Once created, click the gear icon → **Project settings**
4. Go to **Cloud Messaging** tab
5. Scroll down to **Cloud Messaging API (Legacy)**
6. Copy the **Server key** (starts with `AAAA...`)
7. Back in Render, go to your `contrail` service → **Environment**
8. Add new variable:
   - **Key**: `FCM_SERVER_KEY`
   - **Value**: (paste the server key)
9. Click **Save Changes**

### Step 3: Test on Your Phone (5 min)

**On your Mac (for iOS):**
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
1. Connect your iPhone via cable
2. Select your iPhone as the target (top toolbar)
3. Click the Play button (or Cmd+R)
4. App installs and opens on your phone
5. Create your profile, add an aircraft

**On another device or browser:**
1. Open https://contrail-xnd3.onrender.com
2. Use the invite link from Settings

**Test push:**
```bash
# Get your channel ID from Settings
# Then test:
curl -X POST https://contrail-xnd3.onrender.com/api/push/test \
  -H "Content-Type: application/json" \
  -d '{"channel": "your-channel-id-here"}'
```

You should receive a notification: "Push notifications are working!"

## What You'll See

### In the Native App:
- When you open an invite link, you see a big "Follow [Name]" button
- Tap it → "Following!" confirmation
- No need to copy/paste topic names or install ntfy

### When Testing:
1. **Device A** (iPhone with app): Start a flight
2. **Device B** (any device that followed): Gets native push notification
3. Tap the notification → opens directly to the live map in the app
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
- Check FCM_SERVER_KEY is set
- Make sure you're testing on a real device (not simulator)
- Look at Render logs for FCM errors

**"Can't build iOS app":**
- Need Xcode installed (Mac only)
- Need to connect a real iPhone (simulators don't support push)
- If signing errors, select your Apple ID in Xcode project settings

**"Can't test - don't have a Mac":**
- Try Android instead:
  ```bash
  npx cap add android
  npx cap sync android
  npx cap open android
  ```
- Or just test with two browsers for now (web PWA)

## Next: Full App Store Submission

Once you've tested and it works, follow the full guide in README.md:
- Enroll in Apple Developer Program
- Create App Store Connect listing
- Configure bundle ID and signing
- Build for TestFlight
- Submit for review

Takes 2-3 hours first time, then updates are quick.

---

Questions? Everything is documented in README.md and IMPLEMENTATION_SUMMARY.md
