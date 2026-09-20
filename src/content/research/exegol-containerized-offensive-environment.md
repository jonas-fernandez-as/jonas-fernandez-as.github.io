---
title: "Exegol — Why Offensive Security Is Moving Out of the VM"
description: "A Docker-based hacking environment that replaces the monolithic Kali VM with per-engagement containers. How the wrapper works, why isolation matters more than tools, and the security trade-offs that the container model introduces."
date: 2026-06-30
type: "Analysis · Infrastructure"
category: "Infrastructure"
difficulty: "Intermediate"
readingTime: 24
video: "https://youtu.be/3RWHaIevNw0"
tags: [exegol, docker, containers, pentest, kali, infrastructure, isolation]
---

## The problem with the Kali VM

For fifteen years, the standard offensive security workstation was a Kali Linux virtual machine. You install it once, configure the tools, take a snapshot, and use it for everything. It is a proven model. It is also a model that accumulates debt in ways that are invisible until they cause problems.

The debt takes several forms.

**Shared state across engagements.** A single Kali VM used for multiple clients accumulates the residue of every engagement: `/etc/hosts` entries from three different networks, SSH known-hosts from targets that should not be linked, browser history, shell history containing credentials, cached files in `/tmp` from an engagement that ended months ago. The filesystem does not distinguish between the data of client A and the data of client B. An operator who is not meticulous about cleanup — and almost no one is — carries the previous engagement into the next one.

**Tool drift.** A Kali VM is updated through `apt upgrade`, and the updates are not always clean. A package that was replaced, a dependency that conflicts, a Python library that was upgraded and broke a tool that depended on the old version. Operators who have used Kali long enough know the pattern: after a few months, something stops working, and the fix is to either debug it or rebuild the VM from scratch. The rebuild takes a day, and the cycle starts again.

**The snapshot illusion.** The standard practice is to take a snapshot of the clean Kali VM and roll back after every engagement. This works, in theory. In practice, operators take the snapshot once and never roll back, because rolling back loses the tools and configurations they have accumulated. The snapshot becomes a one-time backup, not a per-engagement reset.

**Reproducibility.** Two operators with two Kali VMs do not have the same environment. Different package versions, different tool configurations, different aliases. When an operator says "it works on my machine", there is no way to verify that the other operator's machine should produce the same result.

Exegol was created as a direct answer to these problems. The creator, Charlie Bromberg, described the motivation as frustration with the state of hacking environments — the time wasted keeping a distribution running smoothly instead of doing security work[reference:0].

## What Exegol is

Exegol is a containerized offensive security environment. It is built on Docker, and the core idea is that each engagement gets its own container instead of sharing a single long-lived VM.

The architecture has three components:

**Images.** Pre-built Docker images containing the tools, configurations, aliases, and history that an operator needs. Exegol ships several image variants:
- **free** — the most comprehensive image available to community users, containing all tools supported by Exegol. It trails the current release by a few versions[reference:1].
- **full** — the complete toolkit, available to Pro and Enterprise users. Includes Active Directory, web, C2, OSINT, wordlists, cracking, and mobile tooling[reference:2].
- **ad** — focused on Active Directory and internal penetration testing[reference:3].
- **web** — dedicated to web application security testing[reference:4].
- **osint** — open-source intelligence gathering tools[reference:5].
- **light** — a streamlined image with only the most essential tools, for quick assessments or resource-constrained environments[reference:6].

**The wrapper.** A Python CLI that manages Docker and Git operations. The user interacts with the wrapper (`exegol start`, `exegol stop`, `exegol remove`), and the wrapper handles the Docker commands, the VPN passthrough, the GUI forwarding, and the workspace mounting. The design goal is to make Docker feel like managing virtual machines — the user does not need to understand Docker to use Exegol[reference:7].

**Offline resources and customization.** A shared volume called `my-resources` persists between the host and every container. This is where an operator stores custom scripts, wordlists, and configurations that should be available in every engagement. A separate volume at `/opt/resources` contains pre-staged offline resources — LinPEAS, WinPEAS, Sysinternals, mimikatz, and similar tools — so the operator does not have to download them on every job[reference:8].

## How the workflow works

The Exegol workflow is built around a single principle: **one container per engagement**.

Starting a new engagement for a client called `clientA`:

```bash
exegol start clientA full
```

The wrapper creates a container named `clientA` from the `full` image and opens a shell inside it. The operator works as if they are in a normal Linux environment. When the engagement is complete:

```bash
exegol remove clientA
```

The container is destroyed. Everything that was inside it — the shell history, the temporary files, the `/etc/hosts` entries, the cached data — is gone. The next engagement starts with a fresh container from the same image. The contamination problem is solved by construction.

The shared resources — the workspace, the `my-resources` volume, the offline resources — remain visible on the host by design. This is the intended behavior: the tools and the operator's custom configurations should persist, but the engagement-specific state should not[reference:9].

VPN access is handled through the `--vpn` flag:

```bash
exegol start clientA full --vpn ~/vpn/clientA.ovpn
```

The wrapper configures the container's network so that OpenVPN can be started inside it, and the VPN tunnel is isolated to that container. Other containers running on the same host are not affected. This is a significant improvement over the Kali VM model, where the VPN connection affects the entire machine.

GUI applications work through X11 sharing. If the operator launches BloodHound inside the container, the graphical window appears on the host's desktop[reference:10]. The container does not need its own display server; it uses the host's.

## Why isolation matters more than tools

The tools in Exegol are not the primary feature. The tools are the same tools that are available in Kali, Parrot, or any other offensive security distribution. The primary feature is the isolation model.

Consider the threat model of an engagement. An operator connects to a client's network, runs tools against it, downloads files from it, and executes binaries that may be malicious. The operator's machine is exposed to everything the engagement touches. In a single-VM model, that exposure accumulates. In the container model, it is scoped to the container.

The implications:

**Cross-engagement contamination is eliminated.** A container created for client A cannot access the data of a container created for client B. The filesystems are separate. The network stacks are separate (unless explicitly configured otherwise). The shell histories are separate.

**Compromise is contained.** If a container is compromised — through a malicious file downloaded from a target, a vulnerable tool, or a misconfigured service — the compromise is confined to that container. The host is not necessarily safe (containers share the host kernel), but the attack surface is reduced. The operator can destroy the container and start fresh.

**Reproducibility is achievable.** Two operators using the same Exegol image have the same tools, the same configurations, and the same aliases. When one operator says "it works in Exegol", the other can verify it. This is not true of a Kali VM, which is a unique snowflake after the first month of use.

**The clean-state guarantee is structural.** In the Kali VM model, the operator is responsible for cleaning up after an engagement. In the Exegol model, the operator is not responsible for cleanup because the container is destroyed. The discipline that the VM model requires is replaced by a mechanism that the container model provides.

## Security considerations

The container model is not a security silver bullet. It introduces its own trade-offs, and understanding them matters.

**Containers share the host kernel.** Docker containers are not virtual machines. They use Linux namespaces and cgroups to isolate processes, but they share the kernel. A kernel exploit in one container can potentially escape to the host. This is the fundamental difference between container-based isolation and VM-based isolation, and it is not a difference that Exegol's design can overcome.

The practical implication: if the container is exposed to a hostile target that can deliver a kernel exploit, the host is at risk. For most engagements, this is a theoretical concern. For engagements against sophisticated adversaries who might target the operator's environment, it is a real one.

**Privileged containers are a risk.** Some Exegol features — running OpenVPN inside the container, accessing certain network interfaces — require elevated privileges. The Exegol documentation explicitly warns about this. The "YOLO" approach of running `exegol start <container> <image> --privileged` gives the container all permissions, which is necessary for some workflows but exposes a higher security risk. The recommended approach is to use the `--vpn` flag, which handles VPN configuration without granting full privileges[reference:11].

**The shared workspace is shared.** The `my-resources` volume and the mounted workspace are accessible to every container. If an operator works on client A's engagement and stores data in the shared workspace, that data is visible to a container running for client B. The isolation is at the container level, not the filesystem level. Operators who need strict data separation between engagements must manage it explicitly.

**The host is still the trust boundary.** The Exegol wrapper runs on the host. It has access to Docker, to the filesystem, and to the network. If the wrapper is compromised, or if the Docker daemon is compromised, the isolation model fails. The security of the containers depends on the security of the host.

## Exegol vs Kali

The comparison is inevitable, and it is worth addressing directly.

Kali is a general-purpose offensive security distribution. It is a full operating system with a desktop environment, a package manager, and a set of pre-installed tools. It is designed to be used as a primary workstation, either installed on hardware or running in a VM. It is excellent for learning, for CTFs, and for operators who want a complete desktop environment with everything installed.

Exegol is a containerized environment. It is not an operating system. It is a set of images and a wrapper that run on top of an existing operating system. It is designed for operators who already have a host OS (Linux, macOS, Windows) and want to run offensive tools in an isolated, reproducible way. It is excellent for professional engagements, for operators who work on multiple concurrent projects, and for anyone who values reproducibility and isolation over having a desktop environment[reference:12].

The trade-offs:

| Aspect | Kali VM | Exegol |
|---|---|---|
| Isolation | One VM for everything | One container per engagement |
| Reproducibility | Drifts over time | Consistent per image version |
| Resource usage | Full OS, heavy | Shared kernel, lightweight |
| GUI | Native desktop | X11 sharing from host |
| Persistence | The VM persists | Containers are disposable |
| Learning curve | Familiar to most | Requires Docker familiarity |
| License | GPL, free | ESL, community tier free for non-commercial |

The choice is not "which is better". It is "which model fits the workflow". An operator who works on a single engagement at a time and values a familiar desktop environment may prefer Kali. An operator who works on multiple engagements concurrently, or who values strict isolation between projects, may prefer Exegol.

## Licensing

Exegol is not fully open source in the traditional sense. The project began transitioning from GPL3 to the Exegol Software License (ESL) in June 2025. Code released before that date remains GPL3; later code may be ESL or GPL3 depending on whether it contains GPL3-derived code.

The tiers:

- **Community (free)** — non-commercial use only: learning, research, CTFs, academic work. Access to the `free` image, which contains the same tools as `full` but runs a few versions behind. No access to specialized images or nightly builds[reference:13].
- **Pro** — for professional use: pentest engagements, bug bounty, commercial operations. Access to all image variants at current versions, plus nightly builds[reference:14].
- **Enterprise** — team management, multiple seats, dedicated support, and the option of a managed private registry[reference:15].

This is worth noting because it affects who can use Exegol and for what. A hobbyist learning pentesting can use the Community tier. A professional running client engagements needs Pro. An organization deploying Exegol across a team needs Enterprise.

## The broader lesson

Exegol is a response to a specific problem: the monolithic VM model for offensive security is not designed for the way modern operators work. It is designed for a time when an operator had one project, one machine, and one set of tools. The modern operator has multiple projects, multiple clients, and a need for reproducibility and isolation that the VM model does not provide.

The container model is not a perfect solution. It shares the host kernel, it requires Docker, and it introduces its own security considerations. But it addresses the structural problems of the VM model — contamination, drift, lack of reproducibility — in a way that configuration alone cannot.

The lesson is not that Exegol is the right tool for everyone. It is that the model of offensive security tooling is changing. The monolithic distribution is being replaced, in some workflows, by containerized, disposable environments that prioritize isolation and reproducibility over having everything installed on a single machine. Whether that transition is right for a given operator depends on their workflow, their threat model, and their tolerance for the container model's trade-offs.

## Takeaway

Exegol is a containerized offensive security environment that replaces the Kali VM with per-engagement Docker containers. It is built on the premise that isolation between engagements is more important than having a single machine with everything installed. The wrapper makes Docker manageable for operators who do not want to learn Docker. The images provide curated toolkits for different engagement types. The shared resources and customization mechanisms make it practical for daily use.

The security trade-offs are real: containers share the host kernel, privileged containers are a risk, and the host remains the trust boundary. But the isolation benefits are also real: cross-engagement contamination is eliminated, compromise is contained, and reproducibility is achievable in a way that the VM model does not provide.

The choice between Exegol and Kali is a choice between two models. Kali is a complete desktop environment for offensive security. Exegol is a containerized toolkit for operators who already have a host OS. Both are legitimate. The operator who understands the difference makes a better decision than the operator who chooses based on familiarity alone.
