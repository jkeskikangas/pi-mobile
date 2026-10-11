#!/usr/bin/env bash
# Simulator end to end (PiUITests, scheme PiE2E) against the `npm run ui` fixture hub: web UI loads, the voice
# button opens the native voice screen (basic voice, End returns), dictation reaches `transcribe`, and the
# menu's Notifications row comes from the app. Screenshots go to shots/e2e/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
PORT="${PORT:-7993}"
DEST="${DEST:-platform=iOS Simulator,name=iPhone 16}"
LOG="$(mktemp)"; FIFO="$(mktemp -u)"; mkfifo "$FIFO"
(cd "$ROOT" && exec node --experimental-strip-types --no-warnings test/ui/fixture.ts "$PORT" <"$FIFO" >"$LOG" 2>&1) &
FIX=$!
exec 3>"$FIFO"
trap 'kill $FIX 2>/dev/null || true; exec 3>&-; rm -f "$FIFO"' EXIT
for _ in $(seq 50); do grep -q "#p=" "$LOG" && break; sleep 0.2; done
LINK="$(grep -o "http://127.0.0.1:$PORT/#p=[^ ]*" "$LOG" | head -1 || true)"
[ -n "$LINK" ] || { echo "fixture printed no 127.0.0.1 link:"; cat "$LOG"; exit 1; }
mkdir -p shots/e2e
xcodegen -q
TEST_RUNNER_PI_PAIR_LINK="$LINK" TEST_RUNNER_E2E_SHOTS="$PWD/shots/e2e" xcodebuild test -project Pi.xcodeproj -scheme PiE2E \
  -destination "$DEST" -derivedDataPath "${DERIVED:-build}" 2>&1 | grep -E "error:|Test Case|Executed|\*\* TEST" | tail -20
n=$(grep -c '^transcribe ' "$LOG" || true)
echo "fixture transcribe calls: $n"; grep '^transcribe ' "$LOG" || true
[ "$n" -ge 2 ] || { echo "expected a transcribe call for the tap and the hold take"; exit 1; }
