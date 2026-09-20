---
title: "Self-Hosted VPN — OpenVPN on a VPS, From Scratch"
description: "Rolling your own VPN instead of trusting a provider: SSH hardening, OpenVPN setup, certificate management, and the honest trade-offs — maintenance, attribution, and what a self-hosted tunnel does and does not protect against."
date: 2026-06-26
type: "Guide · Infrastructure"
category: "Infrastructure"
difficulty: "Intermediate"
readingTime: 24
video: "https://youtu.be/ctk3pk_DHzU"
tags: [vpn, openvpn, vps, ssh, hardening, privacy, self-hosted]
---

## Why self-host a VPN

Commercial VPNs are a commodity. A subscription buys access to a network of servers in dozens of countries, a polished client app, and a privacy policy that claims the provider does not log. For most users, that is a reasonable trade: a few euros a month, zero maintenance, and a service that works.

The trade-off is trust. A commercial VPN terminates your encrypted traffic at their server. They can see your IP address, the timing of your connections, the volume of your traffic, and — unless the traffic is also encrypted at the application layer (HTTPS, TLS) — its content. Their privacy policy may promise not to log, but the promise is unverifiable, and several providers have been caught breaking it, coerced by courts, or acquired by companies with different privacy postures.

A self-hosted VPN moves the trust from the provider to yourself. You rent a VPS, you install the VPN software, and you control the server. There is no third party who can be subpoenaed, no logging policy to trust, and no client app that might have been compromised. The trade-off is that you are now responsible for the maintenance, the configuration, and the security of the server.

This writeup covers the full setup: VPS selection, SSH hardening, OpenVPN installation, certificate management, firewall configuration, and the honest assessment of what a self-hosted VPN actually protects against. It is based on a common setup that has been documented in countless tutorials, but the security analysis is what most tutorials leave out.

## Part one — VPS selection

The VPS is the foundation. The choice matters because it determines the cost, the performance, and the trust model.

**Provider choice.** The major providers — Hetzner, DigitalOcean, Linode (now Akamai), Vultr, OVH — all offer comparable VPS plans in the €4–6 per month range with 1 vCPU, 1GB RAM, and 20–40GB of SSD storage. That is more than sufficient for a VPN that serves a handful of clients. Higher-tier plans matter only if the VPN is expected to serve many concurrent users or handle high bandwidth.

**Jurisdiction.** The provider's jurisdiction determines what legal process can compel the disclosure of data. A provider in a jurisdiction with strong privacy protections and a track record of resisting overbroad requests is preferable to one in a jurisdiction with weak protections. This is a consideration, not a decisive factor — a self-hosted VPN with no logs and no client list has little to disclose regardless of the jurisdiction.

**Payment method.** A provider that accepts cryptocurrency or anonymous payment methods allows the VPS to be rented without a personal identity being attached. Providers that require identity verification (KYC) — increasingly common, driven by regulatory pressure — eliminate this option. The choice depends on the threat model: for a user who simply wants their own VPN, KYC is fine; for a user who needs the VPN to be anonymous, KYC is a problem.

**The alternative: dedicated hardware in a datacenter.** A variation on the same idea is to colocate a small physical server in a datacenter rather than renting a virtual one. This is more expensive and more involved, but it eliminates the hypervisor as a trust point — the datacenter operator provides power and network, but cannot inspect the running machine. It is overkill for most users.

## Part two — SSH hardening

The first thing to configure on a fresh VPS is SSH. The default configuration on most distributions is functional but not secure: it uses the standard port (22), and it accepts password authentication. Both are attack surfaces.

The hardening has two parts: change the port and switch to key-only authentication.

**Part 2a — SSH keys.**

If you do not already have an SSH key pair, generate one on your local machine:

```bash
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/vpn_server
```

The `-t ed25519` flag specifies the key type. Ed25519 is the modern choice — smaller keys, faster operations, and no known weaknesses. RSA is the legacy option; it works but is slower and larger. The `-a 100` flag specifies the number of KDF rounds, which slows down brute-force attempts against a stolen private key. The `-f` flag sets the filename.

The command produces two files: `vpn_server` (the private key) and `vpn_server.pub` (the public key). The private key stays on your local machine and is never transmitted. The public key goes on the server.

**Part 2b — copy the key to the server.**

The initial connection to a fresh VPS uses password authentication. Use that one time to copy the public key:

```bash
ssh-copy-id -i ~/.ssh/vpn_server.pub root@<server-ip>
```

The `ssh-copy-id` command appends the public key to `~/.ssh/authorized_keys` on the server. After this, you can connect using the key instead of the password:

```bash
ssh -i ~/.ssh/vpn_server root@<server-ip>
```

**Part 2c — disable password authentication.**

Once key-based login is confirmed working, edit the SSH daemon configuration:

```bash
sudo nano /etc/ssh/sshd_config
```

Change the following lines:

```
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
```

The first disables password authentication entirely. The second ensures key authentication is enabled (which it should be by default). The third prevents root from logging in with a password while still allowing key-based root login — a middle ground. Some guides recommend `PermitRootLogin no` entirely and creating a separate user; that is more secure but requires additional setup. For a personal VPS, `prohibit-password` is a reasonable compromise.

**Part 2d — change the SSH port.**

Edit the same file and uncomment or add:

```
Port 22022
```

Choose a port above 1024 and below 65535, avoiding well-known service ports (80, 443, 3306, 8080, etc.). The exact number is not important — any non-standard port eliminates the vast majority of automated scanning and brute-force attempts, which target port 22 by default.

After changing the config, restart the SSH daemon:

```bash
sudo systemctl restart sshd
```

**Important:** before closing your current session, open a second terminal and verify that the new configuration works. If you disable password authentication and lock yourself out, recovering access requires contacting the provider and using a recovery console. Verify first, disconnect second.

**Part 2e — install fail2ban.**

Fail2ban monitors authentication logs and blocks IP addresses that fail authentication repeatedly. Even with password authentication disabled, a basic fail2ban installation reduces log noise and blocks scanners:

```bash
sudo apt install fail2ban
sudo systemctl enable fail2ban
```

The default configuration is usually sufficient. For finer control, adjust `/etc/fail2ban/jail.local`.

## Part three — OpenVPN installation

OpenVPN is the traditional choice for self-hosted VPNs. WireGuard is the modern alternative — faster, simpler, and easier to configure — but it has different characteristics that some use cases do not accommodate. This writeup covers OpenVPN because it is the one in the video, and because it remains the most widely supported option.

**Part 3a — install the server package.**

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install openvpn easy-rsa
```

The `easy-rsa` package provides the scripts for managing the certificate authority, which is how OpenVPN authenticates clients and servers.

**Part 3b — set up the certificate authority.**

Easy-RSA expects its configuration in a specific directory. Copy the templates:

```bash
make-cadir ~/openvpn-ca
cd ~/openvpn-ca
```

Edit the `vars` file to set the certificate parameters (country, province, organization, email). These appear in the generated certificates and are not functionally important, but they should be set consistently:

```bash
nano vars
```

The `KEY_NAME`, `KEY_OU`, and `KEY_CN` values are the important ones — they affect the file names and the certificate subjects.

**Part 3c — build the CA and server certificates.**

Source the variables and run the build scripts:

```bash
source vars
./clean-all
./build-ca
```

The `build-ca` command generates the root certificate authority. You will be prompted for a passphrase — use a strong one and remember it.

Next, build the server certificate:

```bash
./build-key-server server
```

The `server` argument sets the common name to "server", which must match the OpenVPN server configuration.

Generate the Diffie-Hellman parameters, which are used for key exchange:

```bash
./build-dh
```

This step takes several minutes — the DH parameter generation is intentionally slow.

Generate the HMAC signature to protect against TLS vulnerabilities:

```bash
openvpn --genkey secret ta.key
```

**Part 3d — build client certificates.**

For each client (each device that will connect), generate a separate certificate:

```bash
./build-key client1
./build-key client2
./build-key client3
```

Each certificate is unique. If a device is lost or compromised, its certificate can be revoked without affecting the others. This is the fundamental advantage of certificate-based authentication over shared keys.

## Part four — server configuration

OpenVPN needs a server configuration file and a set of files from the CA directory.

**Part 4a — copy the server files.**

```bash
sudo cp ~/openvpn-ca/keys/ca.crt /etc/openvpn/
sudo cp ~/openvpn-ca/keys/server.crt /etc/openvpn/
sudo cp ~/openvpn-ca/keys/server.key /etc/openvpn/
sudo cp ~/openvpn-ca/keys/dh2048.pem /etc/openvpn/
sudo cp ~/openvpn-ca/keys/ta.key /etc/openvpn/
```

**Part 4b — write the server configuration.**

Create `/etc/openvpn/server.conf`:

```
port 1194
proto udp
dev tun

ca ca.crt
cert server.crt
key server.key
dh dh2048.pem
tls-auth ta.key 0

server 10.8.0.0 255.255.255.0
ifconfig-pool-persist ipp.txt

push "redirect-gateway def1 bypass-dhcp"
push "dhcp-option DNS 1.1.1.1"
push "dhcp-option DNS 1.0.0.1"

keepalive 10 120
cipher AES-256-GCM

user nobody
group nogroup
persist-key
persist-tun

status openvpn-status.log
verb 3
```

The key directives:

- `dev tun` — creates a routed tunnel (as opposed to a bridged one). Routed is the correct choice for a VPN.
- `tls-auth ta.key 0` — adds an HMAC signature to every packet, which defeats DoS attacks against the TLS handshake and provides an additional layer of authentication.
- `push "redirect-gateway def1 bypass-dhcp"` — tells the client to route all traffic through the VPN. Without this, only traffic to the VPN subnet goes through the tunnel.
- `push "dhcp-option DNS ..."` — tells the client to use the specified DNS servers. Using a public resolver like 1.1.1.1 avoids leaking DNS queries to the client's ISP.
- `cipher AES-256-GCM` — specifies the encryption algorithm. AES-256-GCM is the current standard, authenticated and fast on modern CPUs.
- `user nobody` and `group nogroup` — drops privileges after initialization, so that a compromise of OpenVPN does not immediately grant root.

**Part 4c — enable IP forwarding.**

The server needs to forward packets between the VPN interface and the public interface:

```bash
sudo nano /etc/sysctl.conf
```

Uncomment or add:

```
net.ipv4.ip_forward=1
```

Apply the change:

```bash
sudo sysctl -p
```

**Part 4d — configure NAT.**

The server must translate packets from the VPN subnet to the public interface:

```bash
sudo iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
```

Replace `eth0` with the actual public interface name (`ip a` shows the interfaces). To make the rule persistent across reboots, use `iptables-persistent`:

```bash
sudo apt install iptables-persistent
sudo netfilter-persistent save
```

**Part 4e — start the server.**

```bash
sudo systemctl start openvpn@server
sudo systemctl enable openvpn@server
```

Check the status:

```bash
sudo systemctl status openvpn@server
```

## Part five — client configuration

The client needs the CA certificate, its own certificate and key, and the `ta.key`.

**Part 5a — create the client configuration file.**

Create a file (e.g., `client1.ovpn`) with the following content:

```
client
dev tun
proto udp
remote <server-ip> 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
verb 3

<ca>
-----BEGIN CERTIFICATE-----
... contents of ca.crt ...
-----END CERTIFICATE-----
</ca>

<cert>
-----BEGIN CERTIFICATE-----
... contents of client1.crt ...
-----END CERTIFICATE-----
</cert>

<key>
-----BEGIN PRIVATE KEY-----
... contents of client1.key ...
-----END PRIVATE KEY-----
</key>

<tls-auth>
-----BEGIN OpenVPN Static key V1-----
... contents of ta.key ...
-----END OpenVPN Static key V1-----
</tls-auth>
key-direction 1
```

The inline format embeds all the certificates into a single file, which is convenient for distribution. The `key-direction 1` directive must match the `0` on the server side.

**Part 5b — distribute the file.**

The `.ovpn` file contains the client's private key. It must be transmitted securely — not over email, not over a chat that retains history. Options: physical transfer (USB drive), encrypted email, or a self-destructing message service.

**Part 5c — install the client.**

On desktop, install the OpenVPN client (`openvpn` package on Linux, OpenVPN Connect on Windows/macOS). Import the `.ovpn` file and connect. On mobile, OpenVPN Connect (iOS/Android) accepts the same file.

## Part six — what this protects against (and what it does not)

The honest assessment of a self-hosted VPN's security properties.

**What it protects against:**

- **ISP monitoring.** The ISP sees only an encrypted connection to the VPS. The destination of the traffic, the DNS queries, and the content of unencrypted protocols are all hidden.
- **Local network monitoring.** On a public WiFi network, the VPN prevents other users from observing the traffic.
- **IP-based tracking.** Websites see the VPS's IP address instead of the client's home IP. Cross-site tracking that relies on IP correlation is disrupted.
- **Geographic restrictions.** The VPS's location determines the apparent geographic origin of the traffic.

**What it does not protect against:**

- **The VPN provider.** In this case, the "provider" is yourself, so the risk is minimal. But if the VPS is rented from a third party, the hypervisor operator can theoretically observe the VPS's traffic. For most users, this is not a concern; for a high-threat model, it is.
- **Device identification.** As covered in the GDID writeup, the operating system and the browser identify the device regardless of the network path. A VPN does not change this.
- **Application-layer tracking.** Cookies, browser fingerprinting, and logged-in sessions are unaffected by the VPN. If you log into the same account from the VPN as from home, the correlation is trivial.
- **Targeted attacks against the VPS.** A self-hosted VPN is a single point of failure. If the VPS is compromised, all traffic through it can be intercepted. The SSH hardening and firewall configuration are important for this reason.

**Operational considerations:**

- **Maintenance.** The VPS requires ongoing attention: OS updates, OpenVPN updates, certificate renewals, log review. A self-hosted VPN is not a set-and-forget service.
- **Performance.** A single VPS in a single location is not a global network. The latency is determined by the distance between the client and the VPS. For users who travel, a single-location VPN is less convenient than a provider with servers in every country.
- **Cost.** A VPS is €4–6 per month. A commercial VPN is often less expensive for the same number of features, because the provider amortizes the cost across many users.
- **Anonymity.** A self-hosted VPN is not anonymous. The VPS is rented in your name (unless anonymous payment methods are used), and the traffic that exits the VPS is identifiable as originating from that VPS. If the goal is anonymity, a self-hosted VPN is the wrong tool — Tor is the correct one.

## Part seven — the broader lesson

Self-hosting a VPN is an exercise in accepting responsibility. The convenience of a commercial VPN is that someone else handles the maintenance, the updates, the scaling, and the customer support. The cost is that you have to trust that someone else. Self-hosting removes the trust requirement and replaces it with a maintenance requirement.

The trade-off is not for everyone. For a user whose threat model is "I do not want my ISP to see my traffic", a commercial VPN is sufficient and the trust assumption is acceptable. For a user whose threat model includes the possibility of the provider being compelled to disclose data, being breached, or being acquired by a company with different practices, self-hosting is a reasonable response.

The technical setup is not hard. The SSH hardening, the OpenVPN configuration, the certificate management — all of it is documented, and the process is a few hours of work. The hard part is the ongoing commitment: keeping the server patched, monitoring the logs, and responding to incidents. A self-hosted VPN that is set up once and forgotten is less secure than a commercial VPN with a good track record, because the unpatched server is a bigger risk than the trusted provider.

## Takeaway

A self-hosted VPN on a VPS is a way to own the trust assumptions that commercial VPNs ask you to accept. It is not a way to become anonymous, it is not a way to defeat device identification, and it is not a way to hide from a state-level adversary. It is a way to control the network layer, and only the network layer.

The setup is accessible: rent a VPS, harden SSH, install OpenVPN, configure certificates, and connect clients. The maintenance is the real cost, and it is ongoing. The user who understands both the technical and the operational aspects makes a better decision than the user who follows a tutorial and assumes the result is a complete privacy solution.

The VPN is one layer. The value of self-hosting is that you own it. The limitation is that one layer is all it is.
