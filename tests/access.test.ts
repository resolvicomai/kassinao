import { Collection, PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { client } from '../src/discord/client';
import { allowsCurrentChannelGrant, checkAccess, forgetMember, recordingIdentityGrant } from '../src/web/access';
import type { RecordingMeta } from '../src/store';

const GUILD_ID = 'guild-access-test';
const USER_ID = 'user-access-test';

function meta(overrides: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    id: '2026-07-09-0123456789',
    guildId: GUILD_ID,
    guildName: 'Guild',
    voiceChannelId: 'voice',
    voiceChannelName: 'private',
    sourceEveryoneViewable: false,
    startedBy: null,
    startedAt: Date.now(),
    status: 'done',
    participants: [],
    presence: [],
    events: [],
    notes: [],
    ...overrides,
  };
}

function installGuild(options: { admin?: boolean; seesChannel?: boolean; missing?: boolean } = {}) {
  const member = {
    id: USER_ID,
    permissions: {
      has(permission: bigint) {
        return permission === PermissionFlagsBits.ManageGuild && !!options.admin;
      },
    },
  } as unknown as GuildMember;
  const fetchMember = options.missing
    ? vi.fn().mockRejectedValue(Object.assign(new Error('Unknown Member'), { code: 10007 }))
    : vi.fn().mockResolvedValue(member);
  const channel = {
    permissionsFor() {
      return { has: () => !!options.seesChannel };
    },
  };
  const guild = {
    id: GUILD_ID,
    members: { fetch: fetchMember },
    channels: {
      cache: new Collection([['voice', channel]]),
      fetch: vi.fn(),
    },
  } as unknown as Guild;
  client.guilds.cache.set(GUILD_ID, guild);
  return { fetchMember };
}

afterEach(() => {
  forgetMember(GUILD_ID, USER_ID);
  client.guilds.cache.delete(GUILD_ID);
});

describe('ACL histórica das gravações', () => {
  it('grants de participante/iniciador só existem para membro atual', async () => {
    installGuild({ missing: true });
    const recording = meta({
      startedBy: { id: USER_ID, name: 'Alice' },
      participants: [{ id: USER_ID, name: 'Alice' } as RecordingMeta['participants'][number]],
    });
    expect(recordingIdentityGrant(USER_ID, recording)).toEqual({ view: true, delete: true });
    await expect(checkAccess({ id: USER_ID, name: 'Alice' }, recording)).resolves.toEqual({
      view: false,
      delete: false,
    });
  });

  it('call privada não libera o histórico para quem ganhou ViewChannel depois', async () => {
    installGuild({ seesChannel: true });
    const recording = meta({ sourceEveryoneViewable: false });
    expect(allowsCurrentChannelGrant(recording)).toBe(false);
    await expect(checkAccess({ id: USER_ID, name: 'Alice' }, recording)).resolves.toEqual({
      view: false,
      delete: false,
    });
  });

  it('call pública no início aceita ViewChannel atual de membro confirmado', async () => {
    installGuild({ seesChannel: true });
    await expect(checkAccess({ id: USER_ID, name: 'Alice' }, meta({ sourceEveryoneViewable: true }))).resolves.toEqual({
      view: true,
      delete: false,
    });
  });

  it('ações destrutivas podem ignorar o TTL e sempre usam REST com force', async () => {
    const { fetchMember } = installGuild({ admin: true });
    const recording = meta();
    const user = { id: USER_ID, name: 'Admin' };

    await expect(checkAccess(user, recording, { freshMember: true })).resolves.toEqual({ view: true, delete: true });
    await expect(checkAccess(user, recording, { freshMember: true })).resolves.toEqual({ view: true, delete: true });
    expect(fetchMember).toHaveBeenCalledTimes(2);
    expect(fetchMember).toHaveBeenNthCalledWith(1, { user: USER_ID, force: true, cache: true });
    expect(fetchMember).toHaveBeenNthCalledWith(2, { user: USER_ID, force: true, cache: true });
  });
});
