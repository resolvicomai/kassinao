import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecipientArtifactAccess,
  parseContextUserCredentials,
  RecipientAuthorizationUnavailableError,
  withRecipientArtifactAccess,
} from '../src/integrations/access';
import { parseIntegrationConfiguration } from '../src/integrations/config';
import { resolveArtifact } from '../src/integrations/client';

const context = { guildId: '1', channelId: '2' };
const configuration = () =>
  parseIntegrationConfiguration({
    KASSINAO_CONTEXT_SCOPES: JSON.stringify([
      {
        ...context,
        githubRepositories: ['example/app'],
        jira: { site: 'https://example.atlassian.net', projects: ['APP'] },
        documentOrigins: ['https://docs.example.com'],
      },
    ]),
    GITHUB_CONTEXT_TOKEN: 'technical-github-never-use',
    JIRA_CONTEXT_CREDENTIALS: JSON.stringify({
      'https://example.atlassian.net': { email: 'technical@example.com', apiToken: 'technical-jira-never-use' },
    }),
  });
const credentials = () =>
  parseContextUserCredentials(
    JSON.stringify({
      '123': {
        githubToken: 'recipient-github',
        jira: { 'https://example.atlassian.net': { email: 'recipient@example.com', apiToken: 'recipient-jira' } },
      },
      '456': { githubToken: 'another-recipient' },
    }),
  );
const github = resolveArtifact('https://github.com/example/app/pull/12', context, configuration().scopes);
const jira = resolveArtifact('APP-12', context, configuration().scopes);
const githubResponse = () => Response.json({ number: 12, state: 'open', title: 'Synthetic source' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('credenciais privadas do destinatário', () => {
  it('aceita somente mapeamentos explícitos por pessoa e tenant Jira', () => {
    expect(parseContextUserCredentials()).toEqual({});
    const access = createRecipientArtifactAccess(configuration(), credentials());
    expect(access.recipientCredentialsStatus('123')).toEqual({ github: true, jira: true });
    expect(access.recipientCredentialsStatus('456')).toEqual({ github: true, jira: false });
    expect(access.recipientCredentialsStatus('789')).toEqual({ github: false, jira: false });
    expect(JSON.stringify(access.recipientCredentialsStatus('123'))).not.toContain('recipient');
  });
  it.each([
    '{"123":{"githubToken":"secret-never-log"}',
    JSON.stringify({ '123': { githubToken: 'secret\nnever-log' } }),
    JSON.stringify({ '123': { githubToken: 'secret', unexpected: true } }),
    JSON.stringify({
      '123': { jira: { 'https://secret:token@example.atlassian.net': { email: 'a@b', apiToken: 'secret' } } },
    }),
    JSON.stringify({ '123': { jira: { 'https://outside.example.com': { email: 'a@b', apiToken: 'secret' } } } }),
    JSON.stringify({ __proto__: { githubToken: 'secret' }, invalid: {} }),
    '[]',
  ])('recusa configuração inválida sem carregar seu conteúdo no erro (%#)', (raw) => {
    try {
      parseContextUserCredentials(raw);
      expect.fail('Expected invalid credentials');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invalid context recipient credentials');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('acesso externo pelo destinatário', () => {
  it('não herda o token técnico quando o usuário não tem credencial própria', async () => {
    const request = vi.fn<typeof fetch>();
    const access = createRecipientArtifactAccess(configuration(), {}, { fetch: request });
    expect(await access.canRead('123', github, context)).toBe(false);
    expect(await access.canRead('123', jira, context)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('consulta a referência GitHub exata com o token pessoal e bloqueia redirects', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => githubResponse());
    const access = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request });
    expect(await access.canRead('123', github, context)).toBe(true);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/example/app/pulls/12');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer recipient-github');
    expect(JSON.stringify(init)).not.toContain('technical');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('consulta a issue Jira com Basic pessoal vinculado ao tenant', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        key: 'APP-12',
        fields: { summary: 'Synthetic source', status: { statusCategory: { key: 'new' }, name: 'Open' } },
      }),
    );
    const access = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request });
    expect(await access.canRead('123', jira, context)).toBe(true);
    expect(request.mock.calls[0][0]).toBe(
      'https://example.atlassian.net/rest/api/3/issue/APP-12?fields=summary,status,updated',
    );
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('recipient@example.com:recipient-jira').toString('base64')}`,
    );
    expect(await access.canRead('456', jira, context)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('revalida o mapeamento técnico por canal e a identidade da referência antes de GET', async () => {
    const request = vi.fn<typeof fetch>();
    const access = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request });
    expect(await access.canRead('123', github, { ...context, channelId: '3' })).toBe(false);
    expect(await access.canRead('123', { ...github, url: 'https://github.com/example/other/pull/12' }, context)).toBe(
      false,
    );
    expect(await access.canRead('123', { ...github, number: 99 }, context)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])('nega resposta %s sem substituir pela conta técnica', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret provider details', { status }));
    expect(
      await createRecipientArtifactAccess(configuration(), credentials(), { fetch: request }).canRead(
        '123',
        github,
        context,
      ),
    ).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([302, 429, 500])('sinaliza indisponibilidade em %s sem devolver detalhes externos', async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret provider details', { status }));
    const promise = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request }).canRead(
      '123',
      github,
      context,
    );
    await expect(promise).rejects.toBeInstanceOf(RecipientAuthorizationUnavailableError);
    await expect(promise).rejects.toThrow('Recipient source access temporarily unavailable');
  });
  it('deduplica somente dentro da operação; revogação vale na operação seguinte', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => githubResponse());
    const access = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request });
    expect(
      await withRecipientArtifactAccess(() =>
        Promise.all([access.canRead('123', github, context), access.canRead('123', github, context)]),
      ),
    ).toEqual([true, true]);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce(new Response('', { status: 403 }));
    expect(await withRecipientArtifactAccess(() => access.canRead('123', github, context))).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await withRecipientArtifactAccess(() => access.canRead('456', github, context))).toBe(true);
    expect((request.mock.calls[2][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer another-recipient',
    );
  });
  it('limita também transporte que ignora abort e consumo do corpo', async () => {
    const hangingFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    await expect(
      createRecipientArtifactAccess(configuration(), credentials(), { fetch: hangingFetch, timeoutMs: 20 }).canRead(
        '123',
        github,
        context,
      ),
    ).rejects.toBeInstanceOf(RecipientAuthorizationUnavailableError);
    const hangingBody = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    await expect(
      createRecipientArtifactAccess(configuration(), credentials(), { fetch: hangingBody, timeoutMs: 20 }).canRead(
        '123',
        github,
        context,
      ),
    ).rejects.toBeInstanceOf(RecipientAuthorizationUnavailableError);
    const large = vi.fn<typeof fetch>().mockImplementation(async () => githubResponse());
    await expect(
      createRecipientArtifactAccess(configuration(), credentials(), { fetch: large, maxBodyBytes: 10 }).canRead(
        '123',
        github,
        context,
      ),
    ).rejects.toBeInstanceOf(RecipientAuthorizationUnavailableError);
  });
  it('não usa cache ou GET para documentos manuais, e exige escopo técnico mesmo assim', async () => {
    const request = vi.fn<typeof fetch>();
    const access = createRecipientArtifactAccess(configuration(), {}, { fetch: request });
    const document = resolveArtifact('https://docs.example.com/manual', context, configuration().scopes);
    expect(await access.canRead('123', document, context)).toBe(true);
    expect(await access.canRead('123', document, { ...context, channelId: '3' })).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('limita a 100 referências novas na operação sem negar silenciosamente as demais', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        Response.json({ number: Number(String(url).split('/').at(-1)), state: 'open' }),
      );
    const access = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request });
    await withRecipientArtifactAccess(async () => {
      for (let number = 1; number <= 100; number++) {
        const reference = { ...github, number, url: `https://github.com/example/app/pull/${number}` };
        expect(await access.canRead('123', reference, context)).toBe(true);
      }
      const extra = { ...github, number: 101, url: 'https://github.com/example/app/pull/101' };
      await expect(access.canRead('123', extra, context)).rejects.toBeInstanceOf(
        RecipientAuthorizationUnavailableError,
      );
    });
    expect(request).toHaveBeenCalledTimes(100);
  });

  it('não inicia outra consulta depois do orçamento total de dez segundos', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => githubResponse());
    const access = createRecipientArtifactAccess(configuration(), credentials(), { fetch: request });
    await withRecipientArtifactAccess(async () => {
      expect(await access.canRead('123', github, context)).toBe(true);
      now += 10001;
      await expect(
        access.canRead('123', { ...github, number: 13, url: 'https://github.com/example/app/pull/13' }, context),
      ).rejects.toBeInstanceOf(RecipientAuthorizationUnavailableError);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
