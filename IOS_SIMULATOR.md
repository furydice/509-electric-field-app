# iOS Simulator Smoke Test

Apple's official iOS Simulator is only included with Xcode on macOS. From a Windows machine, use Codemagic's macOS build machine to run the simulator smoke test.

## Windows Run

Use this path from Windows:

1. Push the wrapper repo changes to the branch Codemagic builds from.
2. Open Codemagic.
3. Run the `iOS Simulator Smoke` workflow.
4. Download the artifacts after the build finishes:
   - `build/simulator/launch.png`
   - `build/simulator/prepare.log`
   - `build/simulator/xcodebuild.log`
   - `build/simulator/launch.log`
   - `build/simulator/device.log`

The workflow uses the existing `CF_Access` environment group, builds the Capacitor iOS wrapper on a cloud Mac, injects the Cloudflare Access headers into the WebView, launches the app in an iPhone simulator, and captures a screenshot.

The normal `iOS TestFlight` workflow is still the upload path for real iPhones through TestFlight.

## Local Mac Run

Only use this section if you later have access to a Mac. Set the Cloudflare Access service token values, then prepare and launch the app:

```bash
cd 509-field-app
export CF_CLIENT_ID="..."
export CF_CLIENT_SECRET="..."
npm install
npm run ios:sim
```

The script builds the Capacitor iOS wrapper, injects the Cloudflare Access headers into the WebView, launches the app in the first available iPhone simulator, and saves:

- `build/simulator/launch.png`
- `build/simulator/prepare.log`
- `build/simulator/xcodebuild.log`
- `build/simulator/launch.log`
- `build/simulator/device.log`

To pick a specific simulator:

```bash
IOS_SIMULATOR_NAME="iPhone 16 Pro" npm run ios:sim
```

## Codemagic Run

Run the `iOS Simulator Smoke` workflow. It uses the existing `CF_Access` environment group and uploads the simulator screenshot and logs as artifacts.

The normal `iOS TestFlight` workflow is still the upload path for TestFlight.
