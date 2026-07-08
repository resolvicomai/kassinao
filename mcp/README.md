# kassinao-mcp

The **MCP** connector for [Kassinão](https://github.com/resolvicomai/kassinao): it lets your AI assistant (Claude Desktop, Cursor, etc.) answer questions about the meetings the bot recorded — **"what's pending this week?"**, **"who mentioned the budget on Tuesday?"**, **"list the calls between June 1 and 30"** — in natural language.

> Documentação em português: veja o README principal em [pt-BR](../README.pt-BR.md).

## How it works (and why it's safe)

The connector runs **on your machine** and is a **thin** HTTP client: it does **not** read recordings or make access decisions. It carries a **personal token** and calls the bot's API, which applies **the same access control as the web page** — meeting by meeting. You only see what you'd already see on the site. **There is no "see everything" mode.** It is **read-only** (it never writes, deletes, or serves audio).

> ⚠️ **Transcripts are untrusted input.** Any call participant may have "spoken" malicious text or used a hostile nickname. The server wraps all meeting content in an "untrusted data" block and strips control sequences before delivering it — but always treat meeting content as data, never as instructions.

## Prerequisites

- **The bot admin must have enabled MCP** (`MCP_SECRET` set on the server). Without it, `/app/conectar-ia` and `/mcp` don't exist (404 / missing command).
- **Node.js 20+** on your machine.
- **The connector.** `npx -y kassinao-mcp` downloads and runs it on its own — nothing to install manually (you just need Node). Prefer running from source? `git clone` the repo, `cd mcp && npm install && npm run build`; in the config, replace `"command": "npx"` / `"args": ["-y","kassinao-mcp"]` with `"command": "node"`, `"args": ["/absolute/path/to/repo/mcp/dist/index.js"]`.

## Setup

### Option A — via the web page (easiest)

1. Open `https://YOUR-KASSINAO/app/conectar-ia` and sign in with Discord.
2. Click **Generate connection token** and copy the config block shown (it appears **once**).
3. Paste it into your MCP client's config — `claude_desktop_config.json` (Claude Desktop), `~/.cursor/mcp.json` (Cursor), or wherever your assistant's docs point:

```json
{
  "mcpServers": {
    "kassinao": {
      "command": "npx",
      "args": ["-y", "kassinao-mcp"],
      "env": {
        "KASSINAO_URL": "https://YOUR-KASSINAO",
        "KASSINAO_REFRESH_TOKEN": "PASTE_THE_TOKEN_HERE"
      }
    }
  }
}
```

4. Restart your MCP client (Claude Desktop, Cursor, or any other). Done.

### Option B — no browser (VM/SSH)

On Discord, the owner runs **`/mcp new`** (shown as **`/mcp novo`** on pt-BR clients) — ephemeral reply with a single-use code valid for ~5 min. Then:

```bash
KASSINAO_URL=https://YOUR-KASSINAO npx -y kassinao-mcp exchange <code>
```

This stores the token locally. Configure your MCP client just like Option A (the `KASSINAO_REFRESH_TOKEN` env var becomes optional after the first use).

## Where the token lives

After first use, the refresh token (rotated on every renewal) is stored at `~/.config/kassinao-mcp/token.json` with `0600` permissions. No recordings/transcripts are ever copied to your machine — the connector only talks HTTPS to the server.

## Revoking

- On the `/app/conectar-ia` page: **Revoke all** button.
- On Discord: `/mcp revoke-all`.
- Admin panic button: rotate `MCP_SECRET` on the server (revokes **everyone's** connectors at once).

## Exposed tools

| Tool | What for |
|---|---|
| `list_meetings` | list meetings within a time window (default: last 30 days) |
| `pending_actions` | pending action items/deadlines across meetings (overdue / dueSoon / …) |
| `search_meetings` | full-text search over transcripts, minutes and notes, with a link to the exact minute |
| `who_said` | what someone said about a topic, with context and link |
| `get_meeting` | full dossier of one meeting: metadata, minutes, transcript, notes and timeline |

Requires Node.js ≥ 20. License: AGPL-3.0.
