# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
