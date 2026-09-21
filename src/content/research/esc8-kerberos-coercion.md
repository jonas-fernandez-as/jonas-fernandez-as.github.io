---
title: "ESC8, PetitPotam and the Magic DNS — Chaining NTLM Relay to AD CS"
description: "How to escalate from any domain credential to Domain Admin by coercing the DC to authenticate, relaying that authentication to Active Directory Certificate Services, and extracting a certificate for the machine account. A deep dive into the AD CS misconfiguration that requires no template abuse."
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

The technique works like this: coerce a high-value target (a Domain Controller, a Certificate Authority, an Exchange server) into authenticating to an attacker-controlled host, relay that authentication to the AD CS web enrollment endpoint, and request a certificate on behalf of the coerced account. If the target is a Domain Controller, the resulting certificate grants the ability to perform DCSync and extract every credential in the domain.

This article covers the mechanism behind the chain. It assumes familiarity with NTLM authentication, Kerberos, and Active Directory basics. For the full engagement that used this technique end to end, see the [VulnCicada report →](/projects/vulncicada-ad-compromise).

## Part one — what ESC8 actually is

ESC8 is one of the eight AD CS escalation paths documented in the Certified Pre-Owned whitepaper (SpecterOps, 2021). The eight paths (ESC1 through ESC8) describe distinct misconfigurations in AD CS that allow an attacker to obtain a certificate that grants elevated privileges. Most of them (ESC1-ESC7) depend on a certificate template that is misconfigured in a specific way — for example, a template that allows the enrollee to supply a subject alternative name (ESC1), or a template that allows enrollment without manager approval for a privileged context (ESC3).

ESC8 is different. It does not depend on any template misconfiguration. It abuses the web enrollment endpoint — the IIS-hosted interface that allows users to request certificates through a browser.

The endpoint exposes a set of ASP pages (`certfnsh.asp`, `certcrs.asp`, `certnew.cer`, and others) that handle the enrollment flow. By default, these endpoints accept several authentication methods, including NTLM. If the endpoint is exposed over HTTP (not HTTPS), an attacker who can capture a legitimate NTLM authentication from a high-value target can forward it to the endpoint and request a certificate on behalf of that target.

The certificate template used for enrollment determines what the resulting certificate can do. The most damaging choice is the `DomainController` template — a default template available on virtually every AD CS installation — which produces a certificate that authenticates as the Domain Controller machine account.

## Part two — why NTLM authentication on a web endpoint is dangerous

The web enrollment endpoint uses IIS's authentication stack. When configured with Windows Authentication (NTLM), the endpoint authenticates the requester based on the NTLM challenge-response exchange. This is the same primitive that SMB uses, but running over HTTP.

NTLM relay exploits this by separating the two halves of the exchange:

1. **The challenge** — the server (in this case, the coerced DC) sends an NTLM challenge to whoever is authenticating.
2. **The response** — the client (the attacker, in the relay scenario) forwards a valid response.

The attacker never learns the password. The endpoint never knows the request came from a different source. The security boundary that NTLM relay breaks is the assumption that the challenge and the response come from the same network context. In practice, that assumption has never been true on a network where an attacker can position themselves between the two — which is the entire premise of a relay attack.

The reason AD CS is such a rich target for this is that the resulting authentication can be turned into a certificate, and the certificate can be turned into a Kerberos ticket. Every step in that chain is a legitimate AD mechanism. There is no signature that says "this certificate was obtained via relay" — the CA issues it as a normal enrollment.

## Part three — why Kerberos does not protect you here

A common defensive posture is to disable NTLM authentication for SMB. This is good practice. It eliminates a large class of attacks: SMB relay, Pass-the-Hash over SMB, and various protocol downgrade techniques. The domain in the engagement behind this article has NTLM disabled for SMB — the authentication is Kerberos-only, and SMB signing is enabled and required.

None of that stops this attack.

Three reasons:

**1. Kerberos password spraying is unaffected.** The attacker sprays Kerberos AS-REQ messages at the KDC (port 88). The KDC validates them independently of NTLM settings. If a password is weak, the spray succeeds, and the attacker obtains a valid TGT — the entire foothold — without touching NTLM at all.

**2. NTLM on non-SMB protocols is unaffected.** The AD CS web enrollment endpoint accepts NTLM as an HTTP authentication method. Disabling NTLM for SMB does not disable it for IIS or for any other service. The endpoint does not care that SMB is Kerberos-only; it only cares that the request presents a valid NTLM challenge-response.

**3. Coercion triggers authentication regardless of NTLM policy.** PetitPotam calls the MS-EFSRPC interface (`EfsRpcOpenFileRaw`) on a target. The target authenticates to the UNC path supplied by the attacker. The authentication method (NTLM or Kerberos) depends on what the target attempts and what the attacker's listener accepts. If the target falls back to NTLM — which it does in default configurations — the relay succeeds.

The lesson is that a defense implemented at one layer is not a defense at another. Disabling NTLM for SMB is a filter. Disabling NTLM everywhere — including IIS, LDAP, and any other service that accepts it — is a defense. Very few organizations do the latter.

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

- **NTLM authentication over HTTP** — if the environment has a network sensor, this is a high-signal pattern. Legitimate NTLM over HTTP is rare outside of internal IIS applications.
- **certipy-ad relay signatures** — the tool sends a specific POST request structure to the CA. Network monitoring for the specific path and payload format catches the relay in progress.

## Part seven — remediation

The remediation for this chain has three layers, ordered by impact.

**Layer 1 — Remove the ESC8 vulnerability.**

This is the direct fix. It eliminates the entire chain.

- **Disable HTTP web enrollment entirely** if it is not required. This is the cleanest fix; there is no reason to expose the enrollment endpoint over HTTP.
- **If web enrollment is required, enforce HTTPS-only** and configure the CA to reject HTTP requests.
- **Enforce Extended Protection for Authentication (EPA)** on the IIS-hosted AD CS web enrollment endpoint. EPA binds the authentication to the TLS channel, which prevents relay. This is the direct mitigation for NTLM relay attacks and is a standard IIS configuration.
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
