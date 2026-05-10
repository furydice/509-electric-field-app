#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR="$ROOT_DIR/build/simulator"
DERIVED_DATA_DIR="$ROOT_DIR/build/DerivedData"
mkdir -p "$ARTIFACT_DIR"

bash scripts/prepare-ios-local.sh | tee "$ARTIFACT_DIR/prepare.log"

if [[ -n "${IOS_SIMULATOR_ID:-}" ]]; then
  SIM_ID="$IOS_SIMULATOR_ID"
elif [[ -n "${IOS_SIMULATOR_NAME:-}" ]]; then
  SIM_ID="$(xcrun simctl list devices available -j | ruby -rjson -e '
    name = ENV.fetch("IOS_SIMULATOR_NAME")
    devices = JSON.parse(STDIN.read).fetch("devices").values.flatten
    sim = devices.find { |d| d["name"] == name && d["isAvailable"] != false }
    abort("No available simulator named #{name}") unless sim
    puts sim.fetch("udid")
  ')"
else
  SIM_ID="$(xcrun simctl list devices available -j | ruby -rjson -e '
    devices = JSON.parse(STDIN.read).fetch("devices").values.flatten
    sim = devices.find { |d| d["name"].to_s.include?("iPhone") && d["state"] == "Booted" && d["isAvailable"] != false } ||
          devices.find { |d| d["name"].to_s.include?("iPhone") && d["isAvailable"] != false }
    abort("No available iPhone simulator found") unless sim
    puts sim.fetch("udid")
  ')"
fi

echo "Using simulator: $SIM_ID"
xcrun simctl boot "$SIM_ID" 2>/dev/null || true
xcrun simctl bootstatus "$SIM_ID" -b
open -a Simulator 2>/dev/null || true

xcodebuild \
  -workspace "ios/App/App.xcworkspace" \
  -scheme "App" \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -derivedDataPath "$DERIVED_DATA_DIR" \
  CODE_SIGNING_ALLOWED=NO \
  build | tee "$ARTIFACT_DIR/xcodebuild.log"

APP_PATH="$(find "$DERIVED_DATA_DIR/Build/Products/Debug-iphonesimulator" -maxdepth 2 -name "*.app" -print -quit)"
if [[ -z "$APP_PATH" ]]; then
  echo "Could not find built .app under $DERIVED_DATA_DIR/Build/Products/Debug-iphonesimulator"
  exit 1
fi

xcrun simctl uninstall "$SIM_ID" com.fiveohninelectric.field 2>/dev/null || true
xcrun simctl install "$SIM_ID" "$APP_PATH"
xcrun simctl launch "$SIM_ID" com.fiveohninelectric.field | tee "$ARTIFACT_DIR/launch.log"

sleep "${IOS_SIMULATOR_SMOKE_WAIT:-20}"
(
  cd "$ARTIFACT_DIR"
  xcrun simctl io "$SIM_ID" screenshot launch.png
)
xcrun simctl spawn "$SIM_ID" log show --last 2m --style compact > "$ARTIFACT_DIR/device.log" 2>/dev/null || true

echo "Simulator smoke complete."
echo "Screenshot: build/simulator/launch.png"
echo "Logs: build/simulator/*.log"
