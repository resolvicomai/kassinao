# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] — 2026-07-13

### Changed

- Gemini transcription now defaults to `gemini-3.5-flash` because Google shut down `gemini-2.0-flash` on 2026-06-01. Operators using `TRANSCRIBE_PROVIDER=gemini` without an explicit `TRANSCRIBE_MODEL` should review the current Gemini pricing before upgrading.
- `kassinao-mcp` 1.0.4 isolates each local connection and token rotation by profile, rejects credential-bearing redirects, and is published as the exact offline-verified artifact through npm Trusted Publishing with provenance.
- Native Opus is compiled from the signed npm source tarball; ffmpeg and tini come from signed Debian repositories instead of postinstall executable downloads.

### Fixed

- Every recording request revalidates current Discord membership. Historical access is limited to the starter, people who were present, and current admins; destructive actions always force a separate check.
- Public Discord panels and completion notices contain only generic status. Private details stay in freshly authorized DMs/pages, and a durable, no-delete migration neutralizes historical bot messages without overwriting concurrent edits.
- Membership REST calls, archive scans, transcript reads, notes, presence identities, candidates, guilds, payload bytes, and segments now have per-user and global availability budgets. Guild timelines stay pre-indexed, web libraries use bounded cursors, and large transcript routes paginate or fail before unbounded allocation.
- The application container no longer receives the Cloudflare Tunnel token from the shared Compose environment.
- Private notification fanout is bounded and resumable; successful DMs are not duplicated, starter DMs revalidate membership, and webhook failures never log credential-bearing URLs.

## [1.4.1] — 2026-07-13

### Fixed

- Authenticated actions in the private app no longer reject a canonical `app.kassinao.cloud` request when browser Fetch Metadata classifies its form navigation as cross-site. Exact origins remain required whenever the browser sends `Origin`; sibling and external origins remain blocked.

## [1.4.0] — 2026-07-13

### Added

- Public marketing site and private `/app/*` workspace, with a fictional live demo, recordings table, tabbed meeting view, light/dark themes, and per-device MCP connection management.
- Local-only `/health/details` for safe pre-deploy checks without exposing active-call or disk metadata publicly.
- Split-origin deployment through `APP_URL`, `PUBLIC_URL`, `DOCS_URL`, and `MCP_URL`, with host isolation, canonical metadata, per-surface robots/sitemaps, and fail-closed handling for unconfigured hostnames.

### Changed

- The official hosted service now uses `kassinao.cloud` for the landing/demo, `docs.kassinao.cloud` for documentation, `app.kassinao.cloud` for OAuth and private recordings/transcripts, and `mcp.kassinao.cloud` for the connector API. Unconfigured or retired origins cannot access API, OAuth, or private routes.
- `/ask` now resolves meeting dates separately from action deadlines (including relative deadlines such as `today`, `tomorrow`, and weekdays), ranks eligible meetings before applying context limits, and searches structured minutes fields including decisions, actions, owners, due dates, topics, attendance, and per-participant notes.
- `kassinao-mcp` 1.0.3 pins saved refresh tokens to their issuing instance, isolates multiple local connections, serializes concurrent refreshes, preserves sessions across transient 429/5xx responses, and reports its package version to MCP clients.
- Private web/API responses are `no-store`; session cookies are scoped to `/app`; state cookies are scoped to `/auth`; app mutations validate the exact request origin.
- Recording access now requires current server membership. Private-channel history is limited to its starter/participants and current admins; only channels public to `@everyone` when recording began may follow their current audience.
- Container capabilities are dropped and the Node, Cloudflare Tunnel, and autoheal images are pinned to immutable multi-architecture digests.

### Fixed

- `/ask` no longer drops relevant older meetings behind recency/count cuts, bounds archive/transcript work before the LLM, isolates cost quotas per user/guild, and lets the model select source IDs only; the server renders the exact sanitized evidence and authorized links.
- MCP `participantId` filtering now includes people who attended a call without speaking.
- Invalid numeric environment settings, weak manually configured signing secrets, and malformed `BASE_URL` values now fail fast instead of silently weakening sessions or disabling retention, disk guards, timeouts, or token expiry.
- Recording tabs expose complete ARIA relationships and keyboard navigation.
- Revoked Discord roles/membership can no longer survive indefinitely in the discord.js cache; membership refreshes use authoritative REST and destructive actions bypass the local TTL.
- Web logout revokes a persisted session id, cross-site GET can no longer log a user out, and unauthorized/nonexistent recording ids return indistinguishable responses.
- Off-site backups exclude cookie secrets and web/MCP session registries, preventing a leaked or restored archive from forging or resurrecting access state.

## [1.3.0] — 2026-07-07

### Added
- **Unlimited retention** — `RETENTION_DAYS=0` turns expiry off entirely (audio AND text; unlimited audio forces unlimited text). Expiry is now answered by the *current* config, not by the death date stored in each recording — flipping to unlimited retroactively saves existing recordings. `TEXT_RETENTION_DAYS=0` keeps text forever while audio still expires.
- **Recordings manager (`/gravacoes` v2)** — the web index went from "list" to "management": totals header (count, audio bytes on disk, free disk — disk info visible **only to `OWNER_IDS`**), sort by recent/oldest/largest (largest is owner-only), enriched cards (who started, notes count, relative age, per-recording disk size for the owner) and inline actions for whoever can delete.
- **"Free up space" action** — deletes only the audio (tracks + cache) and keeps transcript, minutes and notes; the perfect pair for unlimited retention (the memory stays, the gigabytes come back). Guarded like delete (initiator/admin, blocked while live/downloading/transcribing, idempotent) — new `POST /rec/:id/liberar-audio`.
- **AssemblyAI Universal-3.5-Pro prompting** — recordings transcribed with the new model now send a contextual `prompt` (`TRANSCRIBE_PROMPT`) and per-recording `keyterms_prompt`: the exact names of everyone in the call (speaking or muted) plus server/channel and the optional fixed team vocabulary `TRANSCRIBE_KEYTERMS` — proper spelling of names and jargon in the transcript, minutes and `/ask`. Gracefully degrades (retries without extras) if the API routes to a model without support.

### Changed
- Retention copy across DM/panel/help/page/landing/README is conditional: unlimited mode says "kept until someone deletes it" instead of promising an expiry that will never come.
- Deleting from the index returns to the index (with a confirmation flash) instead of a dead-end page.

## [1.2.0] — 2026-07-06

### Added
- **Web recordings index with full-text search** — `/gravacoes` on the web (Discord login) lists everything you can access across servers, with a channel filter and full-text search over transcripts, minutes and notes; results deep-link to the exact minute. The Discord `/recordings` command now links to it.
- **`/ask` (`/perguntar`)** — ask your meetings right inside Discord: the AI answers (ephemeral, only you see it) using only the transcripts *you* can access, with `[hh:mm:ss]` citations linking to the exact moment. Optional `days:` window (default 30). Requires AI minutes enabled (OpenRouter or Groq key).
- **Minutes summary posted to Discord** — when the minutes are ready, the bot posts an embed with summary, decisions and action items straight to Discord (no login needed), alongside the link.
- **`/config minutes-channel` (`/config ata-canal`)** — admins pick the text channel where the minutes summary is posted; without it, it goes to the voice channel's chat. `/config view` shows the current state.
- **📌 "Mark moment" button** on the live recording panel — stamps the current timestamp with a single click, no typing (saved as a "📌 moment marked" note).
- **Tiered retention** — `RETENTION_DAYS` (default 7) now expires only the **audio**; transcript + minutes + notes live for `TEXT_RETENTION_DAYS` (default 90, never below `RETENTION_DAYS`). The page shows "audio expired" and keeps all the text; search, `/ask` and MCP keep working.
- **Operator minutes webhook** — `MINUTES_WEBHOOK_URL` receives a POST JSON `{event:'minutes.ready', recordingId, url, guildName, channelName, startedAt, endedAt, participants, minutes}` for every finished minutes (self-hosted integrations: n8n → Notion/Jira/etc). Env-only by design — never settable via Discord, to avoid SSRF.

### Changed
- **Recording page redesign** — sticky player with 1×/1.5×/2× speed, transcript grouped by speaker with per-speaker colors, in-transcript search/filter, karaoke-style follow-along, clickable time bar, and one-click copy of action items.
- Error messages shown to users are humanized (no more raw provider/stack errors).
- Audio cooking (mix/downloads) now runs at lower CPU priority (`nice`) and respects the disk guard.

### Fixed
- Partial transcriptions no longer disappear — partial results always stay visible while missing tracks are retried.
- Event anti-spam — join/leave floods no longer spam the live panel timeline.
- VAD now splits speech segments longer than 20 minutes (avoids provider upload limits on long monologues).
- Recordings stuck in an error state are recovered on boot.
- `/status` now reports the correct voice room.

## [1.1.0] — 2026-07-06

### Added
- **Real VAD (voice activity detection)** — speech segments are normally sent to the transcription API after silence-padded tracks are trimmed with ffmpeg `silencedetect`; fixed chunks are the safety fallback when detection fails. Cuts cost/quota dramatically and adds a post-filter for known hallucinated phrases and repetition loops.
- **AssemblyAI transcription provider** (`TRANSCRIBE_PROVIDER=assemblyai`, model `universal`) — top-3 for pt-BR; automatically falls back to Groq Whisper when a `GROQ_API_KEY` is present.
- **OpenRouter provider for AI minutes** (`OPENROUTER_API_KEY`, `MINUTES_PROVIDER`, default model `google/gemini-2.5-flash`) — huge context window, no more HTTP 413 on long calls; Groq path now uses map-reduce with rate-limit-aware pacing.
- **Call presence** — everyone in the voice channel is registered (`meta.presence`), even if muted the whole time: they get access to the recording, show up on the page ("also in the call"), and the timeline logs joins/leaves.
- **Wall-clock times on the timeline** — events and notes now show the real time of day (in the viewer's timezone) next to the relative offset.
- **Partial transcription state** — when the provider rate-limits mid-job, finished tracks are delivered, missing ones are retried automatically (per-track resume, no re-spending quota), and the page/Discord say exactly what is missing.
- `TRANSCRIBE_PROMPT` (context prompt for Whisper) and `temperature: 0` for less hallucination and better jargon spelling.

### Changed
- Groq default transcription model: `whisper-large-v3-turbo` → `whisper-large-v3` (better pt-BR).
- Transcription requests now wait out provider `429`s (Retry-After / "try again in Xm" aware) instead of failing the track.
- The audio mix is **pre-cooked** right after a recording ends — the player no longer takes minutes to start on first click.
- First-speech timeline event reworded ("spoke for the first time"); channel join/leave are their own events.

### Fixed
- Transcription no longer reports "done" when tracks were skipped by rate limits (the cause of "only 2 of 5 people transcribed").
- Meeting minutes no longer fail with `HTTP 413` on long calls.
- Muted participants no longer lose access to recordings of calls they attended.

## [1.0.0] — 2026-07-04

First public release.

### Added
- **Multi-track recording** — one separate, sample-aligned FLAC track per speaker.
- **Automatic transcription** with exact speaker attribution (no AI diarization), pluggable engine: Groq, OpenAI, Gemini, or a local command (faster-whisper / whisper.cpp).
- **AI meeting minutes** — summary, decisions, action items (with owner/due), timestamped topics, and a per-participant breakdown.
- **Recording web page** (Discord OAuth login) with audio player, clickable timestamps, and downloads: MP3, FLAC, single mix, and an Audacity project.
- **Access control** — only call participants, people who can see the channel, the initiator, or server admins can open a recording.
- **Live panel** in the voice channel chat with Stop / Add note buttons and a `[RECORDING]` nickname indicator.
- **Timestamped notes** (`/note` and panel button).
- **Auto-record** — starts on its own when people join a configured channel and stops when it empties.
- **Interactive onboarding** — `/help` with per-topic buttons; DMing the bot also replies with the guide.
- Bilingual (pt-BR / English), HTTPS via Cloudflare Tunnel, silence warnings, auto-stop, retention/expiry, crash recovery, and graceful shutdown.

[1.4.2]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.2
[1.4.1]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.1
[1.4.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.0
[1.3.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.3.0
[1.2.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.2.0
[1.1.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.1.0
[1.0.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.0.0
