import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config';
import { createWebSession, revokeWebSession, webSessionScope, type WebSessionScope } from './webSessions';

export interface WebUser {
  typ: 'session';
  /** Claims obrigatórias em runtime; opcionais no tipo para páginas/test fixtures. */
  iss?: string;
  aud?: string;
  id: string;
  name: string;
  avatar: string | null;
  /** `revoke-only` nunca pode acessar dados nem criar um novo conector. */
  scope: WebSessionScope;
  exp: number;
  /** Sessão ativa persistida; permite revogação real no logout. */
  jti: string;
}

interface StateToken {
  typ: 'state';
  iss?: string;
  aud?: string;
  state: string;
  next: string;
  exp: number;
}

/** Mínimo que o checkAccess precisa: quem é o usuário (sessão web OU token MCP). */
export interface AccessIdentity {
  id: string;
  name: string;
}

export interface OAuthIdentity extends AccessIdentity {
  avatar: string | null;
}

export type LoginAuthorization = 'full' | 'revoke-only' | 'denied' | 'unavailable';

export type FinishLoginResult =
  | { status: 'ok'; next: string; user: WebUser }
  | { status: 'invalid' }
  | { status: 'denied' }
  | { status: 'unavailable' };

/** Token de acesso do MCP (curto, em memória do conector, viaja em cada request). */
export interface McpToken {
  typ: 'mcp';
  iss?: string;
  aud?: string;
  id: string;
  name: string;
  exp: number;
  jti: string;
}

/** Token de refresh do MCP (longo, no cofre do SO do usuário, rotacionado a cada uso). */
export interface McpRefreshToken {
  typ: 'mcp-refresh';
  iss?: string;
  aud?: string;
  id: string;
  name: string;
  exp: number;
  /** id da SESSÃO do conector (estável); o access token carrega o mesmo em `jti`. */
  jti: string;
  /** geração do refresh: incrementa a cada rotação; divergência = reuso detectado. */
  gen: number;
}

const LEGACY_SESSION_COOKIE = 'kassinao_session';
const LEGACY_STATE_COOKIE = 'kassinao_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_NEXT_BYTES = 2_048;
const MAX_LOGIN_NEXT_JSON_BYTES = MAX_LOGIN_NEXT_BYTES + 2;

type DomainConfig = typeof config & { appUrl?: string };

function appOrigin(): string {
  const domainConfig = config as DomainConfig;
  return domainConfig.appUrl ?? domainConfig.baseUrl;
}

export function webCookieSettings(origin: string): {
  sessionName: string;
  stateName: string;
  sessionPath: string;
  statePath: string;
} {
  const secure = origin.startsWith('https://');
  return secure
    ? {
        sessionName: '__Host-kassinao_session',
        stateName: '__Host-kassinao_state',
        sessionPath: '/',
        statePath: '/',
      }
    : {
        sessionName: LEGACY_SESSION_COOKIE,
        stateName: LEGACY_STATE_COOKIE,
        sessionPath: '/app',
        statePath: '/auth',
      };
}

const COOKIE_SETTINGS = webCookieSettings(appOrigin());
const SESSION_COOKIE = COOKIE_SETTINGS.sessionName;
const STATE_COOKIE = COOKIE_SETTINGS.stateName;
const SESSION_PATH = COOKIE_SETTINGS.sessionPath;
const STATE_PATH = COOKIE_SETTINGS.statePath;

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

const MAX_SIGNED_TOKEN_CHARS = 8_192;
const MAX_SIGNED_BODY_BYTES = 6 * 1_024;
const HMAC_SHA256_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Buffer.from(base64url) é permissivo; exige a única codificação canônica. */
function decodeCanonicalBase64Url(value: string, maxBytes: number): Buffer | undefined {
  if (!value || !BASE64URL.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length > maxBytes || decoded.toString('base64url') !== value) return undefined;
  return decoded;
}

function verify<T>(token: string | undefined, secret: string): T | undefined {
  try {
    if (!token || token.length > MAX_SIGNED_TOKEN_CHARS) return undefined;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) return undefined;
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const bodyBytes = decodeCanonicalBase64Url(body, MAX_SIGNED_BODY_BYTES);
    const macBytes = decodeCanonicalBase64Url(mac, HMAC_SHA256_BYTES);
    if (!bodyBytes || !macBytes || macBytes.length !== HMAC_SHA256_BYTES) return undefined;

    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    // timingSafeEqual lança se os buffers tiverem tamanhos diferentes. A
    // checagem em bytes (não em code units Unicode) precisa vir antes.
    if (macBytes.length !== expected.length || !crypto.timingSafeEqual(macBytes, expected)) return undefined;

    return JSON.parse(bodyBytes.toString('utf8')) as T;
  } catch {
    // Token é entrada hostil. Nenhuma codificação, HMAC ou JSON inválido pode
    // escapar para o Express e transformar uma falha de autenticação em 500.
    return undefined;
  }
}

function belongsToThisInstance(token: { iss?: unknown; aud?: unknown }, audience: string): boolean {
  return token.iss === config.instanceId && token.aud === audience;
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

export function serializeWebCookie(
  origin: string,
  name: string,
  value: string,
  maxAgeMs: number,
  cookiePath: string,
): string {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure}`;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number, cookiePath: string): void {
  res.append('Set-Cookie', serializeWebCookie(appOrigin(), name, value, maxAgeMs, cookiePath));
}

// ---------- sessão ----------

export function getWebUser(req: Request): WebUser | undefined {
  const user = verify<WebUser>(readCookie(req, SESSION_COOKIE), config.cookieSecret);
  // Checagens estritas: um cookie de state (mesmo segredo HMAC) NÃO pode passar
  // como sessão. Exige typ correto, exp numérico no futuro e id de verdade.
  if (!user || user.typ !== 'session' || !belongsToThisInstance(user, appOrigin())) return undefined;
  if (!Number.isFinite(user.exp) || user.exp < Date.now()) return undefined; // NaN/Infinity não vira token eterno
  if (typeof user.id !== 'string' || !user.id) return undefined;
  if (typeof user.jti !== 'string' || !user.jti) return undefined;
  if (user.scope !== 'full' && user.scope !== 'revoke-only') return undefined;
  if (webSessionScope(user.jti, user.id) !== user.scope) return undefined;
  return user;
}

export function clearStateCookie(res: Response): void {
  setCookie(res, STATE_COOKIE, '', 0, STATE_PATH);
  // Migração das versões sem prefixo __Host- e dos caminhos antigos.
  setCookie(res, LEGACY_STATE_COOKIE, '', 0, '/auth');
  setCookie(res, LEGACY_STATE_COOKIE, '', 0, '/');
}

/**
 * Sai da conta web: revoga o `jti` no servidor ANTES de expirar o cookie. Assim
 * uma cópia feita antes do logout também para de funcionar imediatamente.
 */
export function logoutWeb(req: Request, res: Response): void {
  const token = verify<WebUser>(readCookie(req, SESSION_COOKIE), config.cookieSecret);
  try {
    if (
      token?.typ === 'session' &&
      belongsToThisInstance(token, appOrigin()) &&
      typeof token.jti === 'string' &&
      token.jti
    )
      revokeWebSession(token.jti);
  } finally {
    setCookie(res, SESSION_COOKIE, '', 0, SESSION_PATH);
    setCookie(res, LEGACY_SESSION_COOKIE, '', 0, '/app');
    setCookie(res, LEGACY_SESSION_COOKIE, '', 0, '/');
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
    !belongsToThisInstance(user, appOrigin()) ||
    typeof user.id !== 'string' ||
    !user.id ||
    typeof user.jti !== 'string' ||
    !user.jti ||
    !Number.isFinite(user.exp) ||
    user.exp <= Date.now() ||
    (user.scope !== 'full' && user.scope !== 'revoke-only') ||
    webSessionScope(user.jti, user.id) !== user.scope
  ) {
    // Cookies antigos (sem jti) e sessões revogadas não são migrados.
    if (raw) {
      setCookie(res, SESSION_COOKIE, '', 0, SESSION_PATH);
      setCookie(res, SESSION_COOKIE, '', 0, '/');
    }
    return;
  }
  setCookie(res, SESSION_COOKIE, raw, user.exp - Date.now(), SESSION_PATH);
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) {
    setCookie(res, LEGACY_SESSION_COOKIE, '', 0, '/app');
    setCookie(res, LEGACY_SESSION_COOKIE, '', 0, '/');
  } else if (SESSION_PATH !== '/') {
    setCookie(res, SESSION_COOKIE, '', 0, '/');
  }
}

/**
 * Defesa CSRF para as mutações do app. SameSite=Lax bloqueia sites externos,
 * mas subdomínios irmãos ainda são "same-site"; o Origin precisa ser o host
 * exato do Kassinão. Clientes não-browser sem Origin continuam aceitos (eles
 * também não carregam automaticamente o cookie HttpOnly do navegador).
 */
export function isAllowedWebMutation(req: Request, expectedBaseUrl = appOrigin()): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) return true;
  const origin = req.get('origin');
  if (origin) {
    if (origin === 'null') return false;
    try {
      // `Origin` exato é a prova principal. Alguns navegadores/webviews podem
      // classificar uma navegação de formulário como cross-site mesmo quando o
      // POST nasce e termina no app; Fetch Metadata não deve sobrepor uma origem
      // canônica já verificada.
      return new URL(origin).origin === new URL(expectedBaseUrl).origin;
    } catch {
      return false;
    }
  }
  // Sem Origin, mantém a defesa de compatibilidade: navegadores cross-site são
  // negados; clientes não-browser continuam aceitos porque não carregam o cookie
  // HttpOnly automaticamente.
  return req.get('sec-fetch-site') !== 'cross-site';
}

// ---------- fluxo OAuth2 do Discord ----------

export function redirectUri(): string {
  return `${appOrigin()}/auth/callback`;
}

export function beginLogin(res: Response, next: string): void {
  const state = crypto.randomBytes(16).toString('hex');
  // OAuth só pode voltar ao namespace privado. Além de redirects externos, isto
  // impede que um login iniciado pelo app seja usado como ponte para demo/docs.
  const safeNext =
    /^\/app(?:[/?#]|$)/.test(next) &&
    !next.includes('\\') &&
    Buffer.byteLength(next, 'utf8') <= MAX_LOGIN_NEXT_BYTES &&
    // Aspas, controles e surrogates podem crescer ao serem escapados no JSON.
    // Limitar também a representação serializada mantém o cookie abaixo de 4 KiB.
    Buffer.byteLength(JSON.stringify(next), 'utf8') <= MAX_LOGIN_NEXT_JSON_BYTES
      ? next
      : '/app';
  const stateToken: StateToken = {
    typ: 'state',
    iss: config.instanceId,
    aud: appOrigin(),
    state,
    next: safeNext,
    exp: Date.now() + 10 * 60 * 1000,
  };
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

export async function finishLogin(
  req: Request,
  res: Response,
  authorize: (identity: OAuthIdentity) => Promise<LoginAuthorization>,
): Promise<FinishLoginResult> {
  const { code, state } = req.query as { code?: string; state?: string };
  const saved = verify<StateToken>(readCookie(req, STATE_COOKIE), config.cookieSecret);
  clearStateCookie(res); // consome o state: não fica vivo 10 min no navegador
  if (
    !code ||
    !state ||
    !saved ||
    saved.typ !== 'state' ||
    !belongsToThisInstance(saved, appOrigin()) ||
    saved.state !== state ||
    !Number.isFinite(saved.exp) ||
    saved.exp <= Date.now()
  )
    return { status: 'invalid' };

  const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.applicationId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResp.ok) return { status: tokenResp.status === 429 || tokenResp.status >= 500 ? 'unavailable' : 'invalid' };
  const token = (await tokenResp.json()) as { access_token: string };
  if (typeof token.access_token !== 'string' || !token.access_token) return { status: 'invalid' };

  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!meResp.ok) return { status: meResp.status === 429 || meResp.status >= 500 ? 'unavailable' : 'invalid' };
  const me = (await meResp.json()) as {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
  };

  if (!me.id || (typeof me.global_name !== 'string' && typeof me.username !== 'string')) {
    return { status: 'invalid' };
  }
  const identity: OAuthIdentity = {
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
  };
  const authorization = await authorize(identity);
  if (authorization === 'denied' || authorization === 'unavailable') return { status: authorization };
  const exp = Date.now() + SESSION_TTL_MS;
  const user: WebUser = {
    typ: 'session',
    iss: config.instanceId,
    aud: appOrigin(),
    ...identity,
    scope: authorization,
    exp,
    jti: createWebSession(me.id, exp, authorization),
  };
  setCookie(res, SESSION_COOKIE, sign(user, config.cookieSecret), SESSION_TTL_MS, SESSION_PATH);
  // Remove cookies antigos sem o prefixo de isolamento entre subdomínios.
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) {
    setCookie(res, LEGACY_SESSION_COOKIE, '', 0, '/app');
    setCookie(res, LEGACY_SESSION_COOKIE, '', 0, '/');
  } else if (SESSION_PATH !== '/') {
    setCookie(res, SESSION_COOKIE, '', 0, '/');
  }
  return { status: 'ok', next: saved.next, user };
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
export function signMcpAccess(payload: Omit<McpToken, 'typ' | 'iss' | 'aud'>): string {
  return sign({ typ: 'mcp', ...payload, iss: config.instanceId, aud: config.mcpUrl }, config.mcpAccessSecret);
}

/** Assina um refresh token do MCP. */
export function signMcpRefresh(payload: Omit<McpRefreshToken, 'typ' | 'iss' | 'aud'>): string {
  return sign({ typ: 'mcp-refresh', ...payload, iss: config.instanceId, aud: config.mcpUrl }, config.mcpRefreshSecret);
}

/**
 * Verifica um refresh token do MCP: `typ` estrito, exp numérico no futuro, id e
 * jti não-vazios. NÃO consulta a denylist — quem chama (o endpoint de refresh) faz.
 */
export function verifyMcpRefresh(token: string | undefined): McpRefreshToken | undefined {
  const t = verify<McpRefreshToken>(token, config.mcpRefreshSecret);
  if (!t || t.typ !== 'mcp-refresh' || !belongsToThisInstance(t, config.mcpUrl)) return undefined;
  if (!Number.isFinite(t.exp) || t.exp < Date.now()) return undefined; // NaN/Infinity não vira token eterno
  if (typeof t.id !== 'string' || !t.id) return undefined;
  if (typeof t.jti !== 'string' || !t.jti) return undefined;
  if (!Number.isInteger(t.gen) || t.gen < 0) return undefined;
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
  if (!t || t.typ !== 'mcp' || !belongsToThisInstance(t, config.mcpUrl)) return undefined;
  if (!Number.isFinite(t.exp) || t.exp < Date.now()) return undefined; // NaN/Infinity não vira token eterno
  if (typeof t.id !== 'string' || !t.id) return undefined;
  if (typeof t.jti !== 'string' || !t.jti) return undefined;
  return t;
}
