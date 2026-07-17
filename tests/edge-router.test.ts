import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import {
  createEdgeRouterServer,
  createEdgeTopology,
  decideEdgeRequest,
  resolveExclusiveInterfaceAddress,
  type EdgeTopology,
} from '../src/web/edgeRouter';
import { createPublicApp } from '../src/web/publicServer';
import { createWebApp } from '../src/web/server';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listener sem porta TCP');
      resolve(address.port);
    });
  });
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(
  port: number,
  options: {
    host?: string;
    method?: string;
    path?: string;
    headers?: http.OutgoingHttpHeaders;
    chunks?: Array<{ value: string | Buffer; delayMs?: number }>;
  } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: {
        ...(options.host === undefined ? {} : { host: options.host }),
        connection: 'close',
        ...options.headers,
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
          body: Buffer.concat(chunks),
        }),
      );
    });
    void (async () => {
      for (const chunk of options.chunks ?? []) {
        if (chunk.delayMs) await new Promise((done) => setTimeout(done, chunk.delayMs));
        req.write(chunk.value);
      }
      req.end();
    })().catch(reject);
  });
}

function rawRequest(port: number, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.end(source));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const DISTINCT_ORIGINS = {
  app: 'https://app.example.test',
  public: 'https://example.test',
  docs: 'https://docs.example.test',
  mcp: 'https://mcp.example.test',
};

describe('decisão pura do edge router', () => {
  const topology = createEdgeTopology(DISTINCT_ORIGINS);

  it.each([
    ['app.example.test', '/', 'core'],
    ['app.example.test', '/demo', 'core'],
    ['mcp.example.test', '/api/meetings', 'core'],
    ['mcp.example.test', '/', 'core'],
    ['example.test', '/', 'public'],
    ['example.test', '/demo/audio', 'public'],
    ['docs.example.test', '/', 'public'],
    ['www.example.test', '/en', 'public'],
  ])('encaminha host=%s path=%s para %s', (host, requestTarget, target) => {
    expect(decideEdgeRequest(topology, { method: 'GET', host, requestTarget })).toMatchObject({
      kind: 'proxy',
      target,
    });
  });

  it('fecha namespaces privados no host público sem tocar upstream', () => {
    for (const requestTarget of ['/app', '/AUTH/callback', '/Api/meetings', '/rec/id']) {
      expect(decideEdgeRequest(topology, { method: 'GET', host: 'example.test', requestTarget })).toEqual({
        kind: 'reject',
        status: 404,
        secure: true,
      });
    }
  });

  it('redireciona privacy público para a origem configurada do app', () => {
    expect(
      decideEdgeRequest(topology, { method: 'GET', host: 'docs.example.test', requestTarget: '/privacy/' }),
    ).toEqual({
      kind: 'redirect',
      status: 308,
      location: 'https://app.example.test/privacy',
      secure: true,
    });
    expect(
      decideEdgeRequest(topology, {
        method: 'POST',
        host: 'example.test',
        requestTarget: '/en/privacy',
      }),
    ).toEqual({ kind: 'reject', status: 404, secure: true });
  });

  it('separa caminhos privados e públicos quando todas as origens são iguais', () => {
    const single = createEdgeTopology({
      app: 'http://localhost:8080',
      public: 'http://localhost:8080',
      docs: 'http://localhost:8080',
      mcp: 'http://localhost:8080',
    });
    for (const requestTarget of ['/app', '/AUTH/callback', '/Api/meetings', '/health', '/privacy']) {
      expect(decideEdgeRequest(single, { method: 'GET', host: 'localhost:8080', requestTarget })).toMatchObject({
        kind: 'proxy',
        target: 'core',
      });
    }
    for (const requestTarget of ['/', '/docs', '/en/docs', '/demo', '/assets/brand.png']) {
      expect(decideEdgeRequest(single, { method: 'GET', host: 'localhost:8080', requestTarget })).toMatchObject({
        kind: 'proxy',
        target: 'public',
      });
    }
  });

  it('recusa o mesmo Host com protocolos canônicos conflitantes', () => {
    expect(() =>
      createEdgeTopology({
        app: 'https://localhost',
        public: 'http://localhost',
        docs: 'http://localhost',
        mcp: 'https://localhost',
      }),
    ).toThrow('mesma origem canônica');
  });

  it('recusa alias www público que colide com app, docs ou MCP', () => {
    expect(() =>
      createEdgeTopology({
        app: 'https://www.example.test',
        public: 'https://example.test',
        docs: 'https://docs.example.test',
        mcp: 'https://mcp.example.test',
      }),
    ).toThrow('alias www');
  });

  it('preserva Host e porta HTTPS não padrão configurados', () => {
    const customPort = createEdgeTopology({
      app: 'https://app.example.test:8443',
      public: 'https://example.test',
      docs: 'https://docs.example.test',
      mcp: 'https://app.example.test:8443',
    });
    expect(
      decideEdgeRequest(customPort, {
        method: 'GET',
        host: 'app.example.test:8443',
        requestTarget: '/app',
      }),
    ).toEqual({
      kind: 'proxy',
      target: 'core',
      host: 'app.example.test:8443',
      protocol: 'https:',
      port: '8443',
    });
  });

  it.each([
    [{ method: 'GET', host: 'unknown.example.test', requestTarget: '/' }, 421],
    [{ method: 'GET', host: 'example.test/path', requestTarget: '/' }, 421],
    [{ method: 'GET', host: 'example.test', requestTarget: 'https://other.example/' }, 400],
    [{ method: 'GET', host: 'example.test', requestTarget: '//other.example/' }, 400],
    [{ method: 'GET', host: 'example.test', requestTarget: '/\\other.example/' }, 400],
    [{ method: 'GET', host: 'example.test', requestTarget: '/%5cother.example/' }, 400],
    [{ method: 'GET', host: 'example.test', requestTarget: '/%0aheader' }, 400],
    [{ method: 'GET', host: 'example.test', requestTarget: '/%' }, 400],
    [{ method: 'TRACE', host: 'example.test', requestTarget: '/' }, 405],
    [{ method: 'GET', host: 'example.test', requestTarget: '/', expect: '100-continue' }, 417],
    [{ method: 'GET', host: 'example.test', requestTarget: '/', upgrade: 'websocket' }, 426],
  ])('rejeita request inválido %#', (description, status) => {
    expect(decideEdgeRequest(topology, description)).toMatchObject({ kind: 'reject', status });
  });

  it('classifica prefixos privados codificados antes de escolher o processo', () => {
    const single = createEdgeTopology({
      app: 'https://single.example.test',
      public: 'https://single.example.test',
      docs: 'https://single.example.test',
      mcp: 'https://single.example.test',
    });
    expect(
      decideEdgeRequest(single, {
        method: 'GET',
        host: 'single.example.test',
        requestTarget: '/%61pi/meetings',
      }),
    ).toMatchObject({ kind: 'proxy', target: 'core' });
    expect(
      decideEdgeRequest(single, {
        method: 'GET',
        host: 'single.example.test',
        requestTarget: '/app%2Frec/id',
      }),
    ).toMatchObject({ kind: 'proxy', target: 'core' });
  });

  it('reserva health interno exclusivamente para autorrequisição', () => {
    expect(
      decideEdgeRequest(topology, {
        method: 'GET',
        requestTarget: '/_kassinao/router-health',
        selfRequest: true,
      }),
    ).toEqual({ kind: 'local-health' });
    expect(
      decideEdgeRequest(topology, {
        method: 'GET',
        host: 'example.test',
        requestTarget: '/_kassinao/router-health',
      }),
    ).toEqual({ kind: 'reject', status: 404, secure: true });
  });
});

describe('bind exclusivo por interface', () => {
  it('resolve somente um IPv4 não-loopback da interface declarada', () => {
    expect(
      resolveExclusiveInterfaceAddress('ingress0', {
        ingress0: [
          {
            address: '172.30.0.2',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '172.30.0.2/24',
          },
        ],
      }),
    ).toBe('172.30.0.2');
  });

  it.each([
    [{}, 'ausente'],
    [
      {
        ingress0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      },
      'loopback',
    ],
    [
      {
        ingress0: [
          {
            address: '172.30.0.2',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '172.30.0.2/24',
          },
          {
            address: '172.30.0.3',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:01',
            internal: false,
            cidr: '172.30.0.3/24',
          },
        ],
      },
      'ambígua',
    ],
  ])('falha fechada quando a interface é %s', (interfaces) => {
    expect(() => resolveExclusiveInterfaceAddress('ingress0', interfaces)).toThrow('exatamente um endereço');
  });
});

describe('adapter HTTP streaming do edge router', () => {
  let coreServer: Server;
  let publicServer: Server;
  let routerServer: Server;
  let routerPort: number;
  let coreRequests: number;
  let publicRequests: number;
  let coreHandler: (req: IncomingMessage, res: ServerResponse) => void;
  let publicHandler: (req: IncomingMessage, res: ServerResponse) => void;
  let topology: EdgeTopology;

  beforeEach(async () => {
    coreRequests = 0;
    publicRequests = 0;
    coreHandler = (_req, res) => res.end('core');
    publicHandler = (_req, res) => res.end('public');
    coreServer = http.createServer((req, res) => {
      coreRequests++;
      coreHandler(req, res);
    });
    publicServer = http.createServer((req, res) => {
      publicRequests++;
      publicHandler(req, res);
    });
    const corePort = await listen(coreServer);
    const publicPort = await listen(publicServer);
    topology = createEdgeTopology(DISTINCT_ORIGINS);
    routerServer = createEdgeRouterServer({
      topology,
      core: { hostname: '127.0.0.1', port: corePort },
      public: { hostname: '127.0.0.1', port: publicPort },
      releaseDigest: `sha256:${'a'.repeat(64)}`,
      deploymentFingerprint: 'b'.repeat(32),
      upstreamTimeoutMs: 100,
    });
    routerPort = await listen(routerServer);
  });

  afterEach(async () => {
    await close(routerServer);
    await close(coreServer);
    await close(publicServer);
  });

  it('encaminha headers end-to-end e reconstrói somente a cadeia confiável', async () => {
    coreHandler = (req, res) => {
      res.setHeader('Set-Cookie', ['a=1; HttpOnly', 'b=2; Secure']);
      res.setHeader('Connection', 'keep-alive, x-upstream-remove');
      res.setHeader('X-Upstream-Remove', 'secret-hop');
      res.end(JSON.stringify(req.headers));
    };

    const response = await request(routerPort, {
      host: 'app.example.test',
      path: '/api/meetings',
      headers: {
        authorization: 'Bearer test-token',
        cookie: 'session=value',
        'cf-connecting-ip': '203.0.113.9',
        forwarded: 'for=192.0.2.1;proto=http',
        'x-forwarded-for': '192.0.2.2, 198.51.100.7',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'http',
        'x-remove-me': 'hop-secret',
        connection: 'close, x-remove-me',
      },
    });
    const received = JSON.parse(response.body.toString('utf8')) as Record<string, string>;

    expect(response.status).toBe(200);
    expect(received).toMatchObject({
      host: 'app.example.test',
      authorization: 'Bearer test-token',
      cookie: 'session=value',
      'x-forwarded-for': '198.51.100.7',
      'x-forwarded-host': 'app.example.test',
      'x-forwarded-port': '443',
      'x-forwarded-proto': 'https',
    });
    expect(received.forwarded).toBeUndefined();
    expect(received['cf-connecting-ip']).toBeUndefined();
    expect(received['x-remove-me']).toBeUndefined();
    expect(response.headers['set-cookie']).toEqual(['a=1; HttpOnly', 'b=2; Secure']);
    expect(response.headers['x-upstream-remove']).toBeUndefined();
  });

  it('não abre upstream para host desconhecido ou namespace privado no host público', async () => {
    expect((await request(routerPort, { host: 'unknown.example.test' })).status).toBe(421);
    expect((await request(routerPort, { host: 'example.test', path: '/API/meetings' })).status).toBe(404);
    expect(coreRequests).toBe(0);
    expect(publicRequests).toBe(0);
  });

  it('não aceita CF-Connecting-IP isolado como prova de um proxy confiável', async () => {
    coreHandler = (req, res) => res.end(String(req.headers['x-forwarded-for']));
    const response = await request(routerPort, {
      host: 'app.example.test',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('127.0.0.1');
  });

  it('faz redirect de privacy sem encaminhar query ou corpo a upstream', async () => {
    const response = await request(routerPort, {
      host: 'docs.example.test',
      path: '/en/privacy?source=ignored',
    });
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('https://app.example.test/en/privacy');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(coreRequests).toBe(0);
    expect(publicRequests).toBe(0);
  });

  it('mantém app, MCP, landing e docs funcionais em uma única origem local', async () => {
    await close(routerServer);
    await close(coreServer);
    await close(publicServer);

    const prior = {
      appUrl: config.appUrl,
      baseUrl: config.baseUrl,
      mcpUrl: config.mcpUrl,
      publicUrl: config.publicUrl,
      docsUrl: config.docsUrl,
      publicSurfacesEnabled: config.publicSurfacesEnabled,
      trustProxyHops: config.trustProxyHops,
    };
    try {
      Object.assign(config, {
        appUrl: 'http://localhost:8080',
        baseUrl: 'http://localhost:8080',
        mcpUrl: 'http://localhost:8080',
        publicUrl: 'http://localhost:8080',
        docsUrl: 'http://localhost:8080',
        publicSurfacesEnabled: false,
        trustProxyHops: 1,
      });

      coreServer = http.createServer(createWebApp());
      publicServer = http.createServer(createPublicApp());
      const corePort = await listen(coreServer);
      const publicPort = await listen(publicServer);
      topology = createEdgeTopology({
        app: config.appUrl,
        mcp: config.mcpUrl,
        public: config.publicUrl,
        docs: config.docsUrl,
      });
      routerServer = createEdgeRouterServer({
        topology,
        core: { hostname: '127.0.0.1', port: corePort },
        public: { hostname: '127.0.0.1', port: publicPort },
      });
      routerPort = await listen(routerServer);

      const language = { 'accept-language': 'pt-BR' };
      const app = await request(routerPort, { host: 'localhost:8080', path: '/app', headers: language });
      expect(app.status).toBe(200);
      expect(app.body.toString('utf8')).toContain('Instância privada');

      const privacy = await request(routerPort, {
        host: 'localhost:8080',
        path: '/privacy',
        headers: language,
      });
      expect(privacy.status).toBe(200);
      expect(privacy.body.toString('utf8')).toContain('Política de privacidade da instância');

      const landing = await request(routerPort, { host: 'localhost:8080', path: '/', headers: language });
      expect(landing.status).toBe(200);
      expect(landing.body.toString('utf8')).toContain('Kassinão');

      const docs = await request(routerPort, { host: 'localhost:8080', path: '/docs', headers: language });
      expect(docs.status).toBe(200);
      expect(docs.body.toString('utf8')).toContain('Documentação');
    } finally {
      Object.assign(config, prior);
    }
  });

  it('preserva request e response streaming, Range e backpressure sem buffer', async () => {
    coreHandler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        expect(req.headers.range).toBe('bytes=2-5');
        res.writeHead(206, {
          'Content-Range': 'bytes 2-5/8',
          'Content-Type': 'application/octet-stream',
        });
        res.write(Buffer.concat(chunks).subarray(2, 4));
        setTimeout(() => res.end(Buffer.concat(chunks).subarray(4, 6)), 30);
      });
    };

    const response = await request(routerPort, {
      host: 'app.example.test',
      method: 'POST',
      path: '/app/rec/id/audio',
      headers: { range: 'bytes=2-5' },
      chunks: [{ value: 'abcd' }, { value: 'efgh', delayMs: 20 }],
    });
    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 2-5/8');
    expect(response.body.toString('utf8')).toBe('cdef');
  });

  it('entrega cada direção do stream antes de receber o corpo completo', async () => {
    let receivedFirstRequestChunk = false;
    let upstreamResponseFinished = false;
    coreHandler = (req, res) => {
      req.once('data', (chunk: Buffer) => {
        receivedFirstRequestChunk = chunk.toString('utf8') === 'first-';
        res.write('ack-');
        setTimeout(() => {
          upstreamResponseFinished = true;
          res.end('done');
        }, 40);
      });
      req.resume();
    };

    await new Promise<void>((resolve, reject) => {
      let requestEnded = false;
      const req = http.request({
        hostname: '127.0.0.1',
        port: routerPort,
        method: 'POST',
        path: '/api/stream',
        headers: { host: 'app.example.test', 'transfer-encoding': 'chunked' },
      });
      const deadline = setTimeout(() => reject(new Error('stream foi bufferizado')), 1_000);
      req.once('error', reject);
      req.write('first-');
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (!requestEnded && Buffer.concat(chunks).toString('utf8').includes('ack-')) {
            requestEnded = true;
            expect(receivedFirstRequestChunk).toBe(true);
            expect(upstreamResponseFinished).toBe(false);
            req.end('second');
          }
        });
        res.once('error', reject);
        res.once('end', () => {
          clearTimeout(deadline);
          expect(Buffer.concat(chunks).toString('utf8')).toBe('ack-done');
          resolve();
        });
      });
      req.flushHeaders();
    });
  });

  it('expõe somente o health interno quando a conexão é do próprio listener', async () => {
    const response = await request(routerPort, { path: '/_kassinao/router-health' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      ok: true,
      surface: 'router',
      release: `sha256:${'a'.repeat(64)}`,
      deployment: 'b'.repeat(32),
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(coreRequests).toBe(0);
    expect(publicRequests).toBe(0);
  });

  it.each([
    ['CONNECT other.example:443 HTTP/1.1\r\nHost: other.example:443\r\n\r\n', 405],
    ['GET / HTTP/1.1\r\nHost: example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n', 426],
    ['POST / HTTP/1.1\r\nHost: example.test\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n', 417],
    ['GET https://other.example/ HTTP/1.1\r\nHost: example.test\r\n\r\n', 400],
    ['POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', 400],
  ])('rejeita protocolo ampliado antes de upstream', async (source, status) => {
    const response = await rawRequest(routerPort, source);
    expect(response).toContain(`HTTP/1.1 ${status}`);
    expect(coreRequests).toBe(0);
    expect(publicRequests).toBe(0);
  });

  it('devolve 502 e 504 sanitizados sem refletir destino interno', async () => {
    await close(coreServer);
    const unavailable = await request(routerPort, { host: 'app.example.test' });
    expect(unavailable.status).toBe(502);
    expect(unavailable.body.toString('utf8')).toBe('Bad gateway.');
    expect(unavailable.body.toString('utf8')).not.toContain('127.0.0.1');

    const hanging = http.createServer(() => undefined);
    const hangingPort = await listen(hanging);
    await close(routerServer);
    routerServer = createEdgeRouterServer({
      topology,
      core: { hostname: '127.0.0.1', port: hangingPort },
      public: { hostname: '127.0.0.1', port: hangingPort },
      upstreamTimeoutMs: 30,
    });
    routerPort = await listen(routerServer);
    const timeout = await request(routerPort, { host: 'app.example.test' });
    expect(timeout.status).toBe(504);
    expect(timeout.body.toString('utf8')).toBe('Gateway timeout.');
    await close(hanging);
  });

  it('limita admissão e cancela o upstream quando o cliente fecha antes dos headers', async () => {
    await close(routerServer);
    routerServer = createEdgeRouterServer({
      topology,
      core: { hostname: '127.0.0.1', port: (coreServer.address() as net.AddressInfo).port },
      public: { hostname: '127.0.0.1', port: (publicServer.address() as net.AddressInfo).port },
      upstreamTimeoutMs: 1_000,
      maxUpstreamRequests: 1,
    });
    routerPort = await listen(routerServer);

    let firstReachedUpstream!: () => void;
    const reachedUpstream = new Promise<void>((resolve) => {
      firstReachedUpstream = resolve;
    });
    let firstUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      firstUpstreamClosed = resolve;
    });
    coreHandler = (req) => {
      firstReachedUpstream();
      req.socket.once('close', firstUpstreamClosed);
    };

    const abandoned = http.request({
      hostname: '127.0.0.1',
      port: routerPort,
      path: '/api/hanging',
      headers: { host: 'app.example.test' },
    });
    abandoned.once('error', () => undefined);
    abandoned.end();
    await reachedUpstream;

    const saturated = await request(routerPort, { host: 'app.example.test', path: '/api/queued' });
    expect(saturated.status).toBe(503);
    expect(saturated.body.toString('utf8')).toBe('Service unavailable.');
    expect(coreRequests).toBe(1);

    abandoned.destroy();
    await upstreamClosed;

    coreHandler = (_req, res) => res.end('recovered');
    const recovered = await request(routerPort, { host: 'app.example.test', path: '/api/recovered' });
    expect(recovered.status).toBe(200);
    expect(recovered.body.toString('utf8')).toBe('recovered');
    expect(coreRequests).toBe(2);
  });

  it.each([0, 513, 1.5])('recusa limite de upstream inválido: %s', (maxUpstreamRequests) => {
    expect(() =>
      createEdgeRouterServer({
        topology,
        maxUpstreamRequests,
      }),
    ).toThrow('maxUpstreamRequests');
  });
});
