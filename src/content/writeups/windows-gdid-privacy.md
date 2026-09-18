---
title: "The GDID — How a Windows Identifier Led to the Arrest of a Scattered Spider Hacker"
description: "The FBI used a Microsoft Global Device Identifier (GDID) to track a member of Scattered Spider across countries, despite his use of a VPN. A technical deep-dive into the persistent Windows identifier that makes anonymity on Windows a myth — including how to see your own."
date: 2026-05-26
type: "Analysis · Privacy"
category: "OSINT"
difficulty: "Intermediate"
readingTime: 24
video: "https://youtu.be/m8drJhA3bQs"
tags: [windows, privacy, telemetry, gdid, machineguid, vpn, tracking, osint, scattered-spider]
---

## The arrest that made the GDID public

In April 2026, a 19-year-old named Peter Stokes was stopped at Helsinki airport while trying to board a flight to Japan. He was carrying two 2TB hard drives. Finnish police, acting on an international warrant, detained him. Weeks later, the United States announced his extradition to face charges of involvement with **Scattered Spider**, a cybercriminal group responsible for over 100 intrusions and more than $100 million in ransom demands.

Stokes had taken precautions. He used a **VPN** to hide his IP address. He used proxies and other anonymization services. His traffic appeared to originate from Estonia, New York, and Thailand at different points in the investigation — never from a single location.

It didn't matter.

The FBI's criminal complaint, unsealed in July 2026, revealed that the primary piece of evidence linking Stokes to the attacks was a **Microsoft Global Device Identifier**, or GDID. Microsoft, in response to legal process, provided telemetry logs that contained Stokes' GDID (`g:6755467234350028`) and a record of the websites he visited using his Windows machine[reference:3]. The VPN had changed his IP address, but the GDID had traveled with him — through every VPN endpoint, across every network, for the entire life of his Windows installation.

This case is the reason this writeup exists. The GDID is real, it is persistent, and Microsoft can be compelled to hand it over.

## Part one — what the GDID actually is

Before looking at where it lives, it is worth understanding what it is — because a lot of incorrect information circulated in the weeks after the Stokes complaint was unsealed.

The GDID is **not** a hardware serial number. It is **not** a hash derived from your CPU, motherboard, or disk. It is **not** a GUID or a UUID. It is a **64-bit Passport Unique ID (PUID)** — an identifier that Microsoft's servers assign to a Windows installation when that installation registers with a Microsoft Account[reference:4].

This is the first critical detail: **the GDID is server-side.** Microsoft generates it. Microsoft stores it. Your machine downloads it and stores a local copy, but the authoritative record lives on Microsoft's servers. This is why deleting it locally does not work — it gets re-downloaded the next time a Microsoft service checks in.

The GDID is written in the registry as a hexadecimal value under the key `LID`. When Microsoft reports it in telemetry or in legal documents, it converts the hex value to decimal and prefixes it with `g:`. The result is the format you see in the Stokes complaint: `g:6755467234350028`.

This is also why the commonly repeated claim that "the GDID is generated from hardware serials" is wrong. A full reinstall of Windows produces a new GDID — which would be impossible if it were derived from hardware that does not change. The court record itself confirms this: "a reinstall produces a new GDID"[reference:5].

## Part two — how to see your own GDID

Unlike the MachineGuid (which requires reading a registry value that Microsoft never exposes through any user-facing interface), the GDID is visible to any user who knows the right registry path.

The value lives at:

```
HKEY_CURRENT_USER\SOFTWARE\Microsoft\IdentityCRL\ExtendedProperties
```

The specific value is named `LID`. To see it in the format Microsoft uses, open PowerShell and run:

```powershell
$lid = (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\IdentityCRL\ExtendedProperties').LID
"g:$([Convert]::ToUInt64($lid,16))"
```

The output is a string like `g:6755467234350028` — your own GDID[reference:6]. It is stored in plain text in your registry, readable by any process running as your user, and it is the same value that Microsoft can be compelled to produce in response to a subpoena.

The simplicity of this is the point. The GDID is not hidden. It is not encrypted. It is not protected by any special permission. It is a registry value that anyone who knows the path can read in a single PowerShell command.

## Part three — why deleting it does not work

The obvious response to discovering a persistent tracking identifier is to delete it. This does not work.

Deleting the `LID` value from the registry removes the local copy. But the GDID is not stored on your machine — it is stored on Microsoft's servers, attached to your Microsoft Account. The next time any Microsoft service that uses the Connected Devices Platform runs — the Store, Delivery Optimization, or any application that checks in with the device graph — it re-downloads the GDID from Microsoft's servers and writes it back to the registry[reference:7].

The same GDID. Not a new one.

This is the difference between a local identifier and a server-side identifier. The MachineGuid is local — delete it and it stays deleted (until you reinstall). The GDID is server-side — delete the local copy and it comes back, because the authoritative record is not on your machine.

Disabling Windows telemetry does not help either. The GDID is not transmitted through the classic telemetry pipeline (the one controlled by `DiagTrack`). It flows through the Connected Devices Platform and Delivery Optimization, which run independently of the telemetry settings[reference:8]. Turning every privacy toggle off in Settings does not stop the GDID from being reported.

## Part four — what identifies a Windows machine (the full picture)

The GDID is one of several identifiers. Understanding the landscape is useful because the fix for each is different.

**The GDID** — the server-side PUID described above. Attached to a Microsoft Account, re-downloaded if deleted, reported through the Connected Devices Platform.

**The MachineGuid** — a local UUID generated when Windows is installed. Lives at `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. Survives everything short of a reinstall. Not server-side, but used by applications that want a stable per-machine identifier.

**The telemetry ID (SQM ID)** — a local identifier used by the classic telemetry pipeline. Lives at `HKLM\SOFTWARE\Microsoft\SQMClient\MachineId`. Sent with telemetry events when telemetry is enabled. Reset when the user resets their diagnostic data.

**The advertising ID** — a per-user identifier for ad targeting. Lives at `HKCU\Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo\Id`. User-resettable through Settings.

**The activation hardware hash** — a hash of the machine's hardware configuration, used for license activation. Not a single identifier, but bound to the machine and retained by Microsoft's activation servers.

Of these, the **GDID is the most concerning** because it is server-side, it is attached to an identity, and it is the one that appeared in the Stokes complaint. The others are either local (and can be deleted) or are used for specific purposes that the user can control.

## Part five — how the GDID travels

The GDID is transmitted by the Connected Devices Platform (`cdp.dll` / `CDPSvc`) and Delivery Optimization. It surfaces in the `UCDOStatus` telemetry item, which reports the device's status to Microsoft's Device Directory Service[reference:9].

The flow, bottom to top:

1. **`wlidsvc`** (the Microsoft Account service) provisions the device with `login.live.com` and receives a device PUID.
2. The PUID is stored in the registry as the `LID` value.
3. **`cdp.dll` / `CDPSvc`** reads the `LID` and registers it with the Device Directory Service graph.
4. **Delivery Optimization** reports it as the `UCDOStatus.GlobalDeviceId` telemetry item.

This is not a hypothetical chain. It was reproduced on a live Windows 11 machine and documented in a public reverse-engineering writeup[reference:10]. The GDID is a functional, documented part of the Windows device graph.

## Part six — the VPN illusion

The Stokes case is the clearest demonstration that a VPN is not an anonymity tool.

A VPN changes the IP address that destination servers see. It does not change:
- The operating system you are using.
- The browser version and its fingerprint.
- The GDID that Windows transmits.
- The identifiers that your browser transmits to the sites you visit.
- The traffic patterns — how you use the connection, when, for how long.

Stokes used a VPN. He used proxies. He used anonymization services. The FBI obtained his GDID from Microsoft's telemetry and linked it to his activity across three countries[reference:11]. The VPN did not help because the identifier was not an IP address — it was a machine identifier that traveled with his Windows installation regardless of the network it was on.

## Part seven — for defenders and investigators

The persistence of the GDID has made it valuable in digital forensics and law enforcement investigations. The Stokes case is the first public example, but the mechanism is general.

**Attribution.** Given a GDID, correlation against Microsoft's records provides attribution to a Microsoft Account and, in many cases, to a real identity. The GDID is the bridge between the machine and the account.

**Correlation across incidents.** The same GDID appearing in two separate incidents links them, even if the IP addresses and network contexts differ. This is how investigators build a pattern of behavior across multiple intrusions.

**Timeline reconstruction.** The persistence of the identifier allows a timeline that spans months or years. The Stokes complaint included a record of websites visited over an extended period, all tied to the same GDID.

## Part eight — mitigation

The honest position: **the GDID cannot be fully disabled.** Microsoft has confirmed this. It is part of the Connected Devices Platform and the device graph, and removing it breaks functionality that Microsoft considers core to the Windows experience.

What can be done:

**Reduce the exposure.** Disabling the Connected Devices Platform services (`CDPSvc`, `CDPUserSvc`) and Delivery Optimization (`DoSvc`) reduces the frequency with which the GDID is reported. This breaks some functionality — the Store, cross-device features, and some update mechanisms — but limits the telemetry.

**Use a local account.** The GDID is attached to a Microsoft Account. If Windows is set up with a local account and never signs into a Microsoft Account, the GDID assigned to the machine is not linked to an identity. This does not eliminate the identifier, but it severs the correlation between the identifier and a real person. The reverse-engineering writeup notes that even without an MSA login, an "anonymous device path" still generates a GDID — but without the account linkage, the identifier does not map to a name[reference:12].

**Reinstall to rotate.** A full reinstall of Windows generates a new GDID. The old GDID remains recorded on Microsoft's servers, but it is no longer associated with the current installation.

**Use a different OS for sensitive activity.** Tails, Qubes OS, Whonix, and hardened Linux configurations are the correct tools for the threat model where Microsoft's records are relevant. Windows is not, and no amount of configuration changes that.

**Community tools.** Several open-source tools have been released to block or rotate the GDID, including `gdid-privacy` and `deGDID`[reference:13]. These disable the services that report the identifier and, in some cases, rotate the local value. They do not remove the server-side record, but they reduce the practical exposure.

## Part nine — the broader lesson

The GDID is a specific instance of a general principle: **anonymity is a property of an entire system, not a property of any single component.** A VPN is one component. It addresses the network layer. It does not address the operating system, the browser, the device, or the user's behavior.

Stokes used a VPN and still got caught. The reason is not that he was careless — the reason is that the tool he trusted (a VPN) addressed a layer (network) that was not where the identification happened. The identification happened at the operating system layer, in a service that was running regardless of the network, transmitting an identifier that was assigned by Microsoft and stored on Microsoft's servers.

The correct approach is to match the tool to the threat. If the threat model is "website tracking me across visits", a VPN plus a privacy-conscious browser is sufficient. If the threat model is "state-level adversary with legal process against Microsoft", the operating system itself is the vulnerability, and the correct response is to not use Windows for that activity.

## Takeaway

Peter Stokes used a VPN. He was arrested anyway. The identifier that led to his arrest was not a network artifact — it was a Windows feature. The GDID is not a bug; it is a design choice. It exists because Microsoft's services need to recognize machines, and the same mechanism that recognizes a machine for a legitimate license check also recognizes it for a subpoena.

The GDID is visible. It is stored in plain text in your registry, and you can read it with a single PowerShell command. You can see the label Microsoft has attached to your machine. What you cannot do is remove it, because the label is not on your machine — it is on Microsoft's, and your machine merely reports it.

The lesson is not that Windows is uniquely bad. The lesson is that anonymity is a system property, and the system includes the operating system. Pretending otherwise is the mistake, and it is a mistake that has consequences.
