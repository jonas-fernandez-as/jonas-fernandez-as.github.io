---
title: "BadUSB — Turning a Raspberry Pi Pico into a Rubber Ducky"
description: "A complete setup guide for turning a Raspberry Pi Pico (or Pico W) into a USB HID device that executes pre-defined keystroke payloads. Includes the keyboard layout problem, payload syntax, and the defensive controls that actually work."
date: 2026-01-15
status: "public"
category: "Hardware"
stack: [CircuitPython, Raspberry Pi Pico, USB HID, Python, Ducky Script]
repo: "https://github.com/jonastrikex/BadUsb"
video: "https://youtu.be/EDICD2nYuo8"
tags: [badusb, hardware, usb-hid, physical-access, rubber-ducky, circuitpython]
---

## What a BadUSB is

A normal USB device tells the host what it is. A flash drive identifies itself as mass storage. A keyboard identifies itself as a HID (Human Interface Device). The host trusts the identification and loads the appropriate driver. This trust model was designed in the 1990s, when USB was a convenience feature for peripheral connections and the assumption was that anything plugged in was what it claimed to be.

A BadUSB lies about what it is. By presenting itself as a keyboard instead of a storage device, it can type arbitrary keystrokes into any machine that trusts the physical connection — no driver prompt, no user interaction beyond plugging it in. From the host's perspective, it is not an attack. It is a very fast typist.

The commercial implementation is the Hak5 Rubber Ducky, which costs around €80 and requires a proprietary scripting language. This project is the free alternative, built on a Raspberry Pi Pico running CircuitPython. The hardware is €5. The firmware is open source. The result is functionally equivalent for the vast majority of use cases.

This writeup covers the full setup process, the parts that go wrong, and the defensive controls that actually stop the technique — including the ones people assume work but don't.

## Part one — why this works

The technique exploits a specific property of the USB HID specification: **keyboards are trusted by default**. When Windows, macOS, or Linux detects a USB HID device, it does not challenge it. It does not ask the user to confirm the device. It does not run an antivirus scan. It loads the standard HID driver and starts accepting input.

This is by design. The alternative — prompting the user every time a keyboard is plugged in — would be unusable. The assumption is that physical access implies authorization, and physical access to a keyboard means the user plugged it in themselves.

A BadUSB breaks this assumption in a subtle way. The device is physically a Raspberry Pi Pico. To the operating system, it presents as a standard HID keyboard with a vendor ID and product ID that the Pico can be configured to report as anything. The operating system has no way to distinguish it from a legitimate keyboard.

From the moment the device is plugged in, the operating system treats its input as authoritative. Keystrokes typed by the Pico are keystrokes typed by a user. This means they run with the full context of the logged-in user — no privilege boundary, no sandbox, no additional authentication.

The implication is significant: an attacker who can physically plug a BadUSB into a machine can execute arbitrary commands as the logged-in user, without knowing any password, without triggering any authentication prompt.

## Part two — the hardware

The Raspberry Pi Pico is a microcontroller board released by the Raspberry Pi Foundation in 2021. The original Pico uses the RP2040 chip, which has two ARM Cortex-M0+ cores, 264 KB of RAM, and 2 MB of flash. The Pico W adds WiFi (via the CYW43439 chip) and is the version this guide targets — the WiFi capability is not required for BadUSB functionality, but it enables additional attacks (remote payload delivery, exfiltration) that the non-WiFi version cannot perform.

The board's form factor is a small PCB roughly 21mm by 51mm, with a micro-USB port on one end and 40 pins in the standard Raspberry Pi GPIO layout. It is small enough to fit inside a USB enclosure, which is why it is popular for this use case.

The board also has a physical button labeled **BOOTSEL**. This button is critical for the setup process — holding it while plugging the board in puts the Pico into a special bootloader mode where it appears as a mass storage device instead of running any firmware.

The board's power consumption is low enough that it can run off USB power with no additional components. There is no battery, no antenna, no external wiring. From the outside, the Pico looks like a small piece of electronics.

## Part three — the setup, step by step

The setup process is the fiddly part. Once complete, the Pico becomes a keyboard on every subsequent plug-in. The setup must be performed carefully, and the most common problems come from skipping steps.

### Step 1 — BOOTSEL mode

Hold down the BOOTSEL button on the board while plugging the micro-USB cable into a computer. The board will appear as a mass storage device named `RPI-RP2`. Release the button.

If the drive does not appear, the button was not held correctly or the cable is power-only. Check both before proceeding.

### Step 2 — Flash nuke (optional but recommended)

If the board has been used before, it may have old firmware that will interfere with the CircuitPython installation. The `flash_nuke.uf2` file wipes the board's flash completely.

The file is available from the Adafruit CircuitPython download page. Copy it to the `RPI-RP2` drive. The board will reboot automatically — the drive will disappear and reappear within a few seconds.

If this is a fresh board, this step can be skipped. If the board has any prior firmware, run it.

### Step 3 — CircuitPython firmware

CircuitPython is a version of Python that runs directly on microcontrollers. It is maintained by Adafruit and is the runtime that the pico-ducky project uses.

Download the correct `.uf2` file for your board from the CircuitPython website. For the Pico W, the file is named something like `adafruit-circuitpython-raspberry_pi_pico_w-en_US-10.0.0.uf2`. The version number will be higher by the time this is read.

Copy the `.uf2` file to the `RPI-RP2` drive. The board will reboot. The drive will reappear with the name `CIRCUITPY`.

**A note on the Pico W rev 2:** the pico-ducky project has specific support requirements, and the second revision of the Pico W has a different chip revision that some firmware builds do not support. If the `CIRCUITPY` drive does not appear, verify the board revision. The rev 2 board is what this guide targets.

### Step 4 — the HID library

CircuitPython does not include USB HID support by default. The `adafruit_hid` library is a pure-Python implementation that adds the necessary classes.

Download the Adafruit CircuitPython bundle for the version of CircuitPython installed on the board. Extract the bundle. Navigate to `lib/`. Copy the following into the `lib/` folder on the `CIRCUITPY` drive:

- `adafruit_hid/` — the HID library itself
- `adafruit_debouncer.mpy` — a utility used by the library
- `adafruit_ticks.mpy` — a utility used by the library

The pico-ducky project also requires additional files at the root of the `CIRCUITPY` drive:

- `boot.py` — runs at board startup, sets up the USB interface
- `duckyinpython.py` — the payload interpreter
- `code.py` — the entry point (must be a copy or rename of `duckyinpython.py`)
- `webapp.py` — a web interface for managing payloads (only for Pico W)
- `wsgiserver.py` — a lightweight web server for the web interface

These files are in the pico-ducky repository. Copy them to the root of the drive.

### Step 5 — install the interpreter

The interpreter is `duckyinpython.py`. To make it run at boot, it must be renamed to `code.py`. If a `code.py` already exists, delete it first.

After renaming, the Pico will execute `code.py` on every power-up. From this point forward, plugging the Pico into any computer will trigger the payload execution.

### Step 6 — the payload

Payloads use the Ducky Script syntax. A minimal payload:

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

Save this as `payload.dd` at the root of the `CIRCUITPY` drive.

The Ducky Script commands used here:

- `DELAY <ms>` — pause for the specified number of milliseconds
- `GUI <key>` — press the Windows key (or Cmd on macOS) plus the specified key
- `STRING <text>` — type the specified text literally
- `ENTER` — press Enter

Additional commands worth knowing:

- `CTRL`, `ALT`, `SHIFT`, `WINDOWS` — modifier keys for combinations like `CTRL ALT DELETE`
- `REPEAT <n>` — repeat the last command n times
- `DEFAULTDELAY <ms>` — set a default delay applied between commands
- `REM <comment>` — a comment that the interpreter ignores
- `STRINGLN <text>` — type text and press Enter

The full Ducky Script reference is in the Hak5 documentation. The pico-ducky interpreter supports most of it, with minor differences.

### Step 7 — test

Unplug the Pico. Plug it into the target machine. The payload runs automatically. For the minimal example above, PowerShell opens hidden, prints a message, and closes.

For editing or resetting the board, hold BOOTSEL while plugging in. The `RPI-RP2` drive appears instead of `CIRCUITPY`. From here, files can be modified or the board can be re-flashed.

## Part four — the keyboard layout problem

The single most common failure in BadUSB payload development is the keyboard layout mismatch.

By default, the pico-ducky interpreter assumes a US English keyboard layout. When a payload types `"` (double quote), the interpreter sends the USB HID scan code for the key that occupies the US English `"` position. On a Spanish keyboard, that physical key produces `@`, not `"`. The payload types the wrong character.

This breaks any command that relies on special characters — URLs, PowerShell flags, file paths with backslashes, and most of the punctuation that appears in real payloads.

Three solutions:

**Change the target's layout to US English.** If the attacker has access to the target before execution (which they usually do, since they are physically present to plug the USB in), they can change the keyboard layout in the OS settings. This is disruptive and often leaves traces in the event log, but it works.

**Edit `code.py` to load a different layout.** The `adafruit_hid.keyboard_layout_es` module (for Spanish) or the equivalent for other layouts provides a translation layer. Uncomment the relevant lines in `code.py`, set the layout code (`es` for Spanish, `de` for German, `fr` for French, etc), and save. The interpreter will translate US English Ducky Script into the target layout's scan codes.

The exact lines to modify depend on the CircuitPython version. They look something like:

```python
from adafruit_hid.keyboard_layout_es import KeyboardLayoutES
kbd = KeyboardLayoutES(usb_hid.devices)
```

with the corresponding US English lines commented out.

**Translate the payload manually.** Run a test payload that types every symbol:

```
STRING ~!@#$%^&*()_+{}|:"<>?`-=[]\;',./
```

Note which characters appear incorrectly on the target. Build a translation table and rewrite the payload accordingly. For a Spanish keyboard, `"` becomes `@`, `:` becomes `>`, and so on. This is slow but reliable and produces payloads that work regardless of the target's settings.

The third approach is what most professional BadUSB developers use for actual engagements. The first is a fallback when the target is accessible. The second is a convenience that works in some cases and not others.

## Part five — the Pico W web interface

The Pico W version supports an additional feature: a web interface for managing payloads over WiFi.

The `webapp.py` and `wsgiserver.py` files provide a small HTTP server that runs on the Pico. Once configured with WiFi credentials in `boot.py`, the Pico exposes a web interface on its IP address. The interface allows the attacker to:

- List installed payloads
- Upload new payloads
- Select which payload to execute on next plug-in
- View logs of previous executions

This is useful for red team engagements where the payload needs to change between targets. Instead of re-flashing the Pico for each target, the attacker connects to the web interface from a phone or laptop and switches the active payload.

The security implication: the Pico W in this mode is a small WiFi access point that an attacker controls, present in the environment for the duration of the engagement. A wireless intrusion detection system might catch it, though the detection depends on whether the environment is monitoring for rogue access points.

## Part six — what attackers actually do with this

The technique is flexible, and the payload determines the impact. Common uses:

**Credential dumping.** A payload that runs a script downloading and executing a credential extraction tool — similar in spirit to the USB Stealer project, but automated via keystrokes rather than a pre-loaded script.

**Reverse shells.** A payload that runs a one-liner to establish a reverse shell from the target back to the attacker's infrastructure. The classic PowerShell reverse shell is the canonical example.

**Persistence installation.** A payload that adds a scheduled task, registry key, or startup folder entry that survives reboots. This transforms a one-time BadUSB execution into ongoing access.

**Ransomware staging.** A payload that downloads and executes ransomware. This is the highest-impact use case and the rarest in practice, because it is also the most likely to attract law enforcement attention.

**Reconnaissance.** A payload that collects system information — hostname, username, domain, installed software — and exfiltrates it via HTTP or DNS. Low-impact, useful for the reconnaissance phase of an engagement.

**Physical disruption.** A payload that opens every application on the desktop, changes the wallpaper, or plays a video at full volume. This is the "prank" use case that appears in most YouTube demonstrations. The technical mechanism is the same; the impact is intentionally harmless.

The pico-ducky project ships with a small library of example payloads. The Hak5 payload repository is the definitive source for more, and it includes a range of difficulty and impact levels.

## Part seven — detection

BadUSB is one of the hardest techniques to detect with software because, from the operating system's perspective, nothing unusual is happening. Keystrokes are keystrokes. Commands are commands. The fact that they originate from a microcontroller rather than a human is not visible to the OS.

That said, there are detection opportunities.

### USB device identification

Every USB device reports a vendor ID (VID) and product ID (PID). The Raspberry Pi Foundation has a registered VID (`0x2E8A`), and the Pico reports specific PIDs depending on the firmware configuration. An EDR that maintains an allowlist of known USB devices can flag unrecognized VIDs.

The limitation: the VID and PID are set by the firmware and can be changed. A sophisticated attacker configures the Pico to report the VID and PID of a legitimate keyboard manufacturer — Logitech, Microsoft, Dell — and the device appears as a trusted keyboard. Device identification catches the lazy implementation, not the careful one.

### USB device classes

A more reliable signal is the USB device class. Keyboards present as HID class devices (class code 0x03). A new HID device connecting to a machine that has a built-in keyboard is anomalous on most systems.

Sysmon Event ID 20001 or Windows event ID 6416 (device connected) can capture USB device connections. The event includes the device class, and a filter that excludes the classes of devices a user normally connects (storage, audio) and alerts on HID can catch BadUSB.

### Behavioral signals

The most powerful detection is behavioral. A payload types commands, and those commands have to come from somewhere. Detection opportunities:

- **Keystroke speed.** A BadUSB types at hundreds of characters per second. A human types at five to ten. An endpoint agent that measures inter-keystroke timing catches this easily.
- **Command content.** A payload that runs `powershell -w hidden -ep bypass -enc <base64>` is not normal user behavior. The command-line telemetry (Sysmon Event ID 1) captures this and can be alerted on.
- **Process lineage.** A command that spawns `powershell.exe` from `explorer.exe` (or from whatever process has focus) at an unusual time is worth investigating. The parent process for a BadUSB-typed command is typically the shell or the focused application, which may not normally spawn PowerShell.
- **Application focus.** A BadUSB types into whatever has focus. If the payload opens the Run dialog with `GUI r`, the process chain is `explorer.exe → powershell.exe` shortly after a Run dialog appears. In an environment where this pattern does not normally occur, it is a signal.

None of these is a perfect detector. The combination — a HID device connected, a command with suspicious content, and a process chain consistent with BadUSB execution — is strong evidence.

## Part eight — defense

The controls that actually work, ordered by effectiveness:

**Disable unused USB ports.** BIOS-level or OS-level. If the port is not enabled, the device cannot connect. This is the most reliable control and the one most commonly skipped. In environments where users do not need USB peripherals beyond a keyboard and mouse, disabling the remaining ports has almost no operational cost.

**USB device allowlisting.** Windows Defender Device Control or an equivalent enterprise product maintains an allowlist of approved USB devices by VID/PID. Unrecognized devices are blocked at connection. This is more flexible than disabling ports entirely and is the standard for enterprise environments.

**Endpoint detection with keystroke timing analysis.** Some EDRs monitor keystroke timing and flag abnormally fast input. This is uncommon, but where it exists, it catches BadUSB reliably.

**Application allowlisting.** Windows AppLocker or WDAC restricts which executables can run. A payload that tries to launch an unauthorized binary is blocked at execution. A payload that uses only allowed binaries (PowerShell, cmd) still runs — but constraining the payload to allowed tools is often enough to prevent meaningful damage.

**Screen lock when leaving the desk.** The BadUSB needs an unlocked session to be useful. If the machine locks when the user walks away, the payload runs against the lock screen and cannot interact with the user's session. This is the single most practical control and the one that depends most on user behavior.

**Physical port locks.** For kiosks and similar fixed-purpose systems, physical USB port blockers prevent unauthorized device connection. Not practical for general workstations, but effective in specific contexts.

**User awareness.** The weakest control. Users will plug in unknown USB devices. Training has value at the margins but does not replace technical controls.

## Part nine — what this is not

A few honest clarifications:

**Not a novel technique.** BadUSB has been public since 2014. The Raspberry Pi Pico implementation is well documented. The value of this project is in the accessibility and the demonstration, not the discovery.

**Not stealthy against a prepared defender.** An environment with USB device allowlisting, endpoint detection for keystroke anomalies, and application allowlisting will detect or block this. An environment with none of those controls will not.

**Not a remote attack.** The attacker must physically insert the device. This is a post-perimeter technique — it assumes the attacker is already inside the physical facility. It is a lateral movement and persistence tool, not an initial-access vector.

**Not a persistence mechanism on its own.** The payload runs once. If the attacker wants ongoing access, the payload must install persistence itself — a scheduled task, a registry key, a service.

## Part ten — the broader lesson

BadUSB is a reminder that physical security and cyber security are not separate domains. Every endpoint control — EDR, antivirus, disk encryption — is downstream of the assumption that the person using the machine is the person authorized to use it. Physical access to an unlocked machine invalidates that assumption in a single USB insertion.

The most sophisticated network defense cannot stop a device that the operating system believes is a keyboard. The controls that matter are physical and configuration-level: disable unused ports, allowlist known devices, lock screens aggressively. These are unglamorous and easy to postpone. They are also the only controls that actually work.

The correct response to a BadUSB is not a better antivirus. It is a USB port that doesn't accept unknown devices and a screen that locks when the user walks away. Everything else is a partial mitigation of a problem that should not exist.

## Takeaway

The Raspberry Pi Pico costs five euros and turns into a Rubber Ducky in about fifteen minutes of setup. The technique it enables is not new, not sophisticated, and not hard to detect — if the environment is watching for it. The environments that are not watching for it are the ones that discover the technique when it is used against them.

The cost of defense is low. The cost of not defending is a credential dump, a reverse shell, or a ransomware deployment that runs as the logged-in user in under five seconds. The asymmetry favors the attacker only until the defender decides to close the gap.
