import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  client: {
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
    guilds: { cache: new Map() },
  },
  listGuildMetaIdsInRange: vi.fn(),
  readMeta: vi.fn(),
}));

vi.mock('../src/discord/client', () => ({ client: runtimeMocks.client }));
vi.mock('../src/web/server', () => ({ startWebServer: vi.fn() }));
vi.mock('../src/cleanup', () => ({ startCleanupJob: vi.fn() }));
vi.mock('../src/processing/minutes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/processing/minutes')>()),
  minutesEnabled: vi.fn(() => true),
}));
vi.mock('../src/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store')>()),
  recoverInterruptedRecordings: vi.fn(() => []),
  listGuildMetaIdsInRange: runtimeMocks.listGuildMetaIdsInRange,
  readMeta: runtimeMocks.readMeta,
}));

import { collectAuthorizedAskArchive, handlePerguntar } from '../src/index';
import { t } from '../src/i18n';
import { RecordingMeta } from '../src/store';

const FROM = Date.parse('2026-07-01T00:00:00Z');
const TO = Date.parse('2026-08-01T00:00:00Z');

function meta(id: string, overrides: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    id,
    guildId: 'guild-ask-bound',
    guildName: 'Servidor',
    voiceChannelId: 'voice',
    voiceChannelName: 'Produto',
    startedBy: { id: 'owner', name: 'Mauro' },
    startedAt: Date.parse('2026-07-09T12:00:00Z'),
    endedAt: Date.parse('2026-07-09T13:00:00Z'),
    status: 'done',
    participants: [],
    presence: [],
    events: [],
    notes: [],
    transcription: { status: 'done' },
    minutes: { status: 'done' },
    ...overrides,
  };
}

describe('/perguntar — leitura limitada do arquivo', () => {
  it('não lê nem materializa mais de 500 metas quando a janela é maior', () => {
    const ids = Array.from({ length: 700 }, (_, index) => `2026-07-09-ask-denied-${index}`);
    const listIdsInRange = vi.fn((_guildId: string, _fromMs: number, _toMs: number, limit: number) => ({
      ids: ids.slice(0, limit),
      truncated: ids.length > limit,
    }));
    const readMeta = vi.fn((id: string) => meta(id));

    const result = collectAuthorizedAskArchive('guild-ask-bound', FROM, TO, () => false, {
      listIdsInRange,
      readMeta,
    });

    expect(listIdsInRange).toHaveBeenCalledWith('guild-ask-bound', FROM, TO, 500);
    expect(readMeta).toHaveBeenCalledTimes(500);
    expect(result.authorized.metas).toEqual([]);
    expect(result.scannedIds).toBe(500);
    expect(result.truncated).toBe(true);
  });

  it('limita a 300 reuniões autorizadas sem deixar negadas ocuparem vagas', () => {
    const deniedIds = Array.from({ length: 25 }, (_, index) => `2026-07-09-ask-denied-first-${index}`);
    const allowedIds = Array.from({ length: 400 }, (_, index) => `2026-07-09-ask-allowed-${index}`);
    const ids = [...deniedIds, ...allowedIds];
    const listIdsInRange = vi.fn((_guildId: string, _fromMs: number, _toMs: number, limit: number) => ({
      ids: ids.slice(0, limit),
      truncated: ids.length > limit,
    }));
    const readMeta = vi.fn((id: string) => meta(id));

    const result = collectAuthorizedAskArchive(
      'guild-ask-bound',
      FROM,
      TO,
      (candidate) => candidate.id.includes('-allowed-'),
      { listIdsInRange, readMeta },
    );

    expect(result.authorized.metas).toHaveLength(300);
    expect(result.authorized.metas[0]?.id).toBe('2026-07-09-ask-allowed-0');
    expect(result.authorized.metas.at(-1)?.id).toBe('2026-07-09-ask-allowed-299');
    expect(readMeta).toHaveBeenCalledTimes(325);
    expect(result.scannedIds).toBe(325);
    expect(result.truncated).toBe(true);
  });

  it('falha fechado para meta ausente, guild/período divergente e erro da ACL', () => {
    const ids = ['missing', 'wrong-guild', 'wrong-period', 'not-ready', 'acl-error', 'denied', 'allowed'];
    const metas = new Map<string, RecordingMeta>([
      ['wrong-guild', meta('wrong-guild', { guildId: 'other-guild' })],
      ['wrong-period', meta('wrong-period', { startedAt: TO })],
      ['not-ready', meta('not-ready', { transcription: { status: 'pending' } })],
      ['acl-error', meta('acl-error')],
      ['denied', meta('denied')],
      ['allowed', meta('allowed')],
    ]);

    const result = collectAuthorizedAskArchive(
      'guild-ask-bound',
      FROM,
      TO,
      (candidate) => {
        if (candidate.id === 'acl-error') throw new Error('Discord indisponível');
        return candidate.id === 'allowed';
      },
      {
        listIdsInRange: () => ({ ids, truncated: false }),
        readMeta: (id) => metas.get(id),
      },
    );

    expect(result.authorized.metas.map((candidate) => candidate.id)).toEqual(['allowed']);
    expect(result.scannedIds).toBe(7);
    expect(result.truncated).toBe(false);
  });

  it('avisa em ambos os idiomas que a resposta é parcial e como estreitar a janela', () => {
    expect(t('pt', 'ask.scan-truncated')).toContain('não consegui verificar a janela inteira');
    expect(t('pt', 'ask.scan-truncated')).toContain('reduza `dias`');
    expect(t('en', 'ask.scan-truncated')).toContain('could not check the entire window');
    expect(t('en', 'ask.scan-truncated')).toContain('reduce `days`');
  });

  it('sinaliza o corte na resposta privada mesmo quando nenhuma reunião verificada é acessível', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => `2026-07-09-command-denied-${index}`);
    runtimeMocks.listGuildMetaIdsInRange.mockReturnValue({ ids, truncated: true });
    runtimeMocks.readMeta.mockImplementation((id: string) => meta(id));
    const editReply = vi.fn(() => Promise.resolve());
    const interaction = {
      locale: 'pt-BR',
      guild: { id: 'guild-ask-bound' },
      user: { id: 'reader' },
      member: {
        id: 'reader',
        permissions: { has: vi.fn(() => false) },
      },
      options: {
        getString: vi.fn(() => 'o que decidimos?'),
        getInteger: vi.fn(() => 30),
      },
      deferReply: vi.fn(() => Promise.resolve()),
      editReply,
    };

    await handlePerguntar(interaction as never);

    expect(runtimeMocks.listGuildMetaIdsInRange).toHaveBeenCalledWith(
      'guild-ask-bound',
      expect.any(Number),
      expect.any(Number),
      500,
    );
    expect(runtimeMocks.readMeta).toHaveBeenCalledTimes(500);
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('não consegui verificar a janela inteira'));
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('reduza `dias`'));
  });
});
