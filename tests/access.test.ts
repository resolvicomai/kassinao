import { Collection, PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { client } from '../src/discord/client';
import {
  checkAccess,
  createAccessRequestContext,
  FreshMembershipBudget,
  recordingIdentityGrant,
  TransientAccessError,
} from '../src/web/access';
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
    await expect(checkAccess({ id: USER_ID, name: 'Alice' }, recording)).resolves.toEqual({
      view: false,
      delete: false,
    });
  });

  it('call pública no início não libera o histórico para quem só ganhou ViewChannel depois', async () => {
    installGuild({ seesChannel: true });
    await expect(checkAccess({ id: USER_ID, name: 'Alice' }, meta({ sourceEveryoneViewable: true }))).resolves.toEqual({
      view: false,
      delete: false,
    });
  });

  it('ações destrutivas ignoram até o contexto da listagem e sempre usam REST com force', async () => {
    const { fetchMember } = installGuild({ admin: true });
    const recording = meta();
    const user = { id: USER_ID, name: 'Admin' };

    await expect(checkAccess(user, recording, { freshMember: true })).resolves.toEqual({ view: true, delete: true });
    await expect(checkAccess(user, recording, { freshMember: true })).resolves.toEqual({ view: true, delete: true });
    expect(fetchMember).toHaveBeenCalledTimes(2);
    expect(fetchMember).toHaveBeenNthCalledWith(1, { user: USER_ID, force: true, cache: false });
    expect(fetchMember).toHaveBeenNthCalledWith(2, { user: USER_ID, force: true, cache: false });
  });

  it('reconfirma membership pela REST em cada request de conteúdo', async () => {
    const { fetchMember } = installGuild();
    const recording = meta({ participants: [{ id: USER_ID, name: 'Alice' } as RecordingMeta['participants'][number]] });
    const user = { id: USER_ID, name: 'Alice' };

    await expect(checkAccess(user, recording)).resolves.toEqual({ view: true, delete: false });
    fetchMember.mockRejectedValueOnce(Object.assign(new Error('Unknown Member'), { code: 10007 }));
    await expect(checkAccess(user, recording)).resolves.toEqual({ view: false, delete: false });

    expect(fetchMember).toHaveBeenCalledTimes(2);
    expect(fetchMember).toHaveBeenNthCalledWith(1, { user: USER_ID, force: true, cache: false });
    expect(fetchMember).toHaveBeenNthCalledWith(2, { user: USER_ID, force: true, cache: false });
  });

  it('reutiliza a confirmação somente dentro da mesma listagem', async () => {
    const { fetchMember } = installGuild();
    const user = { id: USER_ID, name: 'Alice' };
    const requestContext = createAccessRequestContext();

    await checkAccess(user, meta({ id: 'recording-a' }), { requestContext });
    await checkAccess(user, meta({ id: 'recording-b' }), { requestContext });

    expect(fetchMember).toHaveBeenCalledTimes(1);
  });
});

describe('orçamento de membership autoritativo', () => {
  const limits = {
    perUserPerMinute: 2,
    globalPerMinute: 3,
    maxConcurrent: 1,
    maxTrackedUsers: 10,
  };

  it('agrega todas as consultas do mesmo userId sem cachear o resultado', async () => {
    const budget = new FreshMembershipBudget(limits, () => 1_000);
    const task = vi.fn(async () => 'fresh');

    await expect(budget.run('user-a', task)).resolves.toBe('fresh');
    await expect(budget.run('user-a', task)).resolves.toBe('fresh');
    await expect(budget.run('user-a', task)).rejects.toBeInstanceOf(TransientAccessError);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('aplica teto global mesmo quando os userIds são diferentes', async () => {
    const budget = new FreshMembershipBudget({ ...limits, perUserPerMinute: 10 }, () => 1_000);

    await budget.run('user-a', async () => undefined);
    await budget.run('user-b', async () => undefined);
    await budget.run('user-c', async () => undefined);
    await expect(budget.run('user-d', async () => undefined)).rejects.toBeInstanceOf(TransientAccessError);
  });

  it('recusa saturação concorrente e libera a vaga no finally', async () => {
    const budget = new FreshMembershipBudget({ ...limits, perUserPerMinute: 10, globalPerMinute: 10 }, () => 1_000);
    let release!: () => void;
    const first = budget.run(
      'user-a',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(budget.activeChecks).toBe(1));

    await expect(budget.run('user-b', async () => undefined)).rejects.toBeInstanceOf(TransientAccessError);
    release();
    await first;
    await expect(budget.run('user-b', async () => 'ok')).resolves.toBe('ok');
  });
});
