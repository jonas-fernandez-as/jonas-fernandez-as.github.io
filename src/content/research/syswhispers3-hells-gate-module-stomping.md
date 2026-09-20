---
title: "SysWhispers3, Hell's Gate and Module Stomping"
description: "How runtime SSN resolution works, why indirect syscalls still leave a trail, and how Module Stomping hides a payload inside a legitimate DLL to defeat static memory classification — plus the four ways modern EDRs still find it."
date: 2026-04-25
type: "Research · Evasion"
category: "Evasion"
difficulty: "Advanced"
readingTime: 24
tags: [syswhispers3, hells-gate, module-stomping, evasion, red-team, indirect-syscalls, ssn]
---

## The problem with hardcoding SSNs

The syscall service number is the index the Windows kernel uses to dispatch a system call. Every `NtXxx` function in `ntdll.dll` has one, and the number is not arbitrary — it is the position of that function in the kernel's service table.

The problem is that these numbers change between Windows builds. `NtAllocateVirtualMemory` is `0x18` on Windows 10 22H2. On Windows 11 22H2 it is a different number, because Microsoft inserted new syscalls earlier in the table. A payload that hardcodes `0x18` and ships to a machine running Windows 11 will call the wrong function, and the process will crash or behave unpredictably.

For a red teamer, this is unacceptable. You cannot ship an implant that only works on the specific Windows build of the developer's lab. You need to resolve the SSN at runtime, on the target, every time.

This is what Hell's Gate does.

## Hell's Gate — runtime SSN resolution

The technique is elegant and takes advantage of a simple fact: every syscall stub in `ntdll.dll` follows the same structure, and the SSN is right there in the code.

Recall the stub:

```asm
mov r10, rcx          ; 4C 8B D1
mov eax, <SSN>        ; B8 xx xx xx xx
syscall               ; 0F 05
ret                   ; C3
```

The SSN is embedded in the second instruction as the immediate operand of `mov eax, imm32`. The bytes at offset 4 of the function (where the immediate starts, after the `B8` opcode) encode the number. Read them, and you have the SSN.

Hell's Gate walks the export table of `ntdll.dll`, iterates over every function whose name starts with `Nt` or `Zw`, and for each one checks whether it looks like a syscall stub. Two checks are performed:

1. **The bytes at offset 0-3** should be `4C 8B D1` (`mov r10, rcx`).
2. **The bytes at offset 18 (0x12)** should be `0F 05` (`syscall`).

If both match, the function is a syscall stub. The SSN is read from offset 4.

This is fast, reliable, and works on every version of Windows from Vista onwards. It has one weakness: if `ntdll.dll` is hooked — which it usually is, on a machine with an EDR — the first bytes of the stub are overwritten by the hook's `jmp`, and the pattern check fails.

Hell's Gate was published in 2020. The response from EDR vendors was immediate, and later variants (Halo's Gate, FreshyCalls, RecycledGate) addressed the problem by using the SSNs of *nearby* unhooked functions and adjusting by offset. If the stub for `NtXxx` is hooked but `NtXxx+1` is not, the SSN of the target is `SSN(NtXxx+1) - 1`. This works because syscall stubs are stored in order in the export table, with SSNs incrementing by one.

Hell's Gate does not execute the syscall. It resolves the SSN. Execution is the job of whatever stub the attacker pairs it with.

## SysWhispers3 — a generator, not a technique

SysWhispers3 is a Python tool that generates the C and assembly stubs an attacker needs, given a list of NT functions to call. It is the successor to the original SysWhispers (2020) and SysWhispers2 (2021), and it introduces three things that matter.

### 1. Indirect syscalls as a first-class mode

Running `python3 syswhispers.py --preset common --mode indirect` generates stubs that `jmp` into `ntdll.dll` instead of executing `syscall` themselves. The result is the indirect syscall technique from the previous writeup, automated for an arbitrary set of functions.

The alternative — `--mode direct` — generates stubs that execute `syscall` from the attacker's own image. Faster to implement, easier to detect.

### 2. Randomized indirect calls

In vanilla indirect syscalls, every call jumps to `ntdll!NtXxx+0x12` — the same offset, every time. An EDR that fingerprints return addresses can spot this pattern immediately: every syscall from this process has the same origin offset.

SysWhispers3 adds randomization. At runtime, it enumerates the `syscall; ret` gadgets inside `ntdll.dll` and picks one at random for each call. The return address varies per syscall. This defeats offset fingerprinting.

It does not defeat stack walking. The missing `kernel32` frame is still missing, no matter which `syscall` gadget executes.

### 3. A jumper stub instead of a direct jump

The original indirect technique in SysWhispers3 uses a "jumper" stub: instead of the assembly directly computing and jumping to the target, it stores the address in a data section and jumps through that. This makes the generated code less fingerprintable by static analysis tools, since the target address does not appear as an immediate in the instruction stream.

This is a small improvement. Against a static signature, it works. Against dynamic analysis, it changes nothing.

## The memory problem — why indirect syscalls are not enough

Here is where the technique that gets all the attention is actually the smaller half of the problem.

Any loader that runs attacker-controlled code in memory must place that code somewhere. If it places the stubs SysWhispers3 generates into a fresh `VirtualAlloc` region, that region has the following properties:

- **`MEM_PRIVATE`** — not backed by a file on disk.
- **`PAGE_EXECUTE_READWRITE`** (or `PAGE_EXECUTE_READ` after a `VirtualProtect` flip).

An executable `MEM_PRIVATE` region is the single loudest signal in memory forensics. Every EDR and every basic memory scanner flags it. It is not a "suspicious" region. It is a region that does not exist in normal process life, except in JIT compilers (which are on an allowlist) and in injected payloads.

The stubs themselves are not the issue. If they are compiled into the executable's `.text`, they live in a `MEM_IMAGE` region backed by the PE file, and they look legitimate. The issue is when a loader allocates memory at runtime for the stubs, or for the payload itself, or for anything else the exploit needs.

SysWhispers3 alone solves the syscall problem. It does not solve the memory problem.

## Module Stomping — hiding in a legitimate DLL

The insight behind Module Stomping is that memory classification is a proxy. When a scanner sees a `MEM_IMAGE` region, it assumes the code inside it is whatever the on-disk file says it is. That assumption is exploitable.

The technique:

1. **Load a large, rarely-used, signed DLL.** `LoadLibrary("wmp.dll")` or `LoadLibrary("xpsservices.dll")` are common choices. The DLL must be signed by Microsoft (so the memory region is marked as a legitimate image), reasonably large (so the `.text` section has space), and rarely used (so no legitimate code in the process actually executes from it).

2. **Change the `.text` section to writable.** `VirtualProtect` on the target region, flipping `PAGE_EXECUTE_READ` to `PAGE_READWRITE`.

3. **Copy the payload into the `.text`.** Overwrite the legitimate DLL code with the attacker's bytes. The size of the payload must fit within the section — usually 200KB to 2MB is available in practice.

4. **Restore executable permissions.** `VirtualProtect` back to `PAGE_EXECUTE_READ`.

5. **Execute.** Create a thread pointing at the stomped region, queue an APC, or use any injection primitive that reaches the entry point.

From the perspective of a scanner that classifies memory by type, the payload now lives inside a signed Microsoft DLL. The memory region is `MEM_IMAGE`, backed by a file on disk, and located within the address range of a legitimate module. Every static heuristic that flags `MEM_PRIVATE` executable memory is bypassed.

This is the technique that the CRTO course refers to as "Module Stomping" (sometimes "DLL Stomping"), and it is one of the strongest userland evasion primitives available without a kernel driver.

## The catch — why Module Stomping is not a silver bullet

Module Stomping defeats one class of detection (static memory classification) and leaves it exposed to four others.

### 1. Section integrity

The most direct counter: EDRs hash the `.text` section of loaded modules and compare against the on-disk file. If the hash matches, nothing was stomped. If it does not match, the module was modified.

This check is expensive — hashing every loaded module in every process on every scan cycle is prohibitive. In practice, EDRs run it on suspicious events, on high-value processes (LSASS, browsers, Office), and on a rotating schedule. It is not continuous, but it is inevitable.

The counter to section integrity is to only stomp modules that the EDR does not check. Some loaders maintain a whitelist of DLLs that most EDRs ignore (`.NET` runtime DLLs, some printer spooler components). This narrows the attack surface but does not eliminate it.

### 2. Intel Last Branch Record (LBR)

LBR records the last 8 to 32 branches executed on the CPU. When the injected code executes and the first system call happens, the LBR shows the last jumps taken to reach that point.

For a stomped module, the LBR shows a jump into the middle of `wmp.dll` from an address outside any loaded module. The return address on the stack might be inside `wmp.dll`, but the LBR reveals that the actual instruction that reached it came from somewhere else.

LBR is supported on Intel Skylake and later, and is enabled by default on many business-class systems. EDRs that use it are still a minority, but the ones that do catch Module Stomping reliably.

### 3. Synthetic call stacks

This is the most sophisticated detection and the hardest to defeat. Advanced EDRs do not just check whether each frame in the call stack is backed by an image — they reconstruct the *expected* stack from the origin and validate against a database of known-good patterns.

For a stomped module, the reconstructed stack might look like:

```
some_dll!stomped_function+0x0
kernel32!BaseThreadInitThunk+0x14
ntdll!RtlUserThreadStart+0x21
```

This is a valid-looking stack. All addresses are inside legitimate images. But it does not match any known legitimate chain. `wmp.dll` does not call `NtAllocateVirtualMemory` at offset 0, and the intermediate frames that would normally appear between the thread start and a syscall are missing.

An EDR that maintains a database of "for this operation, from this thread, the stack should look like X" catches stomped payloads even when the memory looks clean.

### 4. Intel CET / Shadow Stack

The hardware-level counter. On CET-enabled systems, the shadow stack holds a second copy of return addresses that userland cannot write to. If the payload uses a `ret` to return from its injected function and the shadow stack does not have a matching entry, the CPU raises a control-flow violation and terminates the process.

Module Stomping is not immune to this. CET kills userland hijacking regardless of how clean the memory looks.

## Comparison — the full picture

| Technique | Defeats static memory classification? | Defeats stack walking? | Defeats LBR? | Defeats section integrity? | Defeats CET? |
|---|---|---|---|---|---|
| Direct syscalls | No | No | No | N/A | No |
| Indirect syscalls | No | Partially | No | N/A | No |
| Module Stomping | Yes | No | No | No | No |
| Stomping + Indirect | Yes | Partially | No | No | No |
| Kernel-mode implants | Yes | Yes | Partially | Yes | Yes (kernel bypasses CET) |

The last row is why kernel exploits remain the endgame for evasion. Everything in userland is eventually detectable by something in the stack — a checker, a scanner, or the CPU itself.

## Part six — the defender's position

For a SOC or detection engineer, the practical detection strategy for Module Stomping + Indirect Syscalls is layered:

**Baseline first.** You cannot detect anomalies without knowing what normal looks like. This means:
- Which processes load `wmp.dll`, `xpsservices.dll`, or similar rarely-used large DLLs.
- Which processes have executable memory regions that are not in the loader module list.
- Which processes make syscalls with unusual stack patterns.

Most teams do not have this baseline. Building it is the first task.

**Instrument the right events.** Specifically:
- **Sysmon Event ID 8** (`CreateRemoteThread`) with a target address inside a known module that is not normally a thread entry point.
- **Sysmon Event ID 10** (`ProcessAccess`) with `PROCESS_VM_WRITE` and `PROCESS_VM_OPERATION` from unusual callers.
- **EDR-specific telemetry** for "module was modified", "unbacked executable memory", "suspicious call stack". Most products have these categories but do not forward them to the SIEM by default.

**Alert on section integrity changes.** If the EDR supports it, enable periodic `.text` section integrity checks on high-value processes. If the EDR does not support it, a scheduled script that hashes loaded DLLs and compares against disk is a decent substitute for critical hosts.

**Consider CET where possible.** Windows 11 and Server 2022+ support CET. Hardware support is the limiting factor, but as fleets refresh, the coverage grows. CET is the single highest-leverage mitigation against this class of attack because it moves the check to hardware.

**Understand the limits.** If a sophisticated attacker with a kernel exploit is the threat model, none of the above helps. Userland detections assume the kernel is intact. For most organizations, the kernel is intact, and userland detection is the appropriate layer.

## Takeaway

SysWhispers3, Hell's Gate, and Module Stomping are three techniques that solve three separate problems: syscall origin, SSN resolution, and memory classification. Each one is effective against the specific detection it targets. None of them is effective against the full set of detections that a well-instrumented EDR collects.

The mark of a mature red team is not using the most exotic technique. It is knowing which technique to use against which target, based on an accurate model of what the target actually sees. And the mark of a mature blue team is being that target — knowing which telemetry is collected, which alerts fire, and which do not.

The gap between those two positions is where the engagement is won or lost.
