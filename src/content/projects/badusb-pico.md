---
title: "BadUSB — Turning a Raspberry Pi Pico into a Rubber Ducky"
description: "A unified setup guide for turning a Raspberry Pi Pico (or Pico W) into a USB HID device that executes pre-defined keystroke payloads — the hardware equivalent of a rubber ducky."
date: 2026-01-15
status: "public"
stack: [CircuitPython, Raspberry Pi Pico, USB HID, Python]
repo: "https://github.com/jonas-fernandez-as/BadUsb"
video: "https://youtu.be/EDICD2nYuo8"
---

## What a BadUSB is

A normal USB device tells the host what it is. A BadUSB lies. By presenting itself as a keyboard instead of a storage device, it can type arbitrary keystrokes into any machine that trusts the physical connection — no driver, no prompt, no user interaction beyond plugging it in.

The commercial version is the Hak5 Rubber Ducky. This project is the free version, built on a Raspberry Pi Pico running CircuitPython.

## Hardware

- Raspberry Pi Pico or Pico W (the guide targets the Pico W rev 2)
- USB cable
- A host computer to flash the firmware

Total cost: under €10.

## Setup flow

1. **BOOTSEL mode.** Hold the button, plug in, the board appears as `RPI-RP2`.
2. **Flash nuke (optional).** Copy `flash_nuke.uf2` to wipe the board clean. Recommended if it has been used before.
3. **CircuitPython firmware.** Copy the Adafruit CircuitPython `.uf2` for your board. It reboots as `CIRCUITPY`.
4. **HID library.** Copy `adafruit_hid/`, `adafruit_debouncer.mpy`, `adafruit_ticks.mpy`, and the `asyncio` folder into `/lib`.
5. **Interpreter.** Copy `duckyinpython.py`, `boot.py`, `code.py`, `webapp.py`, and `wsgiserver.py` to the root. Rename `duckyinpython.py` to `code.py`.
6. **Payload.** Drop a `.dd` file (Ducky Script) into the root and rename it `payload.dd`.

From this point on, plugging the Pico into any machine runs the payload automatically.

## Ducky Script

The payload language is a simplified scripting format. A classic example:

```
DELAY 1000
GUI r
DELAY 500
STRING powershell -w hidden
ENTER
DELAY 1000
STRING Write-Host "Hello from the Pico"
ENTER
```

This opens a Run dialog, launches PowerShell, and types a command. The entire sequence takes about three seconds.

## Keyboard layout problem

By default, payloads assume a **US English** layout. On a Spanish keyboard, `"` becomes `@`, `:` becomes `>`, and so on. Three solutions:

1. **Change the target's layout** to US English before running. Only works if you have access.
2. **Edit `code.py`** to load a different layout. Uncomment the layout lines, set `LANG = "es"`, and make sure `adafruit_hid/keyboard_layout_es.py` exists.
3. **Translate manually.** Run a test payload with every symbol, note the mismatches, and rewrite the payload. Slow but reliable.

## Why this matters for defenders

A BadUSB bypasses almost every software control:

- **Antivirus** does not see it — it is a keyboard, not a file.
- **Application allowlisting** does not stop it — the typed commands run as the logged-in user.
- **Endpoint DLP** may catch it, but only if configured for it.

The real controls are physical:

- **Disable unused USB ports** via BIOS or endpoint policy.
- **USB device allowlisting** (Windows Defender Device Control, macOS `com.apple.security.device.usb`).
- **Lock the screen when leaving the desk.** A BadUSB needs an unlocked session.
- **Educate users** on not plugging in unknown USB devices. The delivery vector is still a human one.

## Guardrails

The payloads in this repository are benign — they open Notepad, write text, or play a rickroll. The goal is to demonstrate the attack surface, not to deliver a payload. Every test was run against a machine I own, in an isolated environment.
