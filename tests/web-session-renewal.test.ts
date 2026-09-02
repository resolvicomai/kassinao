import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { scopeWebSessionToApp, WebUser } from '../src/web/auth';
import { createWebSession, isActiveWebSession } from '../src/web/webSessions';

const DAY = 24 * 60 * 60 * 1000;

function signedCookie(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.cookieSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function requestWith(token: string): Request {
  return {
    method: 'GET',
    headers: { cookie: `kassinao_session=${encodeURIComponent(token)}` },
    get() {
      return undefined;
    },
  } as unknown as Request;
}

function response(): { res: Response; cookies: string[] } {
  const cookies: string[] = [];
  const res = {
    append(name: string, value: string) {
      if (name === 'Set-Cookie') cookies.push(value);
      return res;
    },
  } as unknown as Response;
  return { res, cookies };
}

function sessionCookieToken(cookies: string[]): string {
  const cookie = cookies.find((c) => c.startsWith('kassinao_session=') && !c.includes('Max-Age=0'));
  if (!cookie) throw new Error('cookie de sessão ausente');
  return decodeURIComponent(cookie.slice('kassinao_session='.length).split(';', 1)[0]);
}

function session(daysLeft: number): { token: string; exp: number } {
  const exp = Date.now() + daysLeft * DAY;
  const userId = `user-${daysLeft}`;
  const user: WebUser = {
    typ: 'session',
    iss: config.instanceId,
    aud: config.appUrl,
    id: userId,
    name: 'Pessoa',
    avatar: null,
    scope: 'full',
    exp,
    jti: createWebSession(userId, exp, 'full'),
  };
  return { token: signedCookie(user), exp };
}

describe('renovação da sessão web por uso', () => {
  it('com menos de 15 dias restantes, reassina o cookie por 30 dias e estende o registro', () => {
    const { token, exp } = session(10);
    const { res, cookies } = response();
    scopeWebSessionToApp(requestWith(token), res);
    const renewed = sessionCookieToken(cookies);
    expect(renewed).not.toBe(token);
    const payload = JSON.parse(Buffer.from(renewed.split('.', 1)[0], 'base64url').toString('utf8')) as WebUser;
    expect(payload.exp).toBeGreaterThan(exp + 19 * DAY);
    expect(payload.exp).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(isActiveWebSession(payload.jti, payload.id)).toBe(true);
  });

  it('com mais de 15 dias restantes, devolve o mesmo cookie', () => {
    const { token } = session(20);
    const { res, cookies } = response();
    scopeWebSessionToApp(requestWith(token), res);
    expect(sessionCookieToken(cookies)).toBe(token);
  });
});
