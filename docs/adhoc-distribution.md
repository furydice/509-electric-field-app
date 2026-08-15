# Ad Hoc distribution — getting the app onto crew iPads without Apple review

Status: **config ready, blocked on two decisions** (UDID collection, IPA delivery).

## Why this path exists

External TestFlight is hard-blocked. `POST /v1/betaAppReviewSubmissions` returns
`422 ENTITY_UNPROCESSABLE.BETA_CONTRACT_MISSING` even though every agreement
(Paid Apps, Free Apps, bank, W-9, DSA) shows **Active**. Apple Developer Support
case **20000138361635** was opened 2026-08-15 to have the beta contract record
restored. Until Apple fixes it, no build can reach the external "Testers" group.

Ad Hoc sidesteps Apple entirely: no App Review, no beta review, no contract.
The `ios-adhoc` workflow in `codemagic.yaml` already builds a correctly-signed
Ad Hoc IPA and shares the same build scripts as `ios-testflight` (YAML anchor
`*ios_build_scripts`), so it automatically inherits any shell/web changes.

## What it costs you

| | Ad Hoc | TestFlight external | Unlisted App Store |
|---|---|---|---|
| Apple review | none | beta review (blocked) | full App Review |
| Build lifetime | profile valid **1 year** | **90 days**, then re-upload | no expiry |
| Device limit | **100 per device type per membership year** | 10,000 testers | unlimited |
| Adding a device | requires **re-signing and redistributing** | just invite by email | nothing |
| Delivery | you host it (MDM or OTA page) | TestFlight app | App Store link |

The killer detail: **an Ad Hoc profile only covers devices registered at build
time.** Every new hire means registering the UDID and pushing a fresh IPA to
everyone. That is why this is the fallback, not the destination.

## Prerequisite 1 — collect UDIDs (undecided)

Zero devices are currently registered. iOS does **not** show the UDID anywhere
in Settings, so it has to be extracted. Options, best first:

1. **Host a `.mobileconfig` on Mission Control.** The device installs a
   configuration profile which POSTs its UDID back to an MC endpoint. This is
   how every commercial UDID service works. Keeps employee device identifiers
   inside our own infrastructure, and the crew just taps a link. Needs a small
   MC route to serve the profile and record the callback.
2. **USB into a Windows PC.** iTunes / Apple Devices app shows the identifier
   when you click the serial number field. Reliable, but needs every iPad
   physically in hand.
3. **Third-party UDID site.** Fastest, zero build effort — but it hands the
   crew's device identifiers to an outside party. Not recommended for company
   devices without a reason.

Option 1 is the right answer if this becomes the long-term path; option 2 is
fine for a one-off if the iPads pass through the shop anyway.

## Prerequisite 2 — deliver the IPA (undecided)

Codemagic surfaces the IPA as a downloadable artifact; it does not install it.
An `.ipa` file cannot simply be emailed and tapped. You need either:

- **MDM (Mosyle or similar)** — the workflow comment already assumes this. Push
  the IPA to enrolled devices. Cleanest, and worth it if the fleet keeps growing.
- **OTA manifest page** — host a `manifest.plist` plus the IPA over HTTPS and
  link with `itms-services://`. Mission Control already serves HTTPS through the
  tunnel and can host both. No MDM licence, but you maintain the page yourself.

## Once both are settled

1. Register every UDID: developer.apple.com → Certificates, Identifiers &
   Profiles → **Devices** → add each one. **Do this before building** —
   `xcode-project use-profiles` bakes in whichever devices exist at build time.
2. Run the **iOS Ad Hoc** workflow in Codemagic (`ios-adhoc`).
3. Download the IPA artifact from the build page.
4. Distribute via whichever delivery method was chosen above.
5. On each device, first launch requires trusting the enterprise signature if
   prompted: Settings → General → VPN & Device Management.

## Gotchas

- The device limit resets only at **membership renewal**, and removing a device
  mid-year does not free the slot until then. With 11 crew that is not close to
  binding, but do not burn slots on test devices.
- The Ad Hoc profile expires **one year** after issue. Diary a rebuild.
- Ad Hoc builds still point at `https://automation.509electric.com/app`
  (`capacitor.config.json`), so they depend on Mission Control being up exactly
  as the TestFlight builds do. See `ops/mc-boot-start.ps1`.
- If Apple restores the beta contract, **prefer TestFlight** and let this path
  lapse. It is strictly more maintenance.
