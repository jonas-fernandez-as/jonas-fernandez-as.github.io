---
title: "Nmap Essentials"
description: "The scans I actually run on an engagement — discovery, port enumeration, service detection, and NSE scripts."
category: "Recon"
tools: [nmap]
updated: 2026-04-10
tags: [recon, network, discovery]
---

## Discovery

Fast host discovery without port scanning (no root needed):

```bash
nmap -sn 10.10.10.0/24
```

Full TCP SYN scan on all ports — the standard first pass:

```bash
sudo nmap -p- --min-rate 5000 -T4 -oA nmap/allports 10.10.10.100
```

## Service detection

Once you know which ports are open, deep-scan those:

```bash
sudo nmap -sCV -p 22,80,445,5985 -oA nmap/services 10.10.10.100
```

- `-sC` — run default NSE scripts
- `-sV` — detect versions
- The combination is faster than separate passes.

## UDP

UDP scans are slow. Target the common ones first:

```bash
sudo nmap -sU --top-ports 50 --min-rate 500 -oA nmap/udp 10.10.10.100
```

Most common UDP services: DNS (53), SNMP (161), NTP (123), NetBIOS (137-138).

## NSE scripts worth running

Vulnerability check on a web host:

```bash
nmap --script http-vuln-* -p 80,443 10.10.10.100
```

SMB enumeration (very useful for AD):

```bash
nmap --script smb-enum-shares,smb-enum-users,smb-os-discovery -p 445 10.10.10.100
```

EternalBlue check (legacy but still common in labs):

```bash
nmap --script smb-vuln-ms17-010 -p 445 10.10.10.100
```

## Output formats

Always use `-oA <basename>`. It writes three files: `.nmap` (normal), `.gnmap` (grep-friendly), `.xml` (importable into Metasploit, Faraday, etc).

```bash
nmap -sCV -p- --min-rate 5000 -T4 -oA nmap/full 10.10.10.100
```

## Common gotchas

- **`--min-rate` too high** on a rate-limited target causes false negatives. If a scan looks too clean, lower it.
- **`-T4` is fine in labs, risky in production.** Use `-T2` or `-T3` on real engagements.
- **SYN scans need root.** If you cannot sudo, `-sT` (TCP connect) works without root but is slower.
