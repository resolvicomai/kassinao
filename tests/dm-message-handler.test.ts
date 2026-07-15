import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  client: {
    once: vi.fn(),
    on: vi.fn(),
    login: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
    guilds: { cache: new Map() },
  },
}));

vi.mock('../src/discord/client', () => ({ client: runtimeMocks.client }));
vi.mock('../src/web/server', () => ({ startWebServer: vi.fn() }));
vi.mock('../src/cleanup', () => ({ startCleanupJob: vi.fn() }));
vi.mock('../src/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store')>()),
  recoverInterruptedRecordings: vi.fn(() => []),
}));

import { DmMessageLimiter } from '../src/dmMessageLimiter';
import { handleDirectMessage } from '../src/index';
import type { DiscordCapabilities } from '../src/i18n';

const allCapabilities: DiscordCapabilities = {
  transcription: true,
  minutes: true,
  ask: true,
  mcp: true,
};

function directMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: { bot: false, id: 'dm-user' },
    guildId: null,
    content: 'oi',
    channel: {
      partial: false,
      fetch: vi.fn(() => Promise.resolve()),
      isSendable: vi.fn(() => true),
      send: vi.fn(() => Promise.resolve()),
    },
    ...overrides,
  };
}

describe('handler de DM', () => {
  it('ignora excesso antes de ler conteúdo, registrar log ou responder', async () => {
    const contentRead = vi.fn(() => 'não deveria ser lido');
    const message = directMessage();
    Object.defineProperty(message, 'content', { get: contentRead });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const limiter = { admit: vi.fn(() => false) };

    const membership = vi.fn(async () => true);
    await handleDirectMessage(message as never, limiter, membership);

    expect(limiter.admit).toHaveBeenCalledWith('dm-user');
    expect(membership).not.toHaveBeenCalled();
    expect(contentRead).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(message.channel.fetch).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('responde somente às duas primeiras mensagens da pessoa na janela', async () => {
    const message = directMessage();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const limiter = new DmMessageLimiter(
      { maxPerUser: 2, maxGlobal: 60, windowMs: 60_000, maxTrackedUsers: 128 },
      () => 1_000,
    );
    const membership = vi.fn(async () => true);

    await handleDirectMessage(message as never, limiter, membership);
    await handleDirectMessage(message as never, limiter, membership);
    await handleDirectMessage(message as never, limiter, membership);

    expect(message.channel.send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('não lê nem envia o guia privado sem membership em guild autorizada', async () => {
    const contentRead = vi.fn(() => '/gravar');
    const message = directMessage();
    Object.defineProperty(message, 'content', { get: contentRead });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleDirectMessage(message as never, { admit: () => true }, async () => false);

    expect(contentRead).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('não direciona para um /ask que não foi registrado nesta instância', async () => {
    const message = directMessage({ content: '/ask what changed?' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleDirectMessage(message as never, { admit: () => true }, async () => true);

    expect(message.channel.send).toHaveBeenCalledWith(expect.stringContaining('is not enabled on this instance'));
    expect(message.channel.send).not.toHaveBeenCalledWith(expect.stringContaining('/app/conectar-ia'));
    log.mockRestore();
  });

  it('não revela a origem privada numa tentativa de comando por DM', async () => {
    const message = directMessage({ content: '/gravar' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleDirectMessage(message as never, { admit: () => true }, async () => true, allCapabilities);

    expect(message.channel.send).toHaveBeenCalledWith(expect.stringContaining('inside the server'));
    expect(message.channel.send).not.toHaveBeenCalledWith(expect.stringContaining('/app/conectar-ia'));
    expect(JSON.stringify(message.channel.send.mock.calls)).not.toContain('app.kassinao.cloud');
    log.mockRestore();
  });

  it('remove o conector e qualquer URL privada do guia genérico em DM', async () => {
    const message = directMessage();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleDirectMessage(message as never, { admit: () => true }, async () => true, allCapabilities);

    const payload = message.channel.send.mock.calls[0]?.[0];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('/app/conectar-ia');
    expect(serialized).not.toContain('app.kassinao.cloud');
    expect(serialized).not.toContain('Connect an MCP client');
    expect(payload).not.toHaveProperty('components');
    log.mockRestore();
  });
});
