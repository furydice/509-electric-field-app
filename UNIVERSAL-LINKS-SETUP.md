# Universal Links — setup checklist

**Goal:** tapping **📱 Open in the 509 App** in a photo email opens the native app
directly on that photo (for anyone with the app installed).

The code is already in place (this branch + Mission Control). These four steps are
the account/dashboard config that only a human with the Apple + Cloudflare logins can
do. Do them in order — each has a quick verify.

---

## ☐ 1. Apple Team ID → Mission Control

The app-site-association file must name the app as `<TeamID>.com.fiveohninelectric.field`.

- Get the Team ID: [developer.apple.com](https://developer.apple.com/account) → **Membership** →
  *Team ID* (10 chars, e.g. `AB12CD34EF`).
- On the MC machine, put it in: `…\mission-control\workspace\ui\state\apple-team-id.txt`
  (just the 10 chars, no quotes/newline fuss).
- Restart MC (the `mc-restart` skill / kill the `:5173` PID).

**Verify:** open `https://automation.509electric.com/.well-known/apple-app-site-association`
— the JSON should show your real Team ID, **not** the literal `TEAMID`.

---

## ☐ 2. Enable "Associated Domains" on the App ID

Without this, the build's code-signing can't attach the entitlement and the IPA build fails.

- [developer.apple.com](https://developer.apple.com/account) → **Certificates, IDs & Profiles**
  → **Identifiers** → `com.fiveohninelectric.field`.
- Under **Capabilities**, check ☑ **Associated Domains**. Save.

**Verify:** the capability shows enabled on the identifier page. (Codemagic's automatic
signing via the ASC API regenerates the profile with it on the next build.)

---

## ☐ 3. Cloudflare Access — BYPASS the AASA path  ⚠️ most common failure

Apple's servers fetch the association file **without logging in**. If Cloudflare Access
gates it, Apple gets a login page instead of JSON and Universal Links **silently never
work** — no error, the link just opens Safari every time.

- Cloudflare dashboard → **Zero Trust → Access → Applications** (for `automation.509electric.com`).
- Add an application/policy covering the path
  `/.well-known/apple-app-site-association` with action **Bypass** (Everyone / public).
  Belt-and-suspenders: bypass `/.well-known/*`.

**Verify:** in a private browser window (no CF login), open
`https://automation.509electric.com/.well-known/apple-app-site-association` — you should
get the raw JSON immediately, **no** Cloudflare login prompt.

---

## ☐ 4. Build, install, tap-test

- Push this branch and merge to `master` (Codemagic builds off `master`, manually).
- Run the **`ios-testflight`** workflow in Codemagic.
- Install the new build from TestFlight on an iPhone **that has the app**.
- Send yourself a photo email from Mission Control (Photos → a photo → ✉ Email → to your
  own address). On the iPhone, tap **📱 Open in the 509 App**.

**Expected:** the app opens straight to that photo in the full-screen viewer.

> First build is also the test of the native injection (entitlement + AppDelegate patch
> + CFViewController deep-link handler in `codemagic.yaml`). If the app opens but doesn't
> jump to the photo, or the link still goes to Safari with the app installed, it's almost
> always step 3 (AASA not publicly readable) — re-check the private-window test first.

---

## How the pieces fit (for future-you)

| Piece | Where |
|---|---|
| Serves the AASA file | Mission Control `server.mjs` (route next to `/app`) |
| Two email buttons (app + web) | MC `routes/projects-onedrive-api.mjs` photo `/email` endpoint |
| `?photo=` auto-opens the viewer | MC `pages/app-shell.html` `_consumePhotoDeepLink` |
| Entitlement + native link handler | `codemagic.yaml` → "Inject Universal Links" step |

The app loads the **remote** site in a WKWebView, so the link is caught in **native Swift**
(`AppDelegate` posts `CF509OpenURL` → `CFViewController` loads the URL with CF headers),
not the `@capacitor/app` JS listener — the remote page has no Capacitor runtime.

Changing the entitlement requires a **fresh build** (no hot-update).
