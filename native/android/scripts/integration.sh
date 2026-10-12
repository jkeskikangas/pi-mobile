#!/usr/bin/env bash
# Runs FixtureHubIntegrationTest (a JVM test) against the `npm run ui` fixture hub (plans/native-android.md
# Step 2). Starts the fixture on a spare port, passes its pairing link to the test, and types `ask` into it
# every few seconds so a prompt is waiting to be answered. No emulator needed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
PORT="${PORT:-7995}"
FIFO="$(mktemp -u)"; mkfifo "$FIFO"
LOG="$(mktemp)"
# exec: $FIX is node itself, so the trap stops the fixture and not just a subshell.
(cd "$ROOT" && exec node --experimental-strip-types --no-warnings test/ui/fixture.ts "$PORT" <"$FIFO" >"$LOG" 2>&1) &
FIX=$!
exec 3>"$FIFO"
ASK=
trap '{ kill $FIX $ASK; wait; } 2>/dev/null || true; exec 3>&-; rm -f "$FIFO" "$LOG"' EXIT
for _ in $(seq 50); do grep -q "#p=" "$LOG" && break; sleep 0.2; done
LINK="$(grep -o "http://127.0.0.1:$PORT/#p=[^ ]*" "$LOG" | head -1 || true)"
[ -n "$LINK" ] || { echo "fixture printed no 127.0.0.1 link:"; cat "$LOG"; exit 1; }
(while sleep 4; do echo ask >&3; done) & ASK=$!
./gradlew testDebugUnitTest --tests '*FixtureHubIntegrationTest*' -PpiPairLink="$LINK" --rerun -q
RESULT="app/build/test-results/testDebugUnitTest/TEST-dev.pi_mobile.app.core.FixtureHubIntegrationTest.xml"
# A skipped test would pass silently: insist that it ran.
if grep -q "<skipped" "$RESULT"; then echo "FixtureHubIntegrationTest was skipped"; exit 1; fi
grep -o '<testsuite [^>]*>' "$RESULT"
