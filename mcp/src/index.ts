#!/usr/bin/env node
/*
 * Kassinão MCP - local connector for MCP clients.
 * Copyright (C) 2026 Mauro Marques
 * Free software under the GNU Affero General Public License v3 or later.
 * See <https://www.gnu.org/licenses/> for the full license text.
 */
/**
 * Kassinão MCP connector (runs LOCALLY on the MCP client user's machine).
 *
 * This is a THIN HTTP client: it does NOT read recordings or decide access. It loads a
 * personal token and calls the bot's /api/* endpoints, which apply the same checkAccess
 * rules as the web app. Users only see meetings they can already access. Read-only.
 *
 * Usage:
 *   kassinao-mcp                  starts the MCP server over stdio
 *   kassinao-mcp exchange --stdin --url <origin>
 *                                 reads a one-time code without putting it in argv/history
 *
 * Env:
 *   KASSINAO_URL             e.g. https://kassinao.example.com (required)
 *   KASSINAO_REFRESH_TOKEN   legacy bootstrap token (first use only; prefer exchange/profile)
 *   KASSINAO_PROFILE         non-secret local profile id printed by `exchange`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiJson } from './apiResponse.js';
import { parseCredentialTokenResponse, refreshCredential, type CredentialTokenResponse } from './credentialRefresh.js';
import { loadCredentialStore, saveCredentialStore } from './credentialStore.js';
import { DEFAULT_HTTP_TIMEOUT_MS, strictFetch } from './http.js';
import {
  createTokenProfileId,
  mayFallbackToEnvToken,
  normalizeKassinaoUrl,
  selectBootstrapRefreshToken,
  singleFlight,
  StoredCredentials,
  tokenStoreFileName,
} from './tokenAuth.js';
import { createToolErrorResponse, createToolResponse, MCP_UNTRUSTED_DESCRIPTION } from './toolOutput.js';

function configuredUrl(): string {
  const urlFlag = process.argv.indexOf('--url');
  const raw = urlFlag >= 0 ? process.argv[urlFlag + 1] : process.env.KASSINAO_URL;
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
const EXPLICIT_PROFILE = process.env.KASSINAO_PROFILE?.trim() || '';
const PACKAGE_VERSION = (
  JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
const STORE_DIR = path.join(os.homedir(), '.config', 'kassinao-mcp');
const LEGACY_STORE_FILE = path.join(STORE_DIR, 'token.json');
const STORE_FILE = (() => {
  try {
    return path.join(STORE_DIR, tokenStoreFileName(URL_BASE, ENV_REFRESH_TOKEN, EXPLICIT_PROFILE));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
})();

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

// Store the refresh token in a protected local file (0600 on Unix; inherited
// profile ACL on Windows). The README documents the current model.
function saveStore(s: StoredCredentials, file = STORE_FILE): void {
  saveCredentialStore(STORE_DIR, file, s);
}

let accessToken = '';
let accessExpMs = 0;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;

async function tryRefresh(token: string, attemptId: string): Promise<unknown | undefined> {
  return strictFetch(
    `${URL_BASE}/api/mcp/refresh`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: token, attempt_id: attemptId }),
      signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
    },
    async (response) => {
      if (mayFallbackToEnvToken(response.status)) return undefined;
      if (!response.ok) {
        throw new Error(`Could not refresh the token (HTTP ${response.status}). Try again in a moment.`);
      }
      return readApiJson(response, MAX_TOKEN_RESPONSE_BYTES);
    },
  );
}

async function refreshTokens(): Promise<void> {
  if (!URL_BASE) throw new Error('Set KASSINAO_URL (for example, https://kassinao.example.com).');
  const data = await refreshCredential({
    storeFile: STORE_FILE,
    currentUrl: URL_BASE,
    environmentRefreshToken: ENV_REFRESH_TOKEN,
    load: loadStore,
    save: (credentials) => saveStore(credentials),
    request: tryRefresh,
  });
  accessToken = data.access_token;
  accessExpMs = Date.parse(data.access_expires_at) || Date.now() + 10 * 60 * 1000;
}

// Rotation is strict: parallel refreshes with the same generation revoke the session
// as suspected reuse. singleFlight cobre este processo; o lock cobre os demais.
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
  type ApiResult = { unauthorized: true } | { unauthorized: false; data: unknown };
  const request = (token: string): Promise<ApiResult> =>
    strictFetch(url, { headers: { authorization: `Bearer ${token}` } }, async (response) => {
      if (response.status === 401) return { unauthorized: true };
      if (response.status === 503) {
        throw new Error('Kassinão is starting or Discord is unavailable. Try again in a moment.');
      }
      return { unauthorized: false, data: await readApiJson(response) };
    });

  let token = await getAccess();
  let result = await request(token);
  if (result.unauthorized) {
    // Another tool may have refreshed while this request still used the previous
    // access token. Reuse the new token and refresh only if the current one failed.
    if (token === accessToken) await refreshOnce();
    token = accessToken;
    result = await request(token);
  }
  if (result.unauthorized) {
    throw new Error('Kassinão request failed (HTTP 401). Try again in a moment.');
  }
  return result.data;
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
      'List recorded meetings in a time window (defaults to the last 30 days). Only meetings the user can access are returned. Each item carries transcriptStatus ("partial" = some account/stream tracks not transcribed yet), presentSilent (accounts present in the call with no captured speech) and audioDeleted (tiered retention: audio expired, text remains). Discord labels identify the captured account/stream, not a human identity. Follow nextCursor until null; only then continue with nextScanCursor. Use for "what meetings happened between X and Y" / "list this week\'s calls".',
    inputSchema: {
      type: 'object',
      properties: {
        ...rangeProps,
        guildId: { type: 'string' },
        channelId: { type: 'string' },
        participantId: { type: 'string' },
        status: { type: 'string', enum: ['done', 'recording'] },
        limit: { type: 'number' },
        cursor: {
          type: 'string',
          description: 'opaque nextCursor; continue result pagination before using nextScanCursor',
        },
        scanCursor: {
          type: 'string',
          description: 'opaque nextScanCursor; use only when nextCursor is null',
        },
      },
    },
    call: (a) => apiGet('/api/meetings', a),
  },
  {
    name: 'pending_actions',
    description:
      'Aggregate action items (task + owner + deadline) across meetings, bucketed by deadline: overdue, dueSoon, later, noDeadline, unparseable. Items include transcriptStatus — minutes built from a partial transcript may be missing actions. Follow nextCursor until null; only then continue with nextScanCursor. Use for "what is pending this week" / "my open action items". assignee="me" matches the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        withinDays: { type: 'number', description: 'dueSoon window in days (default: 7)' },
        assignee: { type: 'string', description: '"me" or part of the assignee name' },
        meetingsWithin: { type: 'string', description: 'how far back to scan meetings (for example, "60d")' },
        guildId: { type: 'string' },
        limit: { type: 'number' },
        cursor: {
          type: 'string',
          description: 'opaque nextCursor; continue actions before using nextScanCursor',
        },
        scanCursor: {
          type: 'string',
          description: 'opaque nextScanCursor; use only when nextCursor is null',
        },
      },
    },
    call: (a) => apiGet('/api/actions', a),
  },
  {
    name: 'search_meetings',
    description:
      'Full-text search across transcripts, minutes and notes of accessible meetings, accent-insensitive, with deep links to the exact second. Follow nextCursor until null; only then continue with nextScanCursor. Use for "find where we discussed X".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['all', 'any', 'phrase'], description: 'default: all' },
        scope: { type: 'string', description: 'CSV of transcript,minutes,notes (default: all)' },
        ...rangeProps,
        guildId: { type: 'string' },
        limit: { type: 'number' },
        cursor: {
          type: 'string',
          description: 'opaque nextCursor; continue matches before using nextScanCursor',
        },
        scanCursor: {
          type: 'string',
          description: 'opaque nextScanCursor; use only when nextCursor is null',
        },
      },
      required: ['query'],
    },
    call: (a) => apiGet('/api/search', a),
  },
  {
    name: 'who_said',
    description:
      'Find transcript segments matching a query (accent-insensitive), with Discord account/stream label, timestamp, surrounding context and a deep link. Labels are source metadata, not proof of human identity. transcriptStatus="partial" means some tracks are not transcribed yet — absence of a match is not proof nobody said it. Follow nextCursor until null; only then continue with nextScanCursor. Use for "when did the account labeled Ana mention budget".',
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
        cursor: {
          type: 'string',
          description: 'opaque nextCursor; continue transcript matches before using nextScanCursor',
        },
        scanCursor: {
          type: 'string',
          description: 'opaque nextScanCursor; use only when nextCursor is null',
        },
      },
      required: ['query'],
    },
    call: (a) => apiGet('/api/said', a),
  },
  {
    name: 'get_meeting',
    description:
      'Full dossier of one meeting: metadata, minutes (summary/decisions/actions/topics/per-account label), transcript, notes and a merged timeline. Discord labels identify the captured account/stream, not a human identity. Check transcriptStatus: "partial" = transcript incomplete (pending tracks). include is a CSV of meta,minutes,transcript,notes,timeline.',
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
  const data = await strictFetch(
    `${URL_BASE}/api/mcp/exchange`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    },
    async (response) => {
      if (!response.ok) {
        console.error(
          `Could not exchange the code (HTTP ${response.status}). Codes expire in about 5 minutes and can only be used once. Generate another in the private app; instance owners may also use /mcp new.`,
        );
        process.exit(1);
      }
      return parseCredentialTokenResponse(await readApiJson(response, MAX_TOKEN_RESPONSE_BYTES));
    },
  );
  const profile = createTokenProfileId();
  const profileStoreFile = path.join(STORE_DIR, tokenStoreFileName(URL_BASE, '', profile));
  saveStore({ url: URL_BASE, refreshToken: data.refresh_token }, profileStoreFile);
  // The refresh token is already in its protected local store; the config does not need it.
  const cfg = JSON.stringify(
    {
      mcpServers: {
        kassinao: {
          command: 'npx',
          args: ['-y', `kassinao-mcp@${PACKAGE_VERSION}`],
          env: { KASSINAO_URL: URL_BASE, KASSINAO_PROFILE: profile },
        },
      },
    },
    null,
    2,
  );
  const protection = process.platform === 'win32' ? 'inherited current-profile ACL' : '0600';
  console.error(
    `Connected. Token stored at ~/.config/kassinao-mcp/${path.basename(profileStoreFile)} (${protection}).`,
  );
  console.error(
    "Paste this block into your MCP host's local stdio server configuration, then restart the host if required:\n",
  );
  console.log(cfg); // stdout contains only the copy-ready config
}

function isExchangeCode(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}

async function readExchangeCode(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const maxBytes = 256;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const read = fs.readSync(0, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error('Invalid one-time connection code.');
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return Buffer.concat(chunks, total).toString('utf8').trim();
  }

  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = '';
    const finish = (err?: Error): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0003') {
          finish(new Error('Connection cancelled.'));
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        if (/^[A-Za-z0-9_-]$/.test(character) && value.length < 256) value += character;
      }
    };

    input.setEncoding('utf8');
    input.setRawMode(true);
    input.on('data', onData);
    process.stderr.write('Paste the one-time connection code (input hidden), then press Enter: ');
    input.resume();
  });
}

// ---------- MCP server ----------

async function runServer(): Promise<void> {
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const server = new Server({ name: 'kassinao', version: PACKAGE_VERSION }, { capabilities: { tools: {} } });

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
    const code = arg === '--stdin' ? await readExchangeCode() : undefined;
    if (!code || !isExchangeCode(code)) {
      console.error('Usage: kassinao-mcp exchange --stdin --url <origin>');
      process.exit(1);
    }
    await runExchange(code);
    return;
  }
  await runServer();
}

main().catch((err) => {
  console.error('kassinao-mcp failed:', (err as Error).message);
  process.exit(1);
});
