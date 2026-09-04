import { describe, expect, it, vi } from 'vitest';
import { createIntegrationClient, resolveArtifact } from '../src/integrations/client';
import { parseIntegrationConfiguration } from '../src/integrations/config';

const configuration = () =>
  parseIntegrationConfiguration({
    KASSINAO_CONTEXT_SCOPES: JSON.stringify([
      {
        guildId: '1',
        channelId: '2',
        githubRepositories: ['example/app'],
        jira: { site: 'https://example.atlassian.net', projects: ['APP'] },
        documentOrigins: ['https://docs.google.com'],
      },
    ]),
    GITHUB_CONTEXT_TOKEN: 'fixture-github',
    JIRA_CONTEXT_CREDENTIALS: JSON.stringify({
      'https://example.atlassian.net': { email: 'bot@example.test', apiToken: 'fixture-jira' },
    }),
  });
const context = { guildId: '1', channelId: '2' };
const pullUrl = 'https://github.com/example/app/pull/12';
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);

describe('explicit context mappings', () => {
  it('has no implicit org scope and never includes credentials in parse errors', () => {
    expect(parseIntegrationConfiguration({}).scopes).toEqual([]);
    expect(() => parseIntegrationConfiguration({ JIRA_CONTEXT_CREDENTIALS: '{secret-value' })).toThrow(
      'Invalid integration JSON',
    );
    expect(() =>
      parseIntegrationConfiguration({ KASSINAO_CONTEXT_SCOPES: '[{"guildId":"1","githubRepositories":["*"]}]' }),
    ).toThrow();
  });
  it('accepts exact allowlisted references and explicit Jira keys', () => {
    const cfg = configuration();
    expect(resolveArtifact(pullUrl, context, cfg.scopes)).toMatchObject({
      kind: 'github-pull',
      repository: 'example/app',
      number: 12,
    });
    expect(resolveArtifact('APP-8', context, cfg.scopes).url).toBe('https://example.atlassian.net/browse/APP-8');
    expect(resolveArtifact('example/app#12', context, cfg.scopes).kind).toBe('github-issue');
  });
  it.each([
    'http://github.com/example/app/issues/12',
    'https://github.com.evil.test/example/app/issues/12',
    'https://user:secret@github.com/example/app/issues/12',
    'https://github.com:8443/example/app/issues/12',
    'https://github.com/example/private/issues/12',
    'https://other.atlassian.net/browse/APP-1',
    'https://example.atlassian.net/browse/OTHER-1',
    'https://127.0.0.1/',
    'https://example.atlassian.net/rest/api/3/search',
    'https://github.com/example/app/issues/12?next=http://localhost',
    'https://github.com/example/app/issues/%31',
  ])('rejects unapproved input: %s', (url) =>
    expect(() => resolveArtifact(url, context, configuration().scopes)).toThrow(),
  );
  it('refuses use from another guild/channel', () => {
    expect(() => resolveArtifact(pullUrl, { ...context, channelId: '3' }, configuration().scopes)).toThrow();
    expect(() => resolveArtifact(pullUrl, { ...context, guildId: '3' }, configuration().scopes)).toThrow();
  });
});

describe('read-only providers', () => {
  it('fetches a PR by exact URL, records merge, and never claims deployment', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        number: 12,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-04T10:00:00Z',
        title: 'Fix parser',
        updated_at: '2026-09-04T10:00:00Z',
        body: 'irrelevant private body',
      }),
    );
    const client = createIntegrationClient(configuration(), { fetch: request, now: () => 1000 });
    const result = await client.lookup(client.resolve(pullUrl, context), context);
    expect(result).toMatchObject({ state: 'merged', deployed: null, title: 'Fix parser', checkedAt: 1000 });
    expect(result).not.toHaveProperty('body');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/example/app/pulls/12');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture-github');
  });
  it('queries only needed Jira fields with origin-bound credentials', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        key: 'APP-8',
        fields: {
          summary: 'Task',
          updated: '2026-09-04T10:00:00Z',
          status: { name: 'Resolvido', statusCategory: { key: 'done' } },
        },
      }),
    );
    const client = createIntegrationClient(configuration(), { fetch: request });
    expect(await client.lookup(client.resolve('APP-8', context), context)).toMatchObject({
      state: 'done',
      label: 'Resolvido',
      deployed: null,
    });
    expect(request.mock.calls[0][0]).toBe(
      'https://example.atlassian.net/rest/api/3/issue/APP-8?fields=summary,status,updated',
    );
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('bot@example.test:fixture-jira').toString('base64')}`,
    );
  });
  it('does not mistake an issue endpoint representing a PR for a merge', async () => {
    const client = createIntegrationClient(configuration(), {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ number: 12, state: 'closed', pull_request: {}, merged_at: '2026-01-01' })),
    });
    expect((await client.lookup(client.resolve('example/app#12', context), context)).state).toBe('closed');
  });
  it('does not fetch document contents', async () => {
    const request = vi.fn<typeof fetch>();
    const client = createIntegrationClient(configuration(), { fetch: request });
    expect(
      (await client.lookup(client.resolve('https://docs.google.com/document/d/example/edit', context), context)).state,
    ).toBe('unverified');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    [404, 'not_found'],
    [403, 'access_denied'],
    [401, 'access_denied'],
    [500, 'provider_error'],
  ] as const)('HTTP %s stays unavailable', async (status, reason) => {
    const client = createIntegrationClient(configuration(), {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive provider details', { status })),
    });
    const result = await client.lookup(client.resolve(pullUrl, context), context);
    expect(result).toMatchObject({ state: 'unavailable', reason, deployed: null });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it('records provider backoff without retrying inside a request', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    const client = createIntegrationClient(configuration(), { fetch: request, now: () => 1000 });
    expect(await client.lookup(client.resolve(pullUrl, context), context)).toMatchObject({
      reason: 'rate_limited',
      retryAt: 121000,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds bodies even when content-length is missing', async () => {
    const client = createIntegrationClient(configuration(), {
      maxBodyBytes: 20,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ title: 'x'.repeat(100) })),
    });
    expect((await client.lookup(client.resolve(pullUrl, context), context)).reason).toBe('invalid_response');
  });
  it('bounds both stalled headers and stalled response bodies', async () => {
    const clients = [
      createIntegrationClient(configuration(), { timeoutMs: 20, fetch: () => new Promise(() => {}) }),
      createIntegrationClient(configuration(), {
        timeoutMs: 20,
        fetch: async () => new Response(new ReadableStream({ start() {} })),
      }),
    ];
    for (const client of clients)
      expect((await client.lookup(client.resolve(pullUrl, context), context)).reason).toBe('timeout');
  });
  it('revalidates a stored reference before sending any request', async () => {
    const cfg = configuration();
    const request = vi.fn<typeof fetch>();
    const client = createIntegrationClient(cfg, { fetch: request });
    const ref = client.resolve(pullUrl, context);
    cfg.scopes = [];
    await expect(client.lookup(ref, context)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
