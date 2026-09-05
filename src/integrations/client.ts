import type { IntegrationConfiguration } from './config';
import type {
  ArtifactReference,
  ArtifactSnapshot,
  IntegrationClient,
  IntegrationContext,
  IntegrationScope,
} from './types';

export class IntegrationInputError extends Error {}

function matchingScopes(scopes: IntegrationScope[], context: IntegrationContext): IntegrationScope[] {
  return scopes.filter((s) => s.guildId === context.guildId && (!s.channelId || s.channelId === context.channelId));
}

export function resolveArtifact(
  input: string,
  context: IntegrationContext,
  scopes: IntegrationScope[],
): ArtifactReference {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000 || /\p{Cc}/u.test(input))
    throw new IntegrationInputError('Referência inválida.');
  let value = input.trim();
  const allowed = matchingScopes(scopes, context);
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(value)) {
    const sites = [
      ...new Set(allowed.filter((s) => s.jira?.projects.includes(value.split('-')[0])).map((s) => s.jira!.site)),
    ];
    if (sites.length !== 1) throw new IntegrationInputError('Use o link completo da issue em um projeto autorizado.');
    value = `${sites[0]}/browse/${value}`;
  }
  const shorthand = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)#(\d+)$/i.exec(value);
  if (shorthand) value = `https://github.com/${shorthand[1]}/issues/${shorthand[2]}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationInputError('Use um link HTTPS ou uma issue autorizada.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    /%|\\/.test(value)
  )
    throw new IntegrationInputError('O link não pode ter credenciais, parâmetros ou redirecionamentos.');
  if (url.hostname === 'github.com' || url.hostname === 'api.github.com') {
    const match = (
      url.hostname === 'github.com'
        ? /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/
        : /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)\/?$/
    ).exec(url.pathname);
    if (!match) throw new IntegrationInputError('Use o link exato de uma issue ou pull request.');
    const repository = `${match[1]}/${match[2]}`.toLowerCase();
    const number = Number(match[4]);
    if (!Number.isSafeInteger(number) || number < 1 || !allowed.some((s) => s.githubRepositories.includes(repository)))
      throw new IntegrationInputError('Repositório fora do contexto autorizado.');
    const kind = match[3] === 'issues' ? 'github-issue' : 'github-pull';
    return {
      kind,
      repository,
      number,
      origin: 'https://github.com',
      url: `https://github.com/${repository}/${kind === 'github-issue' ? 'issues' : 'pull'}/${number}`,
    };
  }
  if (/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i.test(url.hostname)) {
    const match = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/.exec(url.pathname);
    if (!match || !allowed.some((s) => s.jira?.site === url.origin && s.jira.projects.includes(match[1].split('-')[0])))
      throw new IntegrationInputError('Issue fora do projeto Jira autorizado.');
    return { kind: 'jira-issue', issueKey: match[1], origin: url.origin, url: `${url.origin}/browse/${match[1]}` };
  }
  if (!allowed.some((s) => s.documentOrigins.includes(url.origin)))
    throw new IntegrationInputError('Origem do documento não autorizada.');
  return { kind: 'document', origin: url.origin, url: url.href };
}

function string(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').slice(0, max) : undefined;
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function createIntegrationClient(
  configuration: IntegrationConfiguration,
  options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; maxBodyBytes?: number } = {},
): IntegrationClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBodyBytes ?? 128 * 1024;
  return {
    resolve: (input, context) => resolveArtifact(input, context, configuration.scopes),
    async lookup(reference, context) {
      // Reparse persisted references against the current mapping before every request.
      const ref = resolveArtifact(reference.url, context, configuration.scopes);
      const base = { checkedAt: now(), deployed: null } as const;
      const failure = (reason: ArtifactSnapshot['reason']): ArtifactSnapshot => ({
        ...base,
        state: 'unavailable',
        label: 'Fonte indisponível',
        reason,
      });
      if (ref.kind === 'document')
        return {
          ...base,
          state: 'unverified',
          label: 'Documento vinculado; conteúdo não consultado',
          reason: 'manual_reference',
        };
      let endpoint: string;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (ref.kind.startsWith('github-')) {
        if (!configuration.githubToken) return failure('access_denied');
        endpoint = `https://api.github.com/repos/${ref.repository}/${ref.kind === 'github-pull' ? 'pulls' : 'issues'}/${ref.number}`;
        headers.Authorization = `Bearer ${configuration.githubToken}`;
        headers['X-GitHub-Api-Version'] = '2026-03-10';
        headers['User-Agent'] = 'kassinao-context';
      } else {
        const credentials = configuration.jiraCredentials[ref.origin];
        if (!credentials) return failure('access_denied');
        endpoint = `${ref.origin}/rest/api/3/issue/${ref.issueKey}?fields=summary,status,updated`;
        headers.Authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`;
      }
      const signal = AbortSignal.timeout(timeoutMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await withinDeadline(
          request(endpoint, { method: 'GET', headers, redirect: 'error', signal }),
          signal,
        );
        if (!response.ok) {
          if (response.body) void response.body.cancel().catch(() => undefined);
          if (response.status === 429) {
            const retry = response.headers.get('retry-after');
            const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 60_000;
            return { ...failure('rate_limited'), retryAt: now() + Math.min(delay, 24 * 3600_000) };
          }
          return failure(
            response.status === 404
              ? 'not_found'
              : [401, 403].includes(response.status)
                ? 'access_denied'
                : 'provider_error',
          );
        }
        if (Number(response.headers.get('content-length') || 0) > maxBytes) {
          void response.body?.cancel().catch(() => undefined);
          return failure('invalid_response');
        }
        reader = response.body?.getReader();
        if (!reader) return failure('invalid_response');
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const chunk = await withinDeadline(reader.read(), signal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) {
            void reader.cancel().catch(() => undefined);
            return failure('invalid_response');
          }
          chunks.push(chunk.value);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return failure('invalid_response');
        if (ref.kind.startsWith('github-')) {
          if (Number(data.number) !== ref.number || !['open', 'closed'].includes(data.state))
            return failure('invalid_response');
          // /issues can also return a PR. Do not infer merge status from the issue endpoint.
          const merged = ref.kind === 'github-pull' && data.merged === true && typeof data.merged_at === 'string';
          return {
            ...base,
            state: merged ? 'merged' : data.state,
            label: merged
              ? 'PR incorporado; implantação não verificada'
              : data.state === 'open'
                ? 'Aberto'
                : `Fechado${data.state_reason === 'not_planned' ? ' sem execução planejada' : ''}`,
            title: string(data.title, 300),
            updatedAt: string(data.updated_at, 40),
          };
        }
        if (data.key !== ref.issueKey || !data.fields?.status?.statusCategory?.key) return failure('invalid_response');
        const category = data.fields.status.statusCategory.key;
        return {
          ...base,
          state: category === 'done' ? 'done' : ['new', 'indeterminate'].includes(category) ? 'open' : 'unknown',
          label: string(data.fields.status.name, 100) || 'Estado não informado',
          title: string(data.fields.summary, 300),
          updatedAt: string(data.fields.updated, 40),
        };
      } catch {
        return failure(signal.aborted ? 'timeout' : 'provider_error');
      } finally {
        if (reader) void reader.cancel().catch(() => undefined);
      }
    },
  };
}
