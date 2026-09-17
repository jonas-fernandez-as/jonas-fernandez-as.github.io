---
title: "EDR Userland Hooking — Direct vs Indirect Syscalls and Unhooking"
description: "How EDRs hook ntdll in userland, and the three main ways offensive tooling bypasses it — with the tradeoffs and detection artifacts of each."
date: 2026-03-20
type: "Concept · Windows Internals"
difficulty: "Intermediate"
readingTime: 12
tags: [edr, syscalls, unhooking, hooking, windows-internals]
---

## Why EDRs hook userland

Modern EDRs need visibility into what a process is *about to do* — not what it already did. The cheapest place to get that visibility on Windows is the userland boundary between a program and the kernel: `ntdll.dll`.

Every Windows API that needs kernel services eventually lands in `ntdll.dll` as a stub that does:

```asm
mov r10, rcx
mov eax, <SSN>        ; syscall service number
syscall               ; transition to kernel
ret
```

If an EDR overwrites the first bytes of that stub with a `jmp` to its own handler, it sees every call before it happens and can inspect arguments, origin, and call stack.

```
ntdll!NtAllocateVirtualMemory:
    jmp <EDR handler>    ; <-- inline hook
    mov r10, rcx
    mov eax, 0x18
    syscall
    ret
```

This is **userland inline hooking**, and it is the foundation of most endpoint security products on Windows.

## The three ways to bypass it

### Direct syscalls

Instead of calling the hooked stub, you re-implement it yourself in assembly with the correct SSN. The EDR's hook is never touched.

```asm
NtAllocateVirtualMemory PROC
    mov r10, rcx
    mov eax, 18h        ; SSN for NtAllocateVirtualMemory
    syscall
    ret
NtAllocateVirtualMemory ENDP
```

**Problem:** the `syscall` instruction now lives in your executable, not in `ntdll.dll`. The return address on the stack points to memory that is not backed by a signed Windows DLL. Any EDR that walks the call stack sees this immediately.

### Indirect syscalls

Same idea, but instead of executing `syscall` yourself, you `jmp` to the real `syscall; ret` instruction inside `ntdll.dll`.

```asm
NtAllocateVirtualMemory PROC
    mov r10, rcx
    mov eax, 18h
    jmp [ntdll_syscall_addr]   ; jumps to ntdll!NtAllocateVirtualMemory+0x12
NtAllocateVirtualMemory ENDP
```

**Advantage:** when the kernel is entered, the return address on the stack points inside `ntdll.dll` — legitimately. This is the technique used by SysWhispers3 (via `--mode indirect`).

**Still detectable:** the call stack is not the *expected* one. A normal call comes from `kernel32!VirtualAlloc` → `ntdll!NtAllocateVirtualMemory`. An indirect syscall arrives directly at `NtAllocateVirtualMemory+0x12` with no caller in `kernel32`. Modern EDRs use stack unwinding to detect this: if a return address points into a `MEM_PRIVATE` region, or if the expected caller frame (`kernel32!BaseThreadInitThunk`) is missing, it alerts.

### Unhooking (fresh ntdll from disk)

Load a clean copy of `ntdll.dll` from disk (or from KnownDlls) and call its functions. The clean copy has no hooks.

Two common approaches:

1. **Manual mapping** — read the file, map it as an image, and resolve imports yourself.
2. **KnownDlls** — open the `\KnownDlls\ntdll.dll` section and map a view. This gets you the pristine, unpatched copy the kernel keeps.

Once loaded, you can either:
- Call the fresh copy's functions directly (redirecting the execution path to a region the EDR did not hook), or
- Copy the clean `.text` section **over** the hooked `.text` of the current `ntdll.dll` in memory (classic unhooking). The whole process has clean stubs again.

**Detection:** the fresh ntdll is a `MEM_IMAGE` region, but it is a second ntdll not registered in the loader's module list (`PEB->Ldr`). EDRs that enumerate loaded modules and compare against memory regions will see a ntdll whose `.text` is not hooked while the registered one is — a strong indicator.

## Comparison

| Technique | Evades hook? | Stack looks legitimate? | Main artifact |
|---|---|---|---|
| Direct syscall | Yes | No — `syscall` in caller's image | Return address in `MEM_PRIVATE` |
| Indirect syscall | Yes | Mostly — `syscall` in ntdll | Missing caller frames above ntdll |
| Unhooking (classic) | Yes | Yes | Second `ntdll` not in PEB module list |
| Unhooking (KnownDlls) | Yes | Yes | Section mapped from `\KnownDlls` |

## What defenders should look for

- **Call stack analysis** — EDRs already do this. The question is whether the product's telemetry surfaces it to your SIEM.
- **Double-loaded ntdll** — a process whose memory contains two copies of `ntdll.dll`, or any module outside the loader list, is a strong indicator of manual mapping or unhooking.
- **Section integrity** — compare the `.text` of in-memory modules against the on-disk originals. If they differ and the difference is not attributable to legitimate dynamic linking, alert.
- **Syscall origin via LBR** — Intel Last Branch Record captures the last jumps taken before a syscall. A `jmp` that lands mid-prologue (`ntdll!NtXxx+0x12`) without going through the function entry is anomalous.

## Defender takeaway

There is no single bypass that defeats every EDR. Each technique trades one artifact for another. The defender's job is not to hunt for "the evasion" — it is to baseline what normal syscall traffic looks like per process, then alert on deviations.

Practical mapping for a SOC:

- Missing `kernel32` frames in the stack → indirect syscalls.
- Return address outside any loaded module → direct syscalls.
- Module in memory not present in the loader list → manual mapping or unhooking.

None of these are obvious without telemetry most teams do not collect by default. That is why they work.
