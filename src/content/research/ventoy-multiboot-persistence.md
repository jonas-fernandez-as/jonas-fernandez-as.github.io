---
title: "Ventoy — Multi-Boot USB, Persistence, and the Trust Problem"
description: "A single USB drive that boots a dozen operating systems, each with its own persistent storage. How Ventoy's architecture works, how the persistence plugin binds data to ISOs, and why the project's security posture has drawn comparison to the xz-utils backdoor."
date: 2026-06-22
type: "Analysis · Infrastructure"
category: "Infrastructure"
difficulty: "Intermediate"
readingTime: 22
video: "https://youtu.be/lQn877NWw6U"
tags: [ventoy, usb, multiboot, persistence, secure-boot, supply-chain, xz-utils]
---

## The premise

The traditional way to create a bootable USB drive is destructive. You write an ISO to the drive, and the drive becomes that ISO. To boot a different operating system, you write a different ISO, and the first one is gone. For anyone who regularly installs operating systems, recovers machines, or carries a portable toolkit, this means either carrying multiple USB drives or re-flashing a single one constantly.

Ventoy changes this. It installs a small bootloader on the drive and creates a large data partition that holds ISO files as ordinary files. At boot, Ventoy presents a menu of the ISOs on the drive, and the user selects one. The ISOs are never written to the drive — they are booted in place, directly from the file. A single 128GB USB drive can hold Windows, Ubuntu, Kali, Debian, a rescue disk, and a hardware diagnostic tool, all bootable from a single menu.

The feature is genuinely useful. It is also the subject of a security controversy that has been building since 2024 and reached a peak in late 2025, when researchers drew explicit parallels to the xz-utils backdoor. The comparison is not casual — it is about binary blobs in the source tree, a reused Secure Boot key, and a maintainer who has not responded to the concerns.

This writeup covers how Ventoy works, how the persistence feature binds data to ISOs, what the security concerns actually are, and what a user should do about them.

## Part one — how Ventoy works

Understanding the architecture is necessary to understand both the capabilities and the risks.

**The partition layout.** A Ventoy drive has two partitions. The first is a small EFI system partition — typically 32MB — formatted as FAT16, labeled `VTOYEFI`. This partition contains the Ventoy bootloader, the GRUB2 modules, the Secure Boot shim and certificate, and the plugin configuration files. It is the part of the drive that the firmware boots from.

The second partition is the data partition. It is formatted as exFAT or NTFS, and it occupies the rest of the drive. This is where the ISO files live, alongside the `ventoy` directory that holds the configuration. The user sees this partition when the drive is plugged into a running system — it appears as a normal USB drive with ISO files on it. The user can add, remove, and rename ISO files at any time without re-flashing the drive.

**The boot process.** When the drive is booted, the firmware loads the Ventoy bootloader from the `VTOYEFI` partition. The bootloader — a GRUB2 build with Ventoy-specific modules — scans the data partition for ISO files, IMG files, VHD files, and other bootable images. It builds a menu and presents it to the user. When the user selects an image, Ventoy uses a loopback mechanism to mount the image and chain-load it, passing control to the image's own bootloader.

**The plugin system.** Ventoy supports a range of plugins that customize the boot behavior. All plugins are configured through JSON files in the `ventoy` directory on the data partition. The primary configuration file is `ventoy.json`[reference:0]. The plugin system is table-driven — each plugin type is registered with entry and validation functions, and the configuration is processed during boot by the GRUB module[reference:1].

Plugins cover themes, menu customization, password protection, auto-installation of Windows, and — the one most relevant to this writeup — persistence.

## Part two — persistence

Persistence is the feature that turns a live USB from a read-only environment into a usable daily driver. A live Linux system normally discards all changes on shutdown — anything you install, configure, or save is gone. With persistence, changes are written to a file on the USB drive, and the next boot restores them.

Ventoy's persistence plugin implements this without requiring a separate partition. The mechanism is a data file — a `.dat` file — placed on the first partition of the drive. The file is a filesystem image, typically ext4, created with a script that Ventoy provides:

```bash
sudo bash CreatePersistentImg.sh -s 4096 -l casper-rw -o /path/to/ubuntu-persist.dat
```

The `-s` flag sets the size in megabytes, `-l` sets the filesystem label (which must match what the distribution expects — `casper-rw` for Ubuntu and its derivatives, `persistence` for Kali, `vtoycow` for Arch and Fedora), and `-o` sets the output path[reference:2].

The `.dat` file is then associated with an ISO through the `ventoy.json` configuration:

```json
{
  "persistence": [
    {
      "image": "/ISO/ubuntu-20.04-desktop-amd64.iso",
      "backend": "/persistence/ubuntu-persist.dat"
    }
  ]
}
```

The `image` field is the path to the ISO, and the `backend` field is the path to the persistence file[reference:3]. When Ventoy boots the ISO, it mounts the persistence file as a writable layer, and the live system uses it for storage. Changes are written to the file and persist across reboots.

**Multiple persistence files.** Ventoy supports specifying more than one persistence file for a single ISO. When the ISO is selected, Ventoy presents a submenu that allows the user to choose which persistence file to use, or to boot without persistence entirely[reference:4]. This is useful for testing — a user can keep a clean state, an experimental state, and a production state as separate files.

**The filename coupling.** This is a detail that matters for security and for usability. Ventoy matches persistence backends to ISOs strictly by the ISO's filename in `ventoy.json`[reference:5]. If the ISO file is renamed, the association breaks. If a new version of the ISO is downloaded and the old one is replaced but the filename is kept, the persistence file is automatically associated with the new ISO — which may or may not be the intended behavior.

## Part three — the security concerns

The security controversy around Ventoy has three components, and they are worth separating because they have different severities and different mitigations.

### Binary blobs in the source tree

The most fundamental concern is that the Ventoy source tree contains numerous binary blobs without corresponding source code[reference:6]. These blobs are pre-compiled binaries that are included in the build but whose source is not available for inspection.

The comparison to the xz-utils backdoor is explicit in the community discussions. In the xz-utils incident, a malicious actor gained maintainer access and introduced a backdoor into the build process, hidden in test files that were not part of the normal compilation. The backdoor was discovered before widespread distribution, but only by accident. The parallel is that a binary blob is a black box — it could contain anything, and the only way to know is to reverse-engineer it.

The Ventoy issue was raised on GitHub in issue #2795, requesting that the blobs be removed from the source tree. As of the search results available, the issue has not been resolved, and the author has not responded to the thread[reference:7].

### The reused Secure Boot MOK

The second concern is specific to Secure Boot. Ventoy ships with a Machine Owner Key (MOK) that is used to sign the bootloader so that Secure Boot can be enabled. The problem is that this MOK is the same for every Ventoy installation[reference:8].

The implication is significant. If an attacker has access to the Ventoy MOK's private key — and since it ships with every installation, the key is effectively public — they can sign their own malicious kernel or bootloader and have it trusted by any system that has enrolled the Ventoy MOK. The attacker can replace a legitimate kernel with a malicious one, sign it with the Ventoy key, and the system will boot it[reference:9].

The threat model described in the GitHub issue is concrete: an attacker writes zeros to damage a filesystem (this works even on encrypted disks, because the encryption does not protect against destruction), replaces the kernel with a malicious one signed by the Ventoy key, and waits for the user to boot into Ventoy to repair the filesystem. The user enters their disk encryption passphrase, and the malicious kernel captures it[reference:10].

The GitHub issue requesting that the MOK be generated individually for each installation was opened in January 2024 and remains open[reference:11]. The temporary workaround suggested in the thread is to set a BIOS password and ensure that the boot order never prioritizes an external drive[reference:12]. This is standard security hygiene, but it does not address the core problem — the MOK is still reused, and a user who boots from a Ventoy drive on a system where Secure Boot is enabled is trusting a key that everyone has.

### The supply chain concern

The third concern is not a specific vulnerability but a pattern of behavior. The binary blobs have been raised multiple times and not addressed. The maintainer has been active on the project but has not responded to the security concerns. And — as noted in the community discussions — when a video by Veronica Explains about creating bootable USB drives was flooded by comments suggesting Ventoy, the pattern resembled the social engineering that preceded the xz-utils backdoor[reference:13].

This is a characterization, not a technical finding. The technical findings are the blobs and the MOK. The characterization is about what those findings suggest about the project's security posture and the maintainer's responsiveness to criticism.

## Part four — what a user can do

The honest position is that Ventoy's security concerns are real and have not been addressed by the maintainer. A user who continues to use Ventoy should understand the risks and take specific mitigations.

**If you use Ventoy for a rescue drive:** the risk is that the drive could be tampered with, or that the reused MOK could be exploited. Mitigations: keep the drive in your possession, do not let it out of your sight, and do not boot it on a system with Secure Boot enabled and a BIOS that prioritizes external boot. Set a BIOS password on your own systems.

**If you use Ventoy for persistence:** the persistence file is a `.dat` file on the data partition. It is not encrypted. If the drive is lost or stolen, the data in the persistence file — including any credentials, SSH keys, or sensitive documents — is accessible to anyone who mounts the drive. BitLocker or LUKS encryption of the persistence file is not supported by Ventoy's persistence plugin. The mitigation is to not store sensitive data in the persistent environment, or to encrypt individual files within it.

**If you are evaluating Ventoy for an organization:** the binary blobs and the reused MOK make Ventoy unsuitable for any environment where Secure Boot is a meaningful control. The alternative is to use a different multi-boot tool — the IODD SSD Enclosure is mentioned in the community discussions as a hardware-based alternative that emulates an optical drive and allows selecting an ISO from the drive without Ventoy's software stack[reference:14]. For a purely software-based approach, a manually configured GRUB2 installation with multiple loopback entries achieves similar functionality without the Ventoy bootloader.

**If you are a Ventoy user who wants to reduce risk:** update to the latest version (which may address some issues), verify the checksums of the Ventoy release against the published values, and do not use the drive for anything that requires a high degree of trust in the bootloader. The persistence feature works, but it works by trusting the Ventoy bootloader, and the bootloader is the part of the system whose trustworthiness is in question.

## Part five — the broader lesson

Ventoy is a case study in a pattern that appears repeatedly in open-source security: **a useful tool with a legitimate purpose, a maintainer who is unresponsive to security criticism, and a community that continues to use the tool because the alternative is inconvenient.**

The xz-utils backdoor was possible because a maintainer was overwhelmed, a new contributor offered to help, and the contribution was accepted without sufficient scrutiny. The Ventoy situation is different — there is no evidence of a backdoor — but the structural conditions are similar: a project with binary blobs that cannot be audited, a maintainer who has not addressed the concerns, and users who continue to rely on the tool.

The lesson is not that Ventoy is malicious. It is that the security of a tool depends on more than whether it works. It depends on whether the code can be audited, whether the maintainer responds to criticism, and whether the trust assumptions are explicit and reasonable. Ventoy works. The trust assumptions are not reasonable, and the maintainer has not made them safer.

The user who understands this can make an informed decision. The user who does not — who installs Ventoy because it is convenient and because the internet says it is the standard — is accepting a security model they have not examined.

## Takeaway

Ventoy is the most convenient multi-boot tool available. It lets a single USB drive boot a dozen operating systems, each with its own persistent storage, without re-flashing. The persistence plugin is well-designed, the menu is clean, and the workflow is faster than any alternative.

It is also a tool with binary blobs in its source tree, a reused Secure Boot key that is the same for every installation, and a maintainer who has not addressed these concerns despite repeated requests. The comparison to the xz-utils backdoor is not a claim that Ventoy contains a backdoor — it is a claim that the conditions that made the xz-utils backdoor possible are present, and the community should not ignore them.

The honest recommendation: use Ventoy if you understand the risks and are willing to accept them. Do not use it in environments where Secure Boot is a control, where the boot chain must be auditable, or where the drive is used for anything that requires a high degree of trust. The tool is useful. The trust model is not. Both are true, and the user who knows both makes a better decision.
