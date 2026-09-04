import { describe, expect, it } from 'vitest';
import { normalizeMinutes, verifiedMinutesSource } from '../src/processing/minutes';
import { parseContextReaderGrants, readerCanAccessArtifact } from '../src/context';
import { contextPage } from '../src/web/page';
import type { CommitmentView } from '../src/commitments';

it('só publica a fonte quando trecho e limites conferem com uma fala original', () => {
  const segments = [{ startMs: 1200, endMs: 5400, speaker: 'Ana', text: 'Vou revisar a proposta amanhã.' }];
  const source = { startMs: 1200, endMs: 5400, quote: 'revisar a proposta amanhã' };
  expect(verifiedMinutesSource(source, segments)).toEqual(source);
  expect(verifiedMinutesSource({ ...source, startMs: 1000 }, segments)).toBeUndefined();
  expect(verifiedMinutesSource({ ...source, quote: 'Já publiquei em produção' }, segments)).toBeUndefined();
  const raw = JSON.stringify({
    resumo: 'Proposta',
    decisoes: ['', 'Revisar'],
    decisionSources: [null, source],
    acoes: [{ tarefa: 'Revisar', source }],
  });
  const checked = normalizeMinutes(raw, segments);
  expect(checked.decisionSources).toEqual([source]);
  expect(checked.acoes[0].source).toEqual(source);
  expect(normalizeMinutes(raw).acoes[0].source).toBeUndefined();
});

describe('permissão externa explícita do destinatário', () => {
  const grants = parseContextReaderGrants(
    JSON.stringify([
      {
        userId: '123',
        expiresAt: '2026-10-01T00:00:00Z',
        githubRepositories: ['example/work'],
        jiraProjects: [{ site: 'https://example.atlassian.net', projects: ['WORK'] }],
      },
    ]),
  );
  const now = Date.parse('2026-09-01T00:00:00Z');
  it('não herda acesso da conta técnica e respeita identidade, projeto, origem, tipo e validade', () => {
    const ref = {
      kind: 'github-pull' as const,
      url: 'https://github.com/example/work/pull/1',
      origin: 'https://github.com',
      repository: 'example/work',
      number: 1,
    };
    expect(readerCanAccessArtifact(grants, '123', ref, now)).toBe(true);
    expect(readerCanAccessArtifact(grants, '124', ref, now)).toBe(false);
    expect(readerCanAccessArtifact(grants, '123', { ...ref, origin: 'https://other.example' }, now)).toBe(false);
    expect(readerCanAccessArtifact(grants, '123', { ...ref, kind: 'document' }, now)).toBe(false);
    expect(readerCanAccessArtifact(grants, '123', ref, Date.parse('2026-10-01T00:00:00Z'))).toBe(false);
    expect(
      readerCanAccessArtifact(
        grants,
        '123',
        { kind: 'jira-issue', url: '', origin: 'https://other.atlassian.net', issueKey: 'WORK-1' },
        now,
      ),
    ).toBe(false);
    expect(() => parseContextReaderGrants('{"token":"do-not-print"}')).toThrow('Invalid context reader grants');
  });
});

it('apresenta os combinados com origem, estado explícito e formulários sem interpolar HTML externo', () => {
  const entry: CommitmentView = {
    id: 'a'.repeat(32),
    meetingId: 'test-meeting',
    guildId: '1',
    channelId: '2',
    meetingStartedAt: Date.parse('2026-09-01T12:00:00Z'),
    task: '<script>alert(1)</script>',
    assignee: 'Ana',
    sourcePresent: true,
    status: 'mentioned',
    createdAt: 1,
    updatedAt: 1,
    links: [],
    preference: { mode: 'mute' },
    deadlineState: 'unknown',
  };
  const html = contextPage({
    user: { id: '123', name: 'Teste', avatar: null, scope: 'full', exp: Date.now() + 100000 },
    lang: 'pt',
    entries: [entry],
    configured: false,
  });
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('Origem ainda não confirmada');
  expect(html).toContain('Receber avisos por DM');
  expect(html).toContain('value="mentioned" selected');
  expect(html).toContain('Jira e GitHub ainda não foram configurados');
});

it('só mostra eventos futuros com canal visível, sem inventar agenda a partir da presença', async () => {
  const { client } = await import('../src/discord/client');
  const { upcomingContextEvents } = await import('../src/context');
  let visible = true;
  const guildId = '987';
  client.guilds.cache.set(guildId, {
    id: guildId,
    members: { fetch: async () => ({}) },
    channels: {
      cache: new Map([['876', { id: '876', name: 'Canal fictício', permissionsFor: () => ({ has: () => visible }) }]]),
    },
    scheduledEvents: {
      fetch: async () =>
        new Map([
          [
            'event',
            {
              id: 'event',
              name: 'Evento fictício',
              channelId: '876',
              status: 1,
              scheduledStartTimestamp: Date.now() + 60000,
            },
          ],
        ]),
    },
  } as never);
  try {
    expect((await upcomingContextEvents('123')).events).toHaveLength(1);
    visible = false;
    expect((await upcomingContextEvents('123')).events).toHaveLength(0);
    visible = true;
    expect((await upcomingContextEvents('123', new Set(['other']))).events).toHaveLength(0);
  } finally {
    client.guilds.cache.delete(guildId);
  }
});
