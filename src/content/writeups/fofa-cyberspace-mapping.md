---
title: "FOFA and the Cyberspace Mapping Arsenal — Beyond Maltego"
description: "A practical guide to FOFA, Shodan, Censys and ZoomEye for attack surface discovery. Query syntax, real workflows, the differences between engines, and how defenders can reduce their exposure."
date: 2026-05-06
type: "Technique · OSINT"
category: "OSINT"
difficulty: "Intermediate"
readingTime: 22
video: "https://youtu.be/6dQ7ofl5eOQ"
tags: [osint, fofa, shodan, censys, zoomeye, attack-surface, reconnaissance]
---

## The internet you can't Google

Google indexes web pages. It crawls links, follows redirects, and builds an index of content that is meant to be found. It does not index the SSH banner on a server in a data center in Frankfurt. It does not index the default login page of a Jenkins instance that was never linked from anywhere. It does not index the MQTT broker sitting on an IoT device in an industrial control network.

Those things are on the internet. They are reachable. They respond to connections. Google just does not know they exist, because nothing links to them and nothing tells Google to look.

Cyberspace mapping engines — FOFA, Shodan, Censys, ZoomEye — solve this problem by doing the opposite of what Google does. Instead of crawling links, they scan IP ranges. Instead of indexing content, they index **banners**: the small piece of information every network service sends back when you connect to it. An SSH server sends its version string. An HTTP server sends its headers. A database sends its protocol handshake. A camera sends its model number.

This is the reconnaissance layer that most people do not know exists, and it is where real attack surface discovery happens.

## Part one — what FOFA actually is

FOFA stands for **Fingerprint of Full Asset**. It is a Chinese-developed cyberspace mapping engine, launched in 2015, and it has become one of the most capable tools in the category. The name is literal: FOFA builds fingerprints of assets — servers, devices, services — by combining multiple signals into a single identifier.

What sets FOFA apart from the other engines is its focus on **web content search**. Shodan is optimized for banners and protocol metadata. Censys is optimized for TLS certificates and structured service data. FOFA is optimized for the actual content of HTTP responses — HTML body, headers, title, and the components that make up a web page.

This makes FOFA particularly effective for finding:

- **Web applications with specific technologies.** A search for `body="wp-content"` finds every WordPress installation on the internet that FOFA has scanned.
- **Admin panels and login pages.** A search for `title="Admin"` or `title="Login"` returns thousands of management interfaces, many of which should not be publicly accessible.
- **Exposed configuration files.** A search for `body="DB_PASSWORD"` or `body="api_key"` finds source code files and configuration files left in web-accessible directories.
- **Specific software versions.** A search for `body="Apache/2.4.49"` finds servers running the specific version affected by CVE-2021-41773.

FOFA's index covers over 1300 protocols and maintains more than 360,000 fingerprint rules for identifying software and hardware. The scanning infrastructure is distributed and asynchronous, which allows it to cover a large portion of the IPv4 space on a recurring basis.

## Part two — the query syntax

FOFA's query syntax is the core of its power, and it is worth learning properly because the difference between a naive search and a well-constructed one is the difference between 10 million results and 10 useful ones.

### Basic field operators

Every FOFA query is built from field operators. The syntax is `field="value"`:

```
title="Admin"           # pages with "Admin" in the <title>
body="password"         # pages with "password" in the HTML body
header="Elastic"        # pages with "Elastic" in HTTP headers
domain="example.com"    # assets under a specific domain
ip="1.1.1.1"           # assets on a specific IP
port="22"              # assets on a specific port
protocol="ssh"         # assets speaking a specific protocol
```

The operators support comparison modes:

- `=` — fuzzy match. `title="admin"` matches "Admin", "admin panel", "Administrator".
- `==` — exact match. `title=="Admin"` matches only the exact string "Admin".
- `!=` — negation. `title!="Admin"` excludes pages with "Admin" in the title.

### Boolean logic

Multiple conditions are combined with `&&` (AND), `||` (OR), and `!` (NOT):

```
title="Admin" && country="CN"
(port="80" || port="443") && body="phpMyAdmin"
body="login" && !title="error"
```

Parentheses control precedence. The syntax is intuitive for anyone who has written a SQL `WHERE` clause or a basic boolean expression.

### The killer feature — full-text body search

The `body=` operator is what makes FOFA uniquely powerful for web-focused reconnaissance. It searches the actual HTML content of every indexed page. Combined with boolean logic, it allows queries that would be impossible on a banner-only engine:

```
body="Welcome to Jenkins" && country="US"
body="phpinfo()" && !domain="internal"
title="Grafana" && body="login"
```

The first query finds Jenkins instances in the US. The second finds exposed phpinfo pages. The third finds Grafana dashboards that are publicly accessible.

Each of these is a potential security issue. The results are not hypothetical — they are real, reachable, and in many cases, they belong to organizations that do not know they are exposed.

### Advanced operators

Beyond the basic fields, FOFA supports operators that narrow results by infrastructure and fingerprint:

- **`cert=`** — search by TLS certificate content. `cert="example.com"` finds every server presenting a certificate that mentions the domain, even if the server itself is on a different IP.
- **`fid=`** — FOFA's own fingerprint ID. When FOFA identifies a specific application or device, it assigns a unique fingerprint. Searching by `fid` finds every asset matching that fingerprint.
- **`icon_hash=`** — search by favicon hash. Favicons are often unique to a specific application, and their hash is a reliable identifier even when the title and headers are stripped.
- **`jarm=`** — search by JARM fingerprint, a TLS server fingerprinting technique developed by Salesforce. Useful for identifying servers running the same TLS stack.

The `icon_hash` operator deserves special mention. Favicons are frequently overlooked by administrators who otherwise harden their servers. A Jenkins instance may have its title changed, its headers stripped, and its version hidden — but if the favicon is still the default Jenkins icon, `icon_hash` finds it. This is one of the most underused reconnaissance techniques in the toolkit.

## Part three — FOFA vs the other engines

FOFA is not the only cyberspace mapping engine. The other major players are Shodan, Censys, and ZoomEye. Each has strengths and weaknesses, and the choice between them depends on what you are trying to find.

**Shodan** is the oldest and most well-known. It is optimized for **banners and protocol metadata**. It excels at finding devices that speak specific protocols — MQTT brokers, industrial control systems, RDP servers, and IoT cameras. Its coverage of non-HTTP protocols is the best in the category. Its web-content search is weaker than FOFA's.

**Censys** is the most **academically rigorous**. It was built by researchers at the University of Michigan and provides open datasets and APIs. Its strength is in **TLS certificate analysis** — it maintains a comprehensive index of certificates and can correlate servers by certificate content, issuer, and trust chain. It is the tool of choice for infrastructure mapping and for research that requires reproducible data.

**ZoomEye** is the closest competitor to FOFA in scope. It is also Chinese-developed, and it has similar web-content search capabilities. Its coverage of the Asia-Pacific region is particularly strong. In practice, using FOFA and ZoomEye together provides better coverage than using either alone — they scan different ranges and index different features.

A comparison table:

| Engine | Primary strength | Best for | Weakness |
|---|---|---|---|
| Shodan | Protocol banners | IoT, ICS, non-HTTP services | Weak web content search |
| Censys | TLS certificates | Infrastructure mapping, research | Less flexible query syntax |
| FOFA | Web content + fingerprints | Finding web apps, exposed panels | Weaker on non-HTTP protocols |
| ZoomEye | Broad coverage | Asia-Pacific, general discovery | Smaller index than FOFA |

The practical approach: use all four. Run the same query on each and compare results. The overlap is useful — if all four find the same asset, it is definitely exposed. The unique results from each engine are the ones worth investigating.

## Part four — real OSINT workflows

Cyberspace mapping engines are not just for finding exposed services. They are a full reconnaissance layer, and the workflows that experienced analysts use them for go well beyond simple queries.

### Workflow 1 — Subdomain discovery

Given a root domain, find every subdomain and asset associated with it:

```
domain="example.com"
```

FOFA returns every asset it has indexed that is under `example.com`. This is often more comprehensive than DNS enumeration, because FOFA discovers assets that are not linked from anywhere and not discoverable through certificate transparency logs.

To find assets that share infrastructure but are not on the same domain:

```
cert="example.com"
```

This finds servers presenting a TLS certificate that mentions the domain. A staging server, a forgotten development environment, or a misconfigured CDN edge node may present a certificate that reveals the relationship to the main domain.

### Workflow 2 — Technology fingerprinting

Given a specific technology, find every instance on the internet:

```
body="wp-content" && country="ES"
```

This finds WordPress installations in Spain. Combined with version-specific strings, it narrows to vulnerable installations:

```
body="wp-content" && body="ver=5.8"
```

WordPress 5.8 had several high-severity vulnerabilities. A search like this finds every site running that version that FOFA has scanned — a list that a defender would want to know about, and an attacker would too.

### Workflow 3 — Exposed admin panels

Admin panels are frequently deployed without authentication or with default credentials. FOFA finds them:

```
title="Admin" && body="login"
title="phpMyAdmin"
title="Grafana" && !auth
body="Welcome to Jenkins"
```

The third query is particularly useful — `!auth` excludes instances that require authentication. What remains are publicly accessible Grafana dashboards, which may leak sensitive metrics and data.

### Workflow 4 — Credential and secret hunting

This is the workflow that generates the most alarming results:

```
body="DB_PASSWORD"
body="api_key"
body="AWS_SECRET_ACCESS_KEY"
body="-----BEGIN RSA PRIVATE KEY-----"
```

These queries search for configuration files, source code, and environment files that have been accidentally exposed on web servers. The results are real — FOFA and similar engines regularly index `.env` files, `config.php` files, and backup archives that were never meant to be public.

The last query — `-----BEGIN RSA PRIVATE KEY-----` — finds exposed private keys. A server that serves its own private key is a server that can be impersonated by anyone who finds it.

## Part five — the API and automation

The web interface is useful for exploration, but real work happens through the API.

FOFA's API accepts a query in base64 and returns JSON. The basic pattern:

```
QUERY=$(echo -n 'domain="example.com"' | base64 -w0)
curl "https://fofa.info/api/v1/search/all?email=$EMAIL&key=$FOFA_KEY&qbase64=$QUERY"
```

The API supports pagination, field selection, and result limits. It is the foundation for automated workflows:

- **Continuous monitoring.** A scheduled script queries the API daily and alerts on new assets appearing under a domain. New assets are often the ones that were just deployed — and the ones that were just misconfigured.
- **Bulk enrichment.** Given a list of domains, query each one against FOFA and aggregate the results into an asset inventory.
- **Cross-engine correlation.** Query the same term against FOFA, Shodan, and Censys, and merge the results. The union is more comprehensive than any single engine.

There are open-source tools that wrap the API for common workflows. `gofofa` is a Go client that makes scripting straightforward:

```bash
export FOFA_KEY='your_key'
fofa search -s 1 ip=1.1.1.1
```

For Python, several libraries exist, and the API is simple enough to wrap in a few lines of `requests` code.

## Part six — detection and defense

From a defender's perspective, cyberspace mapping engines are a mirror. They show what an attacker sees when they look at your organization from the outside. The defensible position is to look first.

**Know what you expose.** Run the same queries an attacker would run:

- `domain="yourdomain.com"` — what assets are under your domain?
- `cert="yourdomain.com"` — what servers present your certificate?
- `body="yourdomain"` — what pages mention your domain?
- `org="Your Organization"` — what does FOFA know about your organization?

The results are your external attack surface as FOFA sees it. Anything unexpected is worth investigating.

**Reduce the surface.** Common findings from this exercise:

- **Forgotten development and staging environments.** A staging server that was set up for a project two years ago and never torn down. It is running an old version of the application, has no WAF, and is publicly accessible.
- **Exposed admin panels.** Grafana, Kibana, Jenkins, phpMyAdmin, and similar tools deployed with default credentials or no authentication.
- **Misconfigured cloud storage.** S3 buckets, Azure blobs, and Google Cloud Storage buckets with public read access. FOFA indexes their contents.
- **Leaked configuration files.** `.env`, `config.php`, `wp-config.php`, and similar files left in web-accessible directories.

Each of these is a finding, and each has a remediation. The exercise is not about finding novel vulnerabilities — it is about finding the ones you already have.

**Monitor for new exposure.** Set up a scheduled query against the FOFA API that alerts when a new asset appears under your domain. New assets are often misconfigured assets, because the person who deployed them was moving fast and did not follow the checklist.

**Use fingerprint exclusion where possible.** FOFA indexes what it can scan. If a service does not need to be public, putting it behind authentication or a VPN removes it from the index. If it does need to be public, ensure it does not leak version information or default banners.

## Part seven — the ethics

Cyberspace mapping engines are dual-use tools. The same query that a defender runs to audit their own surface is the query an attacker runs to find targets. The technique does not distinguish between the two.

The professional position: **use these tools to audit what you own, or what you are authorized to test.** Running queries against domains you do not control is not illegal in most jurisdictions — the information is public — but it is a step toward activity that is. The line is crossed when reconnaissance becomes scanning, and scanning becomes exploitation.

For red teamers, the scope document defines the boundary. A query for a target domain is in scope if the target is the client. A query for a third-party domain that happens to be in the client's infrastructure is out of scope unless explicitly authorized.

For defenders, the ethics are simpler: use the tools on your own infrastructure. The goal is to see what an attacker sees before the attacker does. That goal is served by auditing your own surface, not by auditing someone else's.

## Part eight — references and further reading

- **FOFA official documentation** (`en.fofa.info`) — the search syntax reference and API documentation. The syntax is the foundation; everything else builds on it.
- **Shodan** (`shodan.io`) — the original cyberspace mapping engine. The `shodan` CLI is worth learning for protocol-level reconnaissance.
- **Censys** (`censys.io`) — the academic option. The open datasets are useful for research that requires reproducibility.
- **ZoomEye** (`zoomeye.org`) — the other major Chinese engine, complementary to FOFA.
- **OSINT Tools Library** — maintained by The OSINT Newsletter, includes a section on FOFA and similar tools.
- **`awesome-hacker-search-engines`** (GitHub) — a curated list of search engines for pentesting, bug bounty, and red/blue team operations.

## Takeaway

The internet is larger than the web. Most of what is exposed is not linked from anywhere, not indexed by Google, and not visible to anyone who is not actively looking for it. Cyberspace mapping engines exist to make the invisible visible.

FOFA is one of the most capable of these engines, particularly for web applications and exposed panels. Its query syntax is learnable in an afternoon, its API is straightforward to automate, and the results it produces are the same results an attacker would find.

The defensive question is not whether an attacker can find your exposed services. It is whether you found them first. The tools are free, the queries are public, and the only barrier is the discipline to run them regularly. That discipline is the difference between an attack surface you manage and an attack surface that manages you.
