export interface IntegrationContext {
  guildId: string;
  channelId: string;
}

export interface IntegrationScope {
  guildId: string;
  channelId?: string;
  githubRepositories: string[];
  jira?: { site: string; projects: string[] };
  /** Links only. Document contents are never fetched by these adapters. */
  documentOrigins: string[];
}

export interface ArtifactReference {
  kind: 'github-issue' | 'github-pull' | 'jira-issue' | 'document';
  url: string;
  origin: string;
  repository?: string;
  issueKey?: string;
  number?: number;
}

export interface ArtifactSnapshot {
  state: 'open' | 'closed' | 'merged' | 'done' | 'unknown' | 'unavailable' | 'unverified';
  label: string;
  checkedAt: number;
  updatedAt?: string;
  title?: string;
  /** A repository merge is never evidence of a production deployment. */
  deployed: null;
  reason?:
    | 'not_found'
    | 'access_denied'
    | 'rate_limited'
    | 'timeout'
    | 'provider_error'
    | 'invalid_response'
    | 'manual_reference';
  retryAt?: number;
}

export interface IntegrationClient {
  resolve(input: string, context: IntegrationContext): ArtifactReference;
  lookup(reference: ArtifactReference, context: IntegrationContext): Promise<ArtifactSnapshot>;
}
