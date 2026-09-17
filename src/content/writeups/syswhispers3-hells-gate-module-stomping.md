---
title: "SysWhispers3, Hell's Gate and Module Stomping"
description: "Analysis of indirect syscall generation via SysWhispers3, the limits of Hell's Gate, and how Module Stomping hides payloads inside legitimate DLLs to defeat static memory classification."
date: 2026-03-25
type: "Research · Evasion"
difficulty: "Advanced"
readingTime: 15
tags: [syswhispers3, hells-gate, module-stomping, evasion, red-team]
---

## What Hell's Gate does

Hell's Gate resolves syscall service numbers (SSNs) at runtime, without hardcoding them. That matters because SSNs change between Windows versions — the same `NtAllocateVirtualMemory` may be SSN 0x18 on Windows 10 20H2 and 0x19 on Windows 11 22H2. Hardcoding breaks across versions.

The technique walks every stub in `ntdll.dll`, reads the 4 bytes at offset 4 (which encode the SSN as `mov eax, <SSN>`), and uses that as the value for a manual syscall.

```c
// conceptual
for (i = 0; i < number_of_exports; i++) {
    if (is_syscall_stub(exports[i])) {
        ssn = *(DWORD*)((BYTE*)exports[i] + 4);
        // store for later
    }
}
```

Hell's Gate itself does not execute the syscall. It resolves the SSN. The syscall is executed by whatever stub you pair it with.

## What SysWhispers3 adds

SysWhispers3 generates C/ASM stubs for any set of NT functions you need. Compared to the original SysWhispers, it adds:

- **Indirect mode** via `--mode indirect`, where the stub `jmp`s into `ntdll` instead of executing `syscall` itself.
- **Randomized SSN resolution** — using a "jumper" or "egg-hunter" pattern, so the generated code is not a static copy of what a known tool looks like.
- **Randomized `syscall` gadget target** — the indirect call does not always land at the same address inside ntdll. This is important: if it did, an EDR could fingerprint the pattern (which memory address in ntdll appears as return address for every syscall).

Generation:

```bash
python3 syswhispers.py --preset common --mode indirect -o syscalls
```

Produces `syscalls.h` and `syscalls-asm.x64.asm`.

## The RWX problem

The stubs themselves, if placed in a static section of the executable, are fine — they live in the module's `.text`, marked `RX` from the loader.

The problem appears when a loader allocates memory **at runtime** for these stubs and marks it `PAGE_EXECUTE_READWRITE`. An RWX region in a modern process is the single loudest signal in memory forensics. No EDR misses it.

A correct implementation either:
- Allocates as `RW`, writes, then flips to `RX` (`VirtualProtect`).
- Or, better, keeps the stubs in the module's own `.text` and never allocates anything.

But even with `RX` memory, the region is still `MEM_PRIVATE` — unbacked executable memory. That is where Module Stomping comes in.

## Module Stomping

The idea: instead of allocating a fresh private region for your payload, write it into the `.text` section of an already-loaded, legitimate DLL. To a static memory scanner, the memory is `MEM_IMAGE` — backed by a file on disk — and lives within a signed module's range.

The flow:

1. `LoadLibrary("some_large_signed.dll")` — pick a DLL with enough `.text` space, ideally one rarely used (e.g. `wmp.dll`, `xpsservices.dll`).
2. `VirtualProtect` the target region to `RW`.
3. `memcpy` the payload into the `.text` section, overwriting the legitimate code.
4. `VirtualProtect` back to `RX`.
5. Execute — create a thread, queue an APC, whatever the injection primitive is.

The DLL is now "stomped". The code running in its range is not the code the disk file says should be there.

## How this is still detected

Module Stomping defeats *static* memory classification (unbacked executable memory). It does not defeat dynamic checks:

1. **Section integrity** — hash the `.text` of the on-disk DLL and compare against the in-memory `.text`. Any mismatch means the module was stomped. Some EDRs do this on a schedule; a few do it on demand.
2. **Intel Last Branch Record (LBR)** — the CPU records the last N jumps taken. A jump into the middle of a module's `.text` that has never been legitimately executed from that point is a strong signal.
3. **Synthetic call stacks** — even if the immediate return address lives inside a signed DLL, the frames above it may not match any legitimate chain. EDRs that reconstruct the full stack (not just the top frame) catch this.
4. **Intel CET / Shadow Stack** — the CPU keeps a second copy of return addresses that userland cannot write to. Any mismatch between the normal stack and the shadow stack aborts execution at the hardware level.

## The honest takeaway

Module Stomping + Indirect Syscalls is one of the strongest evasion combinations available short of kernel-mode. It is not unbeatable — it just pushes detection to hardware and kernel-level telemetry that most organizations do not collect.

For a defender: if you are not collecting LBR data or performing section integrity checks, this class of attack looks like "a signed DLL performed a syscall". That is not nothing — but it is also not a lot.
