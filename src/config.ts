import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

const recordingsDir = path.resolve(process.env.RECORDINGS_DIR || './recordings');

/**
 * Segredo usado para assinar os cookies de sessão da página web.
 * Se não vier do ambiente, gera um e persiste em disco para que
 * as sessões sobrevivam a reinícios do bot.
 */
function loadCookieSecret(): string {
  if (process.env.COOKIE_SECRET) return process.env.COOKIE_SECRET;
  const secretFile = path.join(recordingsDir, '.cookie-secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    return secret;
  }
}

/**
 * Deriva um segredo dedicado por finalidade a partir do MCP_SECRET (HKDF-SHA256).
 * Rótulos distintos ⇒ segredos distintos: um token de refresh apresentado como
 * access (ou vice-versa) QUEBRA o HMAC, não depende só da checagem de `typ`.
 */
function deriveSecret(secret: string, label: string): string {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(label), 32)).toString(
    'hex',
  );
}

// MCP é OPT-IN: só liga quando MCP_SECRET vem do ambiente. NUNCA auto-gerado em
// disco (como o cookie) — rotacionar o segredo é o botão de pânico que invalida
// todos os tokens de uma vez, então ele tem que ser deliberado e estável.
const mcpSecret = process.env.MCP_SECRET || '';

export const config = {
  token: required('DISCORD_TOKEN'),
  applicationId: required('APPLICATION_ID'),
  /** Client Secret do OAuth2 (Developer Portal > OAuth2) — usado no login da página de downloads. */
  clientSecret: required('DISCORD_CLIENT_SECRET'),
  /** Se definido, registra os comandos só nesse servidor (atualização instantânea). */
  guildId: process.env.GUILD_ID || undefined,
  port: Number(process.env.PORT || 8080),
  /** URL pública usada nos links (ex.: https://kassinao.suaempresa.com). */
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, ''),
  recordingsDir,
  retentionDays: Number(process.env.RETENTION_DAYS || 7),
  maxRecordingHours: Number(process.env.MAX_RECORDING_HOURS || 6),
  mp3Bitrate: process.env.MP3_BITRATE || '192k',
  cookieSecret: loadCookieSecret(),
  /** Fuso para datas no transcript .md e fallback da página (o navegador tem prioridade na web). */
  timezone: process.env.TZ || 'America/Sao_Paulo',
  /** Idioma padrão onde não há locale do usuário (ex.: DM). 'pt' se DEFAULT_LOCALE começar com "pt", senão 'en'. */
  defaultLocale: ((process.env.DEFAULT_LOCALE || '').toLowerCase().startsWith('pt') ? 'pt' : 'en') as 'pt' | 'en',

  /**
   * Motor de transcrição: 'none' | 'openai' | 'groq' | 'gemini' | 'command'.
   * 'command' roda um executável local (faster-whisper, whisper.cpp, Parakeet...)
   * definido em TRANSCRIBE_COMMAND com os placeholders {input} e {output}.
   */
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER || 'none').toLowerCase(),
  transcribeModel: process.env.TRANSCRIBE_MODEL || '',
  transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || 'pt',
  transcribeCommand: process.env.TRANSCRIBE_COMMAND || '',
  /** Timeout do provider 'command' = max(10min, duração do chunk × este fator). */
  transcribeTimeoutFactor: Number(process.env.TRANSCRIBE_TIMEOUT_FACTOR || 5),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  /**
   * Ata com IA (resumo + decisões + tarefas) gerada após a transcrição.
   * 'auto' (padrão): liga sozinha quando há GROQ_API_KEY. 'false' desliga. 'true' força.
   * Usa a API da Groq (mesma chave da transcrição) com um modelo de LLM.
   */
  minutesEnabled: (process.env.MINUTES_ENABLED || 'auto').toLowerCase(),
  minutesModel: process.env.MINUTES_MODEL || 'llama-3.3-70b-versatile',
  /** Teto de tokens de saída da ata. 8192 cobre reuniões longas; o modelo suporta até 32768. */
  minutesMaxTokens: Number(process.env.MINUTES_MAX_TOKENS || 8192),

  // ---------- MCP (conector para assistentes de IA) — opt-in via MCP_SECRET ----------
  /** Liga a API /api/* e o comando /mcp quando há MCP_SECRET. */
  mcpEnabled: !!mcpSecret,
  mcpSecret,
  /** Segredos dedicados por finalidade (HKDF do MCP_SECRET) — isolados do cookieSecret. */
  mcpAccessSecret: mcpSecret ? deriveSecret(mcpSecret, 'kassinao-mcp-access-v1') : '',
  mcpRefreshSecret: mcpSecret ? deriveSecret(mcpSecret, 'kassinao-mcp-refresh-v1') : '',
  /** IDs Discord autorizados a emitir/revogar tokens pelo comando /mcp (allowlist explícita). */
  ownerIds: (process.env.OWNER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Vida do access token (curto: se vazar, morre sozinho). */
  mcpAccessTtlMin: Number(process.env.MCP_ACCESS_TTL_MIN || 15),
  /** Vida do refresh token (rotacionado a cada uso). */
  mcpRefreshTtlDays: Number(process.env.MCP_REFRESH_TTL_DAYS || 30),

  // ---------- guarda de disco e monitoramento ----------
  /** Espaço livre mínimo (MB) para INICIAR uma gravação; abaixo disso, recusa com aviso. */
  minFreeMbStart: Number(process.env.MIN_FREE_MB_START || 500),
  /** Espaço livre mínimo (MB) DURANTE a gravação; abaixo disso, encerra pra não corromper a faixa. */
  minFreeMbAbort: Number(process.env.MIN_FREE_MB_ABORT || 150),
  /** % de uso de disco que dispara alerta por DM ao(s) dono(s). */
  diskAlertPct: Number(process.env.DISK_ALERT_PCT || 85),
};

// Isolamento de blast-radius: o segredo do MCP não pode coincidir com o dos
// cookies (senão um token de sessão web e um token de MCP se forjariam entre si,
// exatamente a classe de bug do crítico histórico #1).
if (config.mcpEnabled) {
  if (config.mcpSecret === config.cookieSecret) {
    console.error('MCP_SECRET não pode ser igual ao COOKIE_SECRET (isolamento de segurança).');
    process.exit(1);
  }
  if (config.mcpAccessSecret === config.mcpRefreshSecret || !config.mcpAccessSecret || !config.mcpRefreshSecret) {
    console.error('Erro interno: derivação dos segredos MCP falhou.');
    process.exit(1);
  }
}
