import './privateUmask';
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createGuildPolicy } from './guildPolicy';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
}

/** Parser puro e estrito: "abc"/NaN/Infinity não podem desligar guardas em silêncio. */
export function parseConfiguredNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  rule: NumberRule,
): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} precisa ser um número finito (recebido: ${JSON.stringify(raw)})`);
  if (rule.integer && !Number.isInteger(value)) throw new Error(`${name} precisa ser inteiro (recebido: ${value})`);
  if (rule.min !== undefined && value < rule.min)
    throw new Error(`${name} precisa ser >= ${rule.min} (recebido: ${value})`);
  if (rule.max !== undefined && value > rule.max)
    throw new Error(`${name} precisa ser <= ${rule.max} (recebido: ${value})`);
  return value;
}

function numberEnv(name: string, fallback: number, rule: NumberRule): number {
  try {
    return parseConfiguredNumber(name, process.env[name], fallback, rule);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

function choiceEnv<const T extends readonly string[]>(name: string, fallback: T[number], choices: T): T[number] {
  const value = (process.env[name] || fallback).trim().toLowerCase();
  if (!choices.includes(value)) {
    console.error(`Configuração inválida: ${name} aceita somente ${choices.join(' | ')} (recebido: ${value})`);
    process.exit(1);
  }
  return value as T[number];
}

function booleanEnv(name: string, fallback = false): boolean {
  return choiceEnv(name, fallback ? 'true' : 'false', ['true', 'false'] as const) === 'true';
}

/** URLs públicas são origens, não prefixos: todas as rotas partem de /. */
export function normalizeOrigin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} precisa ser uma URL absoluta http(s) (recebido: ${JSON.stringify(raw)})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`${name} aceita apenas http:// ou https://`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${name} não pode conter credenciais, query ou hash`);
  if (url.pathname !== '/' && url.pathname !== '')
    throw new Error(`${name} não pode conter caminho; use apenas a origem`);
  return url.origin;
}

/** Mantida como API pública para instalações e testes anteriores. */
export function normalizeBaseUrl(raw: string): string {
  return normalizeOrigin('BASE_URL', raw);
}

export interface ConfiguredOrigins {
  appUrl: string;
  publicUrl: string;
  docsUrl: string;
  mcpUrl: string;
}

type OriginEnvironment = Partial<
  Record<'APP_URL' | 'BASE_URL' | 'PUBLIC_URL' | 'DOCS_URL' | 'MCP_URL', string | undefined>
>;

/** Resolve a topologia sem estado global para que precedência e fallbacks sejam testáveis. */
export function resolveConfiguredOrigins(source: OriginEnvironment, localUrl: string): ConfiguredOrigins {
  const configured = (name: keyof typeof source, fallback: string): string =>
    normalizeOrigin(name, source[name]?.trim() || fallback);
  const rawApp = source.APP_URL?.trim();
  const rawBase = source.BASE_URL?.trim();
  if (rawApp && rawBase) {
    const app = normalizeOrigin('APP_URL', rawApp);
    const base = normalizeOrigin('BASE_URL', rawBase);
    if (app !== base) throw new Error('APP_URL e BASE_URL apontam para origens diferentes');
  }
  const appUrl = rawApp ? configured('APP_URL', localUrl) : configured('BASE_URL', localUrl);
  const publicUrl = configured('PUBLIC_URL', appUrl);
  const docsUrl = configured('DOCS_URL', publicUrl);
  const mcpUrl = configured('MCP_URL', appUrl);
  return { appUrl, publicUrl, docsUrl, mcpUrl };
}

export function normalizeSourceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SOURCE_URL precisa ser uma URL absoluta http(s) (recebido: ${JSON.stringify(raw)})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('SOURCE_URL aceita apenas http:// ou https://');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('SOURCE_URL não pode conter credenciais, query ou hash');
  return url.toString().replace(/\/$/, '');
}

function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Segredos HMAC fracos não podem parecer configuração válida. */
export function validateSecret(name: string, value: string, minBytes = 32): string {
  if (Buffer.byteLength(value, 'utf8') < minBytes) {
    throw new Error(`${name} precisa ter ao menos ${minBytes} bytes (gere com: openssl rand -hex 32)`);
  }
  return value;
}

/** Um segredo entregue a outra integração nunca pode reutilizar credenciais internas. */
export function validateDedicatedSecret(
  name: string,
  value: string,
  protectedSecrets: ReadonlyArray<readonly [name: string, value: string]>,
): string {
  const valid = validateSecret(name, value);
  const conflict = protectedSecrets.find(([, protectedValue]) => protectedValue && protectedValue === valid);
  if (conflict) throw new Error(`${name} não pode ser igual a ${conflict[0]} (isolamento de segurança)`);
  return valid;
}

const recordingsDir = path.resolve(process.env.RECORDINGS_DIR || './recordings');

try {
  fs.mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(recordingsDir, 0o700);
} catch (err) {
  console.error(`Não foi possível proteger o diretório de gravações ${recordingsDir}: ${(err as Error).message}`);
  process.exit(1);
}

/**
 * Segredo usado para assinar os cookies de sessão da página web.
 * Se não vier do ambiente, gera um e persiste em disco para que
 * as sessões sobrevivam a reinícios do bot.
 */
function loadCookieSecret(): string {
  if (process.env.COOKIE_SECRET) {
    try {
      return validateSecret('COOKIE_SECRET', process.env.COOKIE_SECRET);
    } catch (err) {
      console.error(`Configuração inválida: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const secretFile = path.join(recordingsDir, '.cookie-secret');
  try {
    const saved = validateSecret('.cookie-secret', fs.readFileSync(secretFile, 'utf8').trim());
    if (process.platform !== 'win32') fs.chmodSync(secretFile, 0o600);
    return saved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `Não foi possível carregar o segredo de sessão ${secretFile}: ${(err as Error).message}. ` +
          'Corrija o arquivo ou apague-o deliberadamente para gerar outro (isso encerra os logins atuais).',
      );
      process.exit(1);
    }
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(recordingsDir, { recursive: true });
    try {
      fs.writeFileSync(secretFile, secret, { mode: 0o600, flag: 'wx' });
      return secret;
    } catch (writeErr) {
      // Dois processos podem subir juntos no primeiro boot: quem perdeu a
      // corrida lê o arquivo já criado, em vez de sobrescrever o segredo.
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') return loadCookieSecret();
      console.error(`Não foi possível persistir o segredo de sessão ${secretFile}: ${(writeErr as Error).message}`);
      process.exit(1);
    }
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

// Provider da ata, normalizado UMA vez (o default do modelo depende dele).
const minutesProvider = choiceEnv('MINUTES_PROVIDER', process.env.OPENROUTER_API_KEY ? 'openrouter' : 'groq', [
  'openrouter',
  'groq',
] as const);

// Retenção: RETENTION_DAYS=0 desliga a expiração (áudio E texto ficam até alguém
// apagar manualmente). Áudio ilimitado FORÇA texto ilimitado — não faz sentido a
// memória (transcrição/ata) morrer antes do áudio que ela resume.
const retentionDays = numberEnv('RETENTION_DAYS', 7, { min: 0 });
const audioRetentionUnlimited = retentionDays <= 0;
const textRetentionDaysRaw = numberEnv('TEXT_RETENTION_DAYS', 90, { min: 0 });
const textRetentionUnlimited = audioRetentionUnlimited || textRetentionDaysRaw <= 0;

const port = numberEnv('PORT', 8080, { min: 1, max: 65535, integer: true });
const WEB_BIND_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);

/**
 * O listener bare-node fecha em loopback por padrão. Wildcards continuam
 * disponíveis, mas exigem uma escolha explícita do operador (Compose/Render
 * usam isso dentro do isolamento do container).
 */
export function normalizeWebBindAddress(raw: string | undefined): string {
  const value = raw?.trim() || '127.0.0.1';
  if (!WEB_BIND_ADDRESSES.has(value)) {
    throw new Error(
      `WEB_BIND_ADDRESS aceita somente 127.0.0.1, ::1, localhost, 0.0.0.0 ou :: (recebido: ${JSON.stringify(value)})`,
    );
  }
  return value;
}

let webBindAddress: string;
try {
  webBindAddress = normalizeWebBindAddress(process.env.WEB_BIND_ADDRESS);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
const localUrl = `http://localhost:${port}`;
if (process.env.NODE_ENV === 'production' && !process.env.APP_URL?.trim() && !process.env.BASE_URL?.trim()) {
  console.error('Configuração inválida: APP_URL é obrigatória em produção');
  process.exit(1);
}
// APP_URL é a origem canônica do produto privado (OAuth, gravações e downloads).
// BASE_URL continua aceito como alias retrocompatível para instalações existentes.
let configuredOrigins: ConfiguredOrigins;
try {
  configuredOrigins = resolveConfiguredOrigins(process.env, localUrl);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
const { appUrl, publicUrl, docsUrl, mcpUrl } = configuredOrigins;
for (const [name, origin] of Object.entries({
  APP_URL: appUrl,
  PUBLIC_URL: publicUrl,
  DOCS_URL: docsUrl,
  MCP_URL: mcpUrl,
})) {
  if (origin.startsWith('http:') && !isLoopbackOrigin(origin)) {
    console.error(`Configuração inválida: ${name} precisa usar HTTPS fora de localhost`);
    process.exit(1);
  }
}
if (process.env.BASE_URL?.trim()) {
  console.warn('⚠️  BASE_URL é legado. Migre para APP_URL; quando ambos existem, precisam ser idênticos.');
}

let guildPolicy: ReturnType<typeof createGuildPolicy>;
try {
  guildPolicy = createGuildPolicy(process.env);
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}

let sourceUrl: string;
try {
  sourceUrl = normalizeSourceUrl(process.env.SOURCE_URL || 'https://github.com/resolvicomai/kassinao');
} catch (err) {
  console.error(`Configuração inválida: ${(err as Error).message}`);
  process.exit(1);
}
// Vários módulos e integrações self-hosted ainda leem config.baseUrl. Seu
// significado permanece sendo a origem do app, agora também exposta como appUrl.
const baseUrl = appUrl;

// Aviso de upgrade: quem rodava RETENTION_DAYS curto (privacidade/compliance) e NÃO
// setou TEXT_RETENTION_DAYS passa a reter transcrição/ata/notas por 90 dias (o default
// da retenção em camadas do #23). É intencional e documentado, mas não pode ser silencioso.
if (!process.env.TEXT_RETENTION_DAYS && !audioRetentionUnlimited && textRetentionDaysRaw > retentionDays) {
  console.warn(
    `⚠️  TEXT_RETENTION_DAYS não definido: transcrição/ata/notas ficam ${textRetentionDaysRaw} dias ` +
      `(padrão da retenção em camadas), enquanto o áudio expira em ${retentionDays}. ` +
      `Defina TEXT_RETENTION_DAYS no .env para alinhar (ex.: =${retentionDays}) se precisa apagar o texto junto com o áudio.`,
  );
}

// Prompt de contexto do Whisper: o default em pt-BR só vale quando o idioma é pt
// (um deploy em inglês não pode receber viés de português).
const transcribeLanguage = process.env.TRANSCRIBE_LANGUAGE || 'pt';
const defaultTranscribePrompt = transcribeLanguage.startsWith('pt')
  ? 'Transcrição de uma reunião de trabalho informal em português do Brasil.'
  : '';

const transcribeProvider = choiceEnv('TRANSCRIBE_PROVIDER', 'none', [
  'none',
  'assemblyai',
  'openai',
  'groq',
  'gemini',
  'command',
] as const);
const transcribeFallbackProvider = choiceEnv('TRANSCRIBE_FALLBACK_PROVIDER', 'none', ['none', 'groq'] as const);
const transcribeCommandEnvAllowlist = (process.env.TRANSCRIBE_COMMAND_ENV_ALLOWLIST || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
for (const name of transcribeCommandEnvAllowlist) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    console.error(`Configuração inválida: TRANSCRIBE_COMMAND_ENV_ALLOWLIST contém nome inválido: ${name}`);
    process.exit(1);
  }
}

let openrouterSiteUrl = '';
if (process.env.OPENROUTER_SITE_URL?.trim()) {
  try {
    openrouterSiteUrl = normalizeOrigin('OPENROUTER_SITE_URL', process.env.OPENROUTER_SITE_URL);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

function normalizeWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MINUTES_WEBHOOK_URL precisa ser uma URL absoluta');
  }
  if (url.username || url.password || url.hash || url.search)
    throw new Error('MINUTES_WEBHOOK_URL não pode conter credenciais, query ou hash');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackOrigin(url.origin))) {
    throw new Error('MINUTES_WEBHOOK_URL precisa usar HTTPS fora de localhost');
  }
  return url.toString();
}

let minutesWebhookUrl = '';
let minutesWebhookSecret = '';
if (process.env.MINUTES_WEBHOOK_URL?.trim()) {
  try {
    minutesWebhookUrl = normalizeWebhookUrl(process.env.MINUTES_WEBHOOK_URL);
    minutesWebhookSecret = validateSecret('MINUTES_WEBHOOK_SECRET', process.env.MINUTES_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}

export const config = {
  token: required('DISCORD_TOKEN'),
  applicationId: required('APPLICATION_ID'),
  /** Client Secret do OAuth2 (Developer Portal > OAuth2) — usado no login da página de downloads. */
  clientSecret: required('DISCORD_CLIENT_SECRET'),
  /** Se definido, registra os comandos só nesse servidor (atualização instantânea). */
  guildId: process.env.GUILD_ID || undefined,
  /** Política de tenancy usada por Discord, web, MCP e recuperação. */
  guildPolicy,
  port,
  /** Interface do listener HTTP. Loopback por padrão; container opta por wildcard internamente. */
  webBindAddress,
  /** Quantidade exata de proxies confiáveis entre cliente e Express. 0 = nenhum. */
  trustProxyHops: numberEnv('TRUST_PROXY_HOPS', 0, { min: 0, max: 10, integer: true }),
  /** Origem canônica do app privado, OAuth, gravações e downloads. Alias compatível de appUrl. */
  baseUrl,
  /** Origem canônica do app privado. APP_URL cai para BASE_URL e depois localhost. */
  appUrl,
  /** Origem da landing e da demo pública. Cai para appUrl em instalações de origem única. */
  publicUrl,
  /** Origem da documentação. Cai para publicUrl; quando separada, PT vive em / e EN em /en. */
  docsUrl,
  /** Origem da API MCP. Cai para appUrl em instalações de origem única. */
  mcpUrl,
  /** Repositório-fonte exibido por /sobre e pelas superfícies públicas. Não recebe dados. */
  sourceUrl,
  /** true quando o repo do GitHub está público — libera os links "GitHub"/access.ts e a afirmação "auditável" na landing. Padrão false pra nunca servir link 404. */
  repoPublic: process.env.REPO_PUBLIC === 'true',
  recordingsDir,
  /** Dias até o ÁUDIO expirar. 0 = nunca (delete só manual). */
  retentionDays,
  /** true quando RETENTION_DAYS=0 — nada de áudio expira sozinho. */
  audioRetentionUnlimited,
  /**
   * Retenção em camadas: o ÁUDIO expira em RETENTION_DAYS (pesado), mas
   * transcrição + ata + metadados vivem TEXT_RETENTION_DAYS (leve) — a memória
   * das reuniões (busca, MCP, /perguntar) não pode evaporar em 1 semana.
   * Nunca menor que RETENTION_DAYS. 0 (ou RETENTION_DAYS=0) = nunca expira.
   */
  textRetentionDays: Math.max(textRetentionDaysRaw, retentionDays),
  /** true quando texto (transcrição/ata/meta) nunca expira sozinho. */
  textRetentionUnlimited,
  maxRecordingHours: numberEnv('MAX_RECORDING_HOURS', 6, { min: Number.EPSILON }),
  /** Sessões globais consumindo recursos, inclusive durante início/encerramento. */
  recordingMaxConcurrent: numberEnv('RECORDING_MAX_CONCURRENT', 2, { min: 1, integer: true }),
  /** Cota dura móvel por servidor, somando inícios manuais e automáticos; admin não ignora. */
  recordingGuildStartsPer24h: numberEnv('RECORDING_GUILD_STARTS_PER_24H', 12, { min: 1, integer: true }),
  /** Cotas duras globais contra churn e custo externo. */
  recordingStartsGlobalPerHour: numberEnv('RECORDING_STARTS_GLOBAL_PER_HOUR', 8, { min: 1, integer: true }),
  recordingStartsGlobal24h: numberEnv('RECORDING_STARTS_GLOBAL_PER_24H', 32, { min: 1, integer: true }),
  /** Vagas reservadas antes da captura até cook + ASR + ata terminarem. */
  recordingMaxPendingProcessing: numberEnv('RECORDING_MAX_PENDING_PROCESSING', 12, {
    min: 1,
    integer: true,
  }),
  /** Cooldown global por membro comum entre inícios manuais; admin ignora. */
  manualRecordUserCooldownSec: numberEnv('MANUAL_RECORD_USER_COOLDOWN_SEC', 60, { min: 0, integer: true }),
  /** Cooldown do servidor entre inícios manuais de membros comuns; admin ignora. */
  manualRecordGuildCooldownSec: numberEnv('MANUAL_RECORD_GUILD_COOLDOWN_SEC', 15, { min: 0, integer: true }),
  mp3Bitrate: process.env.MP3_BITRATE || '192k',
  cookieSecret: loadCookieSecret(),
  /** Fuso para datas no transcript .md e fallback da página (o navegador tem prioridade na web). */
  timezone: process.env.TZ || 'America/Sao_Paulo',
  /** Idioma padrão onde não há locale do usuário (ex.: DM). 'pt' se DEFAULT_LOCALE começar com "pt", senão 'en'. */
  defaultLocale: ((process.env.DEFAULT_LOCALE || '').toLowerCase().startsWith('pt') ? 'pt' : 'en') as 'pt' | 'en',

  /**
   * Motor de transcrição: 'none' | 'assemblyai' | 'openai' | 'groq' | 'gemini' | 'command'.
   * 'assemblyai' (Universal) só usa fallback Groq quando o operador define
   * TRANSCRIBE_FALLBACK_PROVIDER=groq e fornece GROQ_API_KEY.
   * 'command' roda um executável local (faster-whisper, whisper.cpp, Parakeet...)
   * definido em TRANSCRIBE_COMMAND com os placeholders {input} e {output}.
   */
  transcribeProvider,
  /** Fallback externo precisa ser autorizado explicitamente; uma chave isolada não o liga. */
  transcribeFallbackProvider,
  /** Autoriza enviar nomes de participantes/servidor/canal ao provider ASR. */
  transcribeSendMeetingContext: booleanEnv('TRANSCRIBE_SEND_MEETING_CONTEXT', false),
  transcribeModel: process.env.TRANSCRIBE_MODEL || '',
  transcribeLanguage,
  /** Prompt de contexto pro ASR (vocabulário/estilo) — reduz alucinação e melhora jargão. Whisper e Universal-3.5-Pro usam. */
  transcribePrompt: process.env.TRANSCRIBE_PROMPT ?? defaultTranscribePrompt,
  /**
   * Termos fixos do time (produtos, siglas, nomes) pro keyterms_prompt do
   * Universal-3.5-Pro da AssemblyAI — separados por vírgula. Os nomes dos
   * participantes de cada gravação entram sozinhos; isto é o vocabulário extra.
   */
  transcribeKeyterms: (process.env.TRANSCRIBE_KEYTERMS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  transcribeCommand: process.env.TRANSCRIBE_COMMAND || '',
  /** Variáveis adicionais que o operador decidiu entregar ao comando local. */
  transcribeCommandEnvAllowlist,
  /** Timeout do provider 'command' = max(10min, duração do chunk × este fator). */
  transcribeTimeoutFactor: numberEnv('TRANSCRIBE_TIMEOUT_FACTOR', 5, { min: Number.EPSILON }),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  assemblyaiApiKey: process.env.ASSEMBLYAI_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  /** Referer opcional enviado ao OpenRouter. Vazio por padrão em self-host. */
  openrouterSiteUrl,

  /**
   * Ata com IA (resumo + decisões + tarefas) gerada após a transcrição.
   * 'false' (padrão) desliga. 'true' liga deliberadamente. 'auto' existe apenas
   * para compatibilidade com instalações antigas e liga quando encontra chave.
   * Provider: MINUTES_PROVIDER = openrouter | groq. Padrão: openrouter se houver
   * OPENROUTER_API_KEY (modelos melhores e sem o TPM apertado do free tier da
   * Groq, que estoura em call longa — HTTP 413), senão groq.
   */
  minutesEnabled: choiceEnv('MINUTES_ENABLED', 'false', ['true', 'false', 'auto'] as const),
  minutesProvider,
  minutesModel:
    process.env.MINUTES_MODEL || (minutesProvider === 'groq' ? 'llama-3.3-70b-versatile' : 'google/gemini-2.5-flash'),
  /** Teto de tokens de saída da ata. 8192 cobre reuniões longas. */
  minutesMaxTokens: numberEnv('MINUTES_MAX_TOKENS', 8192, { min: 1, integer: true }),
  /**
   * Webhook opcional (URL definida pelo OPERADOR via env — nunca via Discord,
   * senão viraria vetor de SSRF): recebe um POST JSON com a ata de cada reunião
   * ao ficar pronta. Útil para n8n/Zapier self-hosted → Notion/Jira/etc.
   */
  minutesWebhookUrl,
  /** HMAC dedicado ao webhook; obrigatório quando a URL está configurada. */
  minutesWebhookSecret,

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
  mcpAccessTtlMin: numberEnv('MCP_ACCESS_TTL_MIN', 15, { min: Number.EPSILON }),
  /** Vida do refresh token (rotacionado a cada uso). */
  mcpRefreshTtlDays: numberEnv('MCP_REFRESH_TTL_DAYS', 30, { min: Number.EPSILON }),

  // ---------- guarda de disco e monitoramento ----------
  /** Espaço livre mínimo (MB) para INICIAR uma gravação; abaixo disso, recusa com aviso. */
  minFreeMbStart: numberEnv('MIN_FREE_MB_START', 500, { min: 0 }),
  /** Espaço livre mínimo (MB) DURANTE a gravação; abaixo disso, encerra pra não corromper a faixa. */
  minFreeMbAbort: numberEnv('MIN_FREE_MB_ABORT', 150, { min: 0 }),
  /** % de uso de disco que dispara alerta por DM ao(s) dono(s). */
  diskAlertPct: numberEnv('DISK_ALERT_PCT', 85, { min: Number.EPSILON, max: 100 }),
};

if (config.minFreeMbAbort > config.minFreeMbStart) {
  console.error(
    'MIN_FREE_MB_ABORT não pode ser maior que MIN_FREE_MB_START (senão a gravação aborta logo após iniciar).',
  );
  process.exit(1);
}

// Isolamento de blast-radius: o segredo do MCP não pode coincidir com o dos
// cookies (senão um token de sessão web e um token de MCP se forjariam entre si,
// exatamente a classe de bug do crítico histórico #1).
if (config.mcpEnabled) {
  try {
    validateSecret('MCP_SECRET', config.mcpSecret);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
  if (config.mcpSecret === config.cookieSecret) {
    console.error('MCP_SECRET não pode ser igual ao COOKIE_SECRET (isolamento de segurança).');
    process.exit(1);
  }
  if (config.mcpAccessSecret === config.mcpRefreshSecret || !config.mcpAccessSecret || !config.mcpRefreshSecret) {
    console.error('Erro interno: derivação dos segredos MCP falhou.');
    process.exit(1);
  }
}

if (config.minutesWebhookUrl) {
  try {
    validateDedicatedSecret('MINUTES_WEBHOOK_SECRET', config.minutesWebhookSecret, [
      ['COOKIE_SECRET', config.cookieSecret],
      ['MCP_SECRET', config.mcpSecret],
      ['DISCORD_TOKEN', config.token],
      ['DISCORD_CLIENT_SECRET', config.clientSecret],
      ['ASSEMBLYAI_API_KEY', config.assemblyaiApiKey],
      ['OPENAI_API_KEY', config.openaiApiKey],
      ['GROQ_API_KEY', config.groqApiKey],
      ['GEMINI_API_KEY', config.geminiApiKey],
      ['OPENROUTER_API_KEY', config.openrouterApiKey],
    ]);
  } catch (err) {
    console.error(`Configuração inválida: ${(err as Error).message}`);
    process.exit(1);
  }
}
