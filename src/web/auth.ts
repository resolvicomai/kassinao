import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config';

export interface WebUser {
  typ: 'session';
  id: string;
  name: string;
  avatar: string | null;
  exp: number;
}

interface StateToken {
  typ: 'state';
  state: string;
  next: string;
}

const SESSION_COOKIE = 'kassinao_session';
const STATE_COOKIE = 'kassinao_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- assinatura de cookies (HMAC-SHA256) ----------

function sign(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify<T>(token: string | undefined): T | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return undefined;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  } catch {
    return undefined;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number): void {
  const secure = config.baseUrl.startsWith('https') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure}`,
  );
}

// ---------- sessão ----------

export function getWebUser(req: Request): WebUser | undefined {
  const user = verify<WebUser>(parseCookies(req)[SESSION_COOKIE]);
  // Checagens estritas: um cookie de state (mesmo segredo HMAC) NÃO pode passar
  // como sessão. Exige typ correto, exp numérico no futuro e id de verdade.
  if (!user || user.typ !== 'session') return undefined;
  if (typeof user.exp !== 'number' || user.exp < Date.now()) return undefined;
  if (typeof user.id !== 'string' || !user.id) return undefined;
  return user;
}

export function clearStateCookie(res: Response): void {
  setCookie(res, STATE_COOKIE, '', 0);
}

// ---------- fluxo OAuth2 do Discord ----------

export function redirectUri(): string {
  return `${config.baseUrl}/auth/callback`;
}

export function beginLogin(res: Response, next: string): void {
  const state = crypto.randomBytes(16).toString('hex');
  // apenas caminhos locais: "//evil.com" e "/\evil.com" são redirects externos no navegador
  const safeNext = /^\/(?![/\\])/.test(next) && !next.includes('\\') ? next : '/';
  const stateToken: StateToken = { typ: 'state', state, next: safeNext };
  setCookie(res, STATE_COOKIE, sign(stateToken), 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: config.applicationId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
}

export async function finishLogin(req: Request, res: Response): Promise<string | undefined> {
  const { code, state } = req.query as { code?: string; state?: string };
  const saved = verify<StateToken>(parseCookies(req)[STATE_COOKIE]);
  clearStateCookie(res); // consome o state: não fica vivo 10 min no navegador
  if (!code || !state || !saved || saved.typ !== 'state' || saved.state !== state) return undefined;

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
  });
  if (!tokenResp.ok) return undefined;
  const token = (await tokenResp.json()) as { access_token: string };

  const meResp = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meResp.ok) return undefined;
  const me = (await meResp.json()) as {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
  };

  if (!me.id) return undefined;
  const user: WebUser = {
    typ: 'session',
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
    exp: Date.now() + SESSION_TTL_MS,
  };
  setCookie(res, SESSION_COOKIE, sign(user), SESSION_TTL_MS);
  return saved.next;
}
