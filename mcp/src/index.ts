#!/usr/bin/env node
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
 *   KASSINAO_REFRESH_TOKEN   token gerado em /conectar-ia (só no 1º uso; depois fica salvo)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_BASE = (process.env.KASSINAO_URL || '').replace(/\/$/, '');
const STORE_DIR = path.join(os.homedir(), '.config', 'kassinao-mcp');
const STORE_FILE = path.join(STORE_DIR, 'token.json');

interface Stored {
  url?: string;
  refreshToken?: string;
}

function loadStore(): Stored {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Stored;
  } catch {
    return {};
  }
}

// Guarda o refresh no disco do usuário com 0600. (Cofre do SO — Keychain/DPAPI/
// libsecret — é uma melhoria futura; por ora, 0600 com aviso no README.)
function saveStore(s: Stored): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

// Precedência: token salvo (rotacionado) > env (só bootstrap). Reusar o token do
// env depois de já ter rotacionado dispararia a detecção de reuso no servidor.
let refreshToken = loadStore().refreshToken || process.env.KASSINAO_REFRESH_TOKEN || '';
let accessToken = '';
let accessExpMs = 0;

interface TokenResponse {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
}

async function refreshTokens(): Promise<void> {
  if (!URL_BASE) throw new Error('Defina KASSINAO_URL (ex.: https://kassinao.suaempresa.com).');
  if (!refreshToken) {
    throw new Error('Sem token. Gere um em <URL>/conectar-ia ou rode: kassinao-mcp exchange <codigo>.');
  }
  const r = await fetch(`${URL_BASE}/api/mcp/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!r.ok) {
    throw new Error(`Não consegui renovar o token (HTTP ${r.status}). Gere um novo em <URL>/conectar-ia.`);
  }
  const data = (await r.json()) as TokenResponse;
  refreshToken = data.refresh_token; // rotação: guarda o novo imediatamente
  accessToken = data.access_token;
  accessExpMs = Date.parse(data.access_expires_at) || Date.now() + 10 * 60 * 1000;
  saveStore({ url: URL_BASE, refreshToken });
}

async function getAccess(): Promise<string> {
  if (accessToken && Date.now() < accessExpMs - 30_000) return accessToken;
  await refreshTokens();
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
    await refreshTokens(); // access venceu/rotacionou — renova uma vez e tenta de novo
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
      'List recorded meetings in a time window (defaults to the last 30 days). Only meetings the user can access are returned. Use for "what meetings happened between X and Y" / "list this week\'s calls".',
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
      'Aggregate action items (task + owner + deadline) across meetings, bucketed by deadline: overdue, dueSoon, later, noDeadline, unparseable. Use for "what is pending this week" / "my open action items". assignee="me" matches the token owner.',
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
      'Full-text search across transcripts, minutes and notes of accessible meetings, with deep links to the exact moment. Use for "find where we discussed X".',
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
      'Find transcript segments matching a query, with speaker, timestamp, surrounding context and a deep link. Use for "when did Ana talk about budget".',
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
      'Full dossier of one meeting: metadata, minutes (summary/decisions/actions/topics/per-participant), transcript, notes and a merged timeline. include is a CSV of meta,minutes,transcript,notes,timeline.',
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
    { mcpServers: { kassinao: { command: 'npx', args: ['-y', '@kassinao/mcp'], env: { KASSINAO_URL: URL_BASE } } } },
    null,
    2,
  );
  console.error('✅ Conectado! Token salvo em ~/.config/kassinao-mcp/token.json (0600).');
  console.error('Cole este bloco no claude_desktop_config.json (ou no equivalente do Cursor) e reinicie o app:\n');
  console.log(cfg); // stdout = a config, pronta pra copiar
}

// ---------- servidor MCP ----------

async function runServer(): Promise<void> {
  const server = new Server({ name: 'kassinao', version: '1.0.0' }, { capabilities: { tools: {} } });

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
