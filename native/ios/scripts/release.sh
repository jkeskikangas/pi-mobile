#!/usr/bin/env bash
# Archive the app and upload it to App Store Connect (TestFlight first, then review). APP_STORE.md has the
# whole checklist. Usage:
#   DEVELOPMENT_TEAM=ABCDE12345 PI_BUNDLE_PREFIX=com.example [PI_PUSH=YES] scripts/release.sh <build number>
# The build number (CFBundleVersion) must be higher than every build already uploaded for this version.
# Signing is automatic: Xcode needs to be signed in to the team's account (Xcode → Settings → Accounts),
# or pass App Store Connect API key flags through XCODEBUILD_AUTH (e.g. "-authenticationKeyPath …
# -authenticationKeyID … -authenticationKeyIssuerID …").
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD="${1:-}"
[[ "$BUILD" =~ ^[0-9]+(\.[0-9]+)*$ ]] || { echo "usage: DEVELOPMENT_TEAM=… PI_BUNDLE_PREFIX=… $0 <build number>"; exit 2; }
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your 10-character team ID}"
: "${PI_BUNDLE_PREFIX:?set PI_BUNDLE_PREFIX to the reverse-DNS prefix of your bundle IDs, e.g. com.example}"
PI_PUSH="${PI_PUSH:-NO}"

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
# shellcheck disable=SC2086
xcodebuild archive -project Pi.xcodeproj -scheme Pi -configuration Release \
  -destination generic/platform=iOS -archivePath "$ARCHIVE" -allowProvisioningUpdates ${XCODEBUILD_AUTH:-} \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" PI_BUNDLE_PREFIX="$PI_BUNDLE_PREFIX" PI_PUSH="$PI_PUSH" \
  CURRENT_PROJECT_VERSION="$BUILD"

APP="$ARCHIVE/Products/Applications/Pi.app"
[ -f "$APP/PrivacyInfo.xcprivacy" ] || { echo "PrivacyInfo.xcprivacy is missing from the app"; exit 1; }
if /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads" "$APP/Info.plist" >/dev/null 2>&1; then
  echo "Info.plist has NSAllowsArbitraryLoads; App Review will ask about it"; exit 1
fi

echo "Uploading to App Store Connect…"
# shellcheck disable=SC2086
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OPTS" -exportPath "$OUT/export-$BUILD" \
  -allowProvisioningUpdates ${XCODEBUILD_AUTH:-}
echo "Uploaded build $BUILD. It shows in App Store Connect → TestFlight after processing (usually 5–30 minutes)."
