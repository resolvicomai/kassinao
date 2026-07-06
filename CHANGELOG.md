# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-07-06

### Added
- **Real VAD (voice activity detection)** — only speech segments are sent to the transcription API (silence-padded tracks are trimmed with ffmpeg `silencedetect`). Cuts cost/quota dramatically and eliminates the classic Whisper silence hallucinations ("Legenda Adriana Zanotto"…), plus a post-filter for known hallucinated phrases and repetition loops.
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

[1.0.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.0.0
