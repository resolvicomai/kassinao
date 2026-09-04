import { expect, it, vi } from 'vitest';
import { contextRuntime, withContextAccess } from '../src/context';
import { deleteRecording, saveMeta, type RecordingMeta } from '../src/store';

vi.mock('../src/web/access', async (load) => ({
  ...(await load<typeof import('../src/web/access')>()),
  checkAccess: vi.fn(async () => ({ view: true, delete: false, release: false })),
}));

it('a leitura real do runtime exige grant, escopo atual e acesso pessoal renovado na próxima operação', async () => {
  const keys = [
    'KASSINAO_CONTEXT_SCOPES',
    'KASSINAO_CONTEXT_READERS',
    'KASSINAO_CONTEXT_USER_CREDENTIALS',
    'GITHUB_CONTEXT_TOKEN',
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  const meta: RecordingMeta = {
    id: 'recipient-runtime',
    guildId: '1',
    guildName: 'Synthetic',
    voiceChannelId: '2',
    voiceChannelName: 'Synthetic',
    startedBy: null,
    startedAt: Date.now(),
    status: 'done',
    participants: [],
    notes: [],
    events: [],
  };
  process.env.KASSINAO_CONTEXT_SCOPES = JSON.stringify([
    { guildId: '1', channelId: '2', githubRepositories: ['example/app'] },
  ]);
  process.env.KASSINAO_CONTEXT_READERS = JSON.stringify([
    { userId: '123', expiresAt: new Date(Date.now() + 86400000).toISOString(), githubRepositories: ['example/app'] },
  ]);
  process.env.KASSINAO_CONTEXT_USER_CREDENTIALS = JSON.stringify({
    '123': { githubToken: 'personal-fixture' },
    '456': { githubToken: 'no-grant-fixture' },
  });
  process.env.GITHUB_CONTEXT_TOKEN = 'technical-fixture';
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ number: 12, state: 'open', title: 'Synthetic source' }));
  vi.stubGlobal('fetch', request);
  try {
    saveMeta(meta);
    const runtime = contextRuntime();
    runtime.service.syncMeeting(meta, [{ tarefa: 'Synthetic task' }]);
    const [entry] = await withContextAccess(() => runtime.service.listForUser('123'));
    await withContextAccess(() =>
      runtime.service.setLinks('123', entry.id, ['https://github.com/example/app/pull/12']),
    );
    request.mockClear();
    await withContextAccess(async () => {
      expect((await runtime.service.listForUser('123'))[0].links).toHaveLength(1);
      expect((await runtime.service.listForUser('123'))[0].links).toHaveLength(1);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer personal-fixture');
    request.mockResolvedValueOnce(new Response('', { status: 403 }));
    expect((await withContextAccess(() => runtime.service.listForUser('123')))[0].links).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect((await withContextAccess(() => runtime.service.listForUser('456')))[0].links).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(2);
    runtime.configuration.scopes[0].channelId = '3';
    expect((await withContextAccess(() => runtime.service.listForUser('123')))[0].links).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(runtime.recipientCredentialsStatus('123')).toEqual({ github: true, jira: false });
  } finally {
    deleteRecording(meta.id);
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  }
});
