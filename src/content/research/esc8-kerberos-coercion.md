---
title: "ESC8, PetitPotam and the Magic DNS — Chaining Kerberos Relay to AD CS"
description: "How to escalate from any domain credential to Domain Admin by coercing the DC to authenticate, relaying that authentication to Active Directory Certificate Services, and extracting a certificate for the machine account. A deep dive into the AD CS misconfiguration that requires no template abuse — and the Kerberos relay technique that bypasses a domain-wide NTLM block."
date: 2026-09-21
type: "Technique · Active Directory"
category: "Red Team"
difficulty: "Advanced"
readingTime: 15
tags: [esc8, adcs, petitpotam, ntlm-relay, kerberos, active-directory, coercion, magic-dns]
---

## The premise

Active Directory Certificate Services (AD CS) is one of the most under-defended pieces of infrastructure in a Windows domain. It is not part of the standard hardening checklist, it does not appear in most compliance frameworks, and it is frequently deployed with default configurations that are exploitable. The result is a class of vulnerabilities that can escalate any domain credential — including a low-privileged user — to Domain Administrator, sometimes in minutes.

ESC8 is the most dangerous of the eight escalation paths documented in the Certified Pre-Owned whitepaper, not because it is technically complex, but because it does not depend on any certificate template misconfiguration. It abuses the web enrollment endpoint itself — a component that is present on most AD CS deployments and that is exposed by default.

The classic technique works like this: coerce a high-value target (a Domain Controller, a Certificate Authority, an Exchange server) into authenticating to an attacker-controlled host, relay that authentication to the AD CS web enrollment endpoint, and request a certificate on behalf of the coerced account. If the target is a Domain Controller, the resulting certificate grants the ability to perform DCSync and extract every credential in the domain.

The technique in this article is the Kerberos variant. The environment had NTLM disabled domain-wide — a common hardening step that blocks the classic NTLM relay. But disabling NTLM does not disable Kerberos relay, and AD CS accepts Kerberos authentication by default. The result is the same: a certificate for the machine account, and a path to Domain Admin.

This article covers the mechanism behind the chain. It assumes familiarity with NTLM authentication, Kerberos, and Active Directory basics. For the full engagement that used this technique end to end, see the [VulnCicada report →](/projects/vulncicada-ad-compromise).

## Part one — what ESC8 actually is

ESC8 is one of the eight AD CS escalation paths documented in the Certified Pre-Owned whitepaper (SpecterOps, 2021). The eight paths (ESC1 through ESC8) describe distinct misconfigurations in AD CS that allow an attacker to obtain a certificate that grants elevated privileges. Most of them (ESC1-ESC7) depend on a certificate template that is misconfigured in a specific way — for example, a template that allows the enrollee to supply a subject alternative name (ESC1), or a template that allows enrollment without manager approval for a privileged context (ESC3).

ESC8 is different. It does not depend on any template misconfiguration. It abuses the web enrollment endpoint — the IIS-hosted interface that allows users to request certificates through a browser.

The endpoint exposes a set of ASP pages (`certfnsh.asp`, `certcrs.asp`, `certnew.cer`, and others) that handle the enrollment flow. By default, these endpoints accept several authentication methods, including NTLM. If the endpoint is exposed over HTTP (not HTTPS), an attacker who can capture a legitimate NTLM authentication from a high-value target can forward it to the endpoint and request a certificate on behalf of that target.

The certificate template used for enrollment determines what the resulting certificate can do. The most damaging choice is the `DomainController` template — a default template available on virtually every AD CS installation — which produces a certificate that authenticates as the Domain Controller machine account.

## Part two — why Kerberos relay works when NTLM is disabled

The classic ESC8 attack uses NTLM relay. The attacker coerces the DC into authenticating via NTLM, forwards the NTLM challenge-response to the AD CS web enrollment endpoint, and the endpoint authenticates the request as the DC. This works because NTLM relay does not require the attacker to know the password — only to forward a valid challenge-response.

When NTLM is disabled domain-wide, the classic attack is no longer possible. The coerced DC will not generate an NTLM response, because the domain policy tells it not to. This is where most defenders stop thinking about ESC8: "NTLM is disabled, so relay attacks don't work."

That assumption is wrong. Kerberos relay is a separate primitive, and disabling NTLM does not disable it.

Kerberos relay works differently. Instead of relaying an NTLM challenge-response, the attacker relays a Kerberos AP-REQ (Authentication Service Request) — the ticket that a client presents when authenticating to a service. The attacker coerces the DC into authenticating to an attacker-controlled host via SMB, using a Kerberos ticket. The relay server receives the AP-REQ, and forwards it to the AD CS endpoint. If the endpoint accepts Kerberos authentication (it does by default), the relay succeeds.

The reason this works is that the AD CS web enrollment endpoint does not enforce channel binding on Kerberos authentication. Channel binding is a mechanism that ties an authentication to the specific TLS channel it was performed over — if the channel changes, the authentication fails. Without channel binding, the endpoint accepts the relayed AP-REQ as if it came from the original client.

The Kerberos relay primitive is implemented in tools like `krbrelayx` (by Dirk-jan Mollema) and `certipy-ad relay`. The technique exploits how SPN construction and parsing work in Kerberos, combined with the ability to coerce authentication from a high-value target. For the full history and mechanics, the original research on relaying Kerberos is worth reading in full.

## Part three — why disabling NTLM is not enough

Disabling NTLM domain-wide is a strong hardening step. It eliminates a large class of attacks: NTLM relay, Pass-the-Hash, and various protocol downgrade techniques. The domain in the engagement behind this article has NTLM disabled for all inbound authentication — SMB, LDAP, and HTTP — and all tool invocations require Kerberos.

None of that stops this attack.

Two reasons:

**1. Kerberos password spraying is unaffected.** The attacker sprays Kerberos AS-REQ messages at the KDC (port 88). The KDC validates them independently of NTLM settings. If a password is weak, the spray succeeds, and the attacker obtains a valid TGT — the entire foothold — without touching NTLM at all.

**2. Kerberos relay is a separate primitive.** The AD CS web enrollment endpoint accepts Kerberos authentication by default. It does not enforce channel binding on Kerberos, which means an attacker who can capture a Kerberos AP-REQ from a high-value target can relay it to the endpoint and authenticate as that target. Disabling NTLM does not disable Kerberos relay; it only changes which primitive the attacker has to use.

The lesson is that a defense implemented against one primitive is not a defense against a different primitive that achieves the same result. NTLM relay and Kerberos relay are different attacks, and blocking one does not block the other. The only complete defense is to enforce channel binding on the AD CS endpoint — which ties the authentication to the TLS channel and prevents both forms of relay.

## Part four — the Magic DNS trick

The coercion itself is not new. PetitPotam has been public since 2021, and it is not the only coercion primitive — PrinterBug, DFSCoerce, and ShadowCoerce all achieve the same result through different protocols. What makes this particular chain interesting is the DNS name used in the coercion.

In the engagement, the attacker created a DNS record with the name `DC-JPQ2251UWhRCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAAAA` pointing to their own IP. This is not an arbitrary string. It is a base64-encoded structure.

The `1UWhRCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAAAA` suffix carries a **`CREDENTIAL_TARGET_INFORMATION`** structure. This is a Kerberos data structure that tells the client which Service Principal Name (SPN) to request a ticket for when authenticating. By embedding this structure in the DNS name, the attacker causes the coerced DC to request a Kerberos ticket for `HTTP/DC-JPQ225.cicada.vl` — the SPN of the AD CS web enrollment endpoint — instead of the default SPN derived from the DNS name itself.

Without the embedded structure, the DC would authenticate using the DNS name as the SPN, which does not match the AD CS service, and the relay would fail. With it, the DC generates an authentication request that the AD CS endpoint will accept — which is exactly what the attacker needs.

The technique is sometimes called "Magic DNS" because the DNS name itself carries the coercion instructions. It is not a bug in Kerberos or DNS — it is a legitimate feature of the protocol (the ability to specify the target SPN for an authentication) that is being used for an unintended purpose.

### The mechanism in detail

When a Windows client is asked to authenticate to a remote service, it constructs a Kerberos Authentication Service Request (AS-REQ) or a Ticket-Granting Service Request (TGS-REQ) for the target SPN. Normally, the SPN is derived from the service name (e.g., `HTTP`, `CIFS`, `LDAP`) plus the hostname. If the target is a UNC path like `\\server\share`, the SPN is `CIFS/server`.

The `CREDENTIAL_TARGET_INFORMATION` structure allows the caller to override this derivation. When a DNS name contains an embedded `CREDENTIAL_TARGET_INFORMATION`, the Kerberos client parses the structure and uses the SPN specified inside it, not the SPN derived from the hostname. The attacker exploits this by embedding a structure that specifies `HTTP/DC-JPQ225.cicada.vl`.

This means the coerced DC authenticates with an SPN that matches the AD CS service, and the relay to the AD CS endpoint succeeds.

## Part five — the full chain

Bringing the pieces together:

```
[1] Attacker creates a malicious DNS record pointing to their own IP.
    The record name encodes a CREDENTIAL_TARGET_INFORMATION structure
    that specifies the SPN of the AD CS web enrollment endpoint.
    
[2] Attacker launches certipy-ad relay, listening on the AD CS endpoint
    (http://DC-JPQ225.cicada.vl/certsrv/certfnsh.asp).
    
[3] Attacker coerces the DC via PetitPotam (MS-EFSRPC EfsRpcOpenFileRaw).
    The DC authenticates to the malicious DNS record.
    
[4] The DC's authentication is relayed to the CA. The CA authenticates the
    request as the DC machine account and issues a certificate for it
    using the DomainController template.
    
[5] Attacker uses the certificate to obtain a TGT for the DC machine
    account via PKINIT.
    
[6] Attacker performs DCSync (DRSUAPI replication) to extract the
    Administrator password hash and Kerberos keys.
    
[7] Attacker obtains a TGT for Administrator and accesses the DC.
```

Each step is a legitimate use of an AD mechanism. The chain is the attack.

## Part six — detection signals

A SOC monitoring this environment should look for the following signals. None of them is conclusive on its own; the combination is what matters.

**On the CA:**

- **Event ID 4886 / 4887** — certificate issuance events. A certificate issued for `dc-jpq225$` (or any DC machine account) outside a maintenance window is a strong indicator.
- **Event ID 4624** — logon type 3 (network) with the DC's computer account as the subject and the CA's web enrollment service as the target.
- **IIS logs** — POST requests to `/certsrv/certfnsh.asp` from unexpected source IPs.

**On DNS:**

- **New DNS record creation** — Sysmon Event ID 22 (DNS query) combined with a suspicious record name pattern. The `1UWhRCAAAAAA...` suffix is distinctive; a DNS monitoring rule matching the pattern catches every variant.
- **DNS record creation from a non-DNS-server source** — legitimate DNS records are created by DNS administrators. A record created by a regular user account is anomalous.

**On the DC:**

- **PetitPotam-style MS-EFSRPC calls** — Event ID 4648 (explicit credential logon) from a DC to an anomalous target, or Sysmon Event ID 1 for `efsrpc` calls originating from the DC to a workstation.
- **Outbound authentication from the DC to a non-DC host** — the DC should not be authenticating to arbitrary workstations. A 4624 logon event with the DC as the source and a non-DC host as the target is worth investigating.

**On the network:**

- **Kerberos authentication over SMB from the DC to a non-DC host** — a DC authenticating to a workstation via SMB is anomalous. Combined with a relay listener on the attacker side, this is the canonical signal of a Kerberos relay attack.
- **certipy-ad relay signatures** — the tool listens for incoming SMB authentication and forwards it to the CA via HTTP POST to `/certsrv/certfnsh.asp`. Network monitoring for this pattern, especially from an unexpected source, catches the relay.

## Part seven — remediation

The remediation for this chain has three layers, ordered by impact.

**Layer 1 — Remove the ESC8 vulnerability.**

This is the direct fix. It eliminates the entire chain.

- **Disable HTTP web enrollment entirely** if it is not required. This is the cleanest fix; there is no reason to expose the enrollment endpoint over HTTP.
- **If web enrollment is required, enforce HTTPS-only** and configure the CA to reject HTTP requests.
- **Enforce Extended Protection for Authentication (EPA)** on the IIS-hosted AD CS web enrollment endpoint. EPA binds the authentication to the TLS channel, which prevents both NTLM and Kerberos relay. This is the direct mitigation for the entire class of relay attacks and is a standard IIS configuration.
- **Require HTTPS with certificate mapping (Kerberos-only enrollment).** This forces channel binding and prevents relay entirely.

**Layer 2 — Reduce the surface.**

- **Disable NTLM on all domain controllers and member servers** where possible. This is not a complete fix (Kerberos coercion is still possible), but it reduces the number of services that accept NTLM.
- **Block outbound NTLM at the network layer** using firewall rules where possible. This prevents the DC from authenticating to a non-DC host via NTLM.
- **Enable SMB signing and require it** on all systems that accept NTLM authentication.

**Layer 3 — Detect and respond.**

- **Deploy monitoring for the detection signals above.** Even if the vulnerability is not fixed, detection gives the SOC a chance to respond before the attacker performs DCSync.
- **Audit certificate template configurations** for the ESC1-ESC7 variants. A template misconfiguration is a separate attack path with similar impact.
- **Regularly review the CA for unexpected certificates.** A certificate issued for a machine account that has no legitimate reason to have one is a lead.

## Part eight — references and further reading

- **Certified Pre-Owned whitepaper** (SpecterOps, 2021) — the definitive documentation of ESC1-ESC8. Anyone doing AD CS work should read it in full.
- **Microsoft KB5005413** — PetitPotam mitigations.
- **MITRE ATT&CK T1649** — Steal or Forge Authentication Certificates.
- **MITRE ATT&CK T1557** — Adversary-in-the-Middle.
- **Certipy documentation** — the tool used in the engagement. The `relay`, `find`, and `auth` modules cover the full chain.
- **PetitPotam original PoC** (Topotam, 2021) — the coercion primitive.

## Takeaway

ESC8 is the most dangerous of the AD CS escalation paths because it requires no template misconfiguration — it works against the default deployment. The web enrollment endpoint over HTTP with NTLM authentication is present in most AD CS installations, and it is rarely disabled because the standard Windows hardening checklists do not mention it.

The chain in this article — coercion, relay, certificate issuance, DCSync — is a legitimate sequence of AD operations. There is no exploit. The attack succeeds because each step is a normal mechanism that the environment is designed to support, and the defense must be equally layered: remove the ESC8 vulnerability, reduce the NTLM surface, and monitor for the specific signals that this chain produces.

Disabling NTLM for SMB is a good start. It is not the end. The environment behind this article had NTLM disabled for SMB, and the attack still succeeded — because the AD CS web enrollment endpoint accepted NTLM over HTTP, and the coercion triggered authentication regardless of the SMB configuration. The defense has to match the attack's scope, not the portion of it that was easiest to configure.

For the full engagement that used this chain end to end, see the [VulnCicada report →](/projects/vulncicada-ad-compromise).
