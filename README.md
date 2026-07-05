<div align="center">

# Kassinão 🎙️

### Self-hosted Discord recorder with per-speaker AI notes

Record Discord voice calls with **one separate track per person**, then get an **AI transcript** and **meeting minutes** (summary, decisions, action items) — automatically, with **perfect speaker attribution** and no AI guessing who said what.

**🌎 Language:** **English** · [Português (BR)](README.pt-BR.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/resolvicomai/kassinao/actions/workflows/ci.yml/badge.svg)](https://github.com/resolvicomai/kassinao/actions/workflows/ci.yml)
[![Made with TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Runs on Docker](https://img.shields.io/badge/Docker-ready-2496ed.svg)](https://www.docker.com/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

<!-- 📹 DEMO: substitua por um GIF/vídeo real (docs/demo.gif) mostrando /gravar → painel → página com player + ata. É o ativo #1 do lançamento. -->
<p align="center"><em>▶️ Demo GIF coming here — <code>/record</code> → live panel → recording page with player, clickable timestamps and AI minutes.</em></p>

<p align="center">
  <b>▶️ <a href="https://kassinao.resolvicomai.app/demo">Try the live example →</a></b><br/>
  <sub>A real rendered recording page from a fictional 6-person, 1-hour meeting — opens without login.<br/>
  (Prefer plain text? Read the same transcript &amp; minutes <a href="docs/example/">on GitHub</a>.)</sub>
</p>

---

## Why Kassinão?

Bots like [Craig](https://craig.chat/) nail multi-track recording. AI note-takers like Otter or Fireflies nail summaries — but they **guess** who spoke (diarization), and that guessing breaks on crosstalk and non-English names.

Kassinão combines both **and sidesteps the hard part**: because every participant is captured on their **own audio track**, it already knows *exactly* who said what. The transcript and the AI minutes inherit that perfect attribution for free. It's open-source, self-hosted, and privacy-first.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How it compares](#how-it-compares)
- [Transcription backends](#transcription-backends)
- [AI connector (MCP)](#ai-connector-mcp)
- [Commands](#commands)
- [Configuration](#configuration)
- [Security & privacy](#security--privacy)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

## Features

- **🎚️ Multi-track** — one lossless FLAC track per speaker, all sample-aligned.
- **📝 AI transcription** with exact speaker names & timestamps. Engines: **Groq**, **OpenAI**, **Gemini**, or a **local** command (faster-whisper / whisper.cpp) for full privacy.
- **📋 AI meeting minutes** — summary, decisions, action items (with owner/due), timestamped topics, and a **per-participant** breakdown.
- **🔊 Recording web page** — audio player with **clickable timestamps**, downloads in **MP3 / FLAC / single mix / Audacity project**, transcript & minutes rendered inline — all behind **Discord login**.
- **🔒 Real access control** — only call participants, people who can see the channel, the initiator, or admins can open a recording. A leaked link opens nothing.
- **🎛️ Live panel** in the voice channel with **Stop** / **Add note** buttons and a `[RECORDING]` nickname indicator (visible consent).
- **🔌 MCP connector** *(optional)* — ask your meetings from **Claude Desktop / Cursor**: time-window queries, cross-meeting **action items with deadlines**, full-text search — each user scoped to exactly what they can already see. See [`mcp/`](mcp/).
- **🤖 Auto-record** — starts by itself when N people join a channel; stops when it empties.
- **❓ Built-in onboarding** — `/help` with interactive topic buttons; DM the bot and it replies with the guide too.
- **🌎 Bilingual** (pt-BR / English), **HTTPS via Cloudflare Tunnel** (no open ports), auto-stop, retention/expiry, crash recovery and graceful shutdown.

## Quick start

You need a machine with **Docker** and a **Discord application** ([1-minute setup](#1-create-the-discord-app)).

```bash
git clone https://github.com/resolvicomai/kassinao.git && cd kassinao
cp .env.example .env      # fill DISCORD_TOKEN, APPLICATION_ID, DISCORD_CLIENT_SECRET, BASE_URL
                          # tip: set GUILD_ID too, so slash commands show up instantly
docker compose up -d --build
```

Then **invite the bot** (step 1) and run **`/record`** in a Discord voice channel. That's it. Full walkthrough below.

> ☁️ **One-click deploy:** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/resolvicomai/kassinao) — blueprint in [`render.yaml`](render.yaml). Set `GROQ_API_KEY` + `TRANSCRIBE_PROVIDER=groq` in the dashboard to turn on transcription & minutes.
> Avoid serverless (Vercel/Netlify) — the voice gateway needs an always-on WebSocket.

### 1. Create the Discord app
1. <https://discord.com/developers/applications> → **New Application**.
2. **General Information** → copy **Application ID** → `APPLICATION_ID`.
3. **Bot** → **Reset Token** → `DISCORD_TOKEN` (no privileged intents needed).
4. **OAuth2** → copy **Client Secret** → `DISCORD_CLIENT_SECRET`; add `BASE_URL/auth/callback` under **Redirects**.
5. Invite it (replace `APP_ID`):
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=68176896`

### 2. Make it reachable
- **Recommended — Cloudflare Tunnel** (HTTPS, no open ports): create a tunnel, then in `.env` set `TUNNEL_TOKEN` **and** `COMPOSE_PROFILES=tunnel`, point the public hostname to `kassinao:8080`, set `BASE_URL=https://your-subdomain.your-domain.com`, and re-run `docker compose up -d`. The bundled tunnel service only starts under the `tunnel` profile (so it never crash-loops when you're not using it).
- **Direct IP (dev/test only — no HTTPS)**: uncomment `ports: ['8080:8080']` in `docker-compose.yml` and set `BASE_URL=http://YOUR_IP:8080`. ⚠️ Discord OAuth only accepts `https` (or `localhost`) redirects, so the login/download page won't work over a plain IP — use the tunnel (or any HTTPS proxy) for real use.

### 3. (Optional) Turn on transcription + minutes
Both light up automatically once a Groq key is present (Groq runs the LLM too):
```env
TRANSCRIBE_PROVIDER=groq
GROQ_API_KEY=gsk_...     # https://console.groq.com  (enable Zero Data Retention!)
MINUTES_ENABLED=auto
```

## How it compares

| | **Kassinão** | Craig | Otter / Fireflies |
|---|:---:|:---:|:---:|
| Multi-track (one file per speaker) | ✅ | ✅ | ❌ |
| Perfect speaker attribution (no AI diarization) | ✅ | ✅ | ❌ (guessed) |
| AI minutes (summary, decisions, tasks) | ✅ | ❌ | ✅ |
| Per-participant breakdown | ✅ | ❌ | ⚠️ |
| Self-hosted / your data | ✅ | ⚠️ | ❌ |
| Access gated by login (not "who has the link") | ✅ | ⚠️ | ✅ |
| Open-source (MIT) | ✅ | ✅ | ❌ |
| Price | Free | Freemium | Paid |

## Transcription backends

| Provider | Cost (per audio hour, **per track**) | pt-BR quality | Privacy | Notes |
|---|---|---|---|---|
| **Groq** (`whisper-large-v3-turbo`) | ~US$0.04 | Excellent | Cloud (enable ZDR) | Best value; free tier often covers small teams |
| **OpenAI** (`whisper-1`) | ~US$0.36 | Excellent | Cloud | Timestamped segments |
| **Gemini** (`gemini-2.x-flash`) | ~cents | Good | Cloud (paid tier only) | Free tier trains on your audio — avoid |
| **Local** (`faster-whisper`) | Free | Good (`small`+) | 🔒 Never leaves your server | Slower without a GPU; see [`scripts/transcribe-local.py`](scripts/transcribe-local.py) |

> 💡 Recording is **multi-track**, so cost scales with speakers: a 1-hour call with 6 people ≈ 6 audio-hours of transcription (silence in each track is skipped, so it's usually less). The AI minutes run once per meeting on Groq's LLM (same key), a few cents each.

## AI connector (MCP)

*Optional, off by default.* Plug your meetings into **Claude Desktop, Cursor** or any MCP client and ask them in natural language:

- *"What's pending this week, and who owns it?"* — aggregates action items with deadlines across meetings.
- *"List the calls in this channel between June 1 and 30."* — time-window queries (timezone-aware).
- *"When did Ana talk about the budget? Give me the link."* — search with deep links to the exact moment.

**Security by design:** the connector runs locally and only carries a **personal token**; the bot applies the *same* access check as the web page, meeting by meeting — each person sees only what they'd see on the site. Read-only, no audio, revocable. Meeting text is wrapped as untrusted data (prompt-injection defense).

Turn it on by setting `MCP_SECRET` (a strong secret, **≠** `COOKIE_SECRET`). Users self-serve at `/conectar-ia`. Client package & full docs: [`mcp/`](mcp/).

## Commands

| English | pt-BR | Does |
|---|---|---|
| `/record [channel]` | `/gravar [canal]` | Start recording (your voice channel, or the given one) |
| `/stop` | `/parar` | End it and generate the link with audio, transcript and minutes |
| `/note <text>` | `/nota <texto>` | Mark a note at the current time (or the 📝 panel button) |
| `/status` | `/status` | Current recording status |
| `/recordings` | `/gravacoes` | Your latest recordings, with links (filtered by access) |
| `/help` | `/ajuda` | Interactive guide (also replies in DMs) |
| `/autorecord on/off/view` | `/autorecord ligar/desligar/ver` | Automatic recording per channel (admin) |

Anyone can record and stop. `/autorecord` requires **Manage Server**. Deleting a recording (from its page) is limited to the initiator or admins.

## Configuration

All options live in [`.env.example`](.env.example). Key ones:

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` · `APPLICATION_ID` · `DISCORD_CLIENT_SECRET` | — | Bot credentials (Developer Portal) |
| `BASE_URL` | `http://localhost:8080` | Public URL for links & OAuth |
| `TUNNEL_TOKEN` | — | Cloudflare Tunnel token (recommended HTTPS path) |
| `GUILD_ID` | — | Registers commands instantly in that server |
| `RETENTION_DAYS` · `MAX_RECORDING_HOURS` | `7` · `6` | Retention & max length |
| `TRANSCRIBE_PROVIDER` | `none` | `none` / `openai` / `groq` / `gemini` / `command` |
| `GROQ_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | — | Key for the chosen provider |
| `MINUTES_ENABLED` | `auto` | AI minutes: `auto` (on when a Groq key exists) / `true` / `false` |
| `TZ` | `America/Sao_Paulo` | Timezone for dates (the web page uses the visitor's) |

## Security & privacy

Recording voice is processing **personal data**. Kassinão is built accordingly:

- Access is always validated by **Discord OAuth login** + participant/channel checks — never by "who has the link".
- The bot shows `[RECORDING]` in its nickname and posts a panel in the channel (visible consent).
- Run transcription **locally**, or enable **Zero Data Retention** on your cloud provider, so audio isn't retained by third parties.
- Secrets live only in `.env` (git-ignored) — **never** committed. See [SECURITY.md](SECURITY.md).

## How it works

Opus packets from each speaker are decoded to PCM and fed to **one ffmpeg per speaker** writing **continuous FLAC** (silence between speech compresses to almost nothing and keeps every track in sync). Downloads (MP3/FLAC/mix/Audacity) are cooked on demand and cached. Transcription and minutes run in a **serial queue** after the call; the web page refreshes itself until they're ready. The page authenticates with **Discord OAuth** (`identify`) and the backend re-checks with Discord who may open each recording.

```mermaid
flowchart LR
    subgraph Discord
      VC[Voice channel]
    end
    subgraph Kassinão
      BOT[Bot<br/>discord.js / voice]
      FF[ffmpeg per speaker<br/>→ FLAC master]
      Q[Serial queue:<br/>transcription → AI minutes]
      WEB[Web page<br/>Express + OAuth]
    end
    VC -- Opus per speaker --> BOT --> FF
    FF -- on stop --> Q
    Q -- Groq / OpenAI / local --> Q
    FF & Q --> WEB
    USER[Participant] -- Discord login --> WEB
    WEB -. Cloudflare Tunnel / HTTPS .-> USER
```

**Stack:** Node.js · TypeScript · discord.js / @discordjs/voice · Express · ffmpeg · Docker · Cloudflare Tunnel.

## Contributing

PRs and issues welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Run `npm run build` before opening a PR.

## License

[MIT](LICENSE) © Mauro Marques. Use, modify and share freely.

---

<div align="center">
<sub>If Kassinão is useful to you, a ⭐ helps others find it.</sub>
</div>
