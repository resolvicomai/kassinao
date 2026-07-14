import crypto from 'node:crypto';
import { withCredentialStoreLock } from './credentialLock.js';
import { selectBootstrapRefreshToken, type StoredCredentials } from './tokenAuth.js';

export interface CredentialTokenResponse {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
}

export interface RefreshCredentialOptions {
  storeFile: string;
  currentUrl: string;
  environmentRefreshToken: string;
  load: () => StoredCredentials;
  save: (credentials: StoredCredentials) => void;
  request: (refreshToken: string, attemptId: string) => Promise<unknown | undefined>;
  createAttemptId?: () => string;
}

const MAX_ACCESS_TOKEN_CHARS = 8_192;
const MAX_REFRESH_TOKEN_CHARS = 4_096;
const MAX_EXPIRY_CHARS = 64;

export function parseCredentialTokenResponse(value: unknown): CredentialTokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Kassinão returned an invalid token response.');
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.access_token !== 'string' ||
    response.access_token.length === 0 ||
    response.access_token.length > MAX_ACCESS_TOKEN_CHARS ||
    typeof response.refresh_token !== 'string' ||
    response.refresh_token.length === 0 ||
    response.refresh_token.length > MAX_REFRESH_TOKEN_CHARS ||
    typeof response.access_expires_at !== 'string' ||
    response.access_expires_at.length === 0 ||
    response.access_expires_at.length > MAX_EXPIRY_CHARS ||
    !Number.isFinite(Date.parse(response.access_expires_at))
  ) {
    throw new Error('Kassinão returned an invalid token response.');
  }
  return {
    access_token: response.access_token,
    access_expires_at: response.access_expires_at,
    refresh_token: response.refresh_token,
  };
}

function storedTokenMatches(stored: StoredCredentials, currentUrl: string, refreshToken: string): boolean {
  return stored.url?.replace(/\/+$/, '') === currentUrl && stored.refreshToken === refreshToken;
}

/**
 * Gira uma credencial sob lock e persiste a intenção ANTES da rede. Se a
 * resposta se perder, a próxima execução repete o mesmo attemptId e o servidor
 * reemite a geração já criada sem interpretar o retry como roubo.
 */
export async function refreshCredential(options: RefreshCredentialOptions): Promise<CredentialTokenResponse> {
  const createAttemptId = options.createAttemptId ?? (() => crypto.randomBytes(16).toString('hex'));
  return withCredentialStoreLock(options.storeFile, async () => {
    const stored = options.load();
    let refreshToken = selectBootstrapRefreshToken(stored, options.currentUrl, options.environmentRefreshToken);
    if (!refreshToken) {
      throw new Error(
        `No token found. Generate one at ${options.currentUrl}/app/conectar-ia or run: kassinao-mcp exchange --stdin --url <origin>.`,
      );
    }

    const attemptFor = (token: string): string => {
      const reusable =
        storedTokenMatches(stored, options.currentUrl, token) &&
        typeof stored.refreshAttempt === 'string' &&
        /^[a-f0-9]{32}$/.test(stored.refreshAttempt)
          ? stored.refreshAttempt
          : undefined;
      const attemptId = reusable ?? createAttemptId();
      if (!/^[a-f0-9]{32}$/.test(attemptId)) throw new Error('Invalid MCP refresh attempt id.');
      options.save({ url: options.currentUrl, refreshToken: token, refreshAttempt: attemptId });
      return attemptId;
    };

    let attemptId = attemptFor(refreshToken);
    const firstResponse = await options.request(refreshToken, attemptId);
    let data = firstResponse === undefined ? undefined : parseCredentialTokenResponse(firstResponse);

    const environmentToken = options.environmentRefreshToken;
    if (!data && environmentToken && environmentToken !== refreshToken) {
      refreshToken = environmentToken;
      attemptId = createAttemptId();
      if (!/^[a-f0-9]{32}$/.test(attemptId)) throw new Error('Invalid MCP refresh attempt id.');
      options.save({ url: options.currentUrl, refreshToken, refreshAttempt: attemptId });
      const fallbackResponse = await options.request(refreshToken, attemptId);
      data = fallbackResponse === undefined ? undefined : parseCredentialTokenResponse(fallbackResponse);
    }
    if (!data) {
      throw new Error(
        `Could not refresh the token because it was revoked or expired. Generate a new one at ${options.currentUrl}/app/conectar-ia.`,
      );
    }

    // Um único rename durável confirma a nova geração e apaga o marcador pendente.
    options.save({ url: options.currentUrl, refreshToken: data.refresh_token });
    return data;
  });
}
