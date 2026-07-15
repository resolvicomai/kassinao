# Product Hunt launch draft

**Pre-launch only.** Do not mark Kassinão as launched or paste the post-launch copy until the public release, site, docs, demo, privacy flow, GHCR image, operations bundle, npm package, and external-account security checks all pass.

The public demo is fictional and has optional AI features enabled to show the full flow. It is not a hosted workspace and must never contain a real meeting, private app hostname, guild/application ID, or operator data.

## Listing draft

**Name**

> Kassinão

**Tagline**

> The self-hosted Discord bot for searchable call memory

**Description**

> Kassinão records Discord calls with one audio track per account that speaks, plus a mix and timestamped notes. Operators can optionally enable transcription, AI minutes, sourced /ask answers, webhooks, and a read-only MCP connector. Each deployment uses its own Discord app, private meeting app, storage, retention, and providers. Access is rechecked against current Discord membership and the meeting ACL. AGPL open source; infrastructure and provider costs are yours.

**Short fallback**

> A self-hosted Discord bot that records separate speaker-account tracks, a mix, and timestamped notes. Add transcription, AI minutes, sourced answers, and read-only MCP only when your operator enables them.

**Intended primary URL**

> https://kassinao.cloud/en

The primary URL must open the public English landing. It must not redirect to the private app, OAuth, or an instance MCP API.

**Pricing**

> No software license fee; AGPL-3.0-or-later. Self-hosters pay for their own server, storage, domain, backups, and any ASR/AI providers they enable.

**Suggested tags**

- Open Source
- Productivity
- Artificial Intelligence

Kassinão is an independent project and is not affiliated with or endorsed by Discord.

## Gallery plan

- `thumbnail-240.png`: square `k/` product mark.
- `gallery-cover-en-1270x760.png`: category and core recording value.
- `discord-demo-en-ph.gif`: fictional Discord workflow; first frame must stand alone.
- `gallery-02-1270x760.png`: separate track for each Discord account that speaks, without a perfect-attribution claim.
- `gallery-04-1270x760.png`: optional sourced answers and five read-only MCP tools.
- `gallery-01-1270x760.png`: optional wider workflow.
- `launch-teaser-en.mp4`: social teaser; Product Hunt video must use a supported public video URL.

Regenerate every image/GIF from the final interface and final copy. Label the demo **Fictional demo · optional AI enabled**. Do not show finished transcripts/minutes as installation defaults, downloads during an active recording, a public `/ask` response, a shared workspace, or detailed meeting content in a Discord channel.

Run `npm run assets:launch` to regenerate the cover, track/MCP cards, repository social preview, and shared Open Graph image from the checked-in SVG renderer. The Discord capture, GIF/WebM, and teaser must be recaptured from the final preview route after product copy or layout changes.

Recommended order: cover, Discord capture, separate speaking-account tracks, optional outputs/MCP.

## First maker comment draft

> Hey Product Hunt 👋
>
> I built Kassinão for teams whose real conversations happen in Discord and disappear as soon as the call ends.
>
> The base product is deliberately straightforward: run /record, get one audio track for each Discord account that speaks, a mixed recording, and timestamped notes. The bot posts a recording panel before capture starts, and the finished meeting stays in a private app behind Discord membership and a per-meeting ACL.
>
> Transcription and AI are not silently on. The person operating the instance chooses whether to enable ASR, meeting minutes, sourced /ask answers, webhooks, or the five read-only MCP tools, and chooses the providers and retention for that deployment.
>
> There is no Kassinão-hosted workspace or public signup. Every self-hoster creates their own Discord application, URLs, storage, policy, and security perimeter. The code is AGPL; infrastructure and external provider costs belong to the operator.
>
> The public demo uses fictional data and has optional AI enabled so you can inspect the complete experience without entering a private instance.
>
> I would value feedback on the Discord recording flow, the self-hosting boundary, and which read-only meeting query should come next.

## Post-launch copy (locked until verification)

Use only after the Product Hunt listing and every target URL are actually public and verified:

> Kassinão is now on Product Hunt. It is an AGPL, self-hosted Discord bot that records separate tracks for the accounts that speak, plus a mix and timestamped notes. Operators can opt into transcription, AI minutes, sourced answers, and read-only MCP. Explore the fictional demo and tell me what you would query first: [verified launch URL]

## 35-second demo script

1. `0–5s`: label the fixture fictional; run `/record` in a Discord voice channel.
2. `5–11s`: show the required channel panel and separate tracks appearing for accounts that speak.
3. `11–16s`: add a timestamped `/note`.
4. `16–22s`: run `/stop`; distinguish immediate audio from optional asynchronous processing.
5. `22–29s`: open the protected meeting renderer with fictional transcript/minutes and an “optional AI enabled” label.
6. `29–35s`: show an ephemeral sourced `/ask` answer or a read-only MCP result, then the public GitHub repository.

Product interaction must remain the proof. Motion may frame the sequence but must not replace the real interface or imply functionality that was not exercised.

## Launch gate

- [ ] Final public release exists, is immutable, and exposes verified operations-bundle assets.
- [ ] Exact public GHCR digest, checksums, release integrity, and GitHub attestations verify.
- [ ] Clean source-free split deployment from the public bundle passes on the production VPS.
- [ ] Active VPS data/auth/snapshots are verified encrypted at rest and recorded in the private runbook.
- [ ] Operator policy is public at the private instance's `APP_URL/privacy`; Discord's Privacy Policy URL points there.
- [ ] A real external-account request for data access/deletion reaches the operator's documented process.
- [ ] Public Bot is off for the private company application; Guild Install uses only `bot` and `applications.commands` with bitfield `68242432`.
- [ ] Unauthorized, departed-member, host-routing, OAuth, MCP, and recording-panel fail-closed tests pass externally.
- [ ] English/PT landing, docs, demo, GitHub, npm, canonical URLs, Open Graph images, HTTPS, keyboard, mobile, and reduced-motion checks pass.
- [ ] No public CTA opens a private app/API and no asset contains a private hostname, ID, meeting, or credential.
- [ ] Gallery media uses the final copy, fictional data, correct 1270×760 size, and uploader limits.
- [ ] Product Hunt listing, maker profile, tags, pricing, and launch date are reviewed in the live form before publication.
- [ ] Communities are asked for honest feedback, never for upvotes.

Current platform references: [Preparing for launch](https://www.producthunt.com/launch/preparing-for-launch), [How to post a product](https://help.producthunt.com/en/articles/479557-how-to-post-a-product), [Sharing your launch](https://www.producthunt.com/launch/sharing-your-launch), and [Featuring guidelines](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines).
