#!/usr/bin/env node
/*
 * Kassinão MCP - local connector for MCP clients.
 * Copyright (C) 2026 Mauro Marques (resolvicomai)
 * Free software under the GNU Affero General Public License v3 or later.
 * See <https://www.gnu.org/licenses/> for the full license text.
 */
/**
 * Kassinão MCP connector (runs LOCALLY on the Claude Desktop/Cursor user's machine).
 *
 * This is a THIN HTTP client: it does NOT read recordings or decide access. It loads a
 * personal token and calls the bot's /api/* endpoints, which apply the same checkAccess
 * rules as the web app. Users only see meetings they can already access. Read-only.
 *
 * Usage:
 *   kassinao-mcp                  starts the MCP server (stdio) for Claude/Cursor
 *   kassinao-mcp exchange <code>  exchanges a /mcp new code and stores the tokens locally
 *
 * Env:
 *   KASSINAO_URL             e.g. https://kassinao.example.com (required)
 *   KASSINAO_REFRESH_TOKEN   token generated in /app/conectar-ia (first use only; then stored)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiJson } from './apiResponse.js';
import { loadCredentialStore } from './credentialStore.js';
import {
  mayFallbackToEnvToken,
  normalizeKassinaoUrl,
  selectBootstrapRefreshToken,
  singleFlight,
  StoredCredentials,
  tokenStoreFileName,
} from './tokenAuth.js';
import { createToolErrorResponse, createToolResponse, MCP_UNTRUSTED_DESCRIPTION } from './toolOutput.js';

function configuredUrl(): string {
  const raw = process.env.KASSINAO_URL;
  if (!raw) return '';
  try {
    return normalizeKassinaoUrl(raw);
  } catch (err) {
    console.error(`Invalid KASSINAO_URL: ${(err as Error).message}`);
    process.exit(1);
  }
}

const URL_BASE = configuredUrl();
const ENV_REFRESH_TOKEN = process.env.KASSINAO_REFRESH_TOKEN || '';
const STORE_DIR = path.join(os.homedir(), '.config', 'kassinao-mcp');
const LEGACY_STORE_FILE = path.join(STORE_DIR, 'token.json');
const STORE_FILE = path.join(STORE_DIR, tokenStoreFileName(URL_BASE, ENV_REFRESH_TOKEN));

function syncStoreFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncStoreDir(): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(STORE_DIR, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function loadStore(): StoredCredentials {
  const current = loadCredentialStore(STORE_DIR, STORE_FILE);
  if (current.refreshToken || STORE_FILE === LEGACY_STORE_FILE) return current;

  // Upgrade the legacy shared store: the first connection that finds it claims
  // it exclusively. Other profiles continue with their own bootstrap tokens.
  const legacy = loadCredentialStore(STORE_DIR, LEGACY_STORE_FILE);
  if (selectBootstrapRefreshToken(legacy, URL_BASE, '') !== '') {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    try {
      // rename claims the source atomically: even if two profiles start together,
      // only one can move the legacy store; the other falls back to its own env.
      fs.renameSync(LEGACY_STORE_FILE, STORE_FILE);
      syncStoreFile(STORE_FILE);
      syncStoreDir();
      return loadCredentialStore(STORE_DIR, STORE_FILE);
    } catch {
      const claimed = loadCredentialStore(STORE_DIR, STORE_FILE);
      if (claimed.refreshToken) return claimed;
      // The legacy store is a migration convenience. Failure to move it does not
      // authorize sharing a token across profiles. The profile-specific env remains safe.
    }
  }
  return {};
}

// Store the refresh token on disk with mode 0600. An OS vault such as Keychain,
// DPAPI, or libsecret is a future improvement; the README documents the current model.
function saveStore(s: StoredCredentials): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(STORE_DIR, 0o700);
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      // Windows does not implement POSIX permissions. On Unix, a file reused after
      // a crash must also be restored to mode 0600.
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(s));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, STORE_FILE);
    syncStoreDir(); // also makes the rename durable across a power failure
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Precedence: stored rotated token > bootstrap-only env token. Reusing the env token
// after rotation would trigger server-side reuse detection.
const stored = loadStore();
let refreshToken = selectBootstrapRefreshToken(stored, URL_BASE, ENV_REFRESH_TOKEN);
let accessToken = '';
let accessExpMs = 0;

interface TokenResponse {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
}

async function tryRefresh(token: string): Promise<TokenResponse | undefined> {
  const r = await fetch(`${URL_BASE}/api/mcp/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: token }),
  });
  if (mayFallbackToEnvToken(r.status)) return undefined;
  if (!r.ok) throw new Error(`Could not refresh the token (HTTP ${r.status}). Try again in a moment.`);
  return (await readApiJson(r)) as TokenResponse;
}

async function refreshTokens(): Promise<void> {
  if (!URL_BASE) throw new Error('Set KASSINAO_URL (for example, https://kassinao.example.com).');
  if (!refreshToken) {
    const base = URL_BASE || '<your Kassinão URL>';
    throw new Error(`No token found. Generate one at ${base}/app/conectar-ia or run: kassinao-mcp exchange <code>.`);
  }
  let data = await tryRefresh(refreshToken);
  // A stored token may be dead after the user revokes everything and supplies a NEW
  // env token. Try the env once instead of failing. If it works, rotation stores it
  // and repairs the flow automatically.
  const envTok = ENV_REFRESH_TOKEN;
  if (!data && envTok && envTok !== refreshToken) {
    data = await tryRefresh(envTok);
  }
  if (!data) {
    const base = URL_BASE || '<your Kassinão URL>';
    throw new Error(
      `Could not refresh the token because it was revoked or expired. Generate a new one at ${base}/app/conectar-ia.`,
    );
  }
  refreshToken = data.refresh_token; // rotation: persist the replacement immediately
  accessToken = data.access_token;
  accessExpMs = Date.parse(data.access_expires_at) || Date.now() + 10 * 60 * 1000;
  saveStore({ url: URL_BASE, refreshToken });
}

// Rotation is strict: parallel refreshes with the same generation revoke the session
// as suspected reuse. All tools share one in-flight refresh.
const refreshOnce = singleFlight(refreshTokens);

async function getAccess(): Promise<string> {
  if (accessToken && Date.now() < accessExpMs - 30_000) return accessToken;
  await refreshOnce();
  return accessToken;
}

async function apiGet(pathname: string, params: Record<string, unknown>): Promise<unknown> {
  const url = new URL(`${URL_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let token = await getAccess();
  let r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 401) {
    // Another tool may have refreshed while this request still used the previous
    // access token. Reuse the new token and refresh only if the current one failed.
    if (token === accessToken) await refreshOnce();
    token = accessToken;
    r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  }
  if (r.status === 503) {
    throw new Error('Kassinão is starting or Discord is unavailable. Try again in a moment.');
  }
  return readApiJson(r);
}

// ---------- tool definitions ----------

const rangeProps = {
  preset: {
    type: 'string',
    description: 'today | yesterday | this_week | last_week | this_month | last_month | last_7_days | last_30_days',
  },
  from: { type: 'string', description: 'start: "YYYY-MM-DD" (calendar date in the configured timezone) or ISO-8601' },
  to: { type: 'string', description: 'end, inclusive: "YYYY-MM-DD" or ISO-8601' },
  last: { type: 'string', description: 'rolling window: "7d", "48h", or "2w"' },
};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_meetings',
    description:
      'List recorded meetings in a time window (defaults to the last 30 days). Only meetings the user can access are returned. Each item carries transcriptStatus ("partial" = some speakers not transcribed yet), presentSilent (people in the call who never spoke) and audioDeleted (tiered retention: audio expired, text remains). Use for "what meetings happened between X and Y" / "list this week\'s calls".',
    inputSchema: {
      type: 'object',
      properties: {
        ...rangeProps,
        guildId: { type: 'string' },
        channelId: { type: 'string' },
        participantId: { type: 'string' },
        status: { type: 'string', enum: ['done', 'recording'] },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    call: (a) => apiGet('/api/meetings', a),
  },
  {
    name: 'pending_actions',
    description:
      'Aggregate action items (task + owner + deadline) across meetings, bucketed by deadline: overdue, dueSoon, later, noDeadline, unparseable. Items include transcriptStatus — minutes built from a partial transcript may be missing actions. Use for "what is pending this week" / "my open action items". assignee="me" matches the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        withinDays: { type: 'number', description: 'dueSoon window in days (default: 7)' },
        assignee: { type: 'string', description: '"me" or part of the assignee name' },
        meetingsWithin: { type: 'string', description: 'how far back to scan meetings (for example, "60d")' },
        guildId: { type: 'string' },
      },
    },
    call: (a) => apiGet('/api/actions', a),
  },
  {
    name: 'search_meetings',
    description:
      'Full-text search across transcripts, minutes and notes of accessible meetings, accent-insensitive, with deep links to the exact second. Use for "find where we discussed X".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['all', 'any', 'phrase'], description: 'default: all' },
        scope: { type: 'string', description: 'CSV of transcript,minutes,notes (default: all)' },
        ...rangeProps,
        guildId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    call: (a) => apiGet('/api/search', a),
  },
  {
    name: 'who_said',
    description:
      'Find transcript segments matching a query (accent-insensitive), with speaker, timestamp, surrounding context and a deep link. transcriptStatus="partial" means some speakers are not transcribed yet — absence of a match is not proof nobody said it. Use for "when did Ana talk about budget".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        speaker: { type: 'string' },
        meetingId: { type: 'string', description: 'restrict the search to one meeting' },
        contextSegments: { type: 'number', description: 'context segments before and after each match (default: 1)' },
        ...rangeProps,
        guildId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    call: (a) => apiGet('/api/said', a),
  },
  {
    name: 'get_meeting',
    description:
      'Full dossier of one meeting: metadata, minutes (summary/decisions/actions/topics/per-participant), transcript, notes and a merged timeline. Check transcriptStatus: "partial" = transcript incomplete (pending speakers). include is a CSV of meta,minutes,transcript,notes,timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' },
        include: { type: 'string', description: 'CSV: meta,minutes,transcript,notes,timeline' },
        transcriptLimit: { type: 'number' },
      },
      required: ['meetingId'],
    },
    call: (a) => {
      const id = encodeURIComponent(String(a.meetingId));
      const { meetingId: _omit, ...rest } = a;
      void _omit;
      return apiGet(`/api/meetings/${id}`, rest);
    },
  },
];

// ---------- CLI: exchange ----------

async function runExchange(code: string): Promise<void> {
  if (!URL_BASE) {
    console.error('Set KASSINAO_URL first (for example, KASSINAO_URL=https://kassinao.example.com).');
    process.exit(1);
  }
  const r = await fetch(`${URL_BASE}/api/mcp/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    console.error(
      `Could not exchange the code (HTTP ${r.status}). Codes expire in about 5 minutes and can only be used once. Generate another with /mcp new.`,
    );
    process.exit(1);
  }
  const data = (await readApiJson(r)) as TokenResponse;
  saveStore({ url: URL_BASE, refreshToken: data.refresh_token });
  // The refresh token is already stored on disk with mode 0600; the config does not need it.
  const cfg = JSON.stringify(
    { mcpServers: { kassinao: { command: 'npx', args: ['-y', 'kassinao-mcp'], env: { KASSINAO_URL: URL_BASE } } } },
    null,
    2,
  );
  console.error(`Connected. Token stored at ~/.config/kassinao-mcp/${path.basename(STORE_FILE)} (0600).`);
  console.error('Paste this block into claude_desktop_config.json (or the Cursor equivalent), then restart the app:\n');
  console.log(cfg); // stdout contains only the copy-ready config
}

// ---------- MCP server ----------

async function runServer(): Promise<void> {
  const packageVersion = (
    JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  const server = new Server({ name: 'kassinao', version: packageVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: `${t.description}\n\n${MCP_UNTRUSTED_DESCRIPTION}`,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return createToolErrorResponse(`Unknown tool: ${req.params.name}`);
    try {
      const result = await tool.call((req.params.arguments ?? {}) as Record<string, unknown>);
      return createToolResponse(result);
    } catch (err) {
      return createToolErrorResponse((err as Error).message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('kassinao-mcp: connected over stdio. Tools are ready for the assistant.');
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'exchange') {
    if (!arg) {
      console.error('Usage: kassinao-mcp exchange <code>');
      process.exit(1);
    }
    await runExchange(arg);
    return;
  }
  await runServer();
}

main().catch((err) => {
  console.error('kassinao-mcp failed:', (err as Error).message);
  process.exit(1);
});
