---
title: "Educational Ransomware PoC — Anatomy of File Encryption"
description: "A minimal ransomware written in C for Linux, built to understand symmetric encryption, C2 check-in, and the exact telemetry each stage produces on the endpoint."
date: 2025-12-19
status: "research"
stack: [C, OpenSSL, libcurl, Linux, Cryptography]
repo: "https://github.com/jonas-fernandez-as/simple-ransomware-poc"
video: "https://youtu.be/JU9z9T79F5k"
---

## Why this exists

Reading about ransomware is not the same as building one. The goal of this PoC is to demystify the mechanics — file enumeration, AES encryption, key handling, C2 check-in — so that defenders can reason about detection from the inside out.

This is the code behind the video *"I built a virus that kidnaps all your files — this is how it works"*. It is intentionally simple. No packer, no evasion, no anti-analysis. Every stage is commented.

## Architecture

Three components:

1. **The ransomware binary** (`files/linux/safer.c`) — enumerates a target directory, encrypts each file with AES via OpenSSL, drops a ransom note, and beacons to a C2 server via libcurl.
2. **The decryption tool** (`decrypt/decrypt.c`) — takes the 32-byte key in hex and restores files. This exists because the experiment is controlled; a real ransomware would not ship a decryptor.
3. **The C2 server** (`server/server.py`) — a Flask app that logs check-ins. Used only to demonstrate that the binary phones home.

## Encryption flow

For each file:

```c
EVP_EncryptInit_ex(ctx, EVP_aes_256_cbc(), NULL, key, iv);
```

A random 32-byte key and 16-byte IV are generated once per run. Files are read, encrypted, written back with a `.locked` extension, and the original is removed. The key is sent to the C2 server — in a real attack it would be wrapped with RSA so only the operator can recover it.

## Compilation

```bash
sudo apt install build-essential libssl-dev libcurl4-openssl-dev
cd files/linux
gcc -o ransom_linux safer.c -lssl -lcrypto -lcurl -pthread -O3 -Wall
```

Optional obfuscation for demo purposes (strip symbols, UPX compression). Not required, and both are detectable trivially.

## What it teaches about detection

Each phase of execution leaves a distinct artifact:

| Phase | Observable signal |
|---|---|
| Directory traversal | Rapid `openat`/`readdir` calls across many files |
| Key generation | `RAND_bytes` from a non-standard process |
| Encryption | `EVP_EncryptUpdate` followed by `write` with high-entropy output |
| File rename | Mass `rename()` calls with `.locked` suffix |
| C2 check-in | Outbound HTTP POST to an unfamiliar host |

The point is not that these signals are subtle — they are not. The point is that **a defender who has not written one of these does not know which signals to prioritize**. Building it forces that prioritization.

## Guardrails

- **Linux only.** The Windows and macOS ports are placeholders and are not functional.
- **No network deployment.** The C2 server binds to localhost and is intended to run inside an isolated VM.
- **No persistence, no lateral movement, no privilege escalation.** This is file encryption and nothing else.
- **Decryptor included.** Recovery is always possible with the key held by the operator.

## Lessons learned

1. **Ransomware is not sophisticated at the encryption layer.** AES-256-CBC is ten lines of OpenSSL. The complexity is in distribution, evasion, and monetization — none of which this PoC attempts.
2. **Backups are the only real defense.** A defender who can restore from an offline copy is not negotiating.
3. **The C2 is the weakest link.** An operator who does not hide their beacon gives defenders a domain to block and pivot from.
