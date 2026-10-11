#!/usr/bin/env bash
# Archive the app and upload it to App Store Connect (TestFlight first, then review). APP_STORE.md has the
# whole checklist. Usage:
#   DEVELOPMENT_TEAM=ABCDE12345 PI_BUNDLE_PREFIX=com.example [PI_RELAY_URL=https://…] scripts/release.sh <build number>
# The build number (CFBundleVersion) must be higher than every build already uploaded for this version.
# Signing is automatic: Xcode needs to be signed in to the team's account (Xcode → Settings → Accounts),
# or use an App Store Connect API key: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID (paths may contain spaces).
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD="${1:-}"
[[ "$BUILD" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { echo "usage: DEVELOPMENT_TEAM=… PI_BUNDLE_PREFIX=… $0 <build number>"; exit 2; }
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your 10-character team ID}"
: "${PI_BUNDLE_PREFIX:?set PI_BUNDLE_PREFIX to the reverse-DNS prefix of your bundle IDs, e.g. com.example}"
# The App Store build pushes through the relay (relay/, deployed first; APP_STORE.md → Push).
PI_PUSH="${PI_PUSH:-YES}"
# The deployed relay (relay/); override for your own deployment.
PI_RELAY_URL="${PI_RELAY_URL:-https://pi-push-relay.pi-push-relay.workers.dev}"
[[ "$PI_RELAY_URL" =~ ^https://[^[:space:]?#]+$ ]] || { echo "PI_RELAY_URL must be an https:// address"; exit 2; }
AUTH=()
if [ -n "${ASC_KEY_PATH:-}" ]; then
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "${ASC_KEY_ID:?set ASC_KEY_ID}" -authenticationKeyIssuerID "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}")
fi

# Only ship what is committed: the archive must match a commit someone can check out again.
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes. Commit or stash them first:"; git status --short; exit 1
fi

OUT="${OUT:-build/release}"
ARCHIVE="$OUT/Pi-$BUILD.xcarchive"
mkdir -p "$OUT"
OPTS="$OUT/ExportOptions.plist"
cp ExportOptions.plist "$OPTS"
plutil -replace teamID -string "$DEVELOPMENT_TEAM" "$OPTS"

xcodegen -q
echo "Archiving build $BUILD ($(git rev-parse --short HEAD)) for $PI_BUNDLE_PREFIX.pi, push $PI_PUSH…"
xcodebuild archive -project Pi.xcodeproj -scheme Pi -configuration Release \
  -destination generic/platform=iOS -archivePath "$ARCHIVE" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" PI_BUNDLE_PREFIX="$PI_BUNDLE_PREFIX" PI_PUSH="$PI_PUSH" PI_RELAY_URL="$PI_RELAY_URL" \
  CURRENT_PROJECT_VERSION="$BUILD"

APP="$ARCHIVE/Products/Applications/Pi.app"
[ -f "$APP/PrivacyInfo.xcprivacy" ] || { echo "PrivacyInfo.xcprivacy is missing from the app"; exit 1; }
if /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads" "$APP/Info.plist" >/dev/null 2>&1; then
  echo "Info.plist has NSAllowsArbitraryLoads; App Review will ask about it"; exit 1
fi

echo "Uploading to App Store Connect…"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OPTS" -exportPath "$OUT/export-$BUILD" \
  -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}
echo "Uploaded build $BUILD. It shows in App Store Connect → TestFlight after processing (usually 5–30 minutes)."
