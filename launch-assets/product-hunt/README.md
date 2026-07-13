# Kassinão on Product Hunt

## Listing copy

**Name**

> Kassinão

**Tagline, 55 of 60 characters**

> The Discord bot that turns calls into searchable memory

**Description, under the current 500-character limit**

> Kassinão is the open-source Discord bot that records one track per speaker, then turns calls into named transcripts, meeting notes, decisions, action items, and sourced answers in Discord or any MCP client. Self-host it, choose your AI provider, and keep access tied to Discord permissions.

**Primary URL**

> https://kassinao.cloud/en

**Pricing**

> Free, open source, self-hosted. External AI providers may charge for usage.

**Suggested launch tags**

- Open Source
- Productivity
- Developer Tools

## Gallery

- `thumbnail-240.png`: square `k/` mark.
- `gallery-01-1270x760.png`: the complete Discord workflow, from `/record` to a sourced `/ask` answer.
- `gallery-02-1270x760.png`: one Discord member, one audio track, one named transcript line.
- `gallery-03-1270x760.png`: the real public meeting interface with fictional data.
- `gallery-04-1270x760.png`: sourced answers in Discord and the read-only MCP connector.
- `discord-demo-en.gif`: animated version for the gallery or launch posts.

Recommended order: Discord workflow, speaker identity, finished meeting, answers and MCP.

## First maker comment

> Hey Product Hunt, I built Kassinão because Discord calls contain important decisions, but the useful context usually disappears as soon as everyone leaves the channel.
>
> Most meeting bots start from one mixed recording and use diarization to infer who spoke. Discord already gives a bot a separate audio stream for each person, so Kassinão preserves that identity from the recording all the way to the transcript.
>
> After a call, it delivers a named transcript, meeting notes, decisions, action items, timestamped notes, and sourced answers through `/ask`. The same meeting memory can be queried from Claude, Cursor, or another MCP client without bypassing Discord access rules.
>
> Kassinão is AGPL open source and self-hosted. You choose local processing or an external AI provider, control retention, and keep the bot on your own infrastructure.
>
> I would especially value feedback on the Discord workflow, self-hosting setup, and which meeting-memory query should become the next MCP tool.

## 35-second demo script

1. `0s–5s`: show a Discord voice channel and run `/record`.
2. `5s–11s`: reveal one track per person and the visible recording panel.
3. `11s–16s`: add a timestamped `/note`.
4. `16s–23s`: stop the call and open the finished meeting.
5. `23s–29s`: move across meeting notes, tasks, and the named transcript.
6. `29s–35s`: run `/ask` and end on the source link plus the open-source GitHub page.

Use a real local fixture and keep the “fictional demo” label visible. Higgsfield can polish the intro or outro, but the product interaction should remain the center of the video.

## Launch checklist

- [ ] Deploy the English landing/demo on `kassinao.cloud`, docs on `docs.kassinao.cloud`, the private app on `app.kassinao.cloud`, and MCP discovery/API on `mcp.kassinao.cloud`.
- [ ] Verify canonical URLs, Open Graph images, HTTPS and cross-domain navigation on all four origins.
- [ ] Verify the public demo without authentication in a clean browser.
- [ ] Confirm the Product Hunt primary URL opens the English landing.
- [ ] Upload the square thumbnail and at least two 1270×760 gallery images.
- [ ] Keep every image or GIF under 3 MB and make the first GIF frame useful.
- [ ] Add up to three relevant tags, pricing, maker profile, and shoutouts.
- [ ] Publish a public YouTube URL only if using a gallery video.
- [ ] Paste the first maker comment immediately after launch.
- [ ] Ask communities for honest feedback, never for upvotes.
- [ ] Monitor comments and answer product, privacy, and setup questions during launch day.

Current official guidance: [Preparing for launch](https://www.producthunt.com/launch/preparing-for-launch), [How to post a product](https://help.producthunt.com/en/articles/479557-how-to-post-a-product), [Sharing your launch](https://www.producthunt.com/launch/sharing-your-launch), and [Featuring guidelines](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines).
