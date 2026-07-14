import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const voice = vi.hoisted(() => ({
  entersState: vi.fn(),
  getVoiceConnection: vi.fn(),
  joinVoiceChannel: vi.fn(),
}));

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  return {
    ...actual,
    entersState: voice.entersState,
    getVoiceConnection: voice.getVoiceConnection,
    joinVoiceChannel: voice.joinVoiceChannel,
  };
});

import {
  MAX_NOTES_PER_RECORDING,
  MAX_PRESENCE_IDENTITIES,
  identityNameMayBeExposed,
  RecordingSession,
  RecordingStartCancelledError,
} from '../src/recorder/RecordingSession';
import { MAX_PRESENCE_IDENTITIES_PER_RESPONSE } from '../src/securityLimits';
import { DISCORD_SURFACE_POLICY_VERSION } from '../src/discordSurfaceMigration';
import { listMetas, readMeta, tracksDir } from '../src/store';
import { NOTIFICATION_POLICY_VERSION } from '../src/transcriptionNotification';

function fakeConnection() {
  return {
    destroy: vi.fn(),
    on: vi.fn(),
    receiver: {
      speaking: { on: vi.fn() },
      subscribe: vi.fn(),
    },
  };
}

function fixture() {
  const message = {
    id: 'panel-1',
    channelId: 'voice-1',
    url: 'https://discord.test/panel-1',
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const channel = {
    id: 'voice-1',
    name: 'daily',
    members: new Map(),
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn().mockResolvedValue(message),
  };
  const me = {
    id: 'bot-1',
    nickname: null,
    user: { username: 'Kassinao' },
    voice: { channelId: 'voice-1' },
    setNickname: vi.fn().mockResolvedValue(undefined),
  };
  const guild = {
    id: 'guild-1',
    name: 'Servidor',
    roles: { everyone: { id: 'guild-1' } },
    voiceAdapterCreator: {},
    members: { me, cache: new Map(), fetch: vi.fn() },
    client: { users: { send: vi.fn().mockResolvedValue(undefined) } },
  };
  Object.assign(channel, { guild });
  return { channel, connection: fakeConnection(), guild, me, message };
}

function recordingDir(session: RecordingSession): string {
  return path.dirname(tracksDir(session.id));
}

describe('RecordingSession.start — transação real de início', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voice.getVoiceConnection.mockReturnValue(undefined);
  });

  it('é idempotente e só ativa o receptor depois de publicar o painel', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });

    const first = session.start();
    const second = session.start();

    expect(first).toBe(second);
    await first;
    expect(voice.joinVoiceChannel).toHaveBeenCalledTimes(1);
    expect(f.channel.send).toHaveBeenCalledTimes(1);
    expect(f.connection.receiver.speaking.on).toHaveBeenCalledTimes(1);
    expect(f.channel.send.mock.invocationCallOrder[0]).toBeLessThan(
      f.connection.receiver.speaking.on.mock.invocationCallOrder[0],
    );
    expect(session.meta.discordSurfacePolicyVersion).toBe(DISCORD_SURFACE_POLICY_VERSION);
    expect(readMeta(session.id)?.notificationPolicyVersion).toBe(NOTIFICATION_POLICY_VERSION);

    await session.stop('manual', { id: 'u1', name: 'Ana' });
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('falha fechado e remove conexão/arquivos quando não consegue avisar no canal', async () => {
    const f = fixture();
    f.channel.send.mockRejectedValue(new Error('missing permission'));
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: true,
    });

    await expect(session.start()).rejects.toThrow('não consegui publicar o aviso');
    expect(f.connection.receiver.speaking.on).not.toHaveBeenCalled();
    expect(f.connection.destroy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(recordingDir(session))).toBe(false);
  });

  it('recusa uma sala que já começa no teto de presença antes de captar áudio', async () => {
    const f = fixture();
    for (let index = 0; index < MAX_PRESENCE_IDENTITIES; index += 1) {
      const id = `member-${index}`;
      f.channel.members.set(id, {
        id,
        displayName: `Pessoa ${index}`,
        user: { bot: false },
      });
    }
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });

    await expect(session.start()).rejects.toThrow(`limite seguro de ${MAX_PRESENCE_IDENTITIES} pessoas`);
    expect(f.connection.receiver.speaking.on).not.toHaveBeenCalled();
    expect(f.connection.destroy).toHaveBeenCalledTimes(1);
    expect(f.message.delete).toHaveBeenCalledTimes(1);
    expect(readMeta(session.id)).toBeUndefined();
    expect(fs.existsSync(recordingDir(session))).toBe(false);
  });

  it('cancela durante painel pendente sem captar áudio e apaga resposta REST tardia', async () => {
    // Inicializa o índice em memória antes de saveMeta para reproduzir o caminho
    // real do bot após o boot. O abort precisa apagar disco e cache juntos.
    listMetas();
    const f = fixture();
    let resolvePanel!: (value: typeof f.message) => void;
    f.channel.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePanel = resolve;
        }),
    );
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    const controller = new AbortController();

    const starting = session.start(controller.signal);
    await vi.waitFor(() => expect(f.channel.send).toHaveBeenCalledTimes(1));
    expect(f.connection.receiver.speaking.on).not.toHaveBeenCalled();
    controller.abort();

    await expect(starting).rejects.toBeInstanceOf(RecordingStartCancelledError);
    expect(f.connection.destroy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(recordingDir(session))).toBe(false);
    expect(readMeta(session.id)).toBeUndefined();

    resolvePanel(f.message);
    await vi.waitFor(() => expect(f.message.delete).toHaveBeenCalledTimes(1));
  });

  it('finaliza uma única vez quando dois gatilhos de parada concorrem', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    await session.start();

    const manual = session.stop('manual', { id: 'u1', name: 'Ana' });
    const disconnect = session.stop('desconectado');

    expect(manual).toBe(disconnect);
    const meta = await manual;
    expect(f.connection.destroy).toHaveBeenCalledTimes(1);
    expect(meta.events.some((event) => event.text.includes('Ana') && event.text.includes('parou'))).toBe(true);
    expect(meta.events.some((event) => event.text.includes('desconectado'))).toBe(false);
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('persiste a identidade que completa o teto e encerra de forma idempotente', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    await session.start();
    session.meta.presence = Array.from({ length: MAX_PRESENCE_IDENTITIES - 1 }, (_, index) => ({
      id: `presence-${index}`,
      name: `Pessoa ${index}`,
      joinedAtMs: index,
    }));
    const autoStop = vi.fn();
    session.onAutoStop = autoStop;

    session.noteVoiceJoin('presence-limit', 'Pessoa Limite');

    expect(session.isStopping).toBe(true);
    expect(session.meta.presence).toHaveLength(MAX_PRESENCE_IDENTITIES);
    expect(session.meta.presence?.at(-1)).toMatchObject({ id: 'presence-limit', name: 'Pessoa Limite' });
    expect(readMeta(session.id)?.presence?.at(-1)).toMatchObject({ id: 'presence-limit' });
    expect(autoStop).toHaveBeenCalledTimes(1);
    expect(autoStop).toHaveBeenCalledWith(session, 'limite-presenca');

    // Mesmo que outro evento chegue enquanto o fechamento está em andamento,
    // nenhuma identidade é descartada com a captura ainda ativa nem o meta cresce.
    session.noteVoiceJoin('presence-overflow', 'Pessoa Excedente');
    expect(session.meta.presence).toHaveLength(MAX_PRESENCE_IDENTITIES);
    expect(session.meta.presence?.some((entry) => entry.id === 'presence-overflow')).toBe(false);

    const firstStop = session.stop('manual', { id: 'admin', name: 'Admin' });
    const secondStop = session.stop('desconectado');
    expect(firstStop).toBe(secondStop);
    const meta = await firstStop;
    expect(meta.events.some((event) => event.text.includes('Limite seguro'))).toBe(true);
    expect(meta.events.some((event) => event.text.includes('Admin') && event.text.includes('parou'))).toBe(false);
    expect(f.connection.destroy).toHaveBeenCalledTimes(1);
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('aplica o mesmo teto quando falar é a única prova de presença recebida', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'en',
      auto: false,
    });
    await session.start();
    session.meta.presence = Array.from({ length: MAX_PRESENCE_IDENTITIES - 1 }, (_, index) => ({
      id: `speaker-presence-${index}`,
      name: `Person ${index}`,
      joinedAtMs: index,
    }));
    const speakingStart = f.connection.receiver.speaking.on.mock.calls[0]?.[1] as
      ((userId: string) => void) | undefined;

    expect(speakingStart).toBeTypeOf('function');
    speakingStart?.('speaker-limit');

    expect(session.isStopping).toBe(true);
    expect(session.meta.presence).toHaveLength(MAX_PRESENCE_IDENTITIES);
    expect(session.meta.presence?.at(-1)).toMatchObject({ id: 'speaker-limit' });
    expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
    const meta = await session.stop('manual');
    expect(meta.events.some((event) => event.text.includes('Safe') && event.text.includes('limit reached'))).toBe(true);
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('não regrava o meta em churn da mesma identidade dentro do cooldown', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    await session.start();

    session.noteVoiceJoin('churn-user', 'Pessoa Churn');
    session.noteVoiceLeave('churn-user', 'Pessoa Churn');
    const before = readMeta(session.id)?.presence?.find((entry) => entry.id === 'churn-user');
    session.noteVoiceJoin('churn-user', 'Pessoa Churn');
    const after = readMeta(session.id)?.presence?.find((entry) => entry.id === 'churn-user');

    expect(before?.leftAtMs).toBeTypeOf('number');
    expect(session.meta.presence?.find((entry) => entry.id === 'churn-user')?.leftAtMs).toBe(before?.leftAtMs);
    expect(after).toEqual(before);
    await session.stop('manual');
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('encerra a captura mesmo quando o grant que completa o teto não pode ser persistido', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    await session.start();
    session.meta.presence = Array.from({ length: MAX_PRESENCE_IDENTITIES - 1 }, (_, index) => ({
      id: `persisted-${index}`,
      name: `Pessoa ${index}`,
      joinedAtMs: index,
    }));
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });

    expect(() => session.noteVoiceJoin('unsafe-last', 'Pessoa Final')).not.toThrow();
    expect(session.isStopping).toBe(true);
    expect(f.connection.destroy).toHaveBeenCalledTimes(1);
    fsync.mockRestore();
    await session.stop('manual').catch(() => {});
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('resume snapshot inicial sem concatenar centenas de nomes numa timeline', () => {
    const f = fixture();
    for (let index = 0; index < MAX_PRESENCE_IDENTITIES - 1; index++) {
      const id = `snapshot-${index}`;
      f.channel.members.set(id, { id, displayName: `Pessoa ${index}`, user: { bot: false } });
    }
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });

    expect(session.snapshotPresence()).toBe(true);
    const initialPresence = session.meta.events.at(-1)?.text ?? '';
    expect(initialPresence).toContain(`+${MAX_PRESENCE_IDENTITIES - 1 - MAX_PRESENCE_IDENTITIES_PER_RESPONSE}`);
    expect(initialPresence).not.toContain('Pessoa 998');
    expect(initialPresence.length).toBeLessThan(10_000);
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('mantém o orçamento global de nomes entre snapshots sucessivos', () => {
    const f = fixture();
    for (let index = 0; index < 150; index++) {
      const id = `snapshot-global-${index}`;
      f.channel.members.set(id, { id, displayName: `Pessoa Global ${index}`, user: { bot: false } });
    }
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    session.snapshotPresence();
    f.channel.members.set('snapshot-global-late', {
      id: 'snapshot-global-late',
      displayName: 'Nome Tardio Secreto',
      user: { bot: false },
    });

    session.snapshotPresence();

    expect(session.meta.events.map((event) => event.text).join(' ')).not.toContain('Nome Tardio Secreto');
    expect(session.meta.events.at(-1)?.text).toContain('+1');
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('anonimiza timeline para identidades além do teto de resposta', () => {
    const f = fixture();
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: null,
      locale: 'pt',
      auto: false,
    });
    session.meta.presence = Array.from({ length: MAX_PRESENCE_IDENTITIES_PER_RESPONSE }, (_, index) => ({
      id: `visible-${index}`,
      name: `Pessoa ${index}`,
      joinedAtMs: index,
    }));

    session.noteVoiceJoin('hidden-person', 'Nome Muito Secreto');
    session.noteVoiceLeave('hidden-person', 'Nome Muito Secreto');

    const events = session.meta.events.slice(-2).map((event) => event.text);
    expect(events).toEqual(['👥 Uma pessoa entrou na call', '🚪 Uma pessoa saiu da call']);
    expect(events.join(' ')).not.toContain('Nome Muito Secreto');
    expect(identityNameMayBeExposed(session.meta.presence, 'hidden-person')).toBe(false);
    expect(identityNameMayBeExposed(session.meta.presence, 'visible-99')).toBe(true);
    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('mantém o painel público genérico e envia detalhes somente por DM', async () => {
    const f = fixture();
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: { id: 'starter-secret', name: 'Iniciador Secreto' },
      locale: 'pt',
      auto: false,
    });

    await session.start();
    session.meta.participants.push({
      id: 'participant-secret',
      name: 'Participante Secreta',
      avatar: null,
      trackFile: 'secret.flac',
      index: 0,
    });
    session.addNote('Participante Secreta', 'Aquisição confidencial por R$ 10 milhões');
    await session.stop('manual', { id: 'participant-secret', name: 'Participante Secreta' });

    const publicPayloads = [f.channel.send.mock.calls[0]?.[0], f.message.edit.mock.calls.at(-1)?.[0]];
    const serialized = JSON.stringify(publicPayloads);
    expect(serialized).not.toContain(session.id);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('Iniciador Secreto');
    expect(serialized).not.toContain('Participante Secreta');
    expect(serialized).not.toContain('Aquisição confidencial');
    expect(f.channel.send).toHaveBeenCalledTimes(1);
    expect(f.guild.client.users.send).toHaveBeenCalled();

    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });

  it('limita a quantidade de notas persistidas por gravação', () => {
    const f = fixture();
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: { id: 'starter', name: 'Starter' },
      locale: 'pt',
      auto: false,
    });
    session.meta.notes = Array.from({ length: MAX_NOTES_PER_RECORDING }, (_, index) => ({
      atMs: index,
      author: 'Pessoa',
      text: `Nota ${index}`,
    }));

    expect(session.addNote('Pessoa', 'nota excedente')).toBe(false);
    expect(session.meta.notes).toHaveLength(MAX_NOTES_PER_RECORDING);
  });

  it('não envia link por DM quando membership atual não pode ser confirmada', async () => {
    const f = fixture();
    f.guild.members.fetch.mockRejectedValue(Object.assign(new Error('Unknown Member'), { code: 10007 }));
    voice.joinVoiceChannel.mockReturnValue(f.connection);
    voice.entersState.mockResolvedValue(f.connection);
    const session = new RecordingSession({
      guild: f.guild as never,
      voiceChannel: f.channel as never,
      startedBy: { id: 'former-member', name: 'Ex-membro' },
      locale: 'pt',
      auto: false,
    });

    await session.start();
    await vi.waitFor(() => expect(f.guild.members.fetch).toHaveBeenCalled());
    expect(f.guild.client.users.send).not.toHaveBeenCalled();

    await session.stop('manual', { id: 'admin', name: 'Admin' });
    await vi.waitFor(() => expect(f.guild.members.fetch.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(f.guild.client.users.send).not.toHaveBeenCalled();

    fs.rmSync(recordingDir(session), { recursive: true, force: true });
  });
});
