#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR="$ROOT_DIR/build/simulator"
DERIVED_DATA_DIR="$ROOT_DIR/build/DerivedData"
mkdir -p "$ARTIFACT_DIR"

bash scripts/prepare-ios-local.sh | tee "$ARTIFACT_DIR/prepare.log"

select_simulator() {
  local kind="$1"
  local requested_name="$2"
  xcrun simctl list devices available -j | SIM_KIND="$kind" REQUESTED_NAME="$requested_name" ruby -rjson -e '
    kind = ENV.fetch("SIM_KIND")
    requested = ENV.fetch("REQUESTED_NAME", "")
    devices = JSON.parse(STDIN.read).fetch("devices").values.flatten
      .select { |d| d["isAvailable"] != false }
    match = kind == "iphone" ? /iPhone/i : /iPad/i
    candidates = devices.select { |d| d["name"].to_s.match?(match) }
    sim = if requested.empty?
      candidates.find { |d| d["state"] == "Booted" } || candidates.last
    else
      candidates.find { |d| d["name"] == requested } ||
        candidates.find { |d| d["name"].to_s.include?(requested) }
    end
    abort("No available #{kind} simulator#{requested.empty? ? "" : " matching #{requested}"}") unless sim
    puts sim.fetch("udid")
  '
}

IPHONE_ID="${IOS_IPHONE_SIMULATOR_ID:-}"
IPAD_ID="${IOS_IPAD_SIMULATOR_ID:-}"
if [[ -z "$IPHONE_ID" ]]; then
  IPHONE_ID="$(select_simulator iphone "${IOS_IPHONE_SIMULATOR_NAME:-}")"
fi
if [[ -z "$IPAD_ID" ]]; then
  IPAD_ID="$(select_simulator ipad "${IOS_IPAD_SIMULATOR_NAME:-}")"
fi

printf 'iPhone simulator: %s\niPad simulator: %s\n' "$IPHONE_ID" "$IPAD_ID" | tee "$ARTIFACT_DIR/devices.txt"

xcodebuild \
  -workspace "ios/App/App.xcworkspace" \
  -scheme "App" \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED_DATA_DIR" \
  CODE_SIGNING_ALLOWED=NO \
  build | tee "$ARTIFACT_DIR/xcodebuild.log"

APP_PATH="$(find "$DERIVED_DATA_DIR/Build/Products/Debug-iphonesimulator" -maxdepth 2 -name "*.app" -print -quit)"
if [[ -z "$APP_PATH" ]]; then
  echo "Could not find built .app under $DERIVED_DATA_DIR/Build/Products/Debug-iphonesimulator"
  exit 1
fi

capture_stable_screenshot() {
  local sim_id="$1"
  local output_path="$2"
  local reference_path="${3:-}"
  local attempt

  for attempt in 1 2 3 4; do
    xcrun simctl io "$sim_id" screenshot --type=png "$output_path"
    test -s "$output_path"
    if [[ -n "$reference_path" ]] \
      && swift scripts/check-simulator-screenshot.swift "$output_path" "$reference_path"; then
      return 0
    elif [[ -z "$reference_path" ]] \
      && swift scripts/check-simulator-screenshot.swift "$output_path"; then
      return 0
    fi

    mv "$output_path" "${output_path%.png}-unstable-${attempt}.png"
    echo "Screenshot was not fully rendered; retrying in 15 seconds."
    sleep 15
  done

  echo "No stable rendered screenshot was captured for $output_path."
  exit 1
}

smoke_device() {
  local label="$1"
  local sim_id="$2"
  local wait_seconds="${IOS_SIMULATOR_SMOKE_WAIT:-20}"

  echo "Testing $label simulator: $sim_id"
  xcrun simctl boot "$sim_id" 2>/dev/null || true
  xcrun simctl bootstatus "$sim_id" -b
  open -a Simulator 2>/dev/null || true

  # A clean install makes the first launch a true cold start.
  xcrun simctl uninstall "$sim_id" com.fiveohninelectric.field 2>/dev/null || true
  xcrun simctl install "$sim_id" "$APP_PATH"
  xcrun simctl launch --terminate-running-process "$sim_id" com.fiveohninelectric.field \
    | tee "$ARTIFACT_DIR/${label}-launch.log"
  sleep "$wait_seconds"
  capture_stable_screenshot "$sim_id" "$ARTIFACT_DIR/${label}-launch.png"

  xcrun simctl spawn "$sim_id" log show --last 3m --style compact \
    --predicate 'process == "App"' > "$ARTIFACT_DIR/${label}-device.log" 2>/dev/null || true
  if grep -Eiq 'Terminating app due to uncaught exception|Fatal error|SIGABRT|EXC_CRASH' "$ARTIFACT_DIR/${label}-device.log"; then
    echo "Native crash signature found on $label."
    exit 1
  fi

  # Verify an ordinary terminate/relaunch path after the clean-install launch.
  xcrun simctl terminate "$sim_id" com.fiveohninelectric.field 2>/dev/null || true
  xcrun simctl launch "$sim_id" com.fiveohninelectric.field \
    | tee "$ARTIFACT_DIR/${label}-relaunch.log"
  sleep "$wait_seconds"
  capture_stable_screenshot \
    "$sim_id" \
    "$ARTIFACT_DIR/${label}-relaunch.png" \
    "$ARTIFACT_DIR/${label}-launch.png"

  xcrun simctl spawn "$sim_id" log show --last 3m --style compact \
    --predicate 'process == "App"' > "$ARTIFACT_DIR/${label}-relaunch-device.log" 2>/dev/null || true
  if grep -Eiq 'Terminating app due to uncaught exception|Fatal error|SIGABRT|EXC_CRASH' "$ARTIFACT_DIR/${label}-relaunch-device.log"; then
    echo "Native crash signature found after relaunch on $label."
    exit 1
  fi
}

smoke_device iphone "$IPHONE_ID"
smoke_device ipad "$IPAD_ID"

echo "Simulator smoke complete."
echo "Screenshots: build/simulator/iphone-*.png and build/simulator/ipad-*.png"
echo "Logs: build/simulator/*.log"
