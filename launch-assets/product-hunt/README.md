# Kassinão on Product Hunt

## Listing copy

**Name**

> Kassinão

**Tagline, 55 of 60 characters**

> The Discord bot that turns calls into searchable memory

**Description, under the current 500-character limit**

> Kassinão turns Discord calls into searchable team memory. It records one track per speaker, then creates named transcripts, meeting notes, decisions, action items, and answers with source links. Ask inside Discord or from an MCP-capable AI assistant. It is free, AGPL open source, and self-hosted, with access rechecked against Discord membership and meeting permissions.

> There is no hosted workspace or public signup. Each operator deploys their own Discord app, private URL, storage, and MCP API.

**Fallback description, under 260 characters**

> Kassinão is an open-source Discord bot that records one track per speaker and turns calls into named transcripts, meeting notes, action items, and sourced answers. Self-host it, choose your AI provider, and keep access tied to Discord permissions.

**Primary URL**

> https://kassinao.cloud/en

**Pricing**

> Free, AGPL-licensed, self-hosted software. Users only pay for their own infrastructure and any external transcription or AI providers they enable. Local transcription is supported.

**Suggested launch tags**

- Open Source
- Productivity
- Artificial Intelligence

## Gallery

- `thumbnail-240.png`: square `k/` mark used as the listing thumbnail.
- `gallery-cover-en-1270x760.png`: English value-proposition cover and first gallery item.
- `discord-demo-en-ph.gif`: cover-first animated workflow for the Product Hunt gallery.
- `gallery-02-1270x760.png`: one Discord member, one audio track, one named transcript line.
- `gallery-04-1270x760.png`: sourced answers in Discord and the read-only MCP connector.
- `gallery-01-1270x760.png`: complete Discord workflow, useful as an optional fifth item.
- `launch-teaser-en.mp4`: H.264 social teaser; Product Hunt itself requires a YouTube or Loom URL for video.

Recommended order: cover, animated workflow, speaker identity, answers and MCP. Keep `gallery-03-1270x760.png` out of the launch until its stale zero-duration audio state is recaptured.

## First maker comment

> Hey Product Hunt 👋
>
> I built Kassinão around a Discord-specific advantage: the platform already exposes a separate voice stream for each participant. Instead of mixing everyone together and trying to infer speakers afterward, Kassinão keeps that identity from capture to transcript.
>
> Start with /record. When the call ends, you get a named transcript, meeting notes, decisions, action items, timestamped notes, downloads, and /ask answers with links back to their sources. The same authorized meeting memory can be queried through a read-only MCP connector from Claude Desktop, Cursor, and other MCP clients.
>
> Kassinão is free and AGPL open source. You self-host it, control retention, and choose local transcription or supported cloud providers. Recording stays visible inside Discord, and access to each meeting is rechecked against Discord membership and meeting permissions.
>
> There is no hosted workspace or public signup. The public site is a product demo and installation guide; your deployment owns the bot, private app, domain, storage, and MCP API.
>
> The public demo uses fictional data but the real product interface, so you can explore a finished meeting without signing in.
>
> I’d especially value feedback on three things: the Discord workflow, the self-hosting experience, and which meeting-memory query should become the next MCP tool.

## Launch post

> Kassinão is live on Product Hunt. It turns Discord calls into named transcripts, meeting notes, action items, and sourced answers — free, open source, and self-hosted. Try the demo and tell me what you’d query first: [launch URL]

## 35-second demo script

1. `0s–5s`: show a Discord voice channel and run `/record`.
2. `5s–11s`: reveal one track per person and the visible recording panel.
3. `11s–16s`: add a timestamped `/note`.
4. `16s–23s`: stop the call and open the finished meeting.
5. `23s–29s`: move across meeting notes, tasks, and the named transcript.
6. `29s–35s`: run `/ask` and end on the source link plus the open-source GitHub page.

Use a real local fixture and keep the “fictional demo” label visible. Higgsfield can polish the intro or outro, but the product interaction should remain the center of the video.

## Launch checklist

- [ ] Deploy the English landing/demo on `kassinao.cloud` and docs on `docs.kassinao.cloud`; verify the GitHub repository and npm package are public.
- [ ] Verify canonical URLs, Open Graph images, HTTPS and public navigation. No CTA may open a private app or API.
- [ ] Verify the public demo without authentication in a clean browser.
- [ ] Confirm the Product Hunt primary URL opens the English landing.
- [ ] Upload the square thumbnail and at least two 1270×760 gallery images.
- [ ] Keep every image or GIF under the live uploader's 2 MB limit and make the first GIF frame useful.
- [ ] Add up to three relevant tags, pricing, maker profile, and shoutouts.
- [ ] Publish a public YouTube URL only if using a gallery video.
- [ ] Paste the first maker comment immediately after launch.
- [ ] Ask communities for honest feedback, never for upvotes.
- [ ] Monitor comments and answer product, privacy, and setup questions during launch day.

Current official guidance: [Preparing for launch](https://www.producthunt.com/launch/preparing-for-launch), [How to post a product](https://help.producthunt.com/en/articles/479557-how-to-post-a-product), [Sharing your launch](https://www.producthunt.com/launch/sharing-your-launch), and [Featuring guidelines](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines).
