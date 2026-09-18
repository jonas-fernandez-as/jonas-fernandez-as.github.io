---
title: "From a Photo to an Identity — OSINT Image Tracking"
description: "The EXIF data is gone. It doesn't matter. A complete workflow for going from a photo to a name, a city, or a map pin using open-source tools, reverse image search, and disciplined pivoting."
date: 2026-04-20
type: "Technique · OSINT"
category: "OSINT"
difficulty: "Beginner"
readingTime: 22
video: "https://youtu.be/7DRhDjBQ5So"
tags: [osint, reconnaissance, images, geolocation, pimeyes, yandex]
---

## The assumption that stopped being true

For about a decade, the standard privacy advice was simple: strip the EXIF. Camera model, GPS coordinates, timestamp, serial number — all of it lived in a metadata block that any tool could read. Strip the block, publish the photo, sleep soundly.

Then every major platform started stripping metadata server-side on upload. Instagram, Twitter, Facebook, WhatsApp, Telegram — all of them now remove EXIF automatically, or store it internally without exposing it. The classic metadata attack was structurally dead by around 2018. Privacy advice never fully caught up.

The assumption that replaced it — that a metadata-free image is a safe image — is also wrong, and this one is more dangerous because it feels true. Removing EXIF removes the *explicit* metadata. It leaves the *implicit* metadata untouched: the face in the frame, the shape of the buildings, the reflection in the sunglasses, the font on the street sign, the shadow direction, the license plate in the corner, the poster on the wall behind the subject.

This is what a real OSINT image track targets. Not the block of bytes at the start of the file. The photograph itself.

This writeup is the workflow I use. It's not novel — the same techniques are in Bellingcat's handbook, in Citizen Lab reports, and in every open-source intelligence course worth taking. What's missing from most tutorials is the discipline: how to organize the investigation, when a tool is lying to you, and where the chain breaks.

## Part one — what an image actually contains

Before touching a tool, it helps to know what you're looking at. An image file is not one thing; it's a container. The pixel data is the obvious part, but a modern photo may also carry:

- **EXIF** — camera-level metadata. GPS, timestamp, camera model, lens, exposure settings, sometimes a unique serial number. Removed by most platforms. Still present in files sent over email, Bluetooth, or AirDrop.
- **IPTC** — press metadata. Captions, credits, copyright. Written by journalists and photo agencies. Usually survives light editing but not re-encoding.
- **XMP** — Adobe's format. Stores editing history, keywords, sometimes GPS. Survives surprising amounts of processing because Adobe treats it as a sidecar.
- **ICC profiles** — color management. Rarely useful but occasionally reveals the software version that last wrote the file.
- **Thumbnails** — most editors keep an embedded thumbnail of the *original* image, even after editing. If someone cropped a GPS landmark out of a photo, the thumbnail often still has it.

The tool for all of this is `exiftool`, and there's no real alternative:

```bash
exiftool image.jpg
```

Run it before anything else. If EXIF is present, half the investigation is done in the first minute. If it's stripped, you'll see a truncated output — usually just a couple of lines about JPEG compression. That truncation is itself information: it tells you the image went through a platform that strips metadata, which narrows down where it came from.

Two things to check beyond the obvious:

**The thumbnail.** `exiftool -b -ThumbnailImage image.jpg > thumb.jpg` extracts it if present. Compare the thumbnail to the visible image. Any difference — different crop, different object, different version — is a lead.

**The software tag.** Even if GPS and camera info are stripped, the `Software` field sometimes survives. "Adobe Photoshop 24.1" tells you the image was edited but not necessarily re-encoded by a platform. "Google" or "Instagram" tells you the platform processed it. The absence of any Software tag, combined with zero EXIF, usually means a platform stripped it, not the user.

Once EXIF is exhausted, you move to the image itself. There are two branches, and they use different tools.

## Part two — face tracking

Face search is the branch that has matured most in the last three years, and it's the one most people don't know exists.

The premise: upload a photo of a face, get back publicly-indexed photos of the same face from across the web. Not similar images — the same person, in different photos, often with their name attached to one of them.

The tools that actually work, in order of usefulness:

**PimEyes.** The most established. Indexes faces from public web sources — social media, news sites, corporate directories, dating sites. Free tier limits you to a few searches; paid tier opens up more results and the ability to set monitoring alerts on a face. The results page shows each match with a confidence score and a link to the source. When it works, it works spectacularly — you get a name in under five minutes.

**FaceCheck.ID.** A smaller index than PimEyes but a different one. Running the same photo through both is not redundant — they pull from different sources and often return different candidates. The overlap between the two is a strong signal; the unique results from each are worth chasing individually.

**Yandex Images.** The most underrated tool in open-source intelligence. Yandex's reverse image engine is significantly better at facial matching than Google's, particularly for faces of Eastern European, Russian, and Latin American subjects. Google's algorithm is optimized for recognizing *objects*; Yandex is optimized for *people*. If you're tracking someone from a region Google serves poorly, Yandex should be your first stop, not your last.

**Google Lens.** Weak on identity but useful for context. What brand is that jacket? What type of car is in the background? What kind of tree is that? Google Lens answers contextual questions faster than any other tool, and those answers feed back into the geolocation branch.

The workflow: run the photo through PimEyes, then FaceCheck, then Yandex, then Google Lens. Four searches. Compile the results. Look for the same face appearing with a name attached on any platform.

A trick that is not obvious: **search the photo, not just the face.** If your target uses the same profile picture on five platforms, reverse image search on the profile picture itself finds all five instances. Their usernames on each platform become new pivot points. From the profile picture, you can go to a forum account, from there to a gaming handle, from there to a LinkedIn profile.

The reverse of this — searching for a face you don't have but a username you do — is also useful. Most people reuse at least one profile photo somewhere. Scraping their public posts gives you a face to feed into PimEyes.

## Part three — geolocation

Geolocation from a single photo is a different discipline. It's slower, more rigorous, and more satisfying when it works. The mistake most people make is trying to identify a location by its landmarks. That's the last step, not the first.

The correct order is: **country, then region, then city, then street.**

### Country

You don't identify the country by the Eiffel Tower. You identify it by the boring infrastructure that no one thinks about:

- **Road markings.** Which side drives on which side? What color are the lane lines? Are there reflective studs on the pavement? What shape are the give-way signs?
- **License plates.** Even partially visible, the format narrows it fast. European plates have a blue strip on the left with a country code. US plates vary by state. Mexican plates have a specific two-letter format.
- **Traffic signs.** Font, color, and symbol design vary by country. The Swiss use a specific rounded typeface; the Spanish use a different one. The UK has its own style. South American countries have distinctive sign shapes.
- **Power lines.** The way lines are strung and the number of wires per pole varies regionally. Rural American poles look different from rural Portuguese poles.
- **Architecture.** Not iconic buildings — the everyday stuff. Roof tile material, window frame style, the way balconies are enclosed. Southern European architecture is instantly distinguishable from Northern European once you know what to look for.
- **Vegetation.** Pine trees, palm trees, eucalyptus, plane trees — each has a climate range. Palm trees in a street scene rule out most of Europe.

None of this is exotic. It is just what experienced OSINT analysts look at first, because narrowing from "the world" to "a country" is the step that makes every subsequent search tractable.

### Region

Within a country, the same principle applies. You're looking for regional tells:

- **License plate prefix.** In many countries (Spain, Italy, Germany), plates encode the region of registration. Even a blurred plate sometimes retains the prefix.
- **Language.** Any visible text — signs, graffiti, menus, shop names — narrows to a language, then to a dialect region.
- **Architecture style.** Within Spain, Basque architecture looks different from Andalusian. Within Germany, Bavarian looks different from Saxon.
- **Vegetation density.** The specific mix of trees and crops narrows climate zones faster than any single feature.

### City

Now you can start using landmarks. But even here, don't jump to the Eiffel Tower — look for the medium-scale features:

- **Specific bridge style.** Bridges are distinctive per city.
- **Church architecture.** Each city has a handful of churches with recognizable silhouettes.
- **Street layout.** Grid, organic, radial — combined with a river or coastline, this often narrows to a single city.
- **Public transit.** Bus stop design, tram colors, metro signage.

### Street

Only now do you use the tools that do the heavy lifting:

**Overpass Turbo.** Query OpenStreetMap for objects that match what you see. If you can tell there's a roundabout next to a church with a specific architectural style, you can query for "roundabout near church with bell tower" within a bounding box and get a list of candidates. This is how you go from "region" to "street" without guessing.

**Google Earth Pro.** Historical imagery. If your photo is from 2018 and the location has since changed, current satellite won't help. Earth Pro has historical layers going back to the early 2000s for most places.

**SunCalc.** If you can estimate shadow direction from a photo and you know the approximate date, SunCalc tells you the possible times of day and compass orientation. Combined with a street-level guess, this can confirm or eliminate candidates.

**Google Street View.** The final confirmation step. Match specific features — the color of a door frame, a particular poster, a sign in a window. Street View is often years out of date, so seasonal differences are normal. Don't reject a match for vegetation; reject it for architecture.

## Part four — the pivot chain

The individual tools are not what makes an OSINT investigation succeed. The **pivot chain** is.

A pivot is a small step from one confirmed fact to a new source. A chain is several pivots linked together. A single tool rarely gets you to the answer; a chain of cheap steps usually does.

A simple chain:

1. A photo gives you a face.
2. The face gives you a username on a forum.
3. The username gives you a post history.
4. The post history reveals a location mentioned in passing.
5. The location feeds back into the geolocation branch for the original photo.

Each step is cheap. The value is in tracking what's confirmed, what's assumed, and what's open. Experienced analysts keep a running document — a plain text file is enough — with three columns: confirmed, inferred, unknown. No fancy tooling. Just discipline about what is actually established.

The most common failure mode in OSINT is not a missing tool. It's losing track of which facts are confirmed and which are guesses. When you have 40 open tabs and 3 hours in, it's easy to treat a hypothesis as an established fact and build on top of it. The text file prevents that.

## Part five — a worked example

An outdoor café photo. No EXIF. The subject is seated at a table with an awning overhead, a stone building behind them, and a partially visible street sign on the right.

**Step 1 — Yandex.** Reverse image on the full photo. Yandex finds the same photo posted publicly on a photography forum from two years ago, under a username. The username is `[redacted]_[cityname]` — the format suggests the person uses a consistent handle online.

**Step 2 — Username search.** The username, searched on Google and DuckDuckGo with quotes, returns an Instagram account with the same base handle. Instagram profile is public, 42 posts.

**Step 3 — Instagram profile review.** Three posts are geo-tagged. Two are in Barcelona. One is in a coastal town nearby. The person is presumably based in or near Barcelona. This is a hypothesis, not a fact.

**Step 4 — Cross-reference the café photo.** Back to Yandex. Search for the distinctive awning pattern — a specific green-and-white stripe with a scalloped edge. Yandex returns three similar awning patterns, all from Barcelona. Still a hypothesis.

**Step 5 — Google Maps search.** Search Google Maps for cafés in Barcelona with an awning matching that pattern. Narrow to a shortlist of seven. Cross-reference the stone wall texture in the photo against Street View for each.

**Step 6 — Street View match.** At the third candidate, the stone wall behind the subject matches exactly — same block size, same joint pattern, same age of weathering. The awning is gone (photo is two years old), but the wall is unchanged. Confirmed: the café is in the Gràcia district of Barcelona.

Total elapsed time: about 45 minutes. No special access. No paid tools beyond what was already available. All public data.

The important thing to notice is that no single step was clever. The chain was. Yandex found a username, Instagram found a city, Google Maps narrowed to a district, Street View confirmed the exact location. Each step was a $0 search. The investigation succeeded because the steps were sequenced correctly.

## Part six — where this breaks

Three failure modes, all common:

**Confirmation bias.** Once you have a hypothesis about a location, you start seeing confirmations everywhere. A building "looks like" Andalusian architecture because you've already decided the photo is from Seville. The fix is to actively look for disconfirming evidence — what would falsify your hypothesis? If nothing visible could, your hypothesis is not falsifiable and needs to be reformulated.

**Over-reliance on AI geolocation.** GeoSpy, Picarta, and similar tools are genuinely useful as hypothesis generators. They are terrible as conclusions. An AI that says "this looks like it's in southern Portugal" is a starting point for the manual workflow, not a result. Treat these tools the way you'd treat a stranger on the internet offering an opinion: interesting, needs verification.

**Stale imagery.** Google Street View is often 3-7 years out of date in smaller cities. Vegetation grows, awnings come and go, businesses change hands. If your only evidence for a match is that a café has the same name, that's weak. If your evidence is architectural — building structure, window frame pattern, roof material — you can trust it across decades.

## Part seven — detection and mitigation for the tracked

If you're on the other side of this workflow, here's what actually reduces your footprint:

**Don't reuse profile pictures.** This is the single most effective defense. Different photo on each platform breaks the pivot chain before it starts. Most people don't do this because it's mildly inconvenient. That's the point.

**Strip metadata before uploading.** Even if the platform does it server-side, some platforms store the original. `exiftool -all= image.jpg` is a one-liner.

**Don't post geo-tagged content in real time.** Posting "at [current location]" is very different from posting "was at [location] three hours ago". The second is interesting; the first is a tracking beacon.

**Close the pivot chain.** If your Instagram is public, your Twitter handle leads to it, and your gaming forum account uses the same handle, you have one identity across three sites. Deliberate separation is worth the effort — different usernames, different photos, no cross-linking.

**Reverse-image search yourself twice a year.** Know what a stranger would find before a stranger does. PimEyes on your own face is a disquieting experience the first time, and a valuable one.

**Consider the ambient signals.** The photo doesn't have to be yours. A friend's Instagram story, a group photo at a party, a wedding album — all of those are your face in someone else's metadata. There's no clean technical fix for that.

## Part eight — the ethics

This workflow is the same one that journalists use to verify photographs from conflict zones, that NGOs use to document human rights violations, and that Bellingcat publishes openly as a public methodology. It is also the same workflow that stalkers use, that doxxers use, and that private investigators use to circumvent legal processes.

The techniques do not distinguish between these uses. The intent does.

The professional position: **use it to verify, not to track.** If the target is a public figure, a corporation, or a subject of disinformation, the workflow is appropriate. If the target is a private individual who has not consented, the same workflow is a harm.

There is no technical line to draw here. There is only a professional one, and it's worth stating explicitly because the tools don't state it.

## Part nine — references and further reading

If this writeup interested you, the following are worth your time:

- **Bellingcat's Online Investigation Toolkit** — an openly maintained resource list by the investigative journalism collective. The most comprehensive public source on OSINT techniques.
- **Michael Bazzell's OSINT Techniques** — the definitive book on the discipline. Updated annually. Not free, worth every euro.
- **Citizen Lab publications** — for examples of OSINT used at the highest professional level against state actors.
- **GeoSpy and Overpass Turbo documentation** — the two tools most underused by beginners.
- **SunCalc** — worth understanding even if you only use it once a year.

## Takeaway

The metadata is not in the file. It's in the image. Every photograph carries a dozen small decisions — the angle, the reflection, the timing, the background — and each of them narrows the space of possible answers. The tools just make the narrowing faster.

Stripping EXIF was the right answer to the wrong question. The right question is: what did the photographer not notice they were including in the frame?
