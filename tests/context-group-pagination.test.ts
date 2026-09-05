import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createCommitmentService } from '../src/commitments';
import { createIntegrationClient } from '../src/integrations/client';
import { parseIntegrationConfiguration } from '../src/integrations/config';
import { contextPage } from '../src/web/page';

it('mantém relações fora da página navegáveis e reversíveis sem atravessar reuniões ocultas', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassinao-group-page-'));
  const denied = new Set<string>();
  const artifactChecks: string[] = [];
  const service = createCommitmentService({
    stateDir,
    authorize: async (_user, meeting) => !denied.has(meeting),
    authorizeArtifact: async (_user, reference) => {
      artifactChecks.push(reference.url);
      return true;
    },
    integrations: createIntegrationClient(
      parseIntegrationConfiguration({
        KASSINAO_CONTEXT_SCOPES: JSON.stringify([{ guildId: '1', githubRepositories: ['example/product'] }]),
      }),
    ),
  });
  const now = Date.now();
  const meta = { guildId: '1', voiceChannelId: '2', startedAt: now };
  try {
    service.syncMeeting(
      { ...meta, id: 'call-1' },
      Array.from({ length: 101 }, (_, i) => ({ tarefa: `Call 1: ${i}` })),
    );
    service.syncMeeting(
      { ...meta, id: 'call-2', startedAt: now - 86400000 },
      Array.from({ length: 104 }, (_, i) => ({ tarefa: `Call 2: ${i}` })),
    );
    const all = await service.listForUser('123');
    const left = all[50],
      right = all[150];
    const [hidden] = service.syncMeeting({ ...meta, id: 'hidden' }, [{ tarefa: 'Fala sem acesso' }]);
    const [beyond] = service.syncMeeting({ ...meta, id: 'beyond' }, [{ tarefa: 'Não conectar por reunião oculta' }]);
    await service.mergeForUser('123', left.id, right.id);
    await service.mergeForUser('123', right.id, hidden.id);
    await service.mergeForUser('123', hidden.id, beyond.id);
    denied.add('hidden');

    const page = (await service.listForUser('123', { offset: 0, limit: 101, includeRelatedMentions: true })).slice(
      0,
      100,
    );
    const entry = page.find((item) => item.id === left.id)!;
    expect(page.some((item) => item.id === right.id)).toBe(false);
    expect(entry.relatedMentions?.map((item) => item.id)).toEqual([right.id]);
    const html = contextPage({
      user: { id: '123', name: 'Pessoa', avatar: null, scope: 'full', exp: now + 60000 },
      lang: 'pt',
      entries: page,
      configured: false,
      page: 1,
      nextPage: 2,
    });
    expect(html).toContain(`href="/app/contexto?group=${left.id}"`);
    expect(html).toContain(`href="/app/contexto?commitment=${right.id}"`);
    expect(html).toContain(`action="/app/contexto/${left.id}/separar"`);
    expect(html).toContain(`name="other" value="${right.id}"`);
    expect(html).not.toContain(hidden.id);

    const group = await service.listForUser('123', { groupOf: left.id, includeRelatedMentions: true, limit: 101 });
    expect(new Set(group.map((item) => item.id))).toEqual(new Set([left.id, right.id]));
    expect(new Set(group.map((item) => item.groupId)).size).toBe(1);
    expect(JSON.stringify(group)).not.toContain(hidden.id);
    expect(JSON.stringify(group)).not.toContain(beyond.id);
    expect(await service.listForUser('123', { groupOf: hidden.id, includeRelatedMentions: true })).toEqual([]);
    await service.setLinks('123', left.id, ['https://github.com/example/product/issues/1']);
    await service.setLinks('123', right.id, ['https://github.com/example/product/issues/2']);
    artifactChecks.length = 0;
    const individual = await service.listForUser('123', { commitmentId: right.id, includeRelatedMentions: true });
    expect(individual.map((item) => item.id)).toEqual([right.id]);
    expect(individual[0].relatedMentions?.map((item) => item.id)).toEqual([left.id]);
    expect(new Set(artifactChecks)).toEqual(new Set(['https://github.com/example/product/issues/2']));
    await service.unlinkForUser('123', left.id, right.id);
    expect((await service.listForUser('123', { groupOf: left.id })).map((item) => item.id)).toEqual([left.id]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
