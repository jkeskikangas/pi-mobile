#!/usr/bin/env bash
# Emulator end to end (app/src/androidTest AppE2ETest) against the `npm run ui` fixture hub: the web UI loads,
# the voice button opens the native voice screen after the consent sheet (basic voice, End returns), dictation
# reaches `transcribe` (tap and hold), and the menu's Notifications row comes from the app. Screenshots go to
# shots/e2e/. Needs one running emulator or device (adb); the port is forwarded with `adb reverse`.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
PORT="${PORT:-7994}"
APP=dev.pi_mobile.app
LOG="$(mktemp)"; FIFO="$(mktemp -u)"; mkfifo "$FIFO"
# exec: $FIX is node itself, so the trap stops the fixture and not just a subshell.
(cd "$ROOT" && exec node --experimental-strip-types --no-warnings test/ui/fixture.ts "$PORT" <"$FIFO" >"$LOG" 2>&1) &
FIX=$!
exec 3>"$FIFO"
trap 'kill $FIX 2>/dev/null; wait $FIX 2>/dev/null || true; exec 3>&-; rm -f "$FIFO"; adb reverse --remove tcp:$PORT >/dev/null 2>&1 || true' EXIT
for _ in $(seq 50); do grep -q "#p=" "$LOG" && break; sleep 0.2; done
LINK="$(grep -o "http://127.0.0.1:$PORT/#p=[^ ]*" "$LOG" | head -1 || true)"
[ -n "$LINK" ] || { echo "fixture printed no 127.0.0.1 link:"; cat "$LOG"; exit 1; }

./gradlew -q assembleDebug assembleDebugAndroidTest
adb install -r -t app/build/outputs/apk/debug/app-debug.apk >/dev/null
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
adb reverse tcp:"$PORT" tcp:"$PORT" >/dev/null
# A first run: the test answers the microphone dialog itself.
adb shell pm revoke "$APP" android.permission.RECORD_AUDIO 2>/dev/null || true
adb shell rm -rf "/sdcard/Android/data/$APP/files/e2e"
OUT="$(adb shell am instrument -w -e piPairLink "$LINK" -e class "$APP.AppE2ETest" "$APP.test/androidx.test.runner.AndroidJUnitRunner")"
echo "$OUT" | tail -5
rm -rf shots/e2e && mkdir -p shots/e2e
adb pull "/sdcard/Android/data/$APP/files/e2e/." shots/e2e >/dev/null || true
ls shots/e2e
echo "$OUT" | grep -q "^OK (1 test)" || { echo "AppE2ETest failed"; exit 1; }
n=$(grep -c '^transcribe ' "$LOG" || true)
echo "fixture transcribe calls: $n"; grep '^transcribe ' "$LOG" || true
[ "$n" -ge 2 ] || { echo "expected a transcribe call for the tap and the hold take"; exit 1; }
