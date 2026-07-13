import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config';
import { createWebSession, isActiveWebSession, revokeWebSession } from './webSessions';

export interface WebUser {
  typ: 'session';
  id: string;
  name: string;
  avatar: string | null;
  exp: number;
  /** Sessão ativa persistida; permite revogação real no logout. */
  jti: string;
}

interface StateToken {
  typ: 'state';
  state: string;
  next: string;
  exp: number;
}

/** Mínimo que o checkAccess precisa: quem é o usuário (sessão web OU token MCP). */
export interface AccessIdentity {
  id: string;
  name: string;
}

/** Token de acesso do MCP (curto, em memória do conector, viaja em cada request). */
export interface McpToken {
  typ: 'mcp';
  id: string;
  name: string;
  exp: number;
  jti: string;
}

/** Token de refresh do MCP (longo, no cofre do SO do usuário, rotacionado a cada uso). */
export interface McpRefreshToken {
  typ: 'mcp-refresh';
  id: string;
  name: string;
  exp: number;
  /** id da SESSÃO do conector (estável); o access token carrega o mesmo em `jti`. */
  jti: string;
  /** geração do refresh: incrementa a cada rotação; divergência = reuso detectado. */
  gen: number;
}

const SESSION_COOKIE = 'kassinao_session';
const STATE_COOKIE = 'kassinao_state';
const SESSION_PATH = '/app';
const STATE_PATH = '/auth';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type DomainConfig = typeof config & { appUrl?: string; legacyUrl?: string };

function appOrigin(): string {
  const domainConfig = config as DomainConfig;
  return domainConfig.appUrl ?? domainConfig.baseUrl;
}

// ---------- assinatura de tokens (HMAC-SHA256) ----------

// O SEGREDO é sempre parâmetro EXPLÍCITO — nunca capturado do escopo. Isso impede
// que um token assinado com um segredo (ex.: sessão web) passe na verificação de
// outro (ex.: access do MCP): domínios com segredos diferentes ficam isolados por
// construção, não só por uma checagem de `typ` (lição do crítico histórico #1).

function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify<T>(token: string | undefined, secret: string): T | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return undefined;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  } catch {
    return undefined;
  }
}

// Lê UM cookie por nome, sem montar objeto com chave controlada pelo cliente
// (mata property/prototype injection: nada de out[nomeDoCookie] = ...).
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined; // %-encoding malformado: trata como cookie ausente
    }
  }
  return undefined;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number, cookiePath: string): void {
  const secure = appOrigin().startsWith('https') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure}`,
  );
}

// ---------- sessão ----------

export function getWebUser(req: Request): WebUser | undefined {
  const user = verify<WebUser>(readCookie(req, SESSION_COOKIE), config.cookieSecret);
  // Checagens estritas: um cookie de state (mesmo segredo HMAC) NÃO pode passar
  // como sessão. Exige typ correto, exp numérico no futuro e id de verdade.
  if (!user || user.typ !== 'session') return undefined;
  if (!Number.isFinite(user.exp) || user.exp < Date.now()) return undefined; // NaN/Infinity não vira token eterno
  if (typeof user.id !== 'string' || !user.id) return undefined;
  if (typeof user.jti !== 'string' || !user.jti) return undefined;
  if (!isActiveWebSession(user.jti, user.id)) return undefined;
  return user;
}

export function clearStateCookie(res: Response): void {
  setCookie(res, STATE_COOKIE, '', 0, STATE_PATH);
  // Migração da versão antiga, que usava Path=/ para todos os cookies.
  setCookie(res, STATE_COOKIE, '', 0, '/');
}

/**
 * Sai da conta web: revoga o `jti` no servidor ANTES de expirar o cookie. Assim
 * uma cópia feita antes do logout também para de funcionar imediatamente.
 */
export function logoutWeb(req: Request, res: Response): void {
  const token = verify<WebUser>(readCookie(req, SESSION_COOKIE), config.cookieSecret);
  try {
    if (token?.typ === 'session' && typeof token.jti === 'string' && token.jti) revokeWebSession(token.jti);
  } finally {
    setCookie(res, SESSION_COOKIE, '', 0, SESSION_PATH);
    // Também derruba sessões emitidas antes do escopo /app entrar em vigor.
    setCookie(res, SESSION_COOKIE, '', 0, '/');
  }
}

/**
 * Mantém uma sessão ativa no namespace privado e remove o cookie legado Path=/.
 * Cookies anteriores ao registro de `jti` são encerrados deliberadamente; tokens
 * novos preservam a expiração original, sem renovar os 7 dias ao navegar.
 */
export function scopeWebSessionToApp(req: Request, res: Response): void {
  const raw = readCookie(req, SESSION_COOKIE);
  const user = verify<WebUser>(raw, config.cookieSecret);
  if (
    !raw ||
    !user ||
    user.typ !== 'session' ||
    typeof user.id !== 'string' ||
    !user.id ||
    typeof user.jti !== 'string' ||
    !user.jti ||
    !Number.isFinite(user.exp) ||
    user.exp <= Date.now() ||
    !isActiveWebSession(user.jti, user.id)
  ) {
    // Cookies antigos (sem jti) e sessões revogadas não são migrados.
    if (raw) {
      setCookie(res, SESSION_COOKIE, '', 0, SESSION_PATH);
      setCookie(res, SESSION_COOKIE, '', 0, '/');
    }
    return;
  }
  setCookie(res, SESSION_COOKIE, raw, user.exp - Date.now(), SESSION_PATH);
  setCookie(res, SESSION_COOKIE, '', 0, '/');
}

/**
 * Defesa CSRF para as mutações do app. SameSite=Lax bloqueia sites externos,
 * mas subdomínios irmãos ainda são "same-site"; o Origin precisa ser o host
 * exato do Kassinão. Clientes não-browser sem Origin continuam aceitos (eles
 * também não carregam automaticamente o cookie HttpOnly do navegador).
 */
export function isAllowedWebMutation(req: Request, expectedBaseUrl = appOrigin()): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) return true;
  if (req.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.get('origin');
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).origin === new URL(expectedBaseUrl).origin;
  } catch {
    return false;
  }
}

// ---------- fluxo OAuth2 do Discord ----------

function configuredCallbackOrigin(req?: Request): string {
  const domainConfig = config as DomainConfig;
  const canonicalApp = appOrigin();
  if (!req || !domainConfig.legacyUrl) return canonicalApp;
  const rawHost = req.get('host');
  if (!rawHost || /[\s/\\]/.test(rawHost)) return canonicalApp;
  try {
    const requestHost = new URL(`http://${rawHost}`).host.toLowerCase();
    return new URL(domainConfig.legacyUrl).host.toLowerCase() === requestHost ? domainConfig.legacyUrl : canonicalApp;
  } catch {
    return canonicalApp;
  }
}

export function redirectUri(req?: Request): string {
  return `${configuredCallbackOrigin(req)}/auth/callback`;
}

export function beginLogin(res: Response, next: string): void {
  const state = crypto.randomBytes(16).toString('hex');
  // apenas caminhos locais: "//evil.com" e "/\evil.com" são redirects externos no navegador
  const safeNext = /^\/(?![/\\])/.test(next) && !next.includes('\\') ? next : '/';
  const stateToken: StateToken = { typ: 'state', state, next: safeNext, exp: Date.now() + 10 * 60 * 1000 };
  setCookie(res, STATE_COOKIE, sign(stateToken, config.cookieSecret), 10 * 60 * 1000, STATE_PATH);
  const params = new URLSearchParams({
    client_id: config.applicationId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify',
    state,
    // sem prompt:'none' — num app novo ninguém autorizou ainda, e prompt:'none'
    // devolveria consent_required (sem code) e quebraria o 1º login. O Discord
    // mostra o consentimento na 1ª vez e pula automaticamente nas seguintes.
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}

export async function finishLogin(req: Request, res: Response): Promise<string | undefined> {
  const { code, state } = req.query as { code?: string; state?: string };
  const saved = verify<StateToken>(readCookie(req, STATE_COOKIE), config.cookieSecret);
  clearStateCookie(res); // consome o state: não fica vivo 10 min no navegador
  if (
    !code ||
    !state ||
    !saved ||
    saved.typ !== 'state' ||
    saved.state !== state ||
    !Number.isFinite(saved.exp) ||
    saved.exp <= Date.now()
  )
    return undefined;

  const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.applicationId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(req),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResp.ok) return undefined;
  const token = (await tokenResp.json()) as { access_token: string };

  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!meResp.ok) return undefined;
  const me = (await meResp.json()) as {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
  };

  if (!me.id) return undefined;
  const exp = Date.now() + SESSION_TTL_MS;
  const user: WebUser = {
    typ: 'session',
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
    exp,
    jti: createWebSession(me.id, exp),
  };
  setCookie(res, SESSION_COOKIE, sign(user, config.cookieSecret), SESSION_TTL_MS, SESSION_PATH);
  // Remove um eventual cookie legado Path=/ com o mesmo nome.
  setCookie(res, SESSION_COOKIE, '', 0, '/');
  return saved.next;
}

// ---------- tokens do MCP (HMAC com segredos DEDICADOS, isolados do cookie) ----------

function bearerToken(req: Request): string | undefined {
  // Parse manual (sem regex) — o `^Bearer\s+(.+)$` era ambíguo (\s e . ambos casam
  // espaço) e abria backtracking polinomial (ReDoS) num header controlado pelo cliente.
  const h = req.headers.authorization;
  if (!h || h.length > 8192) return undefined;
  const sp = h.indexOf(' ');
  if (sp < 0 || h.slice(0, sp).toLowerCase() !== 'bearer') return undefined;
  const token = h.slice(sp + 1).trim();
  return token || undefined;
}

/** Assina um access token do MCP (jti/exp definidos por quem emite). */
export function signMcpAccess(payload: Omit<McpToken, 'typ'>): string {
  return sign({ typ: 'mcp', ...payload }, config.mcpAccessSecret);
}

/** Assina um refresh token do MCP. */
export function signMcpRefresh(payload: Omit<McpRefreshToken, 'typ'>): string {
  return sign({ typ: 'mcp-refresh', ...payload }, config.mcpRefreshSecret);
}

/**
 * Verifica um refresh token do MCP: `typ` estrito, exp numérico no futuro, id e
 * jti não-vazios. NÃO consulta a denylist — quem chama (o endpoint de refresh) faz.
 */
export function verifyMcpRefresh(token: string | undefined): McpRefreshToken | undefined {
  const t = verify<McpRefreshToken>(token, config.mcpRefreshSecret);
  if (!t || t.typ !== 'mcp-refresh') return undefined;
  if (!Number.isFinite(t.exp) || t.exp < Date.now()) return undefined; // NaN/Infinity não vira token eterno
  if (typeof t.id !== 'string' || !t.id) return undefined;
  if (typeof t.jti !== 'string' || !t.jti) return undefined;
  return t;
}

/**
 * Extrai e valida o usuário do MCP a partir do header `Authorization: Bearer`.
 * Espelho ESTRITO do getWebUser (typ==='mcp', exp numérico futuro, id não-vazio,
 * jti presente). NÃO consulta a denylist: isso é responsabilidade do middleware
 * único da API /api/* (revogação num só lugar). Retorna undefined em qualquer
 * falha — a API converte tudo num 401 uniforme (sem oráculo de causa).
 */
export function getMcpUser(req: Request): McpToken | undefined {
  if (!config.mcpEnabled) return undefined;
  const t = verify<McpToken>(bearerToken(req), config.mcpAccessSecret);
  if (!t || t.typ !== 'mcp') return undefined;
  if (!Number.isFinite(t.exp) || t.exp < Date.now()) return undefined; // NaN/Infinity não vira token eterno
  if (typeof t.id !== 'string' || !t.id) return undefined;
  if (typeof t.jti !== 'string' || !t.jti) return undefined;
  return t;
}
