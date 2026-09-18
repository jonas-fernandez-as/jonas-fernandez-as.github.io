---
title: "Cardputer + Evil Portal — The WiFi Attack That Fits in a Pocket"
description: "A €60 handheld that runs a captive portal on any network. How the technique works, why it lands disproportionately in regions where public WiFi is a daily necessity, and the defenses that actually hold up."
date: 2026-05-22
type: "Technique · Wireless"
category: "Hardware"
difficulty: "Beginner"
readingTime: 20
video: "https://youtu.be/rMFTSheO37E"
tags: [cardputer, evil-portal, captive-portal, wifi, phishing, m5stack]
---

## The premise

The captive portal is one of the internet's most normalized security exceptions. When you join a hotel WiFi, an airport network, a café's guest network, a train, a shopping mall, or an airplane, you are shown a page before you get online. The page asks for your room number, your email, your loyalty card, your boarding pass, or — sometimes — nothing at all. You accept the terms and you are online.

Every part of that experience trains you to do the same thing: connect to an unfamiliar WiFi network, trust whatever page appears, and enter information without checking where it goes. The captive portal is a legitimate security mechanism that has been so thoroughly normalized that the presence of an unverified login page on an unfamiliar network no longer triggers any suspicion at all.

The Evil Portal attack exploits exactly this normalization. An attacker broadcasts a WiFi network that looks like a legitimate one, and when the victim connects, they are shown a captive portal — a fake login page that looks exactly like the ones they have seen a hundred times. The page captures whatever the victim types. The victim, having learned from years of using public WiFi that this is just how it works, enters their credentials without hesitation.

What makes this technique particularly relevant in 2026 is that the hardware to do it now costs under €100 and fits in a pocket. The M5Stack Cardputer is a small handheld device — a keyboard, a screen, and an ESP32 chip — and with the right firmware it becomes a portable Evil Portal that can be deployed anywhere in seconds.

This writeup covers the Cardputer, the technique, why it lands disproportionately in certain regions, and — most importantly — how to defend against it.

## Part one — the Cardputer

The M5Stack Cardputer is a pocket-sized computer released in 2024. Its specifications are modest by any modern standard but impressive for the size and price:

- **CPU:** ESP32-S3, dual-core Xtensa LX7, 240 MHz
- **RAM:** 8 MB PSRAM, 512 KB SRAM
- **Flash:** 8 MB
- **Display:** 1.14-inch IPS, 240x135 pixels
- **Keyboard:** 56 keys, physical, with a backlight
- **Wireless:** WiFi 802.11 b/g/n (2.4 GHz only), Bluetooth 5.0
- **Battery:** 1200 mAh, approximately 4 to 6 hours of runtime
- **Size:** Roughly 84mm x 54mm x 15mm — smaller than a deck of cards
- **Price:** Around €60 from M5Stack or resellers

The device is designed as a general-purpose microcontroller platform — you can program it in MicroPython, C++, or use one of several pre-built firmware images. The form factor makes it useful as a portable terminal, a remote control, a sensor hub, or, in the case of this writeup, a wireless attack platform.

The important thing about the Cardputer is not that it is uniquely capable. An ESP32 dev board costs €5 and can do the same thing. The Cardputer's advantage is that it looks like a consumer gadget. It has a keyboard and a screen. It sits in a pocket. It does not look like attack hardware — it looks like a novelty electronic device or a small retro computer. That is not a technical advantage. It is a social one.

## Part two — the Evil Portal attack

A captive portal is a network access mechanism. When a device connects to a WiFi network that uses a captive portal, the network intercepts the device's first HTTP request and redirects it to a page that must be completed before full network access is granted. This is how hotels collect room numbers, how airports collect emails, and how cafés show their terms of service.

The mechanism relies on a few standard behaviors:

1. **The network broadcasts an SSID.** The device sees the network name in its WiFi list.
2. **The device connects.** No authentication, or a shared password, or an open network.
3. **The device makes an HTTP request.** Usually the operating system itself makes a probe request to test internet connectivity — Apple devices request `captive.apple.com`, Android devices request `connectivitycheck.android.com`, Windows requests `msftconnecttest.com`.
4. **The network intercepts and redirects.** The request is answered with a redirect to the captive portal page.
5. **The device displays the captive portal.** Either in a mini-browser (on mobile) or the full browser (on desktop).
6. **The user fills out the form.** And is granted network access.

The Evil Portal attack replaces the legitimate captive portal with a fake one. The attacker broadcasts an SSID — often something plausible like "Free WiFi", "Hotel_Guest", "Starbucks", or the name of a nearby legitimate network — and runs a captive portal that looks exactly like a legitimate login page. The victim connects, is shown the fake page, and enters whatever the page asks for.

The page can request anything:

- **Email and password** — phrased as "sign in with your account to access the internet"
- **Social media credentials** — "log in with Facebook to continue"
- **Credit card details** — "enter a card for verification" (rare, but it happens)
- **Two-factor codes** — "enter the code we just sent you" (a more sophisticated variant)
- **Personal information** — name, phone, address, date of birth

The victim fills out the form, hits submit, and the attacker captures the credentials. The page then either redirects to a legitimate-looking success page, or shows an error and prompts them to try again (a technique to capture multiple attempts or to buy time).

## Part three — why the Cardputer makes this practical

The technique itself is not new. Evil Portal attacks have been documented since at least 2015, and tools like `wifiphisher` have automated the process on Linux laptops for years. The Cardputer changes the economics and the portability in three ways.

**Size and battery.** A laptop running `wifiphisher` is a laptop. It has to be open, on, powered, and physically present. A Cardputer is a small device that fits in a pocket, runs on battery for hours, and can be left in a bag, on a table, or in a coat pocket while it broadcasts. The attack surface can be deployed in situations where a laptop would be conspicuous.

**Cost.** A laptop is several hundred euros. A Cardputer is €60. The barrier to entry for someone who wants to experiment with the technique is much lower. This is not necessarily a good thing — it means more people can try it, including people who should not.

**Firmware ecosystem.** The Cardputer runs several community firmware images that include Evil Portal functionality out of the box. The most relevant are:

- **Bruce Firmware** — a multi-tool firmware that includes WiFi attacks, BLE attacks, IR, and more. Evil Portal is one of its modules.
- **Marauder** — originally designed for the ESP32-based Flipper Zero add-on, but ported to several ESP32 platforms including the Cardputer.
- **Evil Portal specific firmware** — standalone implementations that do only the portal attack.

These firmware images are open source, actively maintained, and installable via the standard M5Stack flashing tools. The setup process is documented in the project READMEs and takes about fifteen minutes.

## Part four — the attack flow in detail

Understanding the attack requires understanding what happens from the victim's perspective and what happens behind the scenes.

**The attacker's side.** The Cardputer is flashed with firmware that supports the Evil Portal module. The attacker loads an HTML file that represents the fake login page. This file can be anything — a template for a Google login, a Facebook login, a corporate Microsoft 365 login, a generic "network access" form. The templates are widely available in the community, and someone with basic HTML and CSS knowledge can create a plausible facsimile of any login page in an hour.

The Cardputer boots, starts the Evil Portal module, and broadcasts an SSID. When a device connects, the Cardputer runs a DNS server that responds to every DNS query with its own IP address. It runs an HTTP server that serves the fake page. Any request the victim's device makes — to `google.com`, `facebook.com`, or a captive portal probe URL — is redirected to the fake page.

**The victim's side.** The victim's device sees a WiFi network. The name is plausible. The victim connects. The operating system probes for internet connectivity and gets a redirect to the fake page. The operating system displays the fake page in a captive portal mini-browser.

The victim sees a login form that looks like Google's, or like their corporate SSO, or like the hotel's "welcome" page. They fill it in. The credentials are captured by the Cardputer.

**The capture.** The captured credentials are stored on the Cardputer's flash memory. Some implementations display them on the device's screen. Some log them to a file. Some can transmit them over the network (to an attacker-controlled server) or via Bluetooth (to a nearby attacker device). The implementation varies, but the result is the same: the credentials leave the victim's control.

## Part five — why this lands in specific regions

The technique works everywhere. Its effectiveness varies by context, and the context is worth understanding.

**Where public WiFi is a daily necessity.** In regions where mobile data is expensive, slow, or unreliable, public WiFi is not a convenience — it is infrastructure. People use it to work, to communicate, to access banking, to check email. The frequency of legitimate captive portal experiences is high, which means the normalization is deeper. A user who has seen fifty captive portals in the last year has stopped paying attention to them.

**Where corporate security training is less common.** In regions where the average user has not received security awareness training, the baseline of suspicion is lower. This is not a judgment of individuals — it is a structural fact. Countries with mature security training programs (Nordics, Germany, parts of North America) have users who at least know that phishing exists. Countries where this training is not standard have users who have never heard the term.

**Where the language and cultural cues match.** An attacker who runs an Evil Portal in Spanish, targeting users in Spain or Latin America, with a portal that mimics a local bank, ISP, or social media platform, has a much higher success rate than an attacker who runs an English-language portal against a non-English audience. The portal can be perfectly tailored to its target audience.

**Where the hardware is available.** Cardputer and similar devices are available globally, but the firmware ecosystem, community, and tutorials are disproportionately in Spanish and Portuguese. This means that someone in Latin America who wants to experiment with the technique has more resources available than someone in, say, Japan or Korea.

None of these factors is deterministic. The technique works everywhere, and attackers use it everywhere. But the density of successful attacks is higher in certain contexts, and those contexts share the properties above.

## Part six — what this is not

It is worth being honest about the limitations of the technique.

**It requires proximity.** The victim must physically be in range of the Cardputer's WiFi signal. This is typically 30-50 meters in open space, less through walls. The attacker must be in the same general area as the victim for the duration of the attack.

**It requires the victim to connect.** The attacker cannot force the victim's device to connect to the fake network. The victim must choose to join. In areas where the victim's device is set to auto-join known networks, this is easy — the attacker picks an SSID that the victim already trusts. In areas where the victim has to manually select, the attacker relies on the plausibility of the SSID name.

**It requires the victim to enter information.** The technique does not steal credentials from the air. It captures them because the victim types them into the fake page. A victim who refuses to enter information on a captive portal — or who uses a VPN, which makes the captive portal unreachable — is not affected.

**It is detectable.** The technique leaves traces on the network and on the device, and the defenses exist. They are just not universally deployed.

**It is not new.** Evil Portal attacks have been used in real-world campaigns for years. The Cardputer is a new delivery vehicle for an old technique.

## Part seven — detection

From a network or organizational perspective, the detection opportunities fall into several categories.

**Rogue AP detection.** A WiFi intrusion detection system (WIDS) monitors the radio spectrum for suspicious access points. A WIDS configured to flag new SSIDs, duplicate SSIDs (same name as a legitimate network, different MAC address), or unauthorized APs on the corporate network catches Evil Portal attacks reliably. The caveat is that WIDS is typically deployed on corporate campuses, not in cafés and public spaces where the technique is most effective.

**DNS hijack detection.** The Evil Portal works by hijacking DNS — every query is answered with the attacker's IP. On a client that uses encrypted DNS (DoH or DoT) with a pinned resolver, the hijack fails and the captive portal does not appear. Browsers that implement their own DoH (Firefox by default in some configurations, Chrome with specific settings) detect this automatically because the DNS query goes through their resolver, not the attacker's.

**Certificate warnings.** A fake login page served over HTTP does not have a valid certificate for the domain it claims to represent. If the victim's browser checks — Chrome and Firefox both flag this aggressively — the attack is caught at the moment the victim sees the page. The reason the technique works is that captive portals bypass this check by rendering in a special mini-browser that does not show the URL. Forcing users to use a real browser (which shows the URL and certificate) defeats this.

**Captive portal probe inspection.** When a device connects to a captive portal, it makes a probe request to a well-known URL (`captive.apple.com`, `connectivitycheck.android.com`, etc). A network sensor that inspects these probes can distinguish a legitimate captive portal from a fake one based on the response pattern. This is a specialized detection and not widely deployed outside of enterprise environments.

**User reports.** A user who notices that their credentials did not work, or that the page looked slightly wrong, or that the network is asking for information it does not normally ask for, may report the incident. This is the last line of defense and the least reliable, but it is sometimes the only signal.

## Part eight — defense

The controls that actually work, ordered by effectiveness:

**Use a VPN.** A VPN encrypts all traffic before it leaves the device. When a device connects to an Evil Portal network with a VPN active, the VPN client cannot reach its server — because the captive portal is intercepting all traffic. The VPN client either fails to connect (alerting the user) or the captive portal cannot serve its page (because the VPN is blocking). Either way, the attack does not land. This is the single most effective defense.

**Use encrypted DNS.** DNS-over-HTTPS or DNS-over-TLS with a pinned resolver prevents the DNS hijack that makes the Evil Portal work. Firefox implements this by default in the US and can be enabled elsewhere. Chrome has DoH settings. Setting these on all devices is a strong mitigation.

**Do not auto-join open networks.** Devices configured to auto-join known open networks are vulnerable to SSID spoofing — the attacker broadcasts a network with the same name as a trusted network and the device connects automatically. Disabling auto-join for open networks (or for all networks not explicitly configured) removes this attack surface.

**Do not enter credentials on captive portals.** If a captive portal asks for a password — for an email, a social media account, a corporate account — do not provide it. Legitimate captive portals ask for room numbers, loyalty cards, and email addresses. They do not ask for your Gmail password. A user who knows this rule is immune to the credential-harvesting version of the attack (though not to the "this is just a fake network" version that asks for any information at all).

**Use a password manager.** Password managers only autofill on recognized domains with valid certificates. A fake login page does not have the correct domain, and a password manager will not autofill. A user who relies on a password manager and never types credentials manually is largely immune to the technique.

**Verify the network name with staff.** In an unfamiliar environment — a hotel, an airport, a café — ask the staff what the official WiFi network name is. If the network you see does not match, do not connect. This costs thirty seconds and eliminates the SSID-plausibility attack.

**For organizations: enforce device management policies.** MDM policies can enforce VPN, encrypted DNS, and specific network connection rules on managed devices. A corporate laptop that follows these policies is not vulnerable to Evil Portal attacks.

**For individuals: educate yourself on the specific pattern.** The Evil Portal attack is a specific technique with a specific signature — an unfamiliar WiFi network that immediately asks for credentials. Knowing the pattern is the difference between recognizing it and falling for it.

## Part nine — the ethics

The Cardputer and Evil Portal firmware are open source, and both are legitimate tools for red teaming, security research, and educational demonstrations. The techniques they implement are documented publicly.

The technique becomes an attack when it is used against people without authorization. This is not a gray area:

- **In a red team engagement,** the client has authorized testing. The attacker (the red teamer) has a scope document, a legal agreement, and a liability structure. Everything is documented and disclosed after the engagement.
- **In a security research context,** the technique is tested in a lab, against volunteers, or in an isolated environment. No real credentials are captured, or captured credentials are destroyed immediately after analysis.
- **In a criminal context,** the technique is deployed in public spaces against unwitting victims. The credentials are used or sold. This is wire fraud, identity theft, and computer intrusion in most jurisdictions, with penalties ranging from fines to prison.

There is no version of "I was just experimenting" that applies when the target has not consented. Curiosity is not a defense. The Cardputer is a tool. Like all tools, its use is defined by the user's intent and the consent of those affected.

## Part ten — the broader lesson

The Evil Portal attack works because it exploits a specific learned behavior: connecting to unfamiliar WiFi networks and trusting whatever page appears. This behavior is not a bug in any individual user's judgment. It is a rational response to a system that has trained users to do exactly this for two decades.

The defensive lesson is that authentication protocols and password policies are downstream of the assumptions users have about what is and is not trustworthy. The Evil Portal breaks one of those assumptions — that a captive portal is a legitimate mechanism — and no amount of password complexity helps when the user types their password into a page they should not have trusted.

The fix is not better passwords. It is better defaults: VPN always on, encrypted DNS enforced, autofill from a password manager, auto-join disabled. These defaults protect users regardless of whether they are paying attention at any given moment. They are what makes the difference between a technique that works and a technique that does not.

The Cardputer makes the attack portable and cheap. The defenses make it ineffective. The gap between them is the security posture of the target.

## Takeaway

A €60 handheld device can host a captive portal that steals credentials from anyone who joins it and enters them. The technique is old, the delivery mechanism is new, and the results are consistent: users connect, users trust, users type.

The reason this matters more in some regions than others is not a difference in intelligence or caution. It is a difference in how often a person has had to use public WiFi as infrastructure rather than convenience, and how much training they have received to recognize the pattern. Both are structural, not individual.

The defenses are cheap and effective. A VPN, encrypted DNS, a password manager, and a policy of not auto-joining open networks make the attack pointless. The users who have these are protected. The users who do not are the ones who will connect, trust, and type.

The technology is not the problem. The defaults are.
