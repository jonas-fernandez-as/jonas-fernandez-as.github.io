---
title: "Exposed S3 Buckets — How Public Cloud Storage Became a Category of Its Own"
description: "The Grayhat Warfare problem: a walkthrough of how misconfigured S3 buckets are discovered, indexed, and exploited, why the default configuration makes this easy, and what actually fixes it."
date: 2026-05-10
type: "Technique · OSINT"
category: "OSINT"
difficulty: "Beginner"
readingTime: 20
video: "https://youtu.be/EDsdIVtJCm0"
tags: [osint, s3, cloud-storage, aws, misconfiguration, data-exposure]
---

## The premise

Cloud storage is one of the few genuinely new attack surfaces of the last fifteen years. Before S3 and its equivalents, an organization that wanted to store files at scale had to run its own infrastructure — file servers, NAS appliances, or a colocation setup. The attack surface was internal, physical, and bounded.

S3 removed the physical boundary. An S3 bucket is reachable from anywhere on the internet, and its access policy is a JSON document that administrators write. The default configuration in 2006, when S3 launched, was public read access. That default was changed years ago, but an enormous amount of infrastructure was built on the old default and never revisited.

The result is one of the largest categories of data exposure in the modern internet. Exposed S3 buckets have leaked health records, passport scans, source code, private keys, customer databases, and in one memorable case, an entire military intelligence archive. The pattern is so consistent that a distinct OSINT discipline has grown around finding and cataloging these buckets, and a service called Grayhat Warfare made it accessible to anyone with a browser.

This writeup covers what S3 buckets are, why they get exposed, how researchers find them, and what actually fixes the problem — which is not what most organizations assume.

## Part one — what an S3 bucket is

S3 (Simple Storage Service) is Amazon's object storage product. It stores files — called objects — in containers called buckets. Every bucket has a globally unique name across all of AWS, and every object inside a bucket has a key (a path-like identifier) and a value (the file content).

The bucket's access policy determines who can read, write, list, or delete objects. Policies can be:

- **Private** (default for new buckets). Only the AWS account owner can access objects.
- **Public read.** Anyone on the internet can read objects if they know the object's exact key, but they cannot list the bucket contents.
- **Public read and list.** Anyone can list the entire bucket contents and read every object.
- **Authenticated users only.** Any AWS-authenticated user (from any account) can read.
- **Cross-account policies.** Specific other AWS accounts are granted access.

The distinction between **public read** and **public read and list** matters enormously. A bucket that is public-read but not public-list is not indexable — you have to know the exact object keys to access anything. A bucket that allows listing is a fully open book, discoverable by anyone, cataloged by search engines and dedicated services.

When researchers and journalists talk about "exposed S3 buckets", they almost always mean the second category — buckets where listing is enabled, or where the object key structure is guessable.

## Part two — why buckets get exposed

There is no single reason. The causes form a spectrum from "understandable mistake" to "gross negligence", and understanding the spectrum is useful because the fix depends on which cause applies.

**The legacy default.** S3 launched in 2006 with public-read as the default for new buckets. This was changed in 2018, but any bucket created before that date and never revisited carries the original policy. Many organizations migrated from the old default to the new one bucket by bucket, and missed some.

**The CDN use case.** One of the most common legitimate uses of S3 is as the origin for a CDN — CloudFront, Cloudflare, or similar. The CDN serves content to end users, and the S3 bucket serves the CDN. In this setup, the bucket must be readable by the CDN. Many administrators, in a hurry, set the bucket to public read and forget to restrict the CDN's access to specific object paths.

**The "make it work" moment.** A developer sets up a new feature that stores files in S3. The feature does not work. In a hurry to make it work, the developer flips the bucket to public. The feature works. The developer moves on to the next task. The bucket stays public.

**The accidental policy.** S3 bucket policies are JSON. A misplaced wildcard, a negation that gets reversed, or a copy-paste error from a StackOverflow answer can produce a bucket that is far more permissive than intended. The policy looks fine at a glance, and only a careful review catches the issue.

**The forgotten bucket.** An organization runs a marketing campaign. The campaign assets live in an S3 bucket. The campaign ends. The bucket stays. Two years later, the bucket is still there, still public, and now contains data that was added by someone who repurposed it.

**The third-party integration.** A SaaS vendor stores customer data in an S3 bucket and provides read access through their platform. The platform uses a shared bucket policy that is more permissive than intended. Every customer's data is accessible to every other customer who knows the URL structure.

Each of these has a slightly different remediation. The legacy default is fixed by a policy audit. The CDN case is fixed by CloudFront Origin Access Identity. The "make it work" case is fixed by education and by making the secure path the easy path. The accidental policy is fixed by careful review. The forgotten bucket is fixed by lifecycle management. The third-party case is fixed by the vendor, and the customer's recourse is to switch vendors.

## Part three — how buckets are discovered

The discovery process uses three techniques, in order of complexity.

### Technique 1 — DNS and certificate enumeration

Every S3 bucket has a corresponding DNS endpoint: `<bucket-name>.s3.amazonaws.com`. If the bucket is accessed through a custom domain — `static.example.com` — that domain typically resolves (via CNAME) to the S3 endpoint. Enumerating subdomains of a target organization and resolving them reveals which ones point to S3.

Certificate transparency logs go further. Any TLS certificate issued for a domain is logged publicly. A query against a CT log aggregator like crt.sh for `example.com` returns every subdomain that has ever had a certificate issued. If a staging environment uses `static-staging.example.com` and that domain points to S3, the CT log reveals it.

This technique is the least noisy — it uses only public data — and it produces high-quality results because the domains are directly associated with the target.

### Technique 2 — Name guessing

S3 bucket names are globally unique, which means a well-chosen name is hard to find. But most organizations use predictable naming patterns:

```
<company>-backups
<company>-static
<company>-media
<company>-prod
<company>-staging
<company>-dev
<company>-<environment>-<region>
```

A tool that tries a list of common patterns against a target company name finds the buckets that exist. The response codes differentiate:

- **200** — the bucket exists and the caller has access.
- **403** — the bucket exists but the caller does not have access (for a specific object or for listing).
- **404** — the bucket does not exist.

Tools like `s3recon`, `lazys3`, `bucket-stream`, and `CloudBrute` automate this enumeration against a wordlist. `CloudBrute` is particularly thorough because it also handles GCP and Azure storage.

The response code distinction is important: a 403 for a listing request means the bucket exists but is not listable. A 403 for an object request means the object exists but is not readable. This kind of information leakage — a distinction between "exists" and "does not exist" — is itself a security issue because it enables enumeration.

### Technique 3 — Public search engines

This is where Grayhat Warfare comes in.

Grayhat Warfare is a free service that continuously scans S3 buckets and indexes any that are public-readable and public-listable. The results are searchable through a web interface at `buckets.grayhatwarfare.com`. It does not require an account for basic browsing, though a paid tier provides API access and additional filtering.

The value of Grayhat Warfare is that it removes the work of guessing names. If a bucket is listable, Grayhat Warfare likely has it. The search interface allows filtering by keyword, by bucket name, by file type, and by other metadata.

The same index is maintained by a handful of competitors — `buckets.grayhatwarfare.com`, `buckhacker.com` (defunct), and various smaller projects. The exact coverage varies; combining them produces the most complete picture.

## Part four — what is actually inside these buckets

The answer is uncomfortable: almost everything.

Common categories found in exposed buckets:

**Source code and backups.** Development teams sometimes stage deployment artifacts in S3 buckets. When a bucket is public-listable, the artifact — often a `.zip` or `.tar.gz` containing the entire application source — is downloadable. Source code exposure leads to further compromise because it reveals vulnerabilities, hardcoded secrets, and internal endpoints.

**Customer and user data.** CSV exports, JSON dumps, database backups. These frequently contain personally identifiable information, and in regulated industries they constitute a reportable breach the moment they are exposed.

**Authentication material.** `.env` files, `credentials.json`, private keys (`.pem`, `.key`), and configuration files that contain API keys and database passwords. These are the most damaging finds because they enable immediate access to other systems.

**Media and documents.** Marketing assets, product images, and internal documents. Less damaging individually, but collectively they reveal internal structure and sometimes confidential business information.

**Logs.** Application logs, access logs, and error logs. These frequently contain session tokens, internal IP addresses, user emails, and other data that helps reconstruct an attack.

**Temporary work products.** Files that were staged during a development sprint and never cleaned up. Frequently include database dumps, test data, and screenshots.

The common thread is that organizations do not set out to expose these things. The exposure is a consequence of a default that was set once, years ago, and never revisited.

## Part five — Grayhat Warfare in practice

The Grayhat Warfare interface is straightforward. Navigating to the site presents a search box with options to filter by keyword, file extension, and bucket name pattern. A search for a company name returns a list of buckets that contain that string.

The interface shows:

- **Bucket name** — the identifier of the bucket.
- **Number of objects** — how many files are in it.
- **Total size** — the aggregate size of all objects.
- **Last modified** — when the bucket was last scanned.
- **A link to browse the bucket** — Grayhat Warfare often mirrors the listing so you can see the file structure without connecting to the bucket directly.

From the browse view, individual objects can be downloaded directly from the Grayhat Warfare interface or from the S3 endpoint. Both return the same content.

The free tier of Grayhat Warfare has limitations — the number of results returned per query is capped, and the API is not available. The paid tier removes these limits and adds features like historical data and alerting.

The critical ethical and legal point: Grayhat Warfare indexes **publicly listable buckets**. The data is not breached or exfiltrated. It is exposed by the bucket owner's own policy, and Grayhat Warfare's role is to make the exposure discoverable.

The legal status of downloading from a public bucket depends on the jurisdiction. In the US, the Computer Fraud and Abuse Act (CFAA) has been interpreted in ways that could consider unauthorized access to a public bucket a violation, though recent Supreme Court precedent (`Van Buren v. United States`, 2021) narrowed the "exceeds authorized access" standard. In the EU, the GDPR treats accidental exposure as a data breach, and downloading from an exposed bucket without authorization can be a separate offense.

The professional position: **do not download from buckets you do not own.** The purpose of an audit is to identify exposed buckets, not to collect their contents. If a bucket belonging to your organization is exposed, the finding is the bucket itself, not the data inside it. Document the finding, report it internally, and move on.

## Part six — the "cyber" economy around exposed buckets

The scale of the problem has created a small economy.

**Grayhat Warfare, Shodan, Censys** and similar services index public buckets. Some of them monetize through API access and alerts.

**"Threat intelligence" vendors** rebrand the same public data and sell it as proprietary. The underlying technique is identical to what a free search would reveal.

**Bug bounty platforms** have evolved to include cloud storage exposure as a category. HackerOne and Bugcrowd programs frequently include "exposed S3 bucket" as an in-scope finding, with payouts ranging from a few hundred to several thousand dollars depending on sensitivity.

**Regulators** have started to treat exposed buckets as a compliance issue. The GDPR in the EU and various US state laws impose reporting requirements when personal data is exposed. Fines have been levied against organizations that failed to secure their buckets.

**Criminal actors** use the same tools as legitimate researchers. The list of buckets on Grayhat Warfare is publicly accessible to anyone, including attackers looking for easy targets.

The net effect is that the exposure of a bucket is not just a technical issue — it is a compliance, legal, and reputational issue the moment it is discovered.

## Part seven — detection

From a defender's perspective, the detection problem has two components: knowing what you have and knowing when it changes.

**Continuous discovery.** Run the same tools an attacker would run against your own domains and names:

```bash
# Certificate transparency enumeration
curl "https://crt.sh/?q=%25.example.com&output=json" | jq -r '.[].name_value' | sort -u

# S3 bucket name guessing against a wordlist
python3 lazys3.py example
```

The output is a list of domains and bucket names. Cross-reference against your known inventory. Anything that is not on the inventory is a lead.

**Direct enumeration.** For each bucket name discovered, query the S3 API directly to check its policy:

```bash
aws s3api get-bucket-acl --bucket example-bucket
aws s3api get-bucket-policy --bucket example-bucket
```

If the ACL grants public read, or the policy contains `"Principal": "*"` with `s3:GetObject` or `s3:ListBucket`, the bucket is exposed.

**Monitoring for new exposure.** A scheduled script that runs the discovery process on a daily or weekly basis and reports new findings catches the "someone deployed a public bucket yesterday" case. The alternative — an annual audit — catches the problem a year after it happens.

**Alerting on public-read transitions.** AWS CloudTrail logs every `PutBucketAcl` and `PutBucketPolicy` call. A CloudWatch alarm or a Lambda function that fires on these events and validates the resulting policy catches the "make it work" case in real time.

## Part eight — defense

The controls that actually fix the problem, in order of effectiveness:

**Block Public Access at the account level.** AWS provides an account-level setting called "Block Public Access" that, when enabled, prevents any bucket in the account from being made public — even accidentally. This is the single most effective control and is enabled by default on new AWS accounts since 2023. Any account that was created before that date should have it enabled manually.

The account-level setting can be overridden per-bucket if the bucket genuinely needs to be public, but the override is explicit and logged. This design makes the secure path the default and the insecure path deliberate.

**Bucket policies with explicit denies.** A bucket policy that starts from a deny-all posture and grants specific access is safer than one that starts from allow-all and tries to restrict. This is the same principle as firewall rules — the default should be deny.

**CloudFront Origin Access Identity.** For buckets that serve content through CloudFront, an OAI ensures that only the CDN can read the bucket. The bucket is fully private, the CDN is the only caller, and the public exposure is limited to what the CDN chooses to serve.

**Encryption at rest.** S3 supports server-side encryption with AES-256 or KMS keys. Encryption does not prevent public access, but it does reduce the impact of an exposure — an attacker who downloads an encrypted object still needs the key to read it.

**Access logging and monitoring.** S3 access logs record every request to a bucket. CloudTrail records every API call. Together, they provide the audit trail needed to investigate an exposure and to detect unauthorized access after the fact.

**Lifecycle policies.** Buckets that are no longer used should be deleted. Lifecycle policies can automatically delete objects after a retention period, and a scheduled task can identify buckets that have not been accessed in ninety days. The "forgotten bucket" problem is solved by making "forgotten" a technical state that triggers a review.

**Regular audits.** No technical control replaces the discipline of running the discovery tools against your own organization. The audit finds the buckets that the controls missed.

## Part nine — what this teaches

Exposed S3 buckets are the clearest example of a pattern that recurs across cloud infrastructure: **the default state matters more than any individual configuration**.

When the default is "private", most buckets stay private because nobody changes the default. When the default is "public", most buckets become public because nobody changes the default. The change AWS made in 2023 — public access blocked by default on new accounts — addresses the root cause, not the symptom.

The corollary is that fixing individual buckets is a game of whack-a-mole. The only durable fix is to change the default. Organizations that have not adopted account-level block-public-access are running the old default, and they will continue to produce exposed buckets until they change it.

This is a general lesson about cloud security. Every cloud service has defaults, and defaults are chosen for developer convenience, not for security. The organization that knows what its defaults are and changes the ones that matter is the organization that does not appear on Grayhat Warfare.

## Part ten — the ethics, revisited

The tools that find exposed S3 buckets are the same tools that find exposed S3 buckets belonging to anyone. The technique does not distinguish between an audit of your own organization and a reconnaissance of someone else's.

The professional line is clear: **audit what you own or what you are explicitly authorized to audit**. If you find a bucket belonging to someone else, the correct action is to report it — most organizations have a security.txt or a responsible disclosure contact. Not to download its contents.

The problem with the data on Grayhat Warfare is not that it is secret. It is public. The problem is that the owner does not know it is public, and the exposure is a violation of their own policies even if it is not a violation of the law for someone else to read it.

The right response is to make the exposure visible to the owner, not to exploit it. That distinction is what separates a security researcher from an attacker. The tools are the same. The intent is the difference.

## Takeaway

Exposed S3 buckets are the shadow IT of the cloud era. They accumulate silently, they are indexed publicly, and they are discovered the moment they become useful to someone. Grayhat Warfare is the search engine for this shadow internet — a reminder that anything reachable from the internet is reachable by everyone, whether the owner intended it or not.

The fix is not technical sophistication. It is the discipline to know what you have, to set the default correctly, and to audit regularly. The organizations that do this appear in the Grayhat Warfare index as negatives — searches for their name return nothing. That is the goal: to be unindexable.
