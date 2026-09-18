---
title: "Under 60 Seconds — Browser Credential Theft via USB"
description: "A .bat script that weaponizes an unlocked workstation and a USB port — disables Defender, dumps browser credentials with SharpChromium, restores Defender, gone in under a minute. A study of what physical access actually buys an attacker."
date: 2026-04-15
status: "public"
category: "Red Team"
stack: [Batch, C#, Windows, Physical Access, DPAPI]
video: "https://youtu.be/u6x_jeoT1hc"
tags: [red-team, physical-access, credential-theft, dpapi, chrome, usb]
---

## The premise that justifies the project

Modern enterprise security invests heavily in network defenses: EDR, NDR, SIEM, zero trust, microsegmentation. Every one of those controls assumes the attacker is somewhere else — on the network, in the cloud, behind a phish. The endpoint is a fortress. The user is the last line.

An unlocked workstation with a USB port invalidates that entire model in about forty-five seconds.

The interesting part of this project is not the tooling. It is not the code. It is the number: under 60 seconds from insertion to removal. That number is shorter than the time it takes to refill a coffee, and it is the window the technique targets. Any user who leaves their desk for "just a minute" is exposed. Any organization that has not physically disabled USB ports or enforced aggressive screen-lock policies has a hole that no amount of network security closes.

This writeup covers how the technique works, why each step matters, and what the defensive controls actually are — including the ones that people assume work but don't.

## Part one — the attack surface

Before the tooling, the surface. Three facts about Windows that make this possible:

**Windows does not challenge an existing session.** Once a user has logged in, the operating system treats the session as trusted for the duration. Inserting a USB device does not trigger a re-authentication. Running a script does not trigger a re-authentication. Anything that runs as the logged-in user — including a USB-launched script — inherits the user's full context.

**DPAPI is per-user, not per-machine.** The Data Protection API encrypts secrets using a key derived from the user's login credentials. Any process running as that user can decrypt DPAPI-protected data without additional authentication. This is by design — it allows applications to store secrets without prompting the user — but it also means that any code running as the user can read every secret the user has ever stored.

**Browser credential stores use DPAPI.** Chrome, Edge, and Brave store saved passwords in a SQLite database encrypted with DPAPI. Firefox uses a similar mechanism (with its own key store). All of these are decryptable by any process running as the user, without elevated privileges, without a password prompt.

Together: an unlocked session is enough to read every saved browser credential. No exploitation, no privilege escalation, no zero-day. Just execution as the user.

## Part two — the tooling

The technique uses two components.

**SharpChromium** is a C# tool that reads the Chromium credential store. It supports Chrome, Edge, Brave, and Chromium itself, on multiple profile versions. It reads the `Login Data` SQLite file from the browser profile, extracts the encrypted password blobs, decrypts them via DPAPI, and outputs the plaintext credentials. It also can extract cookies, credit cards, and autofill data if present.

The tool is not novel — it has been in the public offensive toolkit for years — but it is well maintained and works reliably across browser versions. For the purpose of this project, it is the extraction component.

**The .bat script** is the orchestrator. It is the file that lives on the USB, and it performs five steps in sequence:

1. **Disable Windows Defender real-time monitoring.** Without this step, Defender flags SharpChromium on execution and quarantines it before it finishes. The disable is performed via PowerShell:
   ```powershell
   Set-MpPreference -DisableRealtimeMonitoring $true
   ```
   This requires elevation on modern Windows, but the script can be structured to prompt for it or to use a UAC bypass if the attacker wants to fully automate the flow. For the demonstration, the assumption is that the user is a local administrator (common in small business and in many home environments).

2. **Execute SharpChromium.** The tool runs against each installed Chromium-based browser, extracts credentials, and writes them to a file on the USB.

3. **Copy additional artifacts.** Cookies, autofill data, and any other files the tool can extract are copied to the USB as well.

4. **Re-enable Windows Defender.** This is the cosmetic step. Restoring Defender to its previous state means that if the user checks the tray icon (which they will not), everything looks normal. The disable window was under 60 seconds, so there is nothing to see unless the user is specifically checking Defender logs.

5. **Exit.** The script terminates. The USB is removed. The attack is complete.

From insertion to removal: under 60 seconds. From the user's perspective, nothing happened. From the attacker's perspective, they now have every saved password on the machine.

## Part three — why SharpChromium works without elevated privileges

This is a common misconception that is worth clarifying: SharpChromium does not require administrative privileges on most systems. It only requires running as the logged-in user.

The reason is DPAPI. When Chrome saves a password, it uses `CryptProtectData` with the user's login credentials as the key material. The function is designed to be usable by any process running as the same user — that is the entire point. The Windows security model assumes that "running as the user" is equivalent to "authorized by the user".

SharpChromium uses `CryptUnprotectData` to reverse the process. The call succeeds for any process running in the user's context. There is no password prompt, no elevated token, no UAC. The operating system considers the decryption to be a legitimate operation, because it is — the process is running as the user, and the user is authorized to decrypt their own secrets.

This is not a vulnerability. It is the design working as intended. The fact that it can be weaponized is a consequence of the fact that a USB script is indistinguishable from a legitimate user-driven action.

The only variant where elevation matters is when the attacker wants to extract secrets protected by *another* user's DPAPI key — a service account's saved credentials, for example. For that, they need to run as that user or have their credentials. For plain browser credential theft, the current user's context is sufficient.

## Part four — the Defender disable step

The step that gets all the attention in writeups of this kind is the Defender disable, and for good reason: it is the noisiest event in the entire attack chain.

`Set-MpPreference -DisableRealtimeMonitoring $true` is a PowerShell cmdlet that modifies Defender's configuration. It requires elevation on any modern Windows. When it runs, it generates:

- **Windows Event ID 5001** in the Defender operational log ("Real-time Protection disabled").
- **Windows Event ID 5007** if the configuration change is logged ("Defender configuration changed").
- **PowerShell ScriptBlock Logging** event with the exact command line, if ScriptBlock Logging is enabled.
- **Sysmon Event ID 1** (process creation) for `powershell.exe` with the specific command line.

Any single one of these is a strong indicator that something unusual is happening. The Defender disable is the entire reason this technique has a limited operational window — the attacker needs to complete the extraction and re-enable Defender before anyone notices the disable event.

On a machine where the user is not a local administrator, the disable fails outright, and SharpChromium is likely quarantined before it can extract anything. This is a meaningful mitigation, and it is the default configuration in most well-managed enterprises.

## Part five — SharpChromium detection

Even with Defender disabled, SharpChromium leaves traces. The most obvious are the file operations:

- **Read on the `Login Data` SQLite file** in the Chrome profile directory. This file is read by Chrome on startup and by the password manager when the user navigates to a login page. Reads by other processes are anomalous.
- **Read on the `Local State` file** in the Chrome user data directory, which contains the DPAPI-encrypted master key that wraps the credential store.
- **Write to a removable drive** immediately after the above reads, containing a file with high entropy (credentials in plaintext or in a compressed format).

An EDR that correlates "process read Chrome credential files" with "wrote to removable drive" catches this at step two. Most EDRs do not ship with this correlation by default, but it is straightforward to build with the right telemetry.

## Part six — defense

The controls that actually work, in order of effectiveness:

**USB device control.** Windows Defender Device Control, or an equivalent from a third-party EDR, allows an organization to define an allowlist of approved USB devices and block everything else. On a machine where only known USB devices are allowed, this technique is impossible. This is the single highest-leverage control.

**Screen lock on inactivity.** Five minutes or less. Non-negotiable. A machine that locks when the user walks away cannot be attacked this way, regardless of whether the USB port is enabled.

**Remove local administrator rights.** If the user cannot elevate, the Defender disable fails, and SharpChromium is caught by the enabled Defender. This is the default in most enterprise environments; it is common for small businesses and home users to have local admin, and it is a meaningful risk.

**Browser master password.** Chrome and Firefox both support a master passphrase that wraps the DPAPI-encrypted store in a second encryption layer. With a master password set, SharpChromium reads ciphertext it cannot decrypt. This is not enabled by default, and most users do not enable it — but for users who care about this specific threat, it is a strong mitigation.

**Credential isolation.** Some enterprise products maintain the browser credential store in a separate, hardened location that requires additional authentication to access. This is uncommon outside of high-security environments, but it exists.

**Physical security.** A cable lock is theater. The counter to physical access is not preventing access — it is ensuring that physical access does not grant a usable session. Screen lock is the operative control.

**User training.** The honest version: training does not work reliably. Users will leave machines unlocked. The only reliable controls are technical: device control, screen lock enforcement, and revocation of local admin.

## Part seven — what this is not

It is worth being clear about the limits of the demonstration:

**No persistence.** The script runs once and exits. It does not install anything that survives a reboot. If the attacker wants ongoing access, they need a separate persistence mechanism.

**No lateral movement.** The extracted credentials are useful for lateral movement, but the script itself does not move laterally. It extracts and exits.

**No advanced evasion.** This is not a sophisticated implant. It is a script that runs for under a minute, does one thing, and terminates. Against an EDR that watches for "process read Chrome credentials" or "Defender disabled", it is caught. Against an environment with no endpoint telemetry, it is invisible.

**Not a novel technique.** Everything in this project is publicly documented. The value is in the demonstration and in the defensive analysis, not in the offensive novelty.

## Part eight — the broader lesson

The technique is a reminder of something that is easy to forget in an era of sophisticated network attacks: **the endpoint is the endpoint.** No amount of network security, cloud access control, or zero-trust architecture matters if an attacker can walk up to an unlocked machine and run a script.

Every credential-protection mechanism in Windows is downstream of the assumption that the user is present and trusted. Physical access — even a few seconds of physical access — breaks that assumption.

The right response is not to tell users to be more careful. It is to remove the attack surface: disable unused USB ports, enforce aggressive screen locks, and revoke unnecessary local administrator rights. Those controls are unglamorous. They are also effective.

The most sophisticated red team in the world cannot extract credentials from a machine that locks when the user walks away. That is the entire point.

## Takeaway

Forty-five seconds is not enough time to do anything sophisticated. It is enough time to disable Defender, run a tool, and leave. The window is that short because the technique does not need to be longer — the attack surface is the unlocked session, and the session is either there or it isn't.

Every organization that has ever said "our users don't leave machines unlocked" has been wrong. The controls that matter are the ones that do not depend on users behaving correctly. USB device control and enforced screen locks are those controls. Everything else is wishful thinking.
