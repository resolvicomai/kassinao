import { ChannelType, type Client, type Message } from 'discord.js';
import type {
  DiscordSurfaceHistoryResult,
  DiscordSurfaceInventoryClient,
  DiscordSurfaceMessage,
  DiscordSurfaceMessageResult,
} from './discordSurfaceMigration';

function isMissingDiscordResource(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = Number((error as { code?: unknown }).code);
  return code === 10003 || code === 10008;
}

function surfaceMessage(message: Message): DiscordSurfaceMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? '',
    authorId: message.author.id,
    createdTimestamp: message.createdTimestamp,
    content: message.content,
    embeds: message.embeds.map((embed) => embed.toJSON()),
    components: message.components.map((component) => component.toJSON()),
  };
}

/** Adapter deliberadamente não expõe delete; toda mutação revalida autoria. */
export function createDiscordSurfaceClient(client: Client): DiscordSurfaceInventoryClient {
  async function fetchMessage(channelId: string, messageId: string): Promise<DiscordSurfaceMessageResult> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return { kind: 'missing' };
      const message = await channel.messages.fetch(messageId);
      return { kind: 'found', message: surfaceMessage(message) };
    } catch (error) {
      if (isMissingDiscordResource(error)) return { kind: 'missing' };
      throw error;
    }
  }

  async function fetchHistory(
    channelId: string,
    options: { beforeMessageId?: string; limit: number },
  ): Promise<DiscordSurfaceHistoryResult> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return { kind: 'missing' };
      const messages = await channel.messages.fetch({
        limit: options.limit,
        ...(options.beforeMessageId ? { before: options.beforeMessageId } : {}),
      });
      const guildId = 'guildId' in channel && typeof channel.guildId === 'string' ? channel.guildId : '';
      return { kind: 'found', guildId, messages: [...messages.values()].map(surfaceMessage) };
    } catch (error) {
      if (isMissingDiscordResource(error)) return { kind: 'missing' };
      throw error;
    }
  }

  return {
    botUserId: client.user?.id ?? '',
    async listGuildMessageChannelIds(guildId) {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
      if (guild.id !== guildId) throw new Error('servidor inesperado no inventário');
      const channels = await guild.channels.fetch();
      return [...channels.values()]
        .filter((channel): channel is NonNullable<typeof channel> =>
          Boolean(
            channel &&
            channel.guildId === guildId &&
            'messages' in channel &&
            (channel.type === ChannelType.GuildText ||
              channel.type === ChannelType.GuildAnnouncement ||
              channel.type === ChannelType.GuildVoice ||
              channel.type === ChannelType.GuildStageVoice),
          ),
        )
        .map((channel) => channel.id);
    },
    fetchMessage,
    fetchHistory,
    async editMessage(channelId, messageId, payload) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) throw new Error('canal indisponível');
      const message = await channel.messages.fetch(messageId);
      if (!client.user || message.author.id !== client.user.id) throw new Error('mensagem não pertence ao bot');
      await message.edit(payload);
    },
  };
}
