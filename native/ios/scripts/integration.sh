#!/usr/bin/env bash
# Runs PiIntegrationTests against the `npm run ui` fixture hub (plans/native-apps.md Step 3 item 6).
# Starts the fixture on a spare port, passes its pairing link to the test, and types `ask` into it
# every few seconds so a prompt is waiting to be answered.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
PORT="${PORT:-7989}"
DEST="${DEST:-platform=iOS Simulator,name=iPhone 16}"
FIFO="$(mktemp -u)"; mkfifo "$FIFO"
LOG="$(mktemp)"
(cd "$ROOT" && node --experimental-strip-types --no-warnings test/ui/fixture.ts "$PORT" <"$FIFO" >"$LOG" 2>&1) &
FIX=$!
exec 3>"$FIFO"
trap 'kill $FIX $ASK 2>/dev/null || true; exec 3>&-; rm -f "$FIFO"' EXIT
for _ in $(seq 50); do grep -q "#p=" "$LOG" && break; sleep 0.2; done
LINK="$(grep -o "http://127.0.0.1:$PORT/#p=[^ ]*" "$LOG" | head -1)"
[ -n "$LINK" ] || { echo "fixture printed no 127.0.0.1 link:"; cat "$LOG"; exit 1; }
(while sleep 4; do echo ask >&3; done) & ASK=$!
xcodegen -q
TEST_RUNNER_PI_PAIR_LINK="$LINK" xcodebuild test -scheme Pi -destination "$DEST" -derivedDataPath build \
  -only-testing:PiIntegrationTests 2>&1 | grep -E "error:|Test Case|Executed|\*\* TEST" | tail -20
