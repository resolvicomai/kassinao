import { expect, it } from 'vitest';
import type { CommitmentView } from '../src/commitments';
import { contextPage } from '../src/web/page';

it('preserva as fontes, avisos e controles de cada menção dentro de um único cartão', () => {
  const now = Date.now();
  const recent: CommitmentView = {
    id: 'a'.repeat(32),
    groupId: 'group',
    meetingId: 'recent-meeting',
    guildId: '1',
    channelId: '2',
    meetingStartedAt: now,
    task: 'Entregar o parser',
    sourcePresent: true,
    status: 'mentioned',
    createdAt: now,
    updatedAt: now,
    links: [],
    preference: { mode: 'mute' },
    deadlineState: 'unknown',
    sourceAccessIncomplete: true,
    directRelatedIds: ['b'.repeat(32)],
  };
  const url = 'https://github.com/example/product/pull/42';
  const older: CommitmentView = {
    ...recent,
    id: 'b'.repeat(32),
    meetingId: 'older-meeting',
    meetingStartedAt: now - 86400000,
    status: 'confirmed',
    sourceAccessIncomplete: false,
    source: { startMs: 1000, endMs: 3000, quote: 'A entrega depende do PR 42.' },
    links: [
      {
        reference: {
          kind: 'github-pull',
          url,
          origin: 'https://github.com',
          repository: 'example/product',
          number: 42,
        },
        addedAt: now - 86400000,
        snapshot: { state: 'merged', label: 'PR integrado', checkedAt: now, deployed: null },
      },
    ],
    completionRule: { kind: 'artifact', url, state: 'merged' },
    effectiveCompletion: { url, state: 'merged', checkedAt: now },
    deadlineState: 'settled',
    preference: { mode: 'follow', snoozedUntil: now + 86400000 },
    lastNotice: { reason: 'PR 42: aberto → integrado.', at: now },
    history: [{ kind: 'status', actorId: '123', at: now, before: 'mentioned', after: 'confirmed' }],
    directRelatedIds: [recent.id],
  };
  const html = contextPage({
    user: { id: '123', name: 'Pessoa sintética', avatar: null, scope: 'full', exp: now + 60000 },
    lang: 'pt',
    entries: [recent, older],
    configured: true,
    page: 2,
    nextPage: 3,
    channelId: '2',
  });
  expect(html.match(/<article class="context-card">/g)).toHaveLength(1);
  expect(html).toContain('<strong>1</strong> em aberto');
  const mention = (id: string) => html.split(`<section id="c-${id}">`)[1]?.split('</section>')[0] ?? '';
  const first = mention(recent.id);
  const second = mention(older.id);
  expect(first).toContain('value="mentioned" selected');
  expect(first).toContain('Receber avisos por DM');
  expect(first).not.toContain(url);
  expect(first).not.toContain('Última mudança avisada');
  expect(first).toContain('Consulta incompleta: algumas fontes');
  expect(first).not.toContain('Nenhuma fonte visível vinculada');
  expect(first.indexOf('Consulta incompleta: algumas fontes')).toBeLessThan(first.indexOf('<details>'));
  expect(first).toContain(`href="/app/contexto?commitment=${recent.id}"`);
  expect(first).toContain('(consulta incompleta)</summary>');
  expect(second).toContain(older.source!.quote);
  expect(second).toContain(`href="/app/rec/${older.meetingId}#t=1"`);
  expect(second).toContain(`href="${url}"`);
  expect(second).toContain(older.lastNotice!.reason);
  expect(second).toContain('Histórico de alterações');
  expect(second).toContain('value="confirmed" selected');
  expect(second).toContain(`value="merged|${url}" selected`);
  expect(second).toContain('Critério de conclusão confirmado na fonte');
  expect(second).toContain('Parar avisos por DM');
  expect(second).toContain('Pausado até');
  expect(second).not.toContain('Consulta incompleta');
  expect(html).toContain('href="/app/contexto?page=1&amp;channel=2" rel="prev"');
  expect(html).toContain('href="/app/contexto?page=3&amp;channel=2" rel="next"');
  expect(html).toContain('Contagens e grupos refletem as menções desta página');
  for (const [entry, other, section] of [
    [recent, older, first],
    [older, recent, second],
  ] as const) {
    expect(section).toContain(`action="/app/contexto/${entry.id}/avisos"`);
    expect(section).toContain(`action="/app/contexto/${entry.id}/estado"`);
    expect(section).toContain(`type="checkbox" name="related" value="${other.id}"`);
    expect(section).not.toContain(`type="checkbox" name="related" value="${entry.id}"`);
    expect(section).toContain(`action="/app/contexto/${entry.id}/separar"`);
    expect(section).toContain(`name="other" value="${other.id}"`);
    expect(section).toContain('name="page" value="2"');
    expect(section).toContain('name="channel" value="2"');
    expect(html.match(new RegExp(`id="c-${entry.id}"`, 'g'))).toHaveLength(1);
  }
});
