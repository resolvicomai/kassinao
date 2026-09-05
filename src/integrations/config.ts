import type { IntegrationScope } from './types';

export interface IntegrationConfiguration {
  scopes: IntegrationScope[];
  githubToken?: string;
  jiraCredentials: Record<string, { email: string; apiToken: string }>;
  maxRequestsPerReconcile: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown, field: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((s) => typeof s !== 'string' || s.length > 500)) {
    throw new Error(`Invalid integration configuration: ${field}`);
  }
  return [...new Set(value as string[])];
}

export function jiraOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('Invalid Jira origin');
  return url.origin;
}

function documentOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Invalid document origin');
  }
  return url.origin;
}

/** Parses only explicit scope mappings. No organization-wide discovery or implicit default project. */
export function parseIntegrationConfiguration(env: Record<string, string | undefined>): IntegrationConfiguration {
  let raw: unknown;
  let credentials: unknown;
  try {
    raw = JSON.parse(env.KASSINAO_CONTEXT_SCOPES || '[]');
    credentials = JSON.parse(env.JIRA_CONTEXT_CREDENTIALS || '{}');
  } catch {
    throw new Error('Invalid integration JSON configuration');
  }
  if (!Array.isArray(raw) || raw.length > 100 || !object(credentials))
    throw new Error('Invalid integration scope configuration');
  const scopes = raw.map((value): IntegrationScope => {
    if (!object(value) || typeof value.guildId !== 'string' || !/^\d{1,30}$/.test(value.guildId))
      throw new Error('Invalid integration guild scope');
    if (value.channelId !== undefined && (typeof value.channelId !== 'string' || !/^\d{1,30}$/.test(value.channelId)))
      throw new Error('Invalid integration channel scope');
    const repositories = strings(value.githubRepositories, 'githubRepositories', 100).map((r) => r.toLowerCase());
    if (repositories.some((r) => !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(r)))
      throw new Error('Invalid repository allowlist');
    let jira: IntegrationScope['jira'];
    if (value.jira !== undefined) {
      if (!object(value.jira) || typeof value.jira.site !== 'string') throw new Error('Invalid Jira scope');
      const projects = strings(value.jira.projects, 'jira.projects', 100);
      if (!projects.length || projects.some((p) => !/^[A-Z][A-Z0-9_]{0,39}$/.test(p)))
        throw new Error('Invalid Jira project allowlist');
      jira = { site: jiraOrigin(value.jira.site), projects };
    }
    return {
      guildId: value.guildId,
      channelId: value.channelId as string | undefined,
      githubRepositories: repositories,
      jira,
      documentOrigins: strings(value.documentOrigins, 'documentOrigins', 30).map(documentOrigin),
    };
  });
  const jiraCredentials: IntegrationConfiguration['jiraCredentials'] = {};
  for (const [site, credential] of Object.entries(credentials)) {
    if (
      !object(credential) ||
      typeof credential.email !== 'string' ||
      typeof credential.apiToken !== 'string' ||
      !credential.email ||
      !credential.apiToken ||
      credential.email.includes(':') ||
      /[\r\n]/.test(credential.email + credential.apiToken)
    )
      throw new Error('Invalid Jira credential configuration');
    jiraCredentials[jiraOrigin(site)] = { email: credential.email, apiToken: credential.apiToken };
  }
  const maxRequestsPerReconcile = Number(env.KASSINAO_CONTEXT_MAX_REQUESTS || 20);
  if (!Number.isInteger(maxRequestsPerReconcile) || maxRequestsPerReconcile < 1 || maxRequestsPerReconcile > 100)
    throw new Error('Invalid integration request budget');
  const githubToken = env.GITHUB_CONTEXT_TOKEN?.trim();
  if (githubToken && /[\r\n]/.test(githubToken)) throw new Error('Invalid GitHub credential configuration');
  return { scopes, githubToken, jiraCredentials, maxRequestsPerReconcile };
}
