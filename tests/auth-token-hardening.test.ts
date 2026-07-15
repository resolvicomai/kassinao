import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getMcpUser, getWebUser, signMcpAccess, type WebUser } from '../src/web/auth';
import { createWebSession } from '../src/web/webSessions';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function signBody(body: string, secret: string): string {
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function signPayload(payload: object, secret: string): string {
  return signBody(Buffer.from(JSON.stringify(payload)).toString('base64url'), secret);
}

/** Altera só os pad bits finais: decodifica para o mesmo MAC, mas não é canônico. */
function nonCanonicalMac(token: string): string {
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const lastIndex = BASE64URL_ALPHABET.indexOf(mac.at(-1) ?? '');
  if (lastIndex < 0) throw new Error('MAC de teste inválido');
  const alternate = BASE64URL_ALPHABET[lastIndex ^ 1];
  const alternateMac = `${mac.slice(0, -1)}${alternate}`;
  if (!Buffer.from(alternateMac, 'base64url').equals(Buffer.from(mac, 'base64url'))) {
    throw new Error('variante de teste não preservou os bytes do MAC');
  }
  return `${body}.${alternateMac}`;
}

function nonCanonicalBody(payload: object, secret: string): string {
  const body = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}=`;
  return signBody(body, secret);
}

function incorrectMac(token: string): string {
  const dot = token.indexOf('.');
  const mac = token.slice(dot + 1);
  const replacement = mac[0] === 'A' ? 'B' : 'A';
  return `${token.slice(0, dot + 1)}${replacement}${mac.slice(1)}`;
}

function cookieHeader(token: string): string {
  return `kassinao_session=${encodeURIComponent(token)}`;
}

describe('tokens assinados hostis falham fechados', () => {
  let server: http.Server;
  let baseUrl: string;
  let validWebToken: string;
  let validMcpToken: string;
  let webPayload: WebUser;
  let mcpPayload: { id: string; name: string; exp: number; jti: string };

  beforeAll(async () => {
    const exp = Date.now() + 60_000;
    webPayload = {
      typ: 'session',
      iss: config.instanceId,
      aud: config.appUrl,
      id: `unicode-web-${crypto.randomUUID()}`,
      name: 'Pessoa',
      avatar: null,
      scope: 'full',
      exp,
      jti: '',
    };
    webPayload.jti = createWebSession(webPayload.id, exp, webPayload.scope);
    validWebToken = signPayload(webPayload, config.cookieSecret);

    mcpPayload = { id: 'unicode-mcp', name: 'Pessoa', exp, jti: 'sid-unicode' };
    validMcpToken = signMcpAccess(mcpPayload);

    const app = express();
    app.get('/web', (req, res) => {
      res.status(getWebUser(req) ? 200 : 401).end();
    });
    app.get('/mcp', (req, res) => {
      res.status(getMcpUser(req) ? 200 : 401).end();
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('servidor de teste sem porta');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('cookie web rejeita MAC Unicode, base64url não canônico e excesso, mantendo o servidor vivo', async () => {
    const dot = validWebToken.indexOf('.');
    const macLength = validWebToken.length - dot - 1;
    const malformed = [
      `${validWebToken.slice(0, dot + 1)}${'é'.repeat(macLength)}`,
      incorrectMac(validWebToken),
      nonCanonicalMac(validWebToken),
      nonCanonicalBody(webPayload, config.cookieSecret),
      signPayload({ ...webPayload, name: 'x'.repeat(7_000) }, config.cookieSecret),
    ];

    for (const token of malformed) {
      const response = await fetch(`${baseUrl}/web`, { headers: { cookie: cookieHeader(token) } });
      expect(response.status).toBe(401);
    }
    expect((await fetch(`${baseUrl}/web`, { headers: { cookie: cookieHeader(validWebToken) } })).status).toBe(200);
  });

  it('Bearer MCP rejeita MAC Unicode, base64url não canônico e excesso com 401, mantendo o servidor vivo', async () => {
    const dot = validMcpToken.indexOf('.');
    const macLength = validMcpToken.length - dot - 1;
    const malformed = [
      `${validMcpToken.slice(0, dot + 1)}${'é'.repeat(macLength)}`,
      incorrectMac(validMcpToken),
      nonCanonicalMac(validMcpToken),
      nonCanonicalBody({ typ: 'mcp', ...mcpPayload }, config.mcpAccessSecret),
      signMcpAccess({ ...mcpPayload, name: 'x'.repeat(7_000) }),
    ];

    for (const token of malformed) {
      const response = await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
    }
    expect((await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${validMcpToken}` } })).status).toBe(200);
  });
});
