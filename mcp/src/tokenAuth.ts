import crypto from 'node:crypto';

export interface StoredCredentials {
  url?: string;
  refreshToken?: string;
}

/** Refresh token só via HTTPS; HTTP é permitido exclusivamente no desenvolvimento local. */
export function normalizeKassinaoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('KASSINAO_URL precisa ser uma URL absoluta http(s).');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('KASSINAO_URL aceita apenas http:// ou https://.');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('KASSINAO_URL não pode conter credenciais, query ou hash.');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('KASSINAO_URL não pode conter caminho.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('KASSINAO_URL precisa usar HTTPS fora de localhost (o refresh token é secreto).');
  }
  return url.origin;
}

/**
 * Um refresh token pertence a UMA instância. Nunca envie o token salvo para
 * outro KASSINAO_URL: além de falhar, isso revela um segredo ao host errado.
 * Stores antigos sem `url` exigem bootstrap explícito pelo env uma vez.
 */
export function selectBootstrapRefreshToken(stored: StoredCredentials, currentUrl: string, envToken: string): string {
  const storedUrl = typeof stored.url === 'string' ? stored.url.replace(/\/+$/, '') : '';
  const savedToken = typeof stored.refreshToken === 'string' ? stored.refreshToken : '';
  if (savedToken && storedUrl && storedUrl === currentUrl) return savedToken;
  return envToken;
}

/**
 * Cada token inicial identifica uma conexão nomeada. Um arquivo por conexão
 * impede Claude/Cursor no mesmo computador de rotacionarem o MESMO refresh em
 * paralelo. O hash só serve de chave local e não revela o token no filename.
 */
export function tokenStoreFileName(currentUrl: string, bootstrapToken: string): string {
  if (!bootstrapToken) return 'token.json'; // fluxo legado `exchange`, sem env
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
