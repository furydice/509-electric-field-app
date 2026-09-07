# Native Cloudflare header origin repair

This source-only change is staged from `android-platform` commit `170c363e98f1c8c6f06685d03a2df8b3d5c905de` in a separate worktree. The saved Field App checkout, endpoint configuration, credentials, installed apps and Mission Control processes are unchanged.

The previous JavaScript fetch/image guards searched URL text for a hostname. A hostname in an unrelated URL's query/path or an attacker-controlled suffix could therefore receive the wrapper's Cloudflare headers. Swift navigation used a substring host match. Android's native GET guard checked the host but omitted scheme/port, and its HTTP connection automatically followed redirects.

The canonical generators are `codemagic.yaml` and `scripts/prepare-ios-local.sh`; ignored generated `android/` and `ios/` directories are not the review source.

## Updated behavior

- JavaScript resolves fetch/image URLs against `document.baseURI` and stamps only the exact HTTPS origin `https://automation.509electric.com`, including explicit default port 443. It rejects userinfo, different hosts/subdomains/suffixes, HTTP, other ports, malformed escapes, control characters and backslashes. Relative service routes remain supported when their resolved origin is allowed. Unstamped external requests pass through unchanged.
- Header objects, tuples, `Headers` and inherited `Request` headers are copied through the standard `Headers` normalization. Explicit option headers replace inherited request headers. Method/body/signal/credentials and other caller options remain intact; the caller's objects are not mutated.
- For stamped fetches, the default and explicit `follow` redirect mode become `error`. Existing `manual` and `error` behavior remains. This deliberate restriction prevents custom headers being forwarded before the wrapper can inspect the destination. The source review found no current MC browser fetch consumer requiring redirects; auth uses JSON errors and explicit page navigation. A protected image/API that starts redirecting will fail visibly rather than forward these credentials. Ordinary navigation and unstamped requests keep their existing behavior.
- Swift navigation checks parsed scheme/host/userinfo/port and keeps the original navigation request when adding headers. Android native GET redirects are handled manually, with each destination checked before opening a connection and a maximum of five hops. Rejected or failed protected GET requests return an unavailable response. Cloudflare login recovery is restricted to HTTPS Cloudflare Access hosts and a validated MC reload destination.

## Validation and limits

Run `npm test` for the existing API 36 generator regression and network-free tests of extracted canonical JavaScript with synthetic headers. These tests do not read credentials or contact Cloudflare. Generated native-source assertions and YAML/shell syntax checks complement the executed JavaScript behavior; they are not Java/Swift compilation or native security certification.

Java/Swift compilation, WKWebView redirect/header propagation, Android WebView behavior, XHR/native plugin traffic, installed binary provenance and physical-device Cloudflare authentication remain unverified here. The patch does not introduce an XHR interceptor or proxy. In particular, Swift's initial-navigation predicate is source-reviewed; a real WKWebView redirect trace is still required to establish what the platform forwards. The installed old wrappers still benefit from the separately accepted MC header-record compatibility patch.

## Next delivery step

Review the separate patch and artifact hashes before publishing/integrating this source, consuming hosted build quota, or uploading/releasing an app; those delivery actions require authorization. Local syntax checks, temporary generation/compilation and reversible synthetic verification remain authorized when the required tools are available. A device session requires the normal real-device preflight and a safe test identity. No native build, device session or delivery action was taken for this repair. Credential values must stay in the existing protected build configuration and out of logs/receipts. Device checks must verify accepted origin requests and rejected decoys/redirects without printing real headers.

Real MC account rollout and the pending Office visibility decision remain separate from this native source repair. Brenda onboarding remains deferred. The accepted 152-path MC package is preserved.
