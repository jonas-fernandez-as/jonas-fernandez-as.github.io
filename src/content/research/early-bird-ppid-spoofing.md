---
title: "Early Bird APC Injection — The PPID Spoofing Combo"
description: "Combining PPID Spoofing, Memory Mapping, and Early Bird APC injection to hide process lineage, dodge WriteProcessMemory detections, and execute before a process's own entry point — plus why ETW-Ti still catches it."
date: 2026-04-28
type: "Research · Process Injection"
category: "Evasion"
difficulty: "Advanced"
readingTime: 22
tags: [early-bird, ppid-spoofing, apc, injection, evasion, etw-ti]
---

## The problem with classic process injection

Process injection is one of the oldest techniques in the offensive toolkit. The premise is simple: get your code running inside another process, where it inherits that process's identity, token, and network context. From an EDR's perspective, the injected process looks legitimate — it is a signed Windows binary, running with the user's normal token, making requests to the network with a plausible User-Agent.

The technique is old enough that defenders have had years to develop countermeasures. Modern EDRs do not look for one signal; they look for a pattern. That pattern involves three observable facts:

1. **The parent process is not the expected one.** A process that spawns `svchost.exe` should be `services.exe`. A process that spawns `notepad.exe` should be `explorer.exe` or a shell. An unsigned binary spawning a Windows system process is an anomaly, and Sysmon Event ID 1 records the `ParentImage` field for exactly this reason.

2. **The write primitive is visible.** `WriteProcessMemory` is a specific API with a specific signature. EDRs hook it, monitor it, and correlate it with subsequent thread creation. The pattern "open handle to remote process → WriteProcessMemory → CreateRemoteThread" is one of the oldest detection signatures in the field.

3. **The memory region is unbacked.** After the injection, the payload lives in a `MEM_PRIVATE` region — memory allocated at runtime with `VirtualAllocEx`, not backed by any file on disk. Executable `MEM_PRIVATE` memory is the single loudest signal in memory forensics. It does not exist in normal process life except in JIT compilers and injected payloads.

Early Bird APC combined with PPID Spoofing and Memory Mapping addresses all three. Not perfectly, and not in a way that defeats every EDR — but enough to significantly raise the cost of detection for most organizations.

## Part one — PPID Spoofing

The parent process ID is a field in the process structure that records who created whom. Sysmon logs it. Process Explorer displays it. Most EDR process trees are built from it. If an attacker can set that field to something other than the real creator, they can hide the true origin of a process.

The technique exploits a legitimate Windows feature: `STARTUPINFOEXA` with the `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` attribute. This exists for a reason — a service running as SYSTEM may want to launch a child process under a different user's token, and the "parent" for that child should reflect the user context, not the service. Microsoft exposed the attribute precisely to give services that level of control.

The attribute takes a process handle. Whichever process's handle you provide becomes the recorded parent of the new process. The kernel does not validate that the caller is actually related to that process. It trusts the handle.

The flow:

```c
// Open a handle to a legitimate process (explorer.exe, svchost.exe, etc)
HANDLE hParent = OpenProcess(PROCESS_CREATE_PROCESS, FALSE, explorer_pid);

// Prepare the extended startup info
STARTUPINFOEXA si = {0};
si.StartupInfo.cb = sizeof(si);

SIZE_T size = 0;
InitializeProcThreadAttributeList(NULL, 1, 0, &size);
si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, size);
InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &size);

UpdateProcThreadAttribute(
    si.lpAttributeList,
    0,
    PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
    &hParent,
    sizeof(hParent),
    NULL,
    NULL
);

// Create the child process with the spoofed parent
PROCESS_INFORMATION pi = {0};
CreateProcessA(
    NULL,
    "C:\\Windows\\System32\\notepad.exe",
    NULL, NULL, FALSE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
    NULL, NULL,
    (STARTUPINFOA*)&si,
    &pi
);
```

The `CREATE_SUSPENDED` flag is essential. It creates the process fully initialized — all threads created, all modules loaded — but with the primary thread frozen before its first instruction. This gives the attacker a window to modify the process before it does anything observable.

From Sysmon's perspective, `explorer.exe` spawned `notepad.exe`. That is a completely normal event. From the kernel's perspective, the attacker's process spawned `notepad.exe`. Those two facts differ, and this is where the technique becomes interesting from a detection standpoint.

## Part two — Memory Mapping instead of WriteProcessMemory

With the process created and suspended, the attacker needs to write the payload into it. The traditional approach — `VirtualAllocEx` followed by `WriteProcessMemory` — has two problems.

First, both are well-known APIs. EDRs hook them and log every call. A remote process writing into a newly created child process is a strong signal.

Second, `VirtualAllocEx` creates a `MEM_PRIVATE` region — unbacked executable memory. This is the memory classification artifact described earlier.

Memory Mapping sidesteps both. Instead of allocating fresh memory in the target and writing to it, the attacker creates a **section object** — a shared memory region — and maps it into both their own process and the target process.

```c
HANDLE hSection = NULL;
LARGE_INTEGER maxSize = { .QuadPart = payload_size };

NtCreateSection(
    &hSection,
    SECTION_ALL_ACCESS,
    NULL,
    &maxSize,
    PAGE_EXECUTE_READWRITE,
    SEC_COMMIT,
    NULL
);

// Map into the current process
PVOID pLocal = NULL;
SIZE_T viewSize = payload_size;
NtMapViewOfSection(
    hSection, GetCurrentProcess(),
    &pLocal, 0, 0, NULL, &viewSize,
    ViewUnmap, 0, PAGE_READWRITE
);

// Write the payload locally
memcpy(pLocal, payload, payload_size);

// Map into the target process
PVOID pRemote = NULL;
viewSize = payload_size;
NtMapViewOfSection(
    hSection, pi.hProcess,
    &pRemote, 0, 0, NULL, &viewSize,
    ViewUnmap, 0, PAGE_EXECUTE_READ
);
```

Three things change:

1. **No `WriteProcessMemory`.** The EDR that monitors that specific API sees nothing.
2. **The remote memory is `MEM_MAPPED`,** not `MEM_PRIVATE`. Section objects are backed by a kernel object, and the classification is different. Some EDRs treat mapped memory as lower risk than private memory — this is not universal, but it is common enough to matter.
3. **The write happens locally.** The attacker's own process writes to its own view of the section, which is a completely normal operation. The remote view shares the same physical pages, so the write propagates without a cross-process write call.

The `NtCreateSection` and `NtMapViewOfSection` calls are themselves hookable, and modern EDRs do watch them. But they are less commonly monitored than `WriteProcessMemory`, and their usage is more varied in legitimate software (shared memory, file mapping, IPC), so the signal-to-noise ratio is worse for the defender.

## Part three — Early Bird APC

With the payload mapped into the target process, the attacker needs to execute it. The obvious approach — `CreateRemoteThread` — is heavily monitored. A thread created in another process with an entry point in a non-image region is a strong alert.

The Early Bird technique uses an **Asynchronous Procedure Call** instead.

An APC is a function that the kernel queues to a thread, to be executed when that thread next enters an "alertable" state. The canonical alertable states are `SleepEx`, `WaitForSingleObjectEx`, `SignalObjectAndWait`, and similar wait functions that check the APC queue when they are about to block.

The key insight is what happens during process initialization. When Windows creates a new process, the primary thread runs `ntdll!LdrInitializeThunk` before it ever reaches the process's own entry point. `LdrInitializeThunk` performs a series of initialization steps and then enters a wait state — specifically, it calls `NtTestAlert` at the end of loader initialization.

`NtTestAlert` checks the APC queue of the current thread. If there are queued APCs, they execute immediately. This is by design — it allows the loader to process certain internal APCs that the kernel uses during initialization.

For an attacker, this is the ideal window. The process is created suspended, the payload is mapped in, and an APC is queued to the primary thread before `ResumeThread` is called. When the thread resumes, it runs `LdrInitializeThunk`, hits `NtTestAlert`, and executes the attacker's payload — **before the process's own entry point ever runs.**

```c
QueueUserAPC(
    (PAPCFUNC)pRemote,   // the mapped payload
    pi.hThread,          // the primary thread (still suspended)
    (ULONG_PTR)NULL
);

ResumeThread(pi.hThread);
```

The process is now executing attacker code. From the process's own perspective, this happens before `main` or `WinMain` — the process has no idea anything unusual occurred. From the attacker's perspective, the code is running with the target's token, in the target's address space, with the target's parent process ID (the spoofed one).

## Why the combination is effective

Each component addresses a specific detection surface:

- **PPID Spoofing** breaks the parent-child relationship. The process tree shows a legitimate chain. Investigating the "parent" leads to `explorer.exe`, which is clean.
- **Memory Mapping** avoids `WriteProcessMemory` and creates `MEM_MAPPED` rather than `MEM_PRIVATE` memory. It also avoids the entire class of detections that hook those specific APIs.
- **Early Bird APC** executes before the process's own code, which means any EDR module that runs inside the target process's initialization has not yet had a chance to observe it. It also avoids `CreateRemoteThread`, which is one of the most-watched APIs on Windows.

The three together produce a scenario where the injected process looks legitimate at three separate layers: process tree, memory classification, and thread creation.

## Why it is still detectable

None of this is invisible. Here is what a modern EDR sees.

### ETW-Ti (Threat Intelligence provider)

This is the primary counter. ETW-Ti is a kernel-level ETW provider that Microsoft makes available to EDR vendors. It emits events for the operations that matter for this attack — process creation, thread creation, memory operations — and it emits them **from the kernel**, not from userland hooks.

The key detail: when a process is created, ETW-Ti records both the process being created **and the process that physically called `NtCreateUserProcess`**. This is not the PPID field. It is the actual creator token — the security context under which the creation call was made.

For a spoofed process, the ETW-Ti event shows `explorer.exe` as the parent (matching the spoof) but the creator token belongs to the attacker's process. An EDR that consumes ETW-Ti sees the discrepancy immediately.

The attacker cannot forge this. The kernel knows who called it. PPID is a display artifact; the creator token is ground truth.

### OpenProcess on system processes

To spoof the parent as `explorer.exe`, the attacker must first open a handle to `explorer.exe` with `PROCESS_CREATE_PROCESS` access. This is a specific right that few legitimate programs request.

Sysmon Event ID 10 (`ProcessAccess`) fires on this. The event records the source process, the target process, and the requested access mask. An unsigned binary opening `PROCESS_CREATE_PROCESS` on `explorer.exe` is a strong anomaly. A binary opening that right on a range of different processes in short succession is a near-certain indication of PPID spoofing reconnaissance.

### Sysmon Event ID 1

Even with the spoof, Sysmon records more than the parent image. It also records `ParentProcessGuid` — a unique identifier for the parent process. In many cases, the GUID does not match the spoofed PPID because the GUID is derived from the real creation event, not from the spoofed field.

This is not always reliable — Sysmon's implementation of the parent fields has evolved, and the reliability varies by version. But on well-configured Sysmon deployments, the GUID reveals the truth.

### Call stack from the APC

When the APC runs and the payload makes its first syscall — likely `NtProtectVirtualMemory` or something similar — the return address on the stack points into the mapped section. That section is `MEM_MAPPED`, not `MEM_IMAGE`. Some EDRs flag executable `MEM_MAPPED` regions just as aggressively as `MEM_PRIVATE`.

The stack walker sees:
```
some_stomped_or_mapped_region!entry+0x0
ntdll!NtTestAlert+0x14
ntdll!LdrInitializeThunk+0x43
kernel32!BaseThreadInitThunk+0x14
ntdll!RtlUserThreadStart+0x21
```

This stack is technically valid — every frame is inside a loaded module. But the top frame is inside an executable region that is not the entry point of any known module. An EDR that validates "the top of the stack should match the process's own entry point, or one of a small set of legitimate initialization frames" catches it.

### Behavior after injection

The payload eventually does something. It connects to a C2, opens a file, injects into another process, or reads from LSASS. Each of those actions generates its own telemetry. The injection itself may be invisible, but the post-injection behavior is not.

This is why injection techniques are described as "raising the cost" rather than "evading". The adversary still has to operate. The question is whether the EDR catches them during the injection (early) or during the operation (later, but still).

## Part four — comparison with other injection techniques

A brief survey of where Early Bird sits relative to alternatives:

| Technique | Write API | Execution API | Parent spoof | Memory type | Primary detection |
|---|---|---|---|---|---|
| Classic `CreateRemoteThread` | `WriteProcessMemory` | `CreateRemoteThread` | No | `MEM_PRIVATE` | API hooks, memory scan |
| Section mapping | `NtMapViewOfSection` | `CreateRemoteThread` | No | `MEM_MAPPED` | `CreateRemoteThread` hook |
| APC injection (alert) | `WriteProcessMemory` | `QueueUserAPC` | No | `MEM_PRIVATE` | Memory scan |
| Early Bird APC | `WriteProcessMemory` | `QueueUserAPC` | No | `MEM_PRIVATE` | Memory scan |
| Early Bird + mapping | `NtMapViewOfSection` | `QueueUserAPC` | No | `MEM_MAPPED` | `QueueUserAPC` hook |
| **Full combo** | `NtMapViewOfSection` | `QueueUserAPC` | **Yes** | `MEM_MAPPED` | **ETW-Ti, stack walk** |

The full combo is the strongest userland variant. It defeats three layers of traditional detection. It is defeated by ETW-Ti and by stack walking with awareness of the early-loader execution pattern.

## Part five — detection: what to instrument

For a SOC team, the practical detection strategy is a set of correlated events, not a single signature.

**The pre-injection phase:**
- **Sysmon Event ID 10** with `CallTrace` containing `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` setup calls, or with unusual `GrantedAccess` values like `0x80` (`PROCESS_CREATE_PROCESS`) opened on `explorer.exe`, `svchost.exe`, or `services.exe` from a non-standard caller.
- **Sysmon Event ID 1** where the `ParentImage` is a system process but the `ParentProcessGuid` does not match any process that normally spawns the child. This requires processing the GUID, not just the image name.

**The injection phase:**
- **Sysmon Event ID 8** (`CreateRemoteThread`) is not triggered by `QueueUserAPC` — this is a feature of the technique. But Sysmon Event ID 25 (`ProcessTampering`) may fire.
- **EDR-specific telemetry** for "APC queued to a suspended thread" or "unbacked memory mapped with execute permissions". Most products generate these; few forward them to the SIEM by default.

**The execution phase:**
- **Sysmon Event ID 1** for the child process showing execution from a memory region that is not the process's own entry point. This requires the EDR to capture the call stack at process start.
- **Stack-walk telemetry** showing a top frame in `MEM_MAPPED` or `MEM_PRIVATE` memory.

**Post-injection behavior:**
- **Network connections** from a process that does not normally make them.
- **File operations** from a process that does not normally perform them.
- **Child process creation** with unusual command lines.

None of these fire in isolation. The value is in correlation: PPID anomaly + APC to suspended thread + mapped executable memory + network connection = a specific, high-confidence pattern.

## Part six — the limits of the technique

Three honest limitations:

**1. It requires prior access to the target.** The attacker must be running code on the machine to perform PPID spoofing, open handles, and queue APCs. This is a post-exploitation technique, not an initial-access one. In practice, it is used during lateral movement or after gaining a foothold via phishing or exploitation.

**2. It does not survive reboots.** No persistence is established by the injection itself. If the injected process is closed, the payload is gone. Persistence is a separate problem.

**3. It is defeated by hardware-level defenses.** CET (Intel Control-flow Enforcement Technology) and shadow stacks break the APC execution model on systems that enable them. As these become more common, the technique will require kernel-mode components to remain viable.

## Takeaway

Early Bird APC with PPID Spoofing and Memory Mapping is a case study in depth. Each of the three components addresses a specific detection surface, and together they defeat the entire layer of traditional userland detection that most organizations rely on.

But it is not evasion. It is misdirection. Every layer that the technique defeats is a layer that a more advanced defender has already stopped relying on. ETW-Ti, kernel callbacks, and stack walking are what catch this — and those are available to any EDR worth its license fee.

The practical lesson for both sides is the same: the important question is not "can this technique evade detection". It is "what telemetry does the target actually collect, and does that telemetry cover the artifacts this technique leaves behind". Everything else is theater.
