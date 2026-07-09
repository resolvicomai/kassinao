#!/usr/bin/env node
/*
 * Kassinão MCP — conector local para clientes MCP.
 * Copyright (C) 2026 Mauro Marques (resolvicomai)
 * Software livre sob a GNU Affero General Public License v3 ou posterior.
 * Veja <https://www.gnu.org/licenses/> para o texto completo.
 */
/**
 * Conector MCP do Kassinão (roda LOCAL, na máquina de quem usa Claude Desktop/Cursor).
 *
 * É um cliente HTTP MAGRO: ele NÃO lê gravações nem decide acesso. Carrega um token
 * pessoal e chama a API /api/* do bot, que aplica o mesmo checkAccess da página web.
 * O usuário só enxerga o que já enxergaria no site. Read-only.
 *
 * Uso:
 *   kassinao-mcp                 inicia o servidor MCP (stdio) — é o que o Claude/Cursor chamam
 *   kassinao-mcp exchange <cod>  troca um código de /mcp new por tokens e os guarda localmente
 *
 * Env:
 *   KASSINAO_URL             ex.: https://kassinao.suaempresa.com  (obrigatório)
 *   KASSINAO_REFRESH_TOKEN   token gerado em /app/conectar-ia (só no 1º uso; depois fica salvo)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mayFallbackToEnvToken,
  normalizeKassinaoUrl,
  selectBootstrapRefreshToken,
  singleFlight,
  StoredCredentials,
  tokenStoreFileName,
} from './tokenAuth.js';

function configuredUrl(): string {
  const raw = process.env.KASSINAO_URL;
  if (!raw) return '';
  try {
    return normalizeKassinaoUrl(raw);
  } catch (err) {
    console.error(`KASSINAO_URL inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

const URL_BASE = configuredUrl();
const ENV_REFRESH_TOKEN = process.env.KASSINAO_REFRESH_TOKEN || '';
const STORE_DIR = path.join(os.homedir(), '.config', 'kassinao-mcp');
const LEGACY_STORE_FILE = path.join(STORE_DIR, 'token.json');
const STORE_FILE = path.join(STORE_DIR, tokenStoreFileName(URL_BASE, ENV_REFRESH_TOKEN));

function readStore(file: string): StoredCredentials {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    return {
      url: typeof value.url === 'string' ? value.url : undefined,
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
    };
  } catch {
    return {};
  }
}

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
  const current = readStore(STORE_FILE);
  if (current.refreshToken || STORE_FILE === LEGACY_STORE_FILE) return current;

  // Upgrade do store único antigo: a primeira conexão que o encontra o reclama
  // de forma exclusiva. As demais usam seus próprios tokens de bootstrap.
  const legacy = readStore(LEGACY_STORE_FILE);
  if (selectBootstrapRefreshToken(legacy, URL_BASE, '') !== '') {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    try {
      // rename reclama a origem de forma atômica: mesmo que dois perfis subam
      // juntos, só um consegue mover o store legado; o outro cai no próprio env.
      fs.renameSync(LEGACY_STORE_FILE, STORE_FILE);
      syncStoreFile(STORE_FILE);
      syncStoreDir();
      return readStore(STORE_FILE);
    } catch {
      const claimed = readStore(STORE_FILE);
      if (claimed.refreshToken) return claimed;
      // Store legado é conveniência de migração; falhar ao movê-lo não autoriza
      // compartilhar o token entre perfis. O env específico continua seguro.
    }
  }
  return {};
}

// Guarda o refresh no disco do usuário com 0600. (Cofre do SO — Keychain/DPAPI/
// libsecret — é uma melhoria futura; por ora, 0600 com aviso no README.)
function saveStore(s: StoredCredentials): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(STORE_DIR, 0o700);
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      // Windows não implementa permissões POSIX; no Unix, arquivo reaproveitado
      // após crash também precisa voltar a 0600.
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(s));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, STORE_FILE);
    syncStoreDir(); // confirma também a troca do nome após queda de energia
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Precedência: token salvo (rotacionado) > env (só bootstrap). Reusar o token do
// env depois de já ter rotacionado dispararia a detecção de reuso no servidor.
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
  if (!r.ok) throw new Error(`Não consegui renovar o token agora (HTTP ${r.status}). Tente de novo em instantes.`);
  return (await r.json()) as TokenResponse;
}

async function refreshTokens(): Promise<void> {
  if (!URL_BASE) throw new Error('Defina KASSINAO_URL (ex.: https://kassinao.suaempresa.com).');
  if (!refreshToken) {
    const base = URL_BASE || '<sua URL do Kassinão>';
    throw new Error(`Sem token. Gere um em ${base}/app/conectar-ia ou rode: kassinao-mcp exchange <codigo>.`);
  }
  let data = await tryRefresh(refreshToken);
  // Token salvo morto (ex.: usuário revogou tudo e gerou um NOVO no env):
  // cai de volta pro env uma vez, em vez de só falhar. Se o env funcionar,
  // ele rotaciona e vira o salvo — o fluxo se conserta sozinho.
  const envTok = ENV_REFRESH_TOKEN;
  if (!data && envTok && envTok !== refreshToken) {
    data = await tryRefresh(envTok);
  }
  if (!data) {
    const base = URL_BASE || '<sua URL do Kassinão>';
    throw new Error(`Não consegui renovar o token (revogado ou expirado). Gere um novo em ${base}/app/conectar-ia.`);
  }
  refreshToken = data.refresh_token; // rotação: guarda o novo imediatamente
  accessToken = data.access_token;
  accessExpMs = Date.parse(data.access_expires_at) || Date.now() + 10 * 60 * 1000;
  saveStore({ url: URL_BASE, refreshToken });
}

// O protocolo de rotação é estrito: refresh paralelo com a mesma geração mata
// a sessão por suspeita de reuso. Todos os tools compartilham um único voo.
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
    // Outra tool pode ter renovado enquanto este request ainda usava o access
    // antigo. Nesse caso reaproveita o novo; só renova se o token atual falhou.
    if (token === accessToken) await refreshOnce();
    token = accessToken;
    r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  }
  if (r.status === 503) {
    throw new Error('O Kassinão está iniciando ou o Discord está indisponível. Tente de novo em instantes.');
  }
  if (!r.ok) throw new Error(`Erro ${r.status} em ${pathname}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- definição das ferramentas ----------

const rangeProps = {
  preset: {
    type: 'string',
    description: 'today | yesterday | this_week | last_week | this_month | last_month | last_7_days | last_30_days',
  },
  from: { type: 'string', description: 'início: "YYYY-MM-DD" (data civil no fuso) ou ISO-8601' },
  to: { type: 'string', description: 'fim (inclusivo): "YYYY-MM-DD" ou ISO-8601' },
  last: { type: 'string', description: 'janela rolante: "7d", "48h", "2w"' },
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
        withinDays: { type: 'number', description: 'janela de "dueSoon" em dias (padrão 7)' },
        assignee: { type: 'string', description: '"me" ou parte do nome do responsável' },
        meetingsWithin: { type: 'string', description: 'quão longe varrer reuniões (ex.: "60d")' },
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
        mode: { type: 'string', enum: ['all', 'any', 'phrase'], description: 'padrão: all' },
        scope: { type: 'string', description: 'CSV de transcript,minutes,notes (padrão: todos)' },
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
        meetingId: { type: 'string', description: 'restringe a uma reunião' },
        contextSegments: { type: 'number', description: 'segmentos de contexto antes/depois (padrão 1)' },
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
    console.error('Defina KASSINAO_URL antes (ex.: KASSINAO_URL=https://kassinao.suaempresa.com).');
    process.exit(1);
  }
  const r = await fetch(`${URL_BASE}/api/mcp/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    console.error(
      `Falha ao trocar o código (HTTP ${r.status}). Ele expira em ~5 min e é de uso único — gere outro com /mcp new.`,
    );
    process.exit(1);
  }
  const data = (await r.json()) as TokenResponse;
  saveStore({ url: URL_BASE, refreshToken: data.refresh_token });
  // O token de refresh já ficou salvo em disco (0600) — a config NÃO precisa dele.
  const cfg = JSON.stringify(
    { mcpServers: { kassinao: { command: 'npx', args: ['-y', 'kassinao-mcp'], env: { KASSINAO_URL: URL_BASE } } } },
    null,
    2,
  );
  console.error(`✅ Conectado! Token salvo em ~/.config/kassinao-mcp/${path.basename(STORE_FILE)} (0600).`);
  console.error('Cole este bloco no claude_desktop_config.json (ou no equivalente do Cursor) e reinicie o app:\n');
  console.log(cfg); // stdout = a config, pronta pra copiar
}

// ---------- servidor MCP ----------

async function runServer(): Promise<void> {
  const packageVersion = (
    JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
  const server = new Server({ name: 'kassinao', version: packageVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool)
      return { content: [{ type: 'text', text: `Ferramenta desconhecida: ${req.params.name}` }], isError: true };
    try {
      const result = await tool.call((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Erro: ${(err as Error).message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('kassinao-mcp: conectado (stdio). Ferramentas disponíveis para o assistente.');
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'exchange') {
    if (!arg) {
      console.error('Uso: kassinao-mcp exchange <codigo>');
      process.exit(1);
    }
    await runExchange(arg);
    return;
  }
  await runServer();
}

main().catch((err) => {
  console.error('kassinao-mcp falhou:', (err as Error).message);
  process.exit(1);
});
