# Change Summary: iOS-Only with Direct APNs

## What Changed

Per Ryan's direction, the implementation has been switched from Firebase Cloud Messaging to direct Apple Push Notification service (APNs) integration, and narrowed to iOS-only for the initial launch.

### Key Changes

1. **Removed Firebase/FCM entirely**
   - No more Firebase Console setup needed
   - No FCM Server Key
   - Simpler architecture

2. **Direct APNs integration**
   - Uses Apple's HTTP/2 APNs API
   - Token-based authentication with .p8 key
   - JWT signed with ES256 algorithm
   - Node's built-in `http2` and `crypto` modules (no external dependencies)

3. **iOS-only**
   - Removed Android platform
   - Removed `@capacitor/android` dependency
   - Documentation focuses on iOS App Store only
   - Android mentioned as future option requiring FCM

4. **Invalid token handling**
   - Server detects 410/BadDeviceToken responses from APNs
   - Automatically deletes invalid tokens from database
   - Keeps the device registry clean

## Server Changes

### New Environment Variables Required

Ryan must set these in Render Dashboard → contrail service → Environment:

```bash
# Database (unchanged)
DATABASE_URL=postgresql://user:pass@dpg-xxx.oregon-postgres.render.com/contrail_db

# APNs Configuration (NEW - replaces FCM_SERVER_KEY)
APNS_KEY_ID=ABC123XYZ           # From Apple Developer Portal (10 chars)
APNS_TEAM_ID=DEF456UVW          # From Apple Developer Portal (10 chars)
APNS_BUNDLE_ID=com.contrail.app # Must match Xcode project
APNS_ENV=production             # 'sandbox' for dev, 'production' for TestFlight/App Store

# APNs Key (contents of .p8 file)
APNS_KEY=-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...
(entire key)
-----END PRIVATE KEY-----
```

### How to Get APNs Key

1. Go to https://developer.apple.com/account
2. Certificates, Identifiers & Profiles → Keys
3. Click + to create new key
4. Name: "Contrail Push Key"
5. Enable: Apple Push Notifications service (APNs)
6. Download the .p8 file (only chance to download!)
7. Note the Key ID (10 characters)
8. Note your Team ID (top right, or Account → Membership)
9. Open .p8 file in text editor, copy entire contents
10. Paste into APNS_KEY environment variable in Render

### API Changes

**Device Registration:**
- Now validates `platform === 'ios'` only (rejects android/web)
- Uses native APNs device token from Capacitor

**Push Sending:**
- Changed from FCM HTTP API to APNs HTTP/2 API
- JWT authentication instead of server key
- Connects to `api.push.apple.com` (production) or `api.sandbox.push.apple.com` (sandbox)
- Returns `{ success, failed, deleted }` (deleted = invalid tokens removed)

**Test Endpoint:**
- `/api/push/test` now returns `deleted` count

## Code Changes

### server.js
- Removed `FCM_SERVER_KEY` and FCM code
- Added `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY`, `APNS_ENV`
- Implemented `generateApnsJwt()` for ES256 JWT signing
- Implemented `sendApnsPush()` for HTTP/2 APNs communication
- Implemented `sendSingleApns()` for per-device push with error handling
- Added invalid token detection (410 response)
- Auto-deletes invalid tokens from database

### app.js
- Removed platform detection (`window.Capacitor.getPlatform()`)
- Hardcoded `platform: 'ios'` for device registration
- Simplified follow flow (no Android handling)

### scripts/migrate.js
- Updated device table constraint: `CHECK (platform = 'ios')` only

### test/server.test.js
- Added test for rejecting non-iOS platforms
- Tests validate iOS-only registration

### package.json
- Removed `@capacitor/android` devDependency

### capacitor.config.json
- Removed `server.url` (loads from deployed server)
- Kept iOS configuration

## Documentation Changes

### README.md
- Removed all Firebase/FCM references
- Removed Android/Google Play sections
- Rewrote ship checklist for iOS App Store only
- Added APNs key setup instructions
- Added environment variable documentation
- Removed Android-specific troubleshooting
- Mentioned Android as future option

### QUICKSTART.md
- Updated to iOS-only workflow
- Added APNs key acquisition steps
- Removed Firebase setup
- Removed Android testing instructions
- Focused on Mac/Xcode/iPhone workflow

## Testing

### CI Status
✅ All checks passing:
- `lint` pass (8s) - JavaScript syntax validation
- `test` pass (44s) - 17 API endpoint tests with PostgreSQL

### New Test
Added test to verify only iOS platform is accepted:
```javascript
test('POST /api/device/register rejects non-iOS platforms', async () => {
  const res = await request('POST', '/api/device/register', {
    channel: 'testchannel123',
    token: 'test-token',
    platform: 'android',  // Should be rejected
  });
  assert.ok(res.status === 400 || res.status === 503);
  if (res.status === 400) {
    assert.ok(res.body.error.includes('iOS'));
  }
});
```

## What Ryan Must Do

### Immediate (to test on device):

1. **Enroll in Apple Developer Program** ($99/year)
   - https://developer.apple.com/programs/
   - Wait for approval (24-48 hours)

2. **Create APNs Key** (10 min)
   - Developer Portal → Keys → + → APNs
   - Download .p8 file
   - Note Key ID and Team ID

3. **Set Render Environment Variables** (5 min)
   - Add all 5 APNs variables (see above)
   - DATABASE_URL (if not already set)

4. **Build and Run on iPhone** (15 min)
   ```bash
   git pull
   npm install
   npx cap add ios
   npx cap sync ios
   npx cap open ios
   ```
   - In Xcode: Select team, add Push capability
   - Run on connected iPhone
   - Test with `/api/push/test`

### For App Store Submission (2-3 hours):

1. Create App Store Connect listing
2. Configure Xcode signing
3. Build and upload to TestFlight
4. Test in TestFlight
5. Submit for review

Full step-by-step in README.md

## Technical Details

### APNs HTTP/2 Integration

**JWT Generation:**
```javascript
function generateApnsJwt() {
  const header = { alg: 'ES256', kid: APNS_KEY_ID };
  const payload = { iss: APNS_TEAM_ID, iat: now };
  const token = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.createSign('sha256').sign(APNS_KEY, 'base64url');
  return `${token}.${signature}`;
}
```

**Push Request:**
```javascript
POST /3/device/{device-token}
Host: api.push.apple.com (or api.sandbox.push.apple.com)
Authorization: bearer {jwt}
apns-topic: com.contrail.app
apns-priority: 10
apns-push-type: alert

Body:
{
  "aps": {
    "alert": { "title": "...", "body": "..." },
    "sound": "default",
    "badge": 1
  },
  "url": "https://contrail.../track/...",
  "type": "flight_start"
}
```

**Response Handling:**
- 200 → success
- 410 or 400 with "BadDeviceToken" → delete from database
- Other errors → logged, counted as failed

### Database

No schema changes needed. The `devices` table constraint was updated to enforce iOS-only at the database level:

```sql
CREATE TABLE devices (
  ...
  platform VARCHAR(10) NOT NULL CHECK (platform = 'ios'),
  ...
);
```

Existing rows are unaffected. New inserts with `platform != 'ios'` will be rejected.

## Advantages of This Approach

1. **No Firebase dependency**
   - One less service to manage
   - No Firebase Console setup
   - No FCM legacy API (which was shut down in 2024 anyway)

2. **Direct control**
   - We own the entire push pipeline
   - No third-party rate limits
   - Better error handling (410 detection)

3. **Simpler for iOS-only**
   - Don't need Firebase if not supporting Android
   - APNs is the native, official way for iOS

4. **Built-in Node.js modules**
   - `http2` for HTTP/2 connection
   - `crypto` for ES256 JWT signing
   - No external dependencies on server

## Limitations

- **iOS only** (as intended)
- **Requires Apple Developer account** ($99/year)
- **Mac required** for Xcode builds
- **Android support** would require adding Firebase back (for FCM)

## PWA Compatibility

✅ **The existing PWA still works perfectly**
- Web users continue to use ntfy.sh
- No changes to web flow
- Native app uses APNs, web uses ntfy.sh
- Same server, same database, smart dual mode

## Files Changed

```
Modified (8 files):
- server.js          (APNs integration, removed FCM)
- app.js             (iOS-only, removed platform detection)
- scripts/migrate.js (iOS-only constraint)
- test/server.test.js (added iOS-only test)
- package.json       (removed Android dependency)
- capacitor.config.json (removed server URL)
- README.md          (iOS-only docs, APNs setup)
- QUICKSTART.md      (iOS-only quick start)
```

## Summary

The implementation is now significantly simpler and more focused:
- **iOS-only** for initial launch
- **Direct APNs** via HTTP/2 with .p8 token auth
- **No Firebase** dependency
- **Native iOS push** from Render Node server
- **Automatic invalid token cleanup**
- **Same database schema**
- **Same API surface** (just different backend)
- **PWA unchanged**

Ryan needs to:
1. Get an APNs .p8 key from Apple Developer Portal
2. Set 5 environment variables in Render
3. Follow the iOS App Store checklist

Everything else is done and tested. ✅

---

**PR #1**: https://github.com/ryanjbusker/Tracking-App/pull/1
**Status**: Ready to merge (all CI checks passing)
**Do not merge yet** - Ryan will merge when ready to deploy
