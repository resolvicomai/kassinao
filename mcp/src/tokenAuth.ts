import crypto from 'node:crypto';

export interface StoredCredentials {
  url?: string;
  refreshToken?: string;
}

/** Refresh tokens require HTTPS; HTTP is allowed only for local development. */
export function normalizeKassinaoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('KASSINAO_URL must be an absolute HTTP(S) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('KASSINAO_URL only accepts http:// or https://.');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('KASSINAO_URL cannot contain credentials, a query, or a hash.');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('KASSINAO_URL cannot contain a path.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('KASSINAO_URL must use HTTPS outside localhost because refresh tokens are secrets.');
  }
  return url.origin;
}

/**
 * A refresh token belongs to ONE instance. Never send a saved token to another
 * KASSINAO_URL: besides failing, that would reveal a secret to the wrong host.
 * Legacy stores without `url` require an explicit one-time env bootstrap.
 */
export function selectBootstrapRefreshToken(stored: StoredCredentials, currentUrl: string, envToken: string): string {
  const storedUrl = typeof stored.url === 'string' ? stored.url.replace(/\/+$/, '') : '';
  const savedToken = typeof stored.refreshToken === 'string' ? stored.refreshToken : '';
  if (savedToken && storedUrl && storedUrl === currentUrl) return savedToken;
  return envToken;
}

/**
 * Each bootstrap token identifies a named connection. One file per connection
 * prevents clients on the same machine from rotating the SAME refresh token in
 * parallel. The hash is only a local key and does not reveal the token in the filename.
 */
export function tokenStoreFileName(currentUrl: string, bootstrapToken: string): string {
  if (!bootstrapToken) return 'token.json'; // legacy `exchange` flow, without env
  const profile = crypto.createHash('sha256').update(`${currentUrl}\0${bootstrapToken}`).digest('hex').slice(0, 24);
  return `token-${profile}.json`;
}

/** Só 401 prova que o token salvo morreu; 429/5xx não autorizam reapresentar um env antigo. */
export function mayFallbackToEnvToken(status: number): boolean {
  return status === 401;
}

/**
 * Deduplica uma operação assíncrona em andamento. Refresh tokens rotacionam a
 * cada uso; duas chamadas paralelas com a mesma geração seriam interpretadas
 * pelo servidor como reuso e revogariam a sessão inteira.
 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      pending = task().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}
