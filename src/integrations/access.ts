import { AsyncLocalStorage } from 'node:async_hooks';
import { createIntegrationClient, resolveArtifact } from './client';
import { jiraOrigin, type IntegrationConfiguration } from './config';
import type { ArtifactReference, IntegrationContext } from './types';

interface RecipientCredentials {
  githubToken?: string;
  jira: IntegrationConfiguration['jiraCredentials'];
}

export type ContextUserCredentials = Record<string, RecipientCredentials>;

/** Private operator mapping; never return this object to a browser, MCP, or log. */
export function parseContextUserCredentials(raw = '{}'): ContextUserCredentials {
  const invalid = () => new Error('Invalid context recipient credentials');
  if (raw.length > 1024 * 1024) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON errors can quote a credential; expose only the fixed category.
    throw invalid();
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const secret = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/\p{Cc}/u.test(value);
  if (!object(parsed) || Object.keys(parsed).length > 1000) throw invalid();
  const credentials: ContextUserCredentials = {};
  for (const [userId, value] of Object.entries(parsed)) {
    if (
      !/^\d{1,30}$/.test(userId) ||
      !object(value) ||
      Object.keys(value).some((k) => !['githubToken', 'jira'].includes(k))
    )
      throw invalid();
    if (value.githubToken !== undefined && (!secret(value.githubToken) || /\s/u.test(value.githubToken)))
      throw invalid();
    const jira: RecipientCredentials['jira'] = {};
    if (value.jira !== undefined) {
      if (!object(value.jira) || Object.keys(value.jira).length > 30) throw invalid();
      for (const [site, pair] of Object.entries(value.jira)) {
        if (
          !object(pair) ||
          !secret(pair.email) ||
          !secret(pair.apiToken) ||
          pair.email.includes(':') ||
          Object.keys(pair).some((key) => !['email', 'apiToken'].includes(key))
        )
          throw invalid();
        let origin: string;
        try {
          origin = jiraOrigin(site);
        } catch {
          // URL errors can quote a credential-bearing input.
          throw invalid();
        }
        if (jira[origin]) throw invalid();
        jira[origin] = { email: pair.email, apiToken: pair.apiToken };
      }
    }
    credentials[userId] = { githubToken: value.githubToken as string | undefined, jira };
  }
  return credentials;
}

export class RecipientAuthorizationUnavailableError extends Error {
  constructor() {
    super('Recipient source access temporarily unavailable');
  }
}

interface AccessOperation {
  checks: Map<string, Promise<boolean>>;
  deadline: number;
}
const operations = new AsyncLocalStorage<AccessOperation>();

/** Deduplicates only within one view/digest. The next operation always checks the provider again. */
export function withRecipientArtifactAccess<T>(fn: () => Promise<T>): Promise<T> {
  return operations.run({ checks: new Map(), deadline: Date.now() + 10_000 }, fn);
}

export function createRecipientArtifactAccess(
  configuration: IntegrationConfiguration,
  credentials: ContextUserCredentials,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBodyBytes?: number } = {},
) {
  return {
    recipientCredentialsStatus(userId: string): { github: boolean; jira: boolean } {
      return {
        github: !!credentials[userId]?.githubToken,
        jira: !!Object.keys(credentials[userId]?.jira ?? {}).length,
      };
    },
    async canRead(userId: string, reference: ArtifactReference, context: IntegrationContext): Promise<boolean> {
      if (!/^\d{1,30}$/.test(userId)) return false;
      let ref: ArtifactReference;
      try {
        ref = resolveArtifact(reference.url, context, configuration.scopes);
      } catch {
        return false;
      }
      if (
        ref.kind !== reference.kind ||
        ref.origin !== reference.origin ||
        ref.repository !== reference.repository ||
        ref.number !== reference.number ||
        ref.issueKey !== reference.issueKey
      )
        return false;
      // Documents stay manual links. No generic document ACL/content adapter exists.
      if (ref.kind === 'document') return true;
      const own = credentials[userId];
      if (!own || (ref.kind.startsWith('github-') ? !own.githubToken : !own.jira[ref.origin])) return false;
      const operation = operations.getStore();
      const key = JSON.stringify([userId, context.guildId, context.channelId, ref.url]);
      const cached = operation?.checks.get(key);
      if (cached) return cached;
      if (operation && (operation.checks.size >= 100 || Date.now() >= operation.deadline))
        throw new RecipientAuthorizationUnavailableError();
      const timeoutMs = Math.max(
        1,
        Math.min(10_000, options.timeoutMs ?? 10_000, (operation?.deadline ?? Infinity) - Date.now()),
      );
      const check = async (): Promise<boolean> => {
        // Override both technical credentials; never fall back to the service account.
        const snapshot = await createIntegrationClient(
          { ...configuration, githubToken: own.githubToken, jiraCredentials: own.jira },
          {
            ...options,
            timeoutMs,
            maxBodyBytes: Math.min(128 * 1024, options.maxBodyBytes ?? 128 * 1024),
          },
        ).lookup(ref, context);
        if (snapshot.state !== 'unavailable') return true;
        if (snapshot.reason === 'not_found' || snapshot.reason === 'access_denied') return false;
        throw new RecipientAuthorizationUnavailableError();
      };
      const pending = check();
      operation?.checks.set(key, pending);
      return pending;
    },
  };
}
