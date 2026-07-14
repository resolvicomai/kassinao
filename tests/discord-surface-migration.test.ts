import { describe, expect, it, vi } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import {
  DISCORD_SURFACE_POLICY_VERSION,
  DiscordSurfaceClient,
  DiscordSurfaceInventoryClient,
  mergeDiscordSurfaceMigrationCheckpoint,
  migrateGuildDiscordSurfacesStep,
  migrateDiscordSurfacesStep,
} from '../src/discordSurfaceMigration';
import { createDiscordSurfaceClient } from '../src/discordSurfaceMigrationDiscord';
import { readDiscordSurfaceInventory, RecordingMeta, saveDiscordSurfaceInventory } from '../src/store';

function legacyMeta(): RecordingMeta {
  return {
    id: '2026-01-02-a1b2c3d4e5',
    guildId: 'guild-1',
    guildName: 'Servidor',
    voiceChannelId: 'voice-1',
    voiceChannelName: 'Privado',
    panelChannelId: 'voice-1',
    panelMessageId: 'panel-1',
    startedBy: { id: 'user-1', name: 'Mauro' },
    startedAt: 1_000_000,
    endedAt: 2_000_000,
    status: 'done',
    participants: [],
    presence: [],
    events: [],
    notes: [],
  };
}

const safeContent = 'Gravação encerrada. Detalhes somente na área privada.';

describe('migração das superfícies históricas do Discord', () => {
  it('inventaria canal antigo e neutraliza link de gravação mesmo sem meta local', async () => {
    const message = {
      id: 'ata-expirada',
      channelId: 'canal-configurado-antigo',
      guildId: 'guild-1',
      authorId: 'bot-1',
      createdTimestamp: 1_500_000,
      content: 'Ata antiga: https://old.example/rec/2025-01-02-a1b2c3d4e5',
      embeds: [{ description: 'Resumo privado que não pode continuar no canal.' }],
    };
    const client: DiscordSurfaceInventoryClient = {
      botUserId: 'bot-1',
      listGuildMessageChannelIds: vi.fn(async () => ['canal-configurado-antigo']),
      fetchMessage: vi.fn(async () => ({ kind: 'found', message })),
      fetchHistory: vi.fn(async () => ({
        kind: 'found',
        guildId: 'guild-1',
        messages: [message],
      })),
      editMessage: vi.fn(async () => {}),
    };

    const result = await migrateGuildDiscordSurfacesStep({
      guildId: 'guild-1',
      safeContent,
      client,
      persist: async () => {},
    });

    expect(client.editMessage).toHaveBeenCalledWith('canal-configurado-antigo', 'ata-expirada', {
      content: safeContent,
      embeds: [],
      components: [],
    });
    expect(result.complete).toBe(true);
    expect(result.state.policyVersion).toBe(DISCORD_SURFACE_POLICY_VERSION);
  });

  it('retoma plano global persistido se a edição falhar depois do checkpoint', async () => {
    let persisted: Parameters<typeof migrateGuildDiscordSurfacesStep>[0]['state'];
    const message = {
      id: 'ata-expirada',
      channelId: 'canal-antigo',
      guildId: 'guild-1',
      authorId: 'bot-1',
      createdTimestamp: 1_500_000,
      content: 'https://old.example/rec/2025-01-02-a1b2c3d4e5',
    };
    const editMessage = vi
      .fn<DiscordSurfaceInventoryClient['editMessage']>()
      .mockRejectedValueOnce(new Error('Discord 503'))
      .mockResolvedValueOnce(undefined);
    let firstHistory = true;
    const client: DiscordSurfaceInventoryClient = {
      botUserId: 'bot-1',
      listGuildMessageChannelIds: async () => ['canal-antigo'],
      fetchMessage: async () => ({ kind: 'found', message }),
      fetchHistory: async () => {
        if (firstHistory) {
          firstHistory = false;
          return { kind: 'found', guildId: 'guild-1', messages: [message] };
        }
        return { kind: 'found', guildId: 'guild-1', messages: [] };
      },
      editMessage,
    };
    const persist = async (state: NonNullable<typeof persisted>) => {
      persisted = structuredClone(state);
    };

    await expect(migrateGuildDiscordSurfacesStep({ guildId: 'guild-1', safeContent, client, persist })).rejects.toThrow(
      'Discord 503',
    );
    expect(persisted?.audits).toEqual([expect.objectContaining({ outcome: 'planned' })]);

    const resumed = await migrateGuildDiscordSurfacesStep({
      guildId: 'guild-1',
      state: persisted,
      safeContent,
      client,
      persist,
    });

    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(resumed.state.audits).toEqual([expect.objectContaining({ outcome: 'sanitized' })]);
    expect(resumed.complete).toBe(true);
  });

  it('adapter inventaria todos os canais de mensagem do guild e exclui categorias', async () => {
    const channels = new Map<string, unknown>([
      ['texto-antigo', { id: 'texto-antigo', guildId: 'guild-1', type: ChannelType.GuildText, messages: {} }],
      ['voz-antiga', { id: 'voz-antiga', guildId: 'guild-1', type: ChannelType.GuildVoice, messages: {} }],
      ['forum', { id: 'forum', guildId: 'guild-1', type: ChannelType.GuildForum, messages: {} }],
      ['categoria', { id: 'categoria', guildId: 'guild-1', type: ChannelType.GuildCategory }],
      ['outro-guild', { id: 'outro-guild', guildId: 'guild-2', type: ChannelType.GuildText, messages: {} }],
    ]);
    const guild = { id: 'guild-1', channels: { fetch: vi.fn(async () => channels) } };
    const discordClient = {
      user: { id: 'bot-1' },
      guilds: { cache: new Map([['guild-1', guild]]) },
    } as unknown as Client;

    const adapter = createDiscordSurfaceClient(discordClient);

    await expect(adapter.listGuildMessageChannelIds('guild-1')).resolves.toEqual(['texto-antigo', 'voz-antiga']);
  });

  it('persiste o cursor global fora das metas de gravação', () => {
    saveDiscordSurfaceInventory({
      guilds: {
        'guild-inventario': {
          guildId: 'guild-inventario',
          audits: [],
          discovery: [
            {
              channelId: 'canal-antigo',
              beforeMessageId: 'cursor-100',
              messagesScanned: 100,
              updatedAt: 2_000_000,
            },
          ],
          channelsInventoriedAt: 1_000_000,
          updatedAt: 2_000_000,
        },
      },
    });

    expect(readDiscordSurfaceInventory().guilds['guild-inventario']).toEqual(
      expect.objectContaining({
        guildId: 'guild-inventario',
        discovery: [expect.objectContaining({ beforeMessageId: 'cursor-100', messagesScanned: 100 })],
      }),
    );
  });

  it('não conclui canal como apagado quando o bot perdeu acesso ao servidor', async () => {
    const state = {
      guildId: 'guild-1',
      audits: [],
      discovery: [{ channelId: 'canal-antigo', messagesScanned: 0, updatedAt: 1_000_000 }],
      channelsInventoriedAt: 1_000_000,
      updatedAt: 1_000_000,
    };
    const client: DiscordSurfaceInventoryClient = {
      botUserId: 'bot-1',
      listGuildMessageChannelIds: vi.fn(async () => {
        throw new Error('Missing Access');
      }),
      fetchMessage: async () => ({ kind: 'missing' }),
      fetchHistory: async () => ({ kind: 'missing' }),
      editMessage: async () => {},
    };

    await expect(
      migrateGuildDiscordSurfacesStep({
        guildId: 'guild-1',
        state,
        safeContent,
        client,
        persist: async () => {},
      }),
    ).rejects.toThrow('Missing Access');
  });

  it('rotaciona canais para um histórico enorme não bloquear os demais', async () => {
    const fetchedChannels: string[] = [];
    const fullPage = (channelId: string) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: `${channelId}-${index}`,
        channelId,
        guildId: 'guild-1',
        authorId: 'outra-pessoa',
        createdTimestamp: 2_000_000 - index,
        content: 'mensagem comum',
      }));
    const client: DiscordSurfaceInventoryClient = {
      botUserId: 'bot-1',
      listGuildMessageChannelIds: async () => ['canal-enorme', 'canal-antigo'],
      fetchMessage: async () => ({ kind: 'missing' }),
      fetchHistory: async (channelId) => {
        fetchedChannels.push(channelId);
        return { kind: 'found', guildId: 'guild-1', messages: fullPage(channelId) };
      },
      editMessage: async () => {},
    };

    const first = await migrateGuildDiscordSurfacesStep({
      guildId: 'guild-1',
      safeContent,
      client,
      persist: async () => {},
    });
    await migrateGuildDiscordSurfacesStep({
      guildId: 'guild-1',
      state: first.state,
      safeContent,
      client,
      persist: async () => {},
    });

    expect(fetchedChannels).toEqual(['canal-enorme', 'canal-antigo']);
  });

  it('persiste a rotação antes do fetch para um canal sem acesso não causar starvation', async () => {
    let persisted: Parameters<typeof migrateGuildDiscordSurfacesStep>[0]['state'];
    const fetchedChannels: string[] = [];
    const client: DiscordSurfaceInventoryClient = {
      botUserId: 'bot-1',
      listGuildMessageChannelIds: async () => ['sem-acesso', 'canal-antigo'],
      fetchMessage: async () => ({ kind: 'missing' }),
      fetchHistory: async (channelId) => {
        fetchedChannels.push(channelId);
        if (channelId === 'sem-acesso') throw new Error('Missing Access');
        return { kind: 'found', guildId: 'guild-1', messages: [] };
      },
      editMessage: async () => {},
    };
    const persist = async (state: NonNullable<typeof persisted>) => {
      persisted = structuredClone(state);
    };

    await expect(migrateGuildDiscordSurfacesStep({ guildId: 'guild-1', safeContent, client, persist })).rejects.toThrow(
      'Missing Access',
    );
    expect(persisted).toBeDefined();

    await migrateGuildDiscordSurfacesStep({
      guildId: 'guild-1',
      state: persisted,
      safeContent,
      client,
      persist,
    });

    expect(fetchedChannels).toEqual(['sem-acesso', 'canal-antigo']);
  });

  it('mescla somente o checkpoint e preserva atualizações concorrentes da gravação', () => {
    const latest = legacyMeta();
    latest.transcription = { status: 'done', finishedAt: 9_000_000 };
    const staleMigration = legacyMeta();
    staleMigration.discordSurfaceMigration = {
      audits: [],
      discovery: [],
      updatedAt: 8_000_000,
    };
    staleMigration.discordSurfacePolicyVersion = DISCORD_SURFACE_POLICY_VERSION;

    const merged = mergeDiscordSurfaceMigrationCheckpoint(latest, staleMigration);

    expect(merged.transcription).toEqual(latest.transcription);
    expect(merged.discordSurfaceMigration).toEqual(staleMigration.discordSurfaceMigration);
    expect(merged.discordSurfacePolicyVersion).toBe(DISCORD_SURFACE_POLICY_VERSION);
    expect(merged).not.toBe(latest);
  });

  it('neutraliza painel persistido do próprio bot e grava plano antes da edição', async () => {
    const events: string[] = [];
    const snapshots: RecordingMeta[] = [];
    const client: DiscordSurfaceClient = {
      botUserId: 'bot-1',
      fetchMessage: vi.fn(async () => ({
        kind: 'found',
        message: {
          id: 'panel-1',
          channelId: 'voice-1',
          guildId: 'guild-1',
          authorId: 'bot-1',
          createdTimestamp: 1_000_100,
          content: 'link antigo',
          embeds: [{ url: 'https://old.example/rec/2026-01-02-a1b2c3d4e5' }],
          components: [{ customId: 'stop:recording-id' }],
        },
      })),
      fetchHistory: vi.fn(async () => ({ kind: 'found', guildId: 'guild-1', messages: [] })),
      editMessage: vi.fn(async (_channelId, _messageId, payload) => {
        events.push(`edit:${payload.content}`);
      }),
    };

    const result = await migrateDiscordSurfacesStep({
      meta: legacyMeta(),
      knownChannelIds: [],
      safeContent,
      client,
      now: () => 3_000_000,
      persist: async (meta) => {
        snapshots.push(structuredClone(meta));
        events.push(`persist:${meta.discordSurfaceMigration?.audits.at(-1)?.outcome ?? 'none'}`);
      },
    });

    expect(events).toEqual(['persist:planned', `edit:${safeContent}`, 'persist:sanitized', 'persist:sanitized']);
    expect(client.editMessage).toHaveBeenCalledWith('voice-1', 'panel-1', {
      content: safeContent,
      embeds: [],
      components: [],
    });
    expect(snapshots[0].discordSurfaceMigration?.audits[0].outcome).toBe('planned');
    expect(result.meta.discordSurfaceMigration?.audits[0].outcome).toBe('sanitized');
    expect(result.meta.discordSurfacePolicyVersion).toBe(DISCORD_SURFACE_POLICY_VERSION);
    expect(result.complete).toBe(true);
  });

  it('nunca edita mensagem que não pertence ao bot atual', async () => {
    const client: DiscordSurfaceClient = {
      botUserId: 'bot-1',
      fetchMessage: async () => ({
        kind: 'found',
        message: {
          id: 'panel-1',
          channelId: 'voice-1',
          guildId: 'guild-1',
          authorId: 'outro-bot',
          createdTimestamp: 1_000_100,
          content: 'não mexer',
        },
      }),
      fetchHistory: async () => ({ kind: 'found', guildId: 'guild-1', messages: [] }),
      editMessage: vi.fn(async () => {}),
    };

    const result = await migrateDiscordSurfacesStep({
      meta: legacyMeta(),
      knownChannelIds: [],
      safeContent,
      client,
      persist: async () => {},
    });

    expect(client.editMessage).not.toHaveBeenCalled();
    expect(result.meta.discordSurfaceMigration?.audits[0].outcome).toBe('not-owned');
  });

  it('retoma um plano persistido quando a edição externa falha no meio', async () => {
    let persisted = legacyMeta();
    const message = {
      id: 'panel-1',
      channelId: 'voice-1',
      guildId: 'guild-1',
      authorId: 'bot-1',
      createdTimestamp: 1_000_100,
      content: 'https://old.example/rec/2026-01-02-a1b2c3d4e5',
    };
    const editMessage = vi
      .fn<DiscordSurfaceClient['editMessage']>()
      .mockRejectedValueOnce(new Error('Discord 503'))
      .mockResolvedValueOnce(undefined);
    const client: DiscordSurfaceClient = {
      botUserId: 'bot-1',
      fetchMessage: async () => ({ kind: 'found', message }),
      fetchHistory: async () => ({ kind: 'found', guildId: 'guild-1', messages: [] }),
      editMessage,
    };
    const persist = async (meta: RecordingMeta) => {
      persisted = structuredClone(meta);
    };

    await expect(
      migrateDiscordSurfacesStep({ meta: persisted, knownChannelIds: [], safeContent, client, persist }),
    ).rejects.toThrow('Discord 503');
    expect(persisted.discordSurfaceMigration?.audits).toEqual([
      expect.objectContaining({ messageId: 'panel-1', outcome: 'planned' }),
    ]);

    const resumed = await migrateDiscordSurfacesStep({
      meta: persisted,
      knownChannelIds: [],
      safeContent,
      client,
      persist,
    });
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(resumed.meta.discordSurfaceMigration?.audits).toHaveLength(1);
    expect(resumed.meta.discordSurfaceMigration?.audits[0].outcome).toBe('sanitized');
    expect(resumed.complete).toBe(true);
  });

  it('não sobrescreve mensagem alterada depois de persistir o plano', async () => {
    let persisted = legacyMeta();
    const message = {
      id: 'panel-1',
      channelId: 'voice-1',
      guildId: 'guild-1',
      authorId: 'bot-1',
      createdTimestamp: 1_000_100,
      content: 'https://old.example/rec/2026-01-02-a1b2c3d4e5',
    };
    const editMessage = vi.fn<DiscordSurfaceClient['editMessage']>().mockRejectedValueOnce(new Error('Discord 503'));
    const client: DiscordSurfaceClient = {
      botUserId: 'bot-1',
      fetchMessage: async () => ({ kind: 'found', message }),
      fetchHistory: async () => ({ kind: 'found', guildId: 'guild-1', messages: [] }),
      editMessage,
    };
    const persist = async (meta: RecordingMeta) => {
      persisted = structuredClone(meta);
    };

    await expect(
      migrateDiscordSurfacesStep({ meta: persisted, knownChannelIds: [], safeContent, client, persist }),
    ).rejects.toThrow('Discord 503');
    message.content = 'Mensagem nova do bot, sem link de gravação.';

    const resumed = await migrateDiscordSurfacesStep({
      meta: persisted,
      knownChannelIds: [],
      safeContent,
      client,
      persist,
    });

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(resumed.meta.discordSurfaceMigration?.audits[0].outcome).toBe('sanitized');
  });

  it('descobre URL histórica exata, mas ignora mensagem alheia e conteúdo não relacionado', async () => {
    const meta = legacyMeta();
    delete meta.panelChannelId;
    delete meta.panelMessageId;
    const relevant = {
      id: 'relevant',
      channelId: 'voice-1',
      guildId: 'guild-1',
      authorId: 'bot-1',
      createdTimestamp: 1_500_000,
      content: 'https://old.example/rec/2026-01-02-a1b2c3d4e5',
    };
    const client: DiscordSurfaceClient = {
      botUserId: 'bot-1',
      fetchMessage: vi.fn(async (_channelId, messageId) =>
        messageId === relevant.id ? { kind: 'found', message: relevant } : { kind: 'missing' },
      ),
      fetchHistory: vi.fn(async () => ({
        kind: 'found',
        guildId: 'guild-1',
        messages: [
          relevant,
          {
            id: 'prefix-only',
            channelId: 'voice-1',
            guildId: 'guild-1',
            authorId: 'bot-1',
            createdTimestamp: 1_400_000,
            content: 'https://old.example/rec/2026-01-02-a1b2c3d4e5-extra',
          },
          {
            id: 'user-message',
            channelId: 'voice-1',
            guildId: 'guild-1',
            authorId: 'user-1',
            createdTimestamp: 1_300_000,
            content: 'https://old.example/app/rec/2026-01-02-a1b2c3d4e5',
          },
        ],
      })),
      editMessage: vi.fn(async () => {}),
    };

    const result = await migrateDiscordSurfacesStep({
      meta,
      knownChannelIds: ['voice-1'],
      safeContent,
      client,
      persist: async () => {},
    });

    expect(client.editMessage).toHaveBeenCalledTimes(1);
    expect(client.editMessage).toHaveBeenCalledWith('voice-1', 'relevant', expect.any(Object));
    expect(result.meta.discordSurfaceMigration?.audits).toEqual([
      expect.objectContaining({ messageId: 'relevant', source: 'discovered-url', outcome: 'sanitized' }),
    ]);
    expect(result.complete).toBe(true);
  });

  it('persiste cursor de paginação e retoma sem voltar ao início', async () => {
    const meta = legacyMeta();
    delete meta.panelChannelId;
    delete meta.panelMessageId;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`,
      channelId: 'voice-1',
      guildId: 'guild-1',
      authorId: 'bot-1',
      createdTimestamp: 2_000_000 - index,
      content: 'genérico',
    }));
    const beforeValues: Array<string | undefined> = [];
    const client: DiscordSurfaceClient = {
      botUserId: 'bot-1',
      fetchMessage: async () => ({ kind: 'missing' }),
      fetchHistory: async (_channelId, options) => {
        beforeValues.push(options.beforeMessageId);
        return options.beforeMessageId
          ? { kind: 'found', guildId: 'guild-1', messages: [] }
          : { kind: 'found', guildId: 'guild-1', messages: firstPage };
      },
      editMessage: async () => {},
    };

    const first = await migrateDiscordSurfacesStep({
      meta,
      knownChannelIds: ['voice-1'],
      safeContent,
      client,
      persist: async () => {},
    });
    expect(first.complete).toBe(false);
    expect(first.meta.discordSurfaceMigration?.discovery[0]).toEqual(
      expect.objectContaining({ beforeMessageId: 'message-99', messagesScanned: 100 }),
    );

    const second = await migrateDiscordSurfacesStep({
      meta: first.meta,
      knownChannelIds: ['voice-1'],
      safeContent,
      client,
      persist: async () => {},
    });
    expect(beforeValues).toEqual([undefined, 'message-99']);
    expect(second.complete).toBe(true);
    expect(second.meta.discordSurfaceMigration?.discovery[0].messagesScanned).toBe(100);
  });
});
