import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import net from 'node:net';
import os, { type NetworkInterfaceInfo } from 'node:os';
import type { Duplex } from 'node:stream';

export type EdgeTarget = 'core' | 'public';
export type EdgeRole = 'app' | 'public' | 'docs' | 'mcp';

export interface EdgeOrigins {
  app: string;
  public: string;
  docs: string;
  mcp: string;
}

interface ParsedOrigin {
  origin: string;
  host: string;
  protocol: 'http:' | 'https:';
  port: string;
}

export interface EdgeTopology {
  origins: Record<EdgeRole, ParsedOrigin>;
  rolesByHost: ReadonlyMap<string, readonly EdgeRole[]>;
  wwwHost?: string;
}

export type EdgeDecision =
  | {
      kind: 'proxy';
      target: EdgeTarget;
      host: string;
      protocol: 'http:' | 'https:';
      port: string;
    }
  | { kind: 'redirect'; status: 308; location: string; secure: boolean }
  | { kind: 'local-health' }
  | { kind: 'reject'; status: 400 | 404 | 405 | 417 | 421 | 426; secure: boolean };

export interface EdgeRequestDescription {
  method: string;
  host?: string;
  requestTarget: string;
  expect?: string;
  upgrade?: string;
  selfRequest?: boolean;
}

export interface EdgeUpstream {
  hostname: string;
  port: number;
}

export interface EdgeRouterOptions {
  topology: EdgeTopology;
  core?: EdgeUpstream;
  public?: EdgeUpstream;
  releaseDigest?: string;
  deploymentFingerprint?: string;
  upstreamTimeoutMs?: number;
  maxUpstreamRequests?: number;
}

export interface ListenEdgeRouterOptions extends EdgeRouterOptions {
  port: number;
  bindInterfaces: readonly [string, string];
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface EdgeRouterListener {
  close(callback: (error?: Error) => void): void;
}

interface EdgeRouterListenerLifecycle {
  listen(server: Server, port: number, address: string): Promise<void>;
  close(servers: readonly Server[], force?: boolean): Promise<Error | undefined>;
}

const INTERNAL_HEALTH_PATH = '/_kassinao/router-health';
const CORE_PREFIXES = ['/app', '/auth', '/api', '/gravacoes', '/rec', '/conectar-ia'];
const STATIC_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const DEFAULT_CORE_UPSTREAM: EdgeUpstream = { hostname: 'kassinao-core', port: 8082 };
const DEFAULT_PUBLIC_UPSTREAM: EdgeUpstream = { hostname: 'kassinao-public', port: 8081 };

function parseOrigin(raw: string, name: string): ParsedOrigin {
  const url = new URL(raw);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} precisa ser uma origem HTTP(S) sem caminho, credenciais, query ou hash`);
  }
  return {
    origin: url.origin,
    host: url.host.toLowerCase(),
    protocol: url.protocol,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
  };
}

function publicWwwHost(publicOrigin: ParsedOrigin): string | undefined {
  const url = new URL(publicOrigin.origin);
  if (
    url.hostname === 'localhost' ||
    url.hostname.startsWith('www.') ||
    net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0
  ) {
    return undefined;
  }
  return `www.${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}`;
}

export function createEdgeTopology(origins: EdgeOrigins): EdgeTopology {
  const parsed: Record<EdgeRole, ParsedOrigin> = {
    app: parseOrigin(origins.app, 'APP_URL'),
    public: parseOrigin(origins.public, 'PUBLIC_URL'),
    docs: parseOrigin(origins.docs, 'DOCS_URL'),
    mcp: parseOrigin(origins.mcp, 'MCP_URL'),
  };
  const mutable = new Map<string, EdgeRole[]>();
  for (const role of ['app', 'public', 'docs', 'mcp'] as const) {
    const existingRole = (mutable.get(parsed[role].host) ?? [])[0];
    if (existingRole && parsed[existingRole].origin !== parsed[role].origin) {
      throw new Error('Papéis no mesmo Host precisam usar a mesma origem canônica');
    }
    const roles = mutable.get(parsed[role].host) ?? [];
    roles.push(role);
    mutable.set(parsed[role].host, roles);
  }
  const wwwHost = publicWwwHost(parsed.public);
  if (wwwHost && mutable.has(wwwHost)) {
    throw new Error('O alias www da origem pública conflita com uma origem configurada');
  }
  return {
    origins: parsed,
    rolesByHost: new Map([...mutable].map(([host, roles]) => [host, Object.freeze([...roles])])),
    wwwHost,
  };
}

function normalizedHost(raw: string | undefined): string | undefined {
  if (!raw || /[\s/\\]/.test(raw)) return undefined;
  try {
    const url = new URL(`http://${raw}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function originFormPath(requestTarget: string): string | undefined {
  const hasForbiddenCharacter = (value: string): boolean =>
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    });
  if (
    !requestTarget.startsWith('/') ||
    requestTarget.startsWith('//') ||
    requestTarget.includes('\\') ||
    hasForbiddenCharacter(requestTarget) ||
    requestTarget.includes('#')
  ) {
    return undefined;
  }
  try {
    const pathname = decodeURIComponent(new URL(requestTarget, 'http://router.invalid').pathname);
    if (pathname.includes('\\') || hasForbiddenCharacter(pathname)) return undefined;
    return pathname;
  } catch {
    return undefined;
  }
}

function isPrefixFolded(pathname: string, prefix: string): boolean {
  const folded = pathname.toLowerCase();
  return folded === prefix || folded.startsWith(`${prefix}/`);
}

function isPrivatePath(pathname: string): boolean {
  return CORE_PREFIXES.some((prefix) => isPrefixFolded(pathname, prefix));
}

function privacyPath(pathname: string): '/privacy' | '/en/privacy' | undefined {
  const key = pathname !== '/' ? pathname.replace(/\/+$/, '').toLowerCase() : pathname;
  if (key === '/privacy') return '/privacy';
  if (key === '/en/privacy') return '/en/privacy';
  return undefined;
}

function isNavigation(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function securityForRoles(topology: EdgeTopology, roles: readonly EdgeRole[]): boolean {
  return roles.some((role) => topology.origins[role].protocol === 'https:');
}

function proxyDecision(
  topology: EdgeTopology,
  target: EdgeTarget,
  host: string,
  roles: readonly EdgeRole[],
): Extract<EdgeDecision, { kind: 'proxy' }> {
  const preferred =
    target === 'core'
      ? roles.find((role) => role === 'app' || role === 'mcp')
      : roles.find((role) => role === 'public' || role === 'docs');
  if (!preferred) throw new Error(`Topologia sem papel para o destino ${target}`);
  const origin = topology.origins[preferred];
  return { kind: 'proxy', target, host, protocol: origin.protocol, port: origin.port };
}

/** Decide o destino sem abrir sockets, ler ambiente ou importar configuração privada. */
export function decideEdgeRequest(topology: EdgeTopology, request: EdgeRequestDescription): EdgeDecision {
  const method = request.method.toUpperCase();
  const pathname = originFormPath(request.requestTarget);
  if (!pathname) return { kind: 'reject', status: 400, secure: false };
  if (request.expect) return { kind: 'reject', status: 417, secure: false };
  if (request.upgrade) return { kind: 'reject', status: 426, secure: false };
  if (method === 'CONNECT' || method === 'TRACE') return { kind: 'reject', status: 405, secure: false };

  if (pathname === INTERNAL_HEALTH_PATH) {
    if (request.selfRequest && isNavigation(method)) return { kind: 'local-health' };
    const host = normalizedHost(request.host);
    const roles = host
      ? host === topology.wwwHost
        ? (['public'] as const)
        : (topology.rolesByHost.get(host) ?? [])
      : [];
    return { kind: 'reject', status: 404, secure: securityForRoles(topology, roles) };
  }

  const host = normalizedHost(request.host);
  if (!host) return { kind: 'reject', status: 421, secure: false };
  const roles: readonly EdgeRole[] =
    host === topology.wwwHost ? (['public'] as const) : (topology.rolesByHost.get(host) ?? []);
  if (roles.length === 0) return { kind: 'reject', status: 421, secure: false };
  const secure = securityForRoles(topology, roles);
  const hasCore = roles.some((role) => role === 'app' || role === 'mcp');
  const hasPublic = roles.some((role) => role === 'public' || role === 'docs');
  const privacy = privacyPath(pathname);

  if (privacy) {
    if (roles.includes('app')) return proxyDecision(topology, 'core', host, roles);
    if (hasPublic) {
      return isNavigation(method)
        ? {
            kind: 'redirect',
            status: 308,
            location: `${topology.origins.app.origin}${privacy}`,
            secure,
          }
        : { kind: 'reject', status: 404, secure };
    }
    return proxyDecision(topology, 'core', host, roles);
  }

  if (hasPublic && !hasCore) {
    if (isPrivatePath(pathname)) return { kind: 'reject', status: 404, secure };
    return proxyDecision(topology, 'public', host, roles);
  }
  if (hasCore && !hasPublic) return proxyDecision(topology, 'core', host, roles);

  if (pathname.toLowerCase() === '/health' || isPrivatePath(pathname)) {
    return proxyDecision(topology, 'core', host, roles);
  }
  return proxyDecision(topology, 'public', host, roles);
}

function connectionHeaderNames(headers: IncomingHttpHeaders): Set<string> {
  const names = new Set(STATIC_HOP_HEADERS);
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const value of values) {
    for (const name of value.split(',')) {
      const normalized = name.trim().toLowerCase();
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

function normalizedRemoteAddress(value: string | undefined): string {
  if (!value) return '0.0.0.0';
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function forwardedClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const xffValue = Array.isArray(xff) ? xff.at(-1) : xff;
  const last = xffValue?.split(',').at(-1)?.trim();
  if (last && net.isIP(last)) return last;
  return normalizedRemoteAddress(req.socket.remoteAddress);
}

function requestHeaders(req: IncomingMessage, decision: Extract<EdgeDecision, { kind: 'proxy' }>): OutgoingHttpHeaders {
  const denied = connectionHeaderNames(req.headers);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const normalized = name.toLowerCase();
    if (
      denied.has(normalized) ||
      normalized === 'host' ||
      normalized === 'forwarded' ||
      normalized === 'cf-connecting-ip' ||
      normalized.startsWith('x-forwarded-')
    ) {
      continue;
    }
    if (value !== undefined) headers[normalized] = value;
  }
  headers.host = decision.host;
  headers['x-forwarded-for'] = forwardedClientIp(req);
  headers['x-forwarded-host'] = decision.host;
  headers['x-forwarded-port'] = decision.port;
  headers['x-forwarded-proto'] = decision.protocol.slice(0, -1);
  return headers;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const denied = connectionHeaderNames(headers);
  const sanitized: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!denied.has(name.toLowerCase()) && value !== undefined) sanitized[name] = value;
  }
  return sanitized;
}

function applyGeneratedHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendText(res: ServerResponse, status: number, message: string, secure: boolean): void {
  applyGeneratedHeaders(res, secure);
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

function rejectionMessage(status: Extract<EdgeDecision, { kind: 'reject' }>['status']): string {
  if (status === 400) return 'Bad request.';
  if (status === 405) return 'Method not allowed.';
  if (status === 417) return 'Expectation failed.';
  if (status === 421) return 'Host não reconhecido.';
  if (status === 426) return 'Upgrade required.';
  return 'Not found.';
}

function isSelfRequest(req: IncomingMessage): boolean {
  const remote = normalizedRemoteAddress(req.socket.remoteAddress);
  const local = normalizedRemoteAddress(req.socket.localAddress);
  return remote !== '0.0.0.0' && remote === local;
}

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  decision: Extract<EdgeDecision, { kind: 'proxy' }>,
  upstream: EdgeUpstream,
  agent: http.Agent,
  timeoutMs: number,
  admission: { active: number; limit: number },
): void {
  if (admission.active >= admission.limit) {
    req.resume();
    sendText(res, 503, 'Service unavailable.', decision.protocol === 'https:');
    return;
  }
  admission.active++;

  let timedOut = false;
  let responseStarted = false;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    admission.active--;
  };
  const upstreamRequest = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: requestHeaders(req, decision),
      agent,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
      maxHeaderSize: 16 * 1024,
    },
    (upstreamResponse) => {
      responseStarted = true;
      clearTimeout(responseDeadline);
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
      upstreamResponse.once('aborted', () => res.destroy());
      upstreamResponse.once('error', () => res.destroy());
    },
  );
  const responseDeadline = setTimeout(() => {
    timedOut = true;
    upstreamRequest.destroy(new Error('upstream_response_timeout'));
  }, timeoutMs);
  responseDeadline.unref();
  upstreamRequest.setTimeout(timeoutMs, () => {
    timedOut = true;
    upstreamRequest.destroy(new Error('upstream_timeout'));
  });
  upstreamRequest.once('close', () => {
    clearTimeout(responseDeadline);
    release();
  });
  upstreamRequest.once('error', () => {
    if (responseStarted || res.headersSent) {
      res.destroy();
      return;
    }
    sendText(res, timedOut ? 504 : 502, timedOut ? 'Gateway timeout.' : 'Bad gateway.', decision.protocol === 'https:');
  });
  req.once('aborted', () => upstreamRequest.destroy());
  req.once('error', () => upstreamRequest.destroy());
  res.once('close', () => {
    if (!res.writableEnded) upstreamRequest.destroy();
  });
  req.pipe(upstreamRequest);
}

function rawResponse(socket: Duplex, status: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${reason}.\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Cache-Control: no-store\r\n' +
      "Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\n" +
      'Referrer-Policy: no-referrer\r\n' +
      'X-Content-Type-Options: nosniff\r\n' +
      'X-Robots-Tag: noindex, nofollow, noarchive\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

interface EdgeRouterResources {
  agents: Record<EdgeTarget, http.Agent>;
  admissions: Record<EdgeTarget, { active: number; limit: number }>;
  dispose(): void;
}

function createEdgeRouterResources(maxUpstreamRequests: number): EdgeRouterResources {
  if (!Number.isSafeInteger(maxUpstreamRequests) || maxUpstreamRequests < 1 || maxUpstreamRequests > 512) {
    throw new Error('maxUpstreamRequests precisa ser um inteiro entre 1 e 512');
  }
  const agents: Record<EdgeTarget, http.Agent> = {
    core: new http.Agent({
      keepAlive: true,
      maxSockets: maxUpstreamRequests,
      maxFreeSockets: 16,
      timeout: 30_000,
    }),
    public: new http.Agent({
      keepAlive: true,
      maxSockets: maxUpstreamRequests,
      maxFreeSockets: 16,
      timeout: 30_000,
    }),
  };
  const admissions: Record<EdgeTarget, { active: number; limit: number }> = {
    core: { active: 0, limit: maxUpstreamRequests },
    public: { active: 0, limit: maxUpstreamRequests },
  };
  let disposed = false;
  return {
    agents,
    admissions,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      agents.core.destroy();
      agents.public.destroy();
    },
  };
}

function createEdgeRouterServerWithResources(
  options: EdgeRouterOptions,
  resources: EdgeRouterResources,
  acceptingRequests: () => boolean,
  disposeOnClose: boolean,
): Server {
  const core = options.core ?? DEFAULT_CORE_UPSTREAM;
  const publicUpstream = options.public ?? DEFAULT_PUBLIC_UPSTREAM;
  const timeoutMs = options.upstreamTimeoutMs ?? 120_000;

  const server = http.createServer(
    {
      connectionsCheckingInterval: 1_000,
      headersTimeout: 10_000,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16 * 1024,
      rejectNonStandardBodyWrites: true,
      requestTimeout: 120_000,
      requireHostHeader: true,
    },
    (req, res) => {
      if (!acceptingRequests()) {
        sendText(res, 503, 'Service unavailable.', false);
        return;
      }
      const decision = decideEdgeRequest(options.topology, {
        method: req.method ?? 'GET',
        host: req.headers.host,
        requestTarget: req.url ?? '',
        expect: Array.isArray(req.headers.expect) ? req.headers.expect[0] : req.headers.expect,
        upgrade: Array.isArray(req.headers.upgrade) ? req.headers.upgrade[0] : req.headers.upgrade,
        selfRequest: isSelfRequest(req),
      });
      if (decision.kind === 'reject') {
        sendText(res, decision.status, rejectionMessage(decision.status), decision.secure);
        return;
      }
      if (decision.kind === 'redirect') {
        applyGeneratedHeaders(res, decision.secure);
        res.statusCode = decision.status;
        res.setHeader('Location', decision.location);
        res.end();
        return;
      }
      if (decision.kind === 'local-health') {
        applyGeneratedHeaders(res, false);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            ok: true,
            surface: 'router',
            ...(options.releaseDigest ? { release: options.releaseDigest } : {}),
            ...(options.deploymentFingerprint ? { deployment: options.deploymentFingerprint } : {}),
          }),
        );
        return;
      }
      proxyRequest(
        req,
        res,
        decision,
        decision.target === 'core' ? core : publicUpstream,
        resources.agents[decision.target],
        timeoutMs,
        resources.admissions[decision.target],
      );
    },
  );
  server.maxConnections = 512;
  server.maxRequestsPerSocket = 1_000;
  server.on('checkContinue', (_req, res) => sendText(res, 417, 'Expectation failed.', false));
  server.on('checkExpectation', (_req, res) => sendText(res, 417, 'Expectation failed.', false));
  server.on('connect', (_req, socket) => rawResponse(socket, 405, 'Method Not Allowed'));
  server.on('upgrade', (_req, socket) => rawResponse(socket, 426, 'Upgrade Required'));
  server.on('clientError', (_error, socket) => rawResponse(socket, 400, 'Bad Request'));
  if (disposeOnClose) {
    server.once('close', resources.dispose);
  }
  return server;
}

export function createEdgeRouterServer(options: EdgeRouterOptions): Server {
  const resources = createEdgeRouterResources(options.maxUpstreamRequests ?? 128);
  return createEdgeRouterServerWithResources(options, resources, () => true, true);
}

export function resolveExclusiveInterfaceAddress(
  interfaceName: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const candidates = (interfaces[interfaceName] ?? []).filter(
    (candidate) => candidate.family === 'IPv4' && !candidate.internal && net.isIPv4(candidate.address),
  );
  if (candidates.length !== 1) {
    throw new Error(`A interface ${interfaceName} precisa ter exatamente um endereço IPv4 não-loopback`);
  }
  return candidates[0].address;
}

export function resolveExclusiveInterfaceAddresses(
  interfaceNames: readonly [string, string],
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = os.networkInterfaces(),
): readonly [string, string] {
  if (interfaceNames[0] === interfaceNames[1]) {
    throw new Error('As interfaces de edge e host precisam ser distintas');
  }
  const addresses = interfaceNames.map((name) => resolveExclusiveInterfaceAddress(name, interfaces)) as [
    string,
    string,
  ];
  if (addresses[0] === addresses[1]) {
    throw new Error('As interfaces de edge e host precisam usar endereços IPv4 distintos');
  }
  return addresses;
}

function listenServer(server: Server, port: number, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, address, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServers(servers: readonly Server[], force = false): Promise<Error | undefined> {
  return new Promise((resolve) => {
    if (servers.length === 0) {
      resolve(undefined);
      return;
    }
    let pending = servers.length;
    let settled = false;
    const errors: Error[] = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      resolve(
        error ?? (errors.length > 0 ? new AggregateError(errors, 'Falha ao fechar listeners do router') : undefined),
      );
    };
    const deadline = force
      ? setTimeout(() => finish(new Error('Timeout ao abortar listeners parciais do router')), 1_000)
      : undefined;
    deadline?.unref();
    for (const server of servers) {
      server.close((error) => {
        if (error) errors.push(error);
        pending--;
        if (pending === 0) {
          if (deadline) clearTimeout(deadline);
          finish();
        }
      });
      if (force) server.closeAllConnections();
    }
  });
}

const systemListenerLifecycle: EdgeRouterListenerLifecycle = {
  listen: listenServer,
  close: closeServers,
};

export async function listenEdgeRouter(
  options: ListenEdgeRouterOptions,
  lifecycle: EdgeRouterListenerLifecycle = systemListenerLifecycle,
): Promise<EdgeRouterListener> {
  const addresses = resolveExclusiveInterfaceAddresses(options.bindInterfaces, options.networkInterfaces);
  const resources = createEdgeRouterResources(options.maxUpstreamRequests ?? 128);
  let acceptingRequests = false;
  // host0 abre primeiro; edge0, alcançável pelo túnel, é sempre o último bind.
  // Ambos devolvem 503 até que os dois listeners estejam confirmados.
  const bindings = [addresses[1], addresses[0]].map((address) => ({
    address,
    server: createEdgeRouterServerWithResources(options, resources, () => acceptingRequests, false),
  }));
  const servers = bindings.map(({ server }) => server);
  for (const server of servers) server.maxConnections = 256;
  const started: Server[] = [];
  try {
    for (const { address, server } of bindings) {
      await lifecycle.listen(server, options.port, address);
      started.push(server);
    }
    acceptingRequests = true;
  } catch (error) {
    acceptingRequests = false;
    try {
      if (started.length > 0) await lifecycle.close(started, true);
    } catch {
      // O erro original de bind é o diagnóstico acionável; cleanup não o mascara.
    }
    resources.dispose();
    throw error;
  }
  return {
    close(callback): void {
      acceptingRequests = false;
      void lifecycle.close(servers).then(
        (error) => {
          resources.dispose();
          callback(error);
        },
        (error: unknown) => {
          resources.dispose();
          callback(error as Error);
        },
      );
    },
  };
}
