---
title: "Browser-into-Browser — Session Theft Without a Fake Login Page"
description: "A phishing technique that runs a real Firefox inside a Docker container, redirects the victim through a hosts file modification, and steals the authenticated session — no cloned login page, no certificate warning, no URL to spot."
date: 2026-05-02
type: "Technique · Session Hijacking"
category: "Social Engineering"
difficulty: "Intermediate"
readingTime: 20
video: "https://youtu.be/BSGiMLLo8BM"
tags: [phishing, session-hijacking, docker, mitm, red-team, hosts-file, tls]
---

## Why classic phishing has a ceiling

Twenty years of security awareness training have produced a generation of users who, at minimum, glance at the URL bar before typing a password. The training is imperfect and most users do not follow it consistently, but the ceiling is real. Cloned login pages on `g00gle.com`, `faceb00k-login.net`, or `microsoft-support-login.com` are caught by a growing fraction of targets, and the ones that aren't caught are increasingly caught by the browser itself — Chrome and Firefox flag suspicious domains, password managers refuse to autofill on unrecognized hosts, and MFA prompts from an unexpected location raise the alarm.

Every one of those defenses rests on the same assumption: **the domain in the URL bar is the domain the user intended to visit.** Phishing works by breaking that assumption — either by making the URL look similar enough to fool the eye, or by tricking the user into ignoring it. Both approaches are fragile. The first relies on typosquatting, which is increasingly detected by browsers. The second relies on user inattention, which is not reliable at scale.

Browser-into-browser breaks the assumption in a different way. Instead of making the URL look correct, it makes the URL *be* correct. The victim visits the real domain, sees the real page, and authenticates with the real service. The trick is that between the victim's browser and the real service, an attacker-controlled Firefox instance is doing the actual work — and when the login finishes, the session belongs to the attacker.

This writeup covers the technique end to end: the setup, the attack flow, why TLS does not break, and the specific detection opportunities that make it catchable.

## Part one — the core idea

The premise of browser-into-browser is that the attacker owns a second browser session running on infrastructure they control, and they find a way to make the victim's browser talk to it instead of the real service.

Concretely:

1. The attacker runs a Firefox instance inside a Docker container on a VPS they control.
2. The attacker redirects the victim's DNS resolution of a target domain (say, `mail.google.com`) to the container's IP.
3. The victim's browser connects to the container, which proxies the request to the real `mail.google.com` — running in the container's own Firefox, with the victim's cookies stored there.
4. The victim sees the real Google login page. They type their credentials. The session cookies are set **on the container's Firefox**, not on the victim's browser.
5. The attacker copies the container's Firefox profile, starts a new Firefox instance pointing at it, and now has an authenticated session that belongs to the victim.

The critical detail is step 3: the container's Firefox is not a fake Google. It is a real Firefox talking to real Google, with the real page rendered through a proxy mechanism. The victim's browser sees a valid TLS connection to `mail.google.com` — because, from the browser's perspective, it is connected to `mail.google.com`.

The subtlety that makes this work is that the victim's browser and the container's Firefox are two separate clients. The victim's browser is talking to the container. The container's Firefox is talking to Google. There is no MITM in the classical cryptographic sense — no certificate substitution, no CA compromise, no warning.

## Part two — the Docker setup

The container runs Firefox in a mode that allows remote interaction. There are several ways to do this, and the choice affects both the attacker's workflow and the detectability of the technique.

**Option A — VNC on top of Xvfb.** A minimal Ubuntu image with `xvfb`, `firefox`, and a VNC server like `x11vnc`. The container runs Firefox inside a virtual framebuffer, and the attacker connects via VNC to interact with it. The port exposed to the internet is the VNC port (usually 5900). A `socat` proxy or a reverse proxy in front can expose the same content on port 80 or 443 for the victim.

**Option B — Remote debugging protocol.** Firefox supports the Chrome DevTools Protocol via `--remote-debugging-port`, and while the Firefox implementation differs, it can be controlled over a network. The attacker scripts the interaction through the debugging API instead of a VNC session. This is more reliable but more complex to set up.

**Option C — Custom reverse proxy.** The most flexible option. A Python or Go service running inside the container that accepts HTTP and HTTPS requests from the victim, forwards them to the real service, renders the responses in a headless Firefox instance inside the container, and returns the rendered content. This is essentially a browser-based proxy — the victim's requests are executed by the container's Firefox, not by the victim's browser.

Option C is the cleanest from an attack perspective, because it lets the container handle arbitrary sites without needing per-site configuration. It is also the most work to implement. For a demonstration, Option A is usually enough.

The container needs to be reachable at the IP that the victim will be redirected to. In a lab, this is a local IP. In a real attack, it would be a VPS with a public IP. The VPS does not need a domain name that resolves to the real service — the attacker relies entirely on the victim's hosts file modification, not on DNS.

## Part three — the hosts file modification

This is the delivery step. The attacker needs write access to the victim's machine before the attack can proceed, and specifically to `/etc/hosts` (Linux, macOS) or `C:\Windows\System32\drivers\etc\hosts` (Windows).

The modification itself is trivial. A single line:

```
192.0.2.42    mail.google.com
```

Where `192.0.2.42` is the attacker's container IP. From this point forward, every DNS lookup for `mail.google.com` on the victim's machine resolves to the attacker's host, regardless of what the actual DNS server returns.

The technique requires prior access for this reason. It is not an initial-access vector — it is a post-compromise technique used to escalate from "attacker can run code on the machine" to "attacker has access to the victim's email and possibly every other logged-in session".

Common ways the attacker gets write access:

- **Phishing with a malicious payload.** The victim clicks a link, downloads something, runs it, and the payload modifies the hosts file. The payload may then remove itself, leaving only the hosts file modification behind.
- **Malicious browser extension.** The PoC from the previous project — a browser extension that exfiltrates cookies — is one path. A slightly more sophisticated extension that modifies the hosts file via `nativeMessaging` or via a helper binary is another.
- **Physical access.** Less relevant for remote attacks, but the technique works equally well if the attacker has physical access and a few seconds of the user's unlocked session.
- **Remote access tool.** Any RAT or C2 implant that includes a "modify file" primitive.

The modification is durable across reboots — the hosts file survives. It is also undetectable to the user, because they have no reason to open the file. A user who has spent their life never looking at `C:\Windows\System32\drivers\etc\hosts` will continue never looking at it.

## Part four — what the victim sees

The victim opens their browser, navigates to `mail.google.com`, and gets the login page. The page renders normally. The URL bar shows `mail.google.com`. The padlock shows a valid certificate for `mail.google.com`. The layout, fonts, and interactive elements are correct — because the page is being rendered by a real Firefox instance that fetched the real page from Google.

The victim enters their credentials. Google's login flow proceeds as expected: username, password, possibly a 2FA prompt. If the victim has MFA configured, the prompt appears on their device (phone, security key) and they approve it. The login succeeds.

At no point does the victim see anything wrong. The page is the real Google. The certificate is the real certificate. The URL is the real URL. Every check the user has been trained to perform passes.

Behind the scenes, the session cookies — `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, and the `__Secure-` variants — are being set on the container's Firefox, not on the victim's browser. From Google's perspective, the login happened from the attacker's IP, with a browser fingerprint that is not the victim's, but the session is valid. Google does not know that a proxy sits between the victim and the login form.

The victim's own browser session, meanwhile, is a proxy session. It may or may not have its own cookies set — depending on how the proxy is implemented — but those cookies are not the ones that matter. The attacker has the authenticated session, and can replay it from any machine.

## Part five — why TLS does not break

This is the part that surprises people the most, and it deserves a careful explanation.

In a classical man-in-the-middle attack, the attacker intercepts the TLS handshake between the client and the server. To read the traffic, the attacker must either present their own certificate (which the client rejects unless the CA is trusted) or compromise the CA. Neither is easy.

Browser-into-browser sidesteps this entirely by not performing a MITM in the cryptographic sense. There are two separate TLS connections:

1. **Victim's browser to the container.** The victim's browser connects to the container at `192.0.2.42:443`, with SNI set to `mail.google.com`. The container responds with a certificate. If the container uses a certificate signed by a trusted CA for `mail.google.com`, the browser accepts it. If the container does not have such a certificate, the browser shows a warning.

2. **Container's Firefox to Google.** The container's Firefox connects to `mail.google.com` at the real Google IP. This is a normal TLS connection with a valid Google certificate. The container terminates this connection and re-encrypts the content for the victim.

The question is: how does the container get a valid certificate for `mail.google.com`?

There are three answers:

- **Let's Encrypt with DNS-01 challenge.** If the attacker controls the DNS resolution for the domain (which they do, in a sense, because they are redirecting the victim's lookup), they can obtain a valid certificate for `mail.google.com` via a DNS-01 challenge. This works if the attacker can control the DNS response for the ACME challenge, which is possible when the attacker controls the victim's resolution path.
- **A wildcard certificate for a domain that looks similar.** This only works if the victim does not look carefully — but in this technique, the whole point is that they do not need to.
- **A certificate from a CA that the victim's browser trusts.** This is harder in 2026 — CT logs make certificate issuance public, and a certificate for `mail.google.com` issued to anyone other than Google would be caught immediately.

The most realistic implementation uses Option 1: Let's Encrypt via DNS-01. The attacker controls the victim's resolution, obtains a certificate for the target domain, and the browser accepts it because it is a valid certificate issued by a trusted CA.

This means the padlock is green. There is no warning. The user has no indication that anything is wrong.

## Part six — session capture and replay

Once the victim has authenticated, the attacker has access to the container's Firefox profile. The profile directory — typically `~/.mozilla/firefox/<random>.default-release/` — contains:

- **`cookies.sqlite`** — the cookie store, including all session cookies for the logged-in domains.
- **`logins.json`** — saved passwords, encrypted with the OS keyring (or a master password, if set).
- **`key4.db`** — the encryption key for `logins.json`.
- **`places.sqlite`** — browsing history.
- **`sessionstore-backups/`** — recent tabs and windows.

For the purpose of session hijacking, `cookies.sqlite` is the target. The attacker copies this file, starts a new Firefox instance with the copied profile, and navigates to `mail.google.com`. The cookies are sent automatically. Google sees a request from the attacker's IP with a valid session cookie and grants access.

The technique does not require cracking any password. The victim's password is never captured in a form the attacker can read — the credential exchange happened between the container's Firefox and Google, over TLS. What the attacker gets is the *post-authentication* state, which is more valuable and does not require MFA to replay.

This is the fundamental weakness of cookie-based session management. The session token is a bearer token — anyone who holds it can use it. Google's defenses against this involve binding the session to a device fingerprint or to a coarse network signature, but those defenses are imperfect because legitimate users travel and change devices.

## Part seven — variations and extensions

The technique can be extended in several directions:

**Multi-target.** The container's Firefox can hold sessions for multiple services simultaneously. The attacker can configure the hosts file to redirect `mail.google.com`, `facebook.com`, `linkedin.com`, `github.com`, and any other service the victim uses, all to the same container. Each service is proxied independently. When the victim logs in to each one, the attacker captures all sessions.

**Credential capture.** If the container's Firefox is configured to save passwords (not just cookies), the attacker can also capture the raw credentials. This requires the victim to accept the "save password?" prompt, which is not guaranteed but common.

**Token theft.** Modern login flows often use OAuth tokens or SAML assertions. The container can capture those as well, either by extracting them from the request/response flow or from the browser's storage (IndexedDB, `sessionStorage`).

**Reverse proxy transparency.** A more sophisticated implementation uses a transparent reverse proxy that does not modify the page content, so the victim's browser sees exactly the same bytes as the real service. The container's Firefox fetches the page, the proxy forwards the bytes, and the victim's browser renders them identically. This requires care around HTTP/2 and WebSocket connections, but it is achievable.

## Part eight — detection: endpoint side

The hosts file is the single point of failure for the attacker, and the single point of detection for the defender.

**File integrity monitoring.** The hosts file rarely changes. On a normal machine, modifications happen during specific events — installing a VPN client, changing DNS settings, running a specific administrative tool. Between those events, the file should be static. Any modification outside a known change window is a lead.

On Linux, `auditd` can watch `/etc/hosts` for write events. On Windows, Sysmon Event ID 11 (`FileCreate`) and 2 (`FileCreateTime` for the file itself) capture modifications, though the hosts file specifically requires explicit configuration — it is not watched by default.

**DNS resolution discrepancy.** If the endpoint resolves `mail.google.com` to an IP that does not belong to Google's published ranges, that is not a routing issue. It is an attack. Comparing the endpoint's resolution against a trusted resolver (a corporate DNS or a public DoH resolver) detects this reliably.

**Browsers connecting to private IPs.** A browser connecting to a `10.x.x.x`, `172.16-31.x.x`, or `192.168.x.x` address on port 443 with SNI for a public domain is anomalous in almost every environment. Exceptions exist (some corporate proxies, some test setups), but the base rate of true positives is high.

**Certificate pinning anomalies.** If the endpoint's browser reports a certificate for a domain that does not match the CA chain normally associated with that domain, that is a lead. Most EDRs do not natively collect this, but it is derivable from browser telemetry if collected.

## Part nine — detection: network side

Network detection is harder, because the technique does not produce obviously malicious traffic. However, three patterns stand out:

**SNI versus IP geo.** The victim's browser sends TLS Client Hello with SNI for `mail.google.com`. If the destination IP is not in Google's ASN or geolocation range, that is anomalous. This requires flow data with SNI extraction, which is standard in most modern NDR products.

**Multiple services resolving to the same IP.** If `mail.google.com`, `facebook.com`, and `github.com` all resolve to the same IP from the same endpoint, the pattern is obvious in aggregation. A single connection to a VPS hosting multiple proxied services is not normal for a typical user.

**Traffic volume and timing.** The container proxies traffic between the victim and the real service. If the victim's browser makes a request, the container makes a request, and the container's request goes out to Google — but with different timing and different byte sizes than a direct connection. This is subtle and not always useful, but in aggregate with other signals it helps.

## Part ten — defense

The controls that actually work against this technique:

**Monitor the hosts file.** This is the single most effective control. Any modification outside a known change window is worth investigating. On Windows, Group Policy can enforce a baseline hosts file and alert on modifications. On Linux, `auditd` provides reliable write monitoring.

**Enable DNS-over-HTTPS with strict resolvers.** Firefox and Chrome both support DoH with a pinned resolver. When enabled, the browser bypasses the hosts file entirely for its own resolution. This is not a complete defense — some services still resolve via the OS resolver — but it raises the bar significantly.

**Use a password manager with domain binding.** Password managers that refuse to autofill on an unrecognized TLS fingerprint or mismatched IP catch the technique even if they cannot see the hosts file. 1Password, Bitwarden, and Keeper all have some form of this feature.

**Bind sessions to device fingerprints.** Service-side, Google and other major providers bind sessions to a device fingerprint or a coarse network signature. This makes stolen cookies less useful from a different host. It is imperfect — legitimate users travel — but it raises the cost.

**Endpoint hardening.** The technique requires write access to a system file. Any attacker who has that access has compromised the endpoint. The prerequisite defense is hardening the endpoint so the access is never obtained — patched software, endpoint protection, and user training.

**Physical and session discipline.** The technique also works with physical access — an attacker with a few seconds at an unlocked machine can modify the hosts file. Locking the screen when leaving the desk is the counter.

## Part eleven — the ethics

The technique is the same one that has been used in real-world campaigns against journalists, activists, and corporate executives. It is also the same technique that a red team uses during an authorized engagement to demonstrate the value of endpoint monitoring.

The tools do not distinguish between these uses. The context does.

The professional position: this technique belongs in the offensive toolkit only when it is being used to test the defenses of an organization that has authorized the test. Using it against individuals without consent — regardless of the technical plausibility — is a criminal act in most jurisdictions, and a violation of professional ethics regardless of jurisdiction.

This is stated explicitly because the technical writeup alone does not carry the ethical weight. The technique is powerful precisely because it is hard to detect. That power is a responsibility.

## Takeaway

Browser-into-browser works because it attacks a layer that most defenders do not think about: DNS resolution on the endpoint. Every "check the URL" training module, every password manager that autofills by domain, every browser warning about suspicious sites — all of it rests on the assumption that the URL bar reflects the truth.

The assumption is wrong. The URL bar reflects what DNS resolved, and DNS on the endpoint is a file that any process with write access can modify.

The right response is not to tell users to check the URL more carefully. The right response is to monitor the file that determines what the URL resolves to — and to treat any modification outside a known change window as the intrusion it is.
