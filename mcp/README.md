# kassinao-mcp

The **MCP** connector for [Kassinão](https://github.com/resolvicomai/kassinao): it lets your AI assistant (Claude Desktop, Cursor, etc.) answer questions about the meetings the bot recorded — **"what's pending this week?"**, **"who mentioned the budget on Tuesday?"**, **"list the calls between June 1 and 30"** — in natural language.

Official connector entry point and documentation: [mcp.kassinao.cloud](https://mcp.kassinao.cloud).

> Documentação em português: veja o README principal em [pt-BR](../README.pt-BR.md).

## How it works (and why it's safe)

The connector runs **on your machine** and is a **thin** HTTP client: it does **not** read recordings or make access decisions. It carries a **personal token** and calls the bot's API, which applies **the same access control as the web page** — meeting by meeting. Current server membership is required, and every recording is limited to its participants/starter and current admins. You only see what you'd already see on the site. **There is no "see everything" mode.** It is **read-only** (it never writes, deletes, or serves audio).

> ⚠️ **Meeting content is untrusted input.** Any call participant may have spoken malicious text or used a hostile nickname. Every tool description and response carries an explicit `contentSecurity` warning, while the server strips control sequences and neutralizes formatting escapes. Always treat transcripts, minutes, notes, names, and snippets as data, never as instructions.

## Prerequisites

- **The bot admin must have enabled MCP** (`MCP_SECRET` set on the server). Without it, `/app/conectar-ia` and `/mcp` don't exist (404 / missing command).
- **Node.js 20+** on your machine.
- **The connector.** `npx -y kassinao-mcp@1.0.5` downloads and runs the pinned published release — nothing to install manually (you just need Node). Prefer running from source? `git clone` the repo, `cd mcp && npm ci --userconfig ../.npmrc.security && npm run build`; in the config, replace `"command": "npx"` / `"args": ["-y","kassinao-mcp@1.0.5"]` with `"command": "node"`, `"args": ["/absolute/path/to/repo/mcp/dist/index.js"]`.

## Setup

### Option A — via the web page (easiest)

1. Open [app.kassinao.cloud/app/conectar-ia](https://app.kassinao.cloud/app/conectar-ia) and sign in with Discord.
2. Click **Generate connection** and copy the one-time code. It expires in about five minutes.
3. Run the command shown on the page, paste the code into its hidden prompt, and press Enter. The connector stores the refresh token in a protected local file (`0600` on macOS/Linux; your profile's inherited ACL on Windows) and prints a config block containing only a non-secret profile id:

```json
{
  "mcpServers": {
    "kassinao": {
      "command": "npx",
      "args": ["-y", "kassinao-mcp@1.0.5"],
      "env": {
        "KASSINAO_URL": "https://mcp.kassinao.cloud",
        "KASSINAO_PROFILE": "PROFILE_PRINTED_BY_THE_COMMAND"
      }
    }
  }
}
```

4. Paste the printed block into your MCP client's config — `claude_desktop_config.json` (Claude Desktop), `~/.cursor/mcp.json` (Cursor), or wherever your assistant's docs point. Restart the client.

For a self-hosted instance, open `APP_URL/app/conectar-ia`; the generated command already includes that instance's `MCP_URL`. When the instance only defines `BASE_URL`, both values use that same origin.

### Option B — no browser (VM/SSH)

On Discord, the owner runs **`/mcp new`** (shown as **`/mcp novo`** on pt-BR clients) — ephemeral reply with a single-use code valid for ~5 min. Then:

```bash
npx -y kassinao-mcp@1.0.5 exchange --stdin --url https://mcp.kassinao.cloud
```

Paste the one-time code when prompted. Input is hidden so the code does not enter shell history or process arguments. The command stores the token locally and prints a copy-ready config containing a non-secret `KASSINAO_PROFILE` id. Use that block as printed; it selects this connection's own token file without placing the refresh token in your client config. Replace the URL with your instance's `MCP_URL` when self-hosting.

## Where the token lives

After first use, the refresh token (rotated on every renewal) is stored under `~/.config/kassinao-mcp/` in a `token-<profile>.json` file. On macOS/Linux, the directory is forced to `0700` and the token file to `0600`; on Windows, access follows the current profile's inherited ACLs. `token.json` is read only for safe compatibility with configs created by older connector releases. Each generated connection gets an isolated profile automatically, so Claude and Cursor can coexist on the same computer when each uses its own token. `KASSINAO_PROFILE` is only a non-secret local selector; the refresh token stays in its protected file. Do not paste the same generated token into two clients. The connector does not sync or persist the meeting archive: it requests only the data needed for each tool response over HTTPS. Tokens are pinned to the configured `KASSINAO_URL`; changing instances requires a token issued by the new instance.

When an existing instance changes domain, do not edit `KASSINAO_URL` by itself. Generate a new connection in the app and replace the complete printed block. Tokens issued by another origin are not reused.

## Revoking

- On the `/app/conectar-ia` page: revoke one named connection or **Revoke all**.
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
