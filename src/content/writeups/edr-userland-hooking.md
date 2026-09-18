---
title: "EDR Userland Hooking — Direct vs Indirect Syscalls and Unhooking"
description: "How endpoint security products hook ntdll in userland to see every kernel call, and the three main techniques offensive tooling uses to bypass that visibility — with the exact artifacts each one leaves behind."
date: 2026-04-22
type: "Concept · Windows Internals"
category: "Evasion"
difficulty: "Intermediate"
readingTime: 20
tags: [edr, syscalls, unhooking, hooking, windows-internals, direct-syscalls, indirect-syscalls]
---

## Why userland hooking exists at all

An EDR has a fundamental problem: it needs to know what a process is about to do, not what it already did. Kernel callbacks and ETW providers give excellent coverage of *completed* actions — a process was created, a file was written, a registry key was modified. But by the time those events fire, the decision has already been made and executed. Prevention requires seeing the decision *before* it happens.

The cheapest place to intercept decisions on Windows is the boundary between a program and the kernel: `ntdll.dll`. Every Win32 API that needs kernel services — `VirtualAlloc`, `CreateFile`, `RegOpenKey`, `CreateProcess` — eventually funnels through a stub in `ntdll.dll` that performs the actual syscall transition. If the EDR can see the arguments to that stub, it can decide whether to allow, block, or log the operation before the kernel ever sees it.

This is the foundation of every modern Windows EDR. It is also the foundation of every technique that tries to defeat one.

## What a syscall stub actually looks like

Every syscall-capable function in `ntdll.dll` follows the same pattern. Take `NtAllocateVirtualMemory` on a clean Windows 10 22H2:

```asm
mov r10, rcx          ; 4C 8B D1
mov eax, 0x18         ; B8 18 00 00 00    <- the SSN (syscall service number)
test byte ptr [7FFE0308h], 1
jnz short +5
syscall               ; 0F 05
ret
```

The function is a template. It moves the first argument into `r10` (a quirk of how the Windows kernel expects syscall arguments), loads the SSN into `eax`, and executes `syscall`. The `test`/`jnz` branch is a legacy artifact of the old `int 2E` syscall path — on modern systems it always takes the `syscall` path.

The SSN is what matters. It is the index the kernel uses to dispatch the call. `NtAllocateVirtualMemory` is `0x18`; `NtCreateFile` is `0x55`; `NtProtectVirtualMemory` is `0x50`. These numbers are not arbitrary — they are the position of the function in the kernel's syscall table. They are also **not stable across Windows versions**. A stub that works on Windows 10 21H2 will call the wrong function on Windows 11 22H2 if the SSN shifted.

This is why hardcoding SSNs is a bad idea, and why runtime resolution — the technique behind Hell's Gate and SysWhispers3 — was such a step forward.

## How userland hooking is implemented

To hook a stub, the EDR overwrites the first few bytes of the function with a jump to its own handler:

```asm
ntdll!NtAllocateVirtualMemory:
    jmp <EDR_handler>      ; E9 xx xx xx xx
    ...                     ; rest of the original stub, now unreachable
```

When any process calls `NtAllocateVirtualMemory`, control flows into the EDR's code first. The EDR inspects the arguments, decides whether to allow the call, and if it does, either:
- Executes the original bytes and jumps back to `ntdll!NtAllocateVirtualMemory+5`, or
- Emulates the syscall transition itself.

The hook lives in userland, in the process's own address space. That is both its strength — no kernel driver needed — and its weakness, because userland memory is writable by the process.

This is the core insight that every bypass technique exploits: **a hook is just a byte patched into memory that you control**. If you can write those bytes back, you remove the hook. If you can bypass the hooked function entirely, the hook never fires.

## Technique one — Direct syscalls

The simplest bypass: don't call the hooked stub at all. Write your own stub with the same structure, but place it in your executable.

```asm
; NtAllocateVirtualMemory.asm
NtAllocateVirtualMemory PROC
    mov r10, rcx
    mov eax, 18h
    syscall
    ret
NtAllocateVirtualMemory ENDP
```

Compile this into your payload, call `NtAllocateVirtualMemory` from your own image, and the EDR hook in `ntdll.dll` is never touched. The syscall executes. The kernel receives it. The EDR sees nothing at the userland layer.

This is the technique behind the original SysWhispers (and the "direct mode" of SysWhispers3). It works, and it is easy to implement.

### Why it gets caught

The `syscall` instruction is now executing from **your image**, not from `ntdll.dll`. When the kernel returns control, the return address on the stack points into your executable's `.text` section.

An EDR that walks the call stack — and most modern ones do — sees a return address that is not inside any Windows system DLL. That is an immediate flag. Legitimate calls to `NtAllocateVirtualMemory` always originate from a small set of call sites: `kernel32!VirtualAlloc`, `kernelbase!VirtualAlloc`, or another system DLL. A return address in an unsigned, freshly-loaded executable is not one of them.

This is not a subtle detection. It is the first thing an EDR with stack-walking capability checks. Direct syscalls were effective around 2020. By 2022 they were firmly on the detection radar, and by 2024 they are essentially a known-signature technique.

## Technique two — Indirect syscalls

The fix for the direct syscall's problem is elegant: use the `syscall` instruction in `ntdll.dll`, but do not go through the hooked preamble.

The stub in `ntdll.dll` looks like this in memory after hooking:

```
ntdll!NtAllocateVirtualMemory:
    jmp EDR_handler         ; <- the hook
    ...

ntdll!NtAllocateVirtualMemory+0x12:
    syscall                 ; <- the real instruction, unhooked
    ret
```

The hook only replaces the first bytes. The `syscall; ret` at offset `+0x12` is untouched. An indirect syscall sets up `r10` and `eax` itself, then jumps directly to `+0x12`:

```asm
NtAllocateVirtualMemory PROC
    mov r10, rcx
    mov eax, 18h
    jmp [ntdll_NtAllocateVirtualMemory_plus_0x12]
NtAllocateVirtualMemory ENDP
```

The kernel now receives the syscall with a return address pointing **inside `ntdll.dll`**. To a stack walker, the return address looks legitimate — it is inside a signed Windows system DLL, at an offset that makes sense for a syscall.

This is the technique that SysWhispers3 implements with `--mode indirect`. It is also the default mode in most modern C2 frameworks that claim to evade userland hooks.

### Why it still gets caught

The return address inside `ntdll.dll` is legitimate. The **stack around it** is not.

When a normal application calls `VirtualAlloc`, the stack at the moment of the syscall looks roughly like this (simplified, growing upward):

```
kernel32!BaseThreadInitThunk+0x14     <- thread entry
kernel32!VirtualAlloc+0x43            <- wrapper
ntdll!NtAllocateVirtualMemory+0x12    <- syscall
```

An indirect syscall from your payload looks like:

```
some_module!my_function+0x87          <- your code
ntdll!NtAllocateVirtualMemory+0x12    <- syscall
```

The `kernel32` frame is missing. The `BaseThreadInitThunk` frame might still be there (if you are running in a standard thread), but the intermediate `kernel32!VirtualAlloc` frame is not. An EDR that validates the *entire* expected call chain — not just the top frame — sees this immediately.

This is what tools like `Hunt-Sleeping-Beacons` and advanced stack walkers look for. They are not checking whether the immediate return address is legitimate. They are checking whether the call chain matches any known-good pattern.

### The variant: randomizing the jump target

SysWhispers3 addresses one specific artifact of indirect syscalls: if every call jumps to `ntdll!NtXxx+0x12`, an EDR can fingerprint the pattern. Every syscall from your process has the same return address offset in `ntdll.dll`.

SysWhispers3 randomizes this. Instead of a fixed `+0x12`, it selects among a set of valid `syscall` gadget addresses inside `ntdll.dll` at runtime — some at `+0x12`, some elsewhere in the code section that also happen to have a `syscall; ret` sequence. The return address varies per call.

This defeats naive fingerprinting but does not defeat stack walking. The missing `kernel32` frame remains.

## Technique three — Unhooking

The other approach is to remove the hook entirely, so the original stub works again. Two variants:

### Variant A: restore from disk

Read `ntdll.dll` from `C:\Windows\System32\ntdll.dll`, map it into memory as a fresh image, and copy its `.text` section over the in-memory `.text` of the currently-loaded `ntdll.dll`. Every hook in the process's `ntdll` is now overwritten with clean bytes. The EDR's code still exists in memory (at the handler addresses) but is no longer reachable through the syscall stubs.

The problem: the restored bytes are correct, but the EDR still has a detection handle. If the EDR periodically checks the `.text` of loaded modules against their on-disk hashes (section integrity check), it sees that `ntdll` was modified. The EDR does not know *why* it was modified — but a runtime modification of a signed system DLL is not something legitimate software does.

### Variant B: load from `\KnownDlls`

The kernel maintains a set of "known DLLs" in a section object under `\KnownDlls\ntdll.dll`. This is a pristine, unpatched copy of the DLL that the kernel itself uses to map it into new processes. It is a `MEM_IMAGE` section, backed by a file.

An attacker can open this section and map a view into their own process:

```c
HANDLE hSection;
NtOpenSection(&hSection, SECTION_MAP_READ, ...);
NtMapViewOfSection(hSection, GetCurrentProcess(), &pView, ...);
```

Now the process has a second, clean copy of `ntdll.dll` in memory. Every syscall stub in this copy is unhooked. The attacker can call functions from this copy directly, and the EDR's hook is bypassed.

This is cleanly elegant. It is also the most detectable of the three techniques, because the loader's module list (`PEB->Ldr`) does not know about the second copy. Any EDR that walks loaded modules and cross-references them against memory regions finds an `ntdll` that does not belong to any registered module.

## Comparison

| Technique | Evades hook? | Immediate return address legitimate? | Full stack legitimate? | Main artifact |
|---|---|---|---|---|
| Direct syscall | Yes | No | No | Return address outside any loaded module |
| Indirect syscall | Yes | Yes | No | Missing `kernel32` frames in the stack |
| Unhooking (disk) | Yes | Yes | Yes | `.text` modified vs on-disk hash |
| Unhooking (KnownDlls) | Yes | Yes | Yes | Second `ntdll` not in loader module list |

The progression from top to bottom is a progression of diminishing returns. Direct syscalls are the easiest to detect. Unhooking via KnownDlls is the hardest, but requires the most implementation effort and leaves the most distinctive structural artifact.

There is no free lunch. Every technique trades one artifact for another. The question is which artifact the target EDR actually collects.

## Part five — how EDRs actually catch this

The detection side is where most offensive writeups stop too early. "This is detectable" is not useful. "This is detectable by *this specific telemetry*" is. Here is what is actually being collected in the field.

### Call stack walking

The most common. When a syscall enters the kernel, the EDR's kernel callback (often via ETW-Ti) captures the userland stack. The EDR then unwinds it — following each frame's return address and walking up — and validates each frame against a known-good call chain.

Two validations happen:
1. **Is each return address inside a mapped image?** (`MEM_IMAGE` rather than `MEM_PRIVATE` or `MEM_MAPPED`). Direct syscalls fail this.
2. **Does the chain of frames match a known legitimate sequence?** Missing intermediate frames (like `kernel32!VirtualAlloc`) fail this.

The second check is what kills indirect syscalls. Some EDRs maintain a database of valid call chains for common operations — a lookup table of "what does the stack look like when `NtAllocateVirtualMemory` is called legitimately". If the actual stack does not match any entry, alert.

### Intel Last Branch Record (LBR)

CPU-level. LBR records the last 8-32 branch instructions executed before the current one. When a syscall happens, the EDR can read the LBR and see the last jumps taken.

For an indirect syscall, the last jump is from the attacker's code directly to `ntdll!NtXxx+0x12`. A legitimate call would show a jump from `kernel32!VirtualAlloc` to `ntdll!NtAllocateVirtualMemory` (at offset 0, not 0x12). The LBR exposes the difference at the hardware level.

LBR is not enabled by default on all systems, and EDRs do not universally consume it. But on modern Intel CPUs with LBR support (Skylake onwards), it is available and some products use it.

### Section integrity

The EDR periodically hashes the `.text` section of loaded modules and compares against the on-disk file. Any mismatch — even a single byte — indicates runtime modification.

This catches:
- Classic unhooking (restoring from disk)
- Module stomping (overwriting another DLL's `.text`)
- In-memory patching of any kind

The check is expensive (hashing hundreds of MB every few seconds), so it is often done on-demand rather than continuously. But on suspicious events, it is triggered.

### Intel CET / Shadow Stack

The hardware-level protection. On CPUs that support CET (Intel 11th gen and later, AMD equivalent), the processor maintains a **shadow stack** — a second copy of return addresses that userland code cannot write to. Every `call` pushes to both stacks; every `ret` pops from both and verifies they match.

If they do not match, the CPU raises a fault and terminates the process. No EDR involvement required.

For indirect syscalls, this is a specific problem. The attacker's code does not perform a normal `call` to `ntdll!NtXxx+0x12` — it performs a `jmp`. The shadow stack never sees a return address for the jump. When the syscall returns, there is a mismatch between the normal stack (which has the `+0x12` return address, pushed manually or by the stub) and the shadow stack (which is empty or has a different value).

This is the reason CET is considered the endgame for userland syscall evasion. On CET-enabled systems, indirect syscalls and direct syscalls are architecturally broken, not just detectable.

CET adoption is uneven. Windows 10 does not enable it. Windows 11 supports it partially. Windows Server 2022+ supports it. Most enterprise environments are not running CET-enabled hardware and OS combinations in 2026, but this is changing.

### ETW-Ti (Threat Intelligence provider)

Microsoft's kernel-level ETW provider, exposed to EDR vendors via `Microsoft-Windows-Threat-Intelligence`. Unlike standard ETW, ETW-Ti cannot be disabled by userland code without a kernel driver.

ETW-Ti emits events for the operations that matter: memory allocation, memory protection changes, process creation, thread creation. When an EDR receives an ETW-Ti event, it does not need to trust the userland stack. The kernel tells it what happened.

The catch: ETW-Ti was designed for EDR vendors, and it emits *events*, not *prevention hooks*. An EDR that only consumes ETW-Ti can detect after the fact but cannot block. To block, it still needs a userland hook or a kernel minifilter.

This means ETW-Ti is a detection layer, not a prevention layer. Userland hooking is still where prevention happens, and therefore still where the bypasses matter.

## Part six — the detection position for a SOC

From a SOC analyst's perspective, here is what to instrument and what to expect:

**Enable the right telemetry first.** None of the following works without it:
- Sysmon Event ID 8 (`CreateRemoteThread`) and ID 10 (`ProcessAccess`).
- Windows Defender ASR rules if applicable (Block Win32 API calls from Office macros, etc).
- EDR-specific telemetry for stack-walk alerts — most products have a "suspicious call stack" or "unbacked memory" category that needs to be enabled and forwarded to the SIEM.
- ETW-Ti if the EDR exposes it (rare in SIEM integration, common in EDR console).

**Watch for specific process patterns.**
- A process that opens a handle to `ntdll.dll` for read access outside of normal startup.
- A process whose memory contains a second `ntdll` (visible in Process Hacker / API Monitor).
- Any process with executable `MEM_PRIVATE` regions. Legitimate JIT compilers exist, but they are a small allowlist.

**Treat direct and indirect syscall alerts as high-signal.** Most legitimate software does not implement its own syscall stubs. If an EDR alerts on a "suspicious syscall origin", the base rate of true positives is high.

**Expect the arms race to shift to hardware.** As CET and shadow stacks become more common, userland syscall evasion will require kernel-mode components or a fundamentally different technique. The transition is already starting.

## Takeaway

Every syscall bypass is a trade between one detection artifact and another. Direct syscalls move the `syscall` instruction into your image — easy to catch. Indirect syscalls hide the immediate return address but leave gaps in the call chain. Unhooking removes the hook but modifies memory that should not change.

The question is not "which is best". The question is "which artifact does the EDR on this engagement actually collect". That requires knowing the product, the configuration, and the telemetry pipeline — which is a defensive problem, not an offensive one.

Attackers win when defenders do not know what their tools see. Defenders win when they do.
