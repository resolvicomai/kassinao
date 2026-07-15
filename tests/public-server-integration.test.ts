import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createPublicApp } from '../src/web/publicServer';

const PUBLIC_ORIGIN = 'https://site.public.example.test';
const DOCS_ORIGIN = 'https://docs.public.example.test';
const PRIVATE_APP_ORIGIN = 'https://app.private.example.test';
const PRIVATE_MCP_ORIGIN = 'https://mcp.private.example.test';
const RELEASE_DIGEST = `sha256:${'a'.repeat(64)}`;
const DEPLOYMENT_FINGERPRINT = 'b'.repeat(32);

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const originalConfig = {
  publicUrl: config.publicUrl,
  docsUrl: config.docsUrl,
  appUrl: config.appUrl,
  baseUrl: config.baseUrl,
  mcpUrl: config.mcpUrl,
  trustProxyHops: config.trustProxyHops,
  releaseDigest: config.releaseDigest,
  deploymentFingerprint: config.deploymentFingerprint,
};

describe('superficies publicas por HTTP real', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    Object.assign(config, {
      publicUrl: PUBLIC_ORIGIN,
      docsUrl: DOCS_ORIGIN,
      appUrl: PRIVATE_APP_ORIGIN,
      baseUrl: PRIVATE_APP_ORIGIN,
      mcpUrl: PRIVATE_MCP_ORIGIN,
      trustProxyHops: 1,
      releaseDigest: RELEASE_DIGEST,
      deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
    });

    server = http.createServer(createPublicApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('servidor publico de teste sem porta');
    port = address.port;
  });

  afterAll(async () => {
    Object.assign(config, originalConfig);
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  function request(method: string, pathname: string, host: string): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          host,
          'accept-language': 'pt-BR',
          'x-forwarded-proto': 'https',
          connection: 'close',
        },
      });
      req.once('error', reject);
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      req.end();
    });
  }

  function expectHardened(response: HttpResponse): void {
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['x-powered-by']).toBeUndefined();
  }

  function expectNoPrivateValues(response: HttpResponse): void {
    const visibleResponse = `${response.body}\n${JSON.stringify(response.headers)}`;
    for (const privateValue of [
      PRIVATE_APP_ORIGIN,
      PRIVATE_MCP_ORIGIN,
      new URL(PRIVATE_APP_ORIGIN).hostname,
      new URL(PRIVATE_MCP_ORIGIN).hostname,
      config.token,
      config.clientSecret,
      config.cookieSecret,
      config.instanceId,
      config.recordingsDir,
      config.stateDir,
      config.authStateDir,
      'private-route-sentinel',
      'private-query-sentinel',
    ]) {
      expect(visibleResponse).not.toContain(privateValue);
    }
  }

  it('aceita somente os hosts publicos para landing e documentacao', async () => {
    const site = await request('GET', '/', new URL(PUBLIC_ORIGIN).hostname);
    expect(site.status).toBe(200);
    expect(site.headers['content-type']).toContain('text/html');
    expect(site.body).toContain('Kassinão');
    expect(site.headers['x-robots-tag']).toBeUndefined();
    expectHardened(site);
    expectNoPrivateValues(site);

    const docs = await request('GET', '/', new URL(DOCS_ORIGIN).hostname);
    expect(docs.status).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).toContain('Kassinão');
    expect(docs.headers['x-robots-tag']).toBeUndefined();
    expectHardened(docs);
    expectNoPrivateValues(docs);
  });

  it('rejeita hosts do app, MCP e desconhecidos antes de qualquer superficie', async () => {
    for (const host of [
      new URL(PRIVATE_APP_ORIGIN).hostname,
      new URL(PRIVATE_MCP_ORIGIN).hostname,
      'unknown.example.test',
    ]) {
      const response = await request('GET', '/', host);
      expect(response.status).toBe(421);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(response.body).toBe('Host não reconhecido.');
      expectHardened(response);
      expectNoPrivateValues(response);
    }
  });

  it('exige host e porta exatos e nunca inventa www.www', async () => {
    const priorPublicUrl = config.publicUrl;
    const priorDocsUrl = config.docsUrl;
    try {
      config.publicUrl = 'https://site.public.example.test:8443';
      config.docsUrl = 'https://docs.public.example.test:9443';

      expect((await request('GET', '/', 'site.public.example.test:8443')).status).toBe(200);
      expect((await request('GET', '/', 'docs.public.example.test:9443')).status).toBe(200);
      expect((await request('GET', '/', 'site.public.example.test')).status).toBe(421);
      expect((await request('GET', '/', 'site.public.example.test:9443')).status).toBe(421);

      config.publicUrl = 'https://www.site.public.example.test:8443';
      expect((await request('GET', '/', 'www.site.public.example.test:8443')).status).toBe(200);
      expect((await request('GET', '/', 'www.www.site.public.example.test:8443')).status).toBe(421);
    } finally {
      config.publicUrl = priorPublicUrl;
      config.docsUrl = priorDocsUrl;
    }
  });

  it('fecha namespaces privados em todos os metodos sem refletir rota, query ou segredo', async () => {
    const cases = [
      ['GET', '/app'],
      ['HEAD', '/app/'],
      ['POST', '/app/private-route-sentinel?value=private-query-sentinel'],
      ['PUT', '/auth/callback?code=private-query-sentinel'],
      ['PATCH', '/AUTH/private-route-sentinel'],
      ['DELETE', '/api/mcp/private-route-sentinel'],
      ['OPTIONS', '/API/private-route-sentinel?token=private-query-sentinel'],
    ] as const;

    for (const [method, pathname] of cases) {
      const response = await request(method, pathname, new URL(PUBLIC_ORIGIN).hostname);
      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(response.headers.location).toBeUndefined();
      expectHardened(response);
      expectNoPrivateValues(response);
    }
  });

  it('devolve health nao indexavel com a identidade exata da release e do deploy', async () => {
    for (const host of [new URL(PUBLIC_ORIGIN).hostname, new URL(DOCS_ORIGIN).hostname]) {
      const response = await request('GET', '/health', host);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(JSON.parse(response.body)).toEqual({
        ok: true,
        surface: 'public',
        release: RELEASE_DIGEST,
        deployment: DEPLOYMENT_FINGERPRINT,
      });
      expectHardened(response);
      expectNoPrivateValues(response);
    }
  });

  it('sanitiza qualquer 404 publico sem refletir o caminho solicitado', async () => {
    const response = await request(
      'POST',
      '/private-route-sentinel?value=private-query-sentinel',
      new URL(PUBLIC_ORIGIN).hostname,
    );
    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(response.body).toBe('Not found.');
    expectHardened(response);
    expectNoPrivateValues(response);
  });
});
