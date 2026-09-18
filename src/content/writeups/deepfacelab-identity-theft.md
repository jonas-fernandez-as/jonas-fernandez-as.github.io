---
title: "DeepFaceLab — Identity Theft in Real Time"
description: "Open-source face-swapping used to be a research toy. It is now a pipeline that runs on a consumer GPU, produces broadcast-quality results, and defeats the liveness checks that KYC and video verification rely on."
date: 2026-06-03
type: "Technique · Social Engineering"
category: "Social Engineering"
difficulty: "Intermediate"
readingTime: 22
video: "https://youtu.be/nkfQajMDL6Y"
tags: [deepfake, deepfacelab, identity-theft, kyc, social-engineering, ai]
---

## The premise

Face has been the dominant identity signal for the last decade. It is how passports work, how KYC verification works, how video calls establish that the person on the other end is who they claim to be. When a bank wants to verify a customer, it asks for a photo of their ID and a selfie. When a company onboards a remote employee, it asks for a video call. When a government issues a document, it binds the document to a photograph of a face.

The premise of all of this is that a face is hard to fake. Producing a convincing synthetic face — one that moves naturally, blinks, responds to prompts, and does not trigger the uncanny valley — was, until recently, a research problem. The technology existed in labs, and the outputs were visibly artificial. Nobody was going to pass a KYC check with a 2018-era deepfake.

DeepFaceLab changed that. The project, originally released in 2018 and continuously maintained since, provides a complete pipeline for training face-swap models. It is open source, well documented, and runs on hardware that a motivated attacker can afford. The outputs are good enough to pass a video call with a human observer, and — depending on the target's liveness detection — sometimes good enough to pass an automated KYC system.

This writeup covers what DeepFaceLab actually does, why the training pipeline is accessible without specialized hardware, what the attack scenarios look like, and why the defensive response is not what most organizations assume.

## Part one — what DeepFaceLab is

DeepFaceLab is not a single tool. It is a collection of scripts that together form a **face-swapping pipeline**. Given two sets of videos — one of a source face (the attacker's) and one of a destination face (the target's) — DeepFaceLab produces a model that can take any frame of the source and render it with the destination's features.

The pipeline has four stages, each implemented as a separate script:

1. **Extraction.** The tool scans every frame of the input videos, detects faces, and crops them out along with the surrounding alignment information (landmarks, pose, expression). This produces a dataset of face crops.

2. **Training.** A neural network learns the mapping between the source face and the destination face. This is the compute-intensive step.

3. **Conversion.** The trained model is applied to a new video — usually the source video, with the destination face substituted — producing a video of the target face performing the attacker's movements.

4. **Merge.** The converted face is composited back into the original frames, with color correction, masking, and blending to hide the seams. The output is a final video.

The entire pipeline is bundled as a set of Windows batch files and Linux shell scripts. There is no GUI in the traditional sense — the operator runs scripts in sequence, configures parameters through text files, and monitors progress through console output. The learning curve is moderate; the time investment is high (training can take hours to days); the technical barrier is lower than the results would suggest.

## Part two — why this is accessible

The most common objection to deepfake attacks is "that requires a data center". It does not. It requires a consumer GPU and patience.

**Hardware requirements.** Training a face-swap model is GPU-intensive. A modern NVIDIA GPU (RTX 3060, 3070, 4060) trains a usable model in six to twelve hours. Older cards (GTX 1080) take two to three times longer. CPU-only training is possible — DeepFaceLab supports it — but takes ten to thirty times longer, with the result that a model that would train overnight on GPU takes a week or more on CPU. This is the scenario in the demonstration video: a machine without a dedicated GPU, running at roughly seven frames per second, producing results that are slow but functional.

**Reference data.** DeepFaceLab needs video of the destination face. A few minutes of clear footage — a video call recording, a social media clip, a public interview — is enough. The tool extracts thousands of face crops from this footage, which becomes the training data for the model. Like voice cloning, the reference data is trivially available for anyone with a public presence.

**Cost.** The software is free. The hardware, if the attacker does not already own it, is a one-time cost of €300 to €1500 for a consumer GPU. Cloud GPU rental services (Vast.ai, RunPod, Lambda Labs) provide on-demand access at roughly €0.30 to €1.50 per GPU-hour, which puts a full training cycle in the range of €5 to €20 per target.

**Result quality.** Modern DeepFaceLab output is not obviously artificial. On a compressed video call, with the target's face at moderate resolution and moderate frame rate, the swap is difficult to detect without forensic analysis. On a broadcast-quality recording, the artifacts are more visible, but the bar for "good enough to fool a human on a phone call" was crossed years ago.

The combination of accessible hardware, freely available software, readily available reference data, and low cost is what makes this technique different from the 2018-era research demos. The capability is not new. The accessibility is.

## Part three — what the attacks look like

Face-swapping enables a specific class of attack that voice cloning alone does not fully cover. Voice cloning defeats voice verification. Face-swapping defeats *video* verification.

### Scenario 1 — Video KYC bypass

Many financial institutions, crypto exchanges, and remote onboarding systems perform KYC through a video call. The user is asked to show their ID document to the camera, then take a selfie or perform a challenge (turn head, blink, read a phrase). The system compares the ID photo to the live video and — if liveness detection passes — approves the verification.

A face swap lets the attacker replace their face with the target's in real time. The ID is presented by the target's face. The selfie shows the target's face. The challenge is performed by the target's face. If the system is automated, the liveness detection may or may not catch the swap, depending on how it works. If the system involves a human reviewer — which is common in high-value KYC — the reviewer sees a video call with the target's face and, in most cases, approves.

The 2024 Hong Kong case is the canonical example: an employee of a UK-based engineering firm was tricked into transferring HK$200 million after a video conference call in which every participant appeared to be a senior executive of the firm. The participants were all deepfakes. The employee was not present in the room with them. The video call was the attack.

### Scenario 2 — Remote onboarding fraud

A variant of the KYC bypass: an attacker applies for a remote position at a company using a real person's identity and a face-swapped interview. The interview is conducted by video. The attacker — sitting at a keyboard in one location — appears as the person whose face is on the resume. If the company hires, the attacker gains access to systems, salary, and any sensitive information that flows through the position.

This is a growing category. A North Korean IT worker program has been documented by multiple security firms, placing operatives in Western companies using stolen identities and, increasingly, deepfake video for interviews. The scheme generates revenue for the North Korean state and provides access to Western corporate environments.

### Scenario 3 — Sextortion and non-consensual imagery

DeepFaceLab is one of the tools behind the proliferation of non-consensual intimate imagery (NCII) — synthetic pornography created by swapping a target's face onto an existing video. The technique is straightforward: take a public figure's or private individual's face, apply it to a source video, produce the output. The tool's documentation explicitly forbids this use, but the software does not enforce any restriction.

The legal and ethical landscape here is the most fraught of any application. This use case is worth mentioning because it is a real harm that the technology enables, and any complete discussion of deepfakes has to account for it. It is not the focus of this writeup, but it is part of the context.

### Scenario 4 — Extortion and family emergency scams

A family member receives a video call from a "relative" who is visibly in distress and asking for money. The relative's face is correct — the attacker has swapped their own face with the relative's using footage from social media. The voice is cloned. The scene is set. The victim, seeing the person they trust and hearing the voice they trust, sends money.

This variant combines voice cloning with face swapping. Both technologies are accessible. Together, they defeat the two biometric signals that most people use to verify identity in a family context.

## Part four — the limits

Face swapping is effective, but not universally so. Understanding the limits matters for both offense and defense.

**Liveness detection.** A face swap on a static image does not respond to challenges. "Turn your head" — the swapped face must rotate. "Read this phrase" — the lips must match the audio. "Blink twice" — the swap must reproduce the eye movement. DeepFaceLab does not handle all of these perfectly. A live video feed with a real person in front of a camera, whose face is being swapped in real time, does handle them — but real-time face swapping requires a powerful GPU and low latency, which is harder than pre-recorded deepfakes.

**Real-time latency.** Converting a video stream in real time requires significant compute. On a consumer GPU, real-time face swapping at acceptable quality is possible but demanding — the model must run inference fast enough to keep up with the incoming frame rate. Higher-quality models are slower. There is a trade-off between quality and latency, and the choice depends on the attack scenario.

**Hands and fine details.** DeepFaceLab swaps the face. Hands, ears, neck, and surrounding details are not swapped. If the destination face has a distinctive feature outside the face region — a scar, a tattoo, a specific hairline — that feature is not reproduced. Attacks that require showing hands or full-body views are harder to execute convincingly.

**Audio-visual coherence.** The swapped face must match the audio. If the attacker speaks, the lips of the swapped face must move in time with the attacker's voice. Basic DeepFaceLab produces faces that move naturally with the underlying video but does not synchronize with arbitrary audio. Audio-to-lip-sync tools exist (Wav2Lip, SadTalker), and combining them with DeepFaceLab produces a coherent output. This is more complex than either tool alone.

**Forensic analysis.** Post-hoc detection of deepfakes uses a range of signals: spectral artifacts in the frequency domain, inconsistencies in the blink rate, asymmetry between the left and right side of the face, and discontinuities in the boundary between the swapped region and the original. These techniques are not perfect — each has false positives and false negatives — but a determined analyst with the original video and the target's real footage can often identify a swap.

The aggregate picture: face swapping works for many scenarios, fails for some, and is detectable with effort. It is not a universal bypass. It is a capability that raises the cost of identity verification.

## Part five — detection

Detection of deepfakes has become a research field in its own right. The tools fall into several categories.

**Commercial detection services.** Sensity, Reality Defender, DuckDuckGoose, and Intel's FakeCatcher offer deepfake detection as a service. They analyze uploaded video and return a probability that the video is synthetic. The results vary in accuracy, and the models are trained on specific deepfake generators, so a novel generator may pass.

**Open-source detectors.** The DFDC (Deepfake Detection Challenge) produced a set of open-source models. These are less capable than the commercial tools but freely available. They are useful for research and for building custom detection pipelines.

**Forensic signals.** A human analyst looking at a suspect video can look for specific artifacts:
- **Blinking rate.** Early deepfake models did not blink, or blinked unnaturally. Modern models have mostly addressed this, but the blink rate can still be a signal.
- **Boundary artifacts.** The edge of the swapped region sometimes shows a subtle discontinuity — a slight color shift, a change in grain, a difference in resolution.
- **Head pose and consistency.** The orientation of the face must be consistent with the orientation of the body. Small mismatches are visible.
- **Lighting.** The lighting on the face must be consistent with the lighting of the scene. If the face is lit from a direction that does not match the rest of the frame, the swap is visible.
- **Audio-visual sync.** In combined voice and face attacks, the sync between the audio and the lips is often imperfect. Careful analysis catches this.

**Liveness challenges.** Automated KYC systems that require a live, dynamic response to a challenge — turn left, read a phrase, hold up a specific hand gesture — are harder to defeat with pre-recorded deepfakes. Real-time face swapping can pass these, but it requires the attacker to have a working real-time pipeline and to respond to the challenge in real time, which is significantly harder.

The honest position: detection is possible in specific contexts, unreliable in general, and lags behind generation. The defender's leverage is not in detection; it is in the design of the verification process.

## Part six — defense

The defensive response to face swapping is not better deepfake detection. It is a change in what verification relies on.

**Move to cryptographic verification.** The same principle that applies to voice cloning applies here. A face is not proof of presence — it is a signal that can be synthesized. What proves presence is something the attacker does not have and cannot fake: a private key, a hardware token, a signed message, a challenge-response protocol that depends on a secret the attacker does not know.

For high-value interactions, cryptographic verification is the only reliable defense. For lower-value interactions, a combination of signals — voice, face, knowledge, behavior — raises the cost, but does not eliminate the risk.

**Implement liveness challenges that require real-time response.** A video call that asks the participant to do something unexpected — hold up a piece of paper with a specific phrase written on it, point at an object in the room, respond to a novel question — is harder to fake. Pre-recorded deepfakes cannot respond. Real-time deepfakes can, but only if the attacker has a real-time pipeline, which is a significant technical investment.

**Verify identity through multiple independent channels.** A video call plus a phone call to a number on file plus an email to a known address plus a document verification plus a knowledge-based challenge. Each additional channel increases the cost of the attack. No single channel is reliable; the combination is more reliable.

**Set expectations about high-value requests.** A financial request, a credential reset, an urgent action — any request that is out of the ordinary should be verified out-of-band. The verification should be initiated by the recipient, not the requester. This breaks the attacker's control over the channel.

**Educate on the specific threat.** Training that says "deepfakes exist" is not enough. Training that says "the face on a video call can be synthesized from a few minutes of public video" changes the mental model. Users who understand that the face is a data artifact behave differently.

**Consider biometric authentication with liveness, but not as the sole factor.** Modern biometric systems combine face recognition with liveness detection with anti-spoofing measures. These systems are more robust than a human observer, but they are not immune to high-quality attacks. They should be one factor among several, not the only factor.

**Regulatory and legal frameworks.** Several jurisdictions have begun to regulate deepfake creation and use, particularly for non-consensual intimate imagery and political disinformation. These frameworks are reactive and lag behind the technology, but they provide a legal basis for prosecution and a deterrent for some categories of attackers. They do not provide a technical defense.

## Part seven — the broader lesson

Face swapping is a specific instance of the same pattern as voice cloning: **biometric signals that were treated as proof of identity become unreliable as the technology to synthesize them improves.**

The pattern is not new. Signatures were once proof of identity; they became unreliable when forgery techniques became widely available. Photographs were once proof of presence; they became unreliable when photo editing became widespread. Voice and face are the latest, and they will not be the last.

The response is not to abandon biometrics. It is to stop treating biometrics as *proof* and start treating them as *evidence*. A face is evidence that the person is probably who they claim to be. It is not proof. Proof requires something the attacker does not have — a secret, a physical token, a signature.

Cryptographic authentication is the only signal that meets this standard. It requires something the attacker does not have (the private key, the hardware token) and cannot synthesize (a face, a voice, a fingerprint). The organizations that have already made this transition are the ones that are not vulnerable to deepfakes. The organizations that have not are the ones that will discover the vulnerability the hard way.

## Part eight — the ethics

DeepFaceLab is a tool. It is used legitimately for film production, for research on deepfake detection, and for creative applications. It is used maliciously for non-consensual imagery, fraud, and impersonation. The technology does not distinguish between these uses. The intent does.

The professional position: **face swapping belongs in the toolkit for security research and authorized testing.** Using it against real people — for fraud, for impersonation, for non-consensual imagery — is a crime in most jurisdictions and an ethical violation in all of them. The barrier to entry is low enough that the deterrent is not technical feasibility but legal and social consequences.

This is worth stating because the technology's accessibility has grown faster than its regulation. A motivated attacker with a mid-range GPU and a few hours of free time can produce a convincing deepfake of any public figure or, with more effort, of a private individual. The tools are free. The documentation is comprehensive. The only barrier is the willingness to use them.

## Takeaway

The face on the video call is not the person on the video call. It has not been for years, and the last technical barriers fell recently. DeepFaceLab is not a novelty — it is a complete, documented pipeline that produces broadcast-quality results on consumer hardware. The reference data required to build a model of any public figure is available on social media. The cost of a full training cycle is measured in hours and, on cloud hardware, in single-digit euros.

Every protocol that relies on face recognition — KYC verification, remote onboarding, family emergency calls, video KYC — is now vulnerable to an attacker who can build a model. The vulnerability is not in the protocol; it is in the assumption that the protocol rests on.

The defense is not better deepfake detection. It is to stop treating face as proof of identity and to replace it with cryptographic verification — the only signal that cannot be synthesized. The transition is uncomfortable because it requires changing processes that have worked for a decade. It is also the only transition that works.
