import fs from 'node:fs';
import {
  ActionRowBuilder,
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Events,
  Guild,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextBasedChannel,
  TextInputBuilder,
  TextInputStyle,
  VoiceBasedChannel,
} from 'discord.js';
import { config } from './config';
import { startCleanupJob } from './cleanup';
import { client } from './discord/client';
import { Locale, localeOf, t } from './i18n';
import { autoRecordStore, isArmed, setArmed } from './recorder/autorecord';
import { sessionManager } from './recorder/manager';
import {
  formatDuration,
  formatOffset,
  joinNames,
  MAX_NOTE_LENGTH,
  NOTE_BUTTON_ID,
  RecordingSession,
  STOP_BUTTON_ID,
  StopReason,
} from './recorder/RecordingSession';
import { enqueueTranscription, killPendingTranscriptions, validateTranscriptionConfig } from './processing/transcribe';
import { listGuildMetas, listMetas, pageUrl, RecordingMeta, recoverInterruptedRecordings } from './store';
import { startWebServer } from './web/server';

const NOTE_MODAL_ID = 'kassinao_note_modal';
const NOTE_INPUT_ID = 'kassinao_note_text';

// ---------- definição dos comandos (pt-BR nativo + localização em inglês) ----------

function localized<T extends { setNameLocalizations: any; setDescriptionLocalizations: any }>(
  builder: T,
  name: string,
  description: string,
): T {
  builder.setNameLocalizations({ 'en-US': name, 'en-GB': name });
  builder.setDescriptionLocalizations({ 'en-US': description, 'en-GB': description });
  return builder;
}

function buildCommands() {
  const gravar = new SlashCommandBuilder()
    .setName('gravar')
    .setDescription('🔴 Grava o canal de voz — uma faixa separada e sincronizada por pessoa')
    .addChannelOption((o) => {
      o.setName('canal')
        .setDescription('Canal de voz a gravar (padrão: o canal onde você está)')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false);
      o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
      o.setDescriptionLocalizations({
        'en-US': 'Voice channel to record (default: the one you are in)',
        'en-GB': 'Voice channel to record (default: the one you are in)',
      });
      return o;
    });
  localized(gravar, 'record', '🔴 Record the voice channel — one separate synced track per speaker');

  const parar = new SlashCommandBuilder().setName('parar').setDescription('⏹️ Para a gravação em andamento');
  localized(parar, 'stop', '⏹️ Stop the current recording');

  const nota = new SlashCommandBuilder()
    .setName('nota')
    .setDescription('📝 Marca uma nota no tempo atual da gravação')
    .addStringOption((o) => {
      o.setName('texto').setDescription('Texto da nota').setMaxLength(MAX_NOTE_LENGTH).setRequired(true);
      o.setNameLocalizations({ 'en-US': 'text', 'en-GB': 'text' });
      o.setDescriptionLocalizations({ 'en-US': 'Note text', 'en-GB': 'Note text' });
      return o;
    });
  localized(nota, 'note', '📝 Mark a note at the current recording time');

  const status = new SlashCommandBuilder().setName('status').setDescription('ℹ️ Mostra o estado da gravação atual');
  localized(status, 'status', 'ℹ️ Show the current recording status');

  const gravacoes = new SlashCommandBuilder()
    .setName('gravacoes')
    .setDescription('📼 Lista as últimas gravações deste servidor com os links');
  localized(gravacoes, 'recordings', '📼 List the latest recordings in this server with links');

  const autorecord = new SlashCommandBuilder()
    .setName('autorecord')
    .setDescription('🤖 Gravação automática quando pessoas entram num canal de voz')
    .addSubcommand((sc) => {
      sc.setName('ligar')
        .setDescription('Liga o auto-record em um canal de voz')
        .addChannelOption((o) => {
          o.setName('canal')
            .setDescription('Canal de voz')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true);
          o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
          o.setDescriptionLocalizations({ 'en-US': 'Voice channel', 'en-GB': 'Voice channel' });
          return o;
        })
        .addIntegerOption((o) => {
          o.setName('minimo')
            .setDescription('Nº mínimo de pessoas para começar a gravar (padrão: 1)')
            .setMinValue(1)
            .setMaxValue(99)
            .setRequired(false);
          o.setNameLocalizations({ 'en-US': 'minimum', 'en-GB': 'minimum' });
          o.setDescriptionLocalizations({
            'en-US': 'Minimum number of people to start recording (default: 1)',
            'en-GB': 'Minimum number of people to start recording (default: 1)',
          });
          return o;
        });
      sc.setNameLocalizations({ 'en-US': 'on', 'en-GB': 'on' });
      sc.setDescriptionLocalizations({ 'en-US': 'Enable auto-record in a voice channel', 'en-GB': 'Enable auto-record in a voice channel' });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('desligar')
        .setDescription('Desliga o auto-record de um canal de voz')
        .addChannelOption((o) => {
          o.setName('canal')
            .setDescription('Canal de voz')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true);
          o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
          o.setDescriptionLocalizations({ 'en-US': 'Voice channel', 'en-GB': 'Voice channel' });
          return o;
        });
      sc.setNameLocalizations({ 'en-US': 'off', 'en-GB': 'off' });
      sc.setDescriptionLocalizations({ 'en-US': 'Disable auto-record in a voice channel', 'en-GB': 'Disable auto-record in a voice channel' });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('ver').setDescription('Mostra os auto-records configurados');
      sc.setNameLocalizations({ 'en-US': 'view', 'en-GB': 'view' });
      sc.setDescriptionLocalizations({ 'en-US': 'Show configured auto-records', 'en-GB': 'Show configured auto-records' });
      return sc;
    });
  localized(autorecord, 'autorecord', '🤖 Automatic recording when people join a voice channel');

  return [gravar, parar, nota, status, gravacoes, autorecord].map((c) => c.toJSON());
}

async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.token);
  const body = buildCommands();
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body });
    console.log(`Comandos registrados no servidor ${config.guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(config.applicationId), { body });
    console.log('Comandos registrados globalmente (podem levar até 1h para aparecer).');
  }
}

// ---------- ciclo de vida das sessões ----------

/**
 * Reserva síncrona por guild: fecha a janela entre a checagem e o registro
 * no manager (session.start() leva segundos aguardando a conexão de voz).
 * Sem isso, dois /gravar ou um /gravar + auto-record simultâneos disputariam
 * a mesma VoiceConnection do guild.
 */
const startingGuilds = new Set<string>();

function guildBusy(guildId: string): boolean {
  return sessionManager.get(guildId) !== undefined || startingGuilds.has(guildId);
}

async function startSession(opts: {
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  startedBy: { id: string; name: string } | null;
  locale: Locale;
  auto: boolean;
}): Promise<RecordingSession> {
  if (guildBusy(opts.guild.id)) {
    throw new Error(opts.locale === 'pt' ? 'já existe uma gravação neste servidor' : 'a recording already exists in this server');
  }
  startingGuilds.add(opts.guild.id);
  try {
    const session = new RecordingSession(opts);
    session.onAutoStop = (s, reason) => {
      if (sessionManager.get(s.guild.id) === s) sessionManager.delete(s.guild.id);
      afterSessionEnd(s, reason);
    };
    await session.start();
    // se o bot foi expulso durante o próprio start, não registra sessão morta
    if (session.meta.status === 'recording') {
      sessionManager.set(opts.guild.id, session);
      // start() leva até ~20s; se o canal esvaziou nesse meio-tempo, nenhum
      // voiceStateUpdate futuro virá — reavalia agora para não gravar sala vazia
      scheduleAutoRecordCheck(opts.guild, session.currentChannelId);
    }
    return session;
  } finally {
    startingGuilds.delete(opts.guild.id);
  }
}

/** Sessões já processadas por afterSessionEnd — o hook não é idempotente sozinho
 *  (stopSession e onAutoStop podem correr para a mesma sessão). */
const endedSessions = new Set<string>();

/** Pós-fim de gravação: rearma o auto-record quando faz sentido, reavalia os canais e transcreve. */
function afterSessionEnd(session: RecordingSession, reason: StopReason): void {
  if (endedSessions.has(session.id)) return; // roda uma única vez por sessão
  endedSessions.add(session.id);
  if (endedSessions.size > 500) endedSessions.clear(); // teto de memória; ids são únicos

  const channelId = session.voiceChannel.id;
  // Limite de horas com a reunião ainda rolando: rearma para recomeçar sozinha
  // e cobrir o resto (o Craig simplesmente para). Idem se o bot foi arrastado
  // para fora: o canal da regra pode seguir cheio e precisa ser reavaliado.
  if (session.auto && (reason === 'tempo-maximo' || reason === 'canal-vazio')) {
    setArmed(session.guild.id, channelId, true);
  }
  // Reavalia o canal da sessão E todas as regras do guild: enquanto este servidor
  // estava ocupado, outro canal com auto-record pode ter enchido sem disparar.
  scheduleAutoRecordCheck(session.guild, channelId);
  for (const rule of autoRecordStore.list(session.guild.id)) {
    scheduleAutoRecordCheck(session.guild, rule.channelId);
  }
  enqueueTranscription(session.id, (meta) => notifyTranscription(meta, session.locale));
}

/** Avisa no chat do canal de voz (e na DM de quem iniciou) que a transcrição terminou. */
async function notifyTranscription(meta: RecordingMeta, locale: Locale): Promise<void> {
  const state = meta.transcription;
  if (!state || (state.status !== 'done' && state.status !== 'error')) return;
  const text =
    state.status === 'done'
      ? t(locale, 'transcript.ready', { url: pageUrl(meta.id) })
      : t(locale, 'transcript.failed', { error: state.error ?? '?' });
  try {
    const channel = (await client.channels.fetch(meta.voiceChannelId)) as TextBasedChannel | null;
    if (channel && 'send' in channel) await channel.send(text);
  } catch {
    // sem acesso ao canal — a página continua mostrando a transcrição
  }
  if (meta.startedBy) {
    client.users.send(meta.startedBy.id, text).catch(() => {});
  }
}

async function stopSession(
  session: RecordingSession,
  reason: StopReason,
  stoppedBy?: { id: string; name: string },
): Promise<void> {
  if (sessionManager.get(session.guild.id) === session) sessionManager.delete(session.guild.id);
  await session.stop(reason, stoppedBy);
  afterSessionEnd(session, reason);
}

// ---------- handlers de comandos ----------

async function handleGravar(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember;
  const optionChannel = interaction.options.getChannel('canal');
  const voiceChannel = (optionChannel ?? member.voice?.channel) as VoiceBasedChannel | null;
  if (!voiceChannel) {
    await interaction.reply({ content: t(l, 'err.not-in-voice'), ephemeral: true });
    return;
  }
  if (!voiceChannel.isVoiceBased()) {
    await interaction.reply({ content: t(l, 'err.invalid-channel'), ephemeral: true });
    return;
  }
  const existing = sessionManager.get(interaction.guild.id);
  if (existing || guildBusy(interaction.guild.id)) {
    await interaction.reply({
      content: t(l, 'err.already-recording', { channel: `#${existing?.voiceChannel.name ?? '?'}` }),
      ephemeral: true,
    });
    return;
  }
  if (!voiceChannel.joinable) {
    await interaction.reply({ content: t(l, 'err.cannot-join', { channel: `#${voiceChannel.name}` }), ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const session = await startSession({
      guild: interaction.guild,
      voiceChannel,
      startedBy: { id: interaction.user.id, name: member.displayName ?? interaction.user.username },
      locale: l,
      auto: false,
    });
    const panel = session.panelJumpUrl;
    await interaction.editReply(
      panel
        ? t(l, 'record.started', { channel: `#${voiceChannel.name}`, panel })
        : t(l, 'record.started-no-panel', { channel: `#${voiceChannel.name}`, url: session.pageUrl }),
    );
  } catch (err) {
    await interaction.editReply(t(l, 'err.join-failed', { reason: (err as Error).message }));
  }
}

async function handleParar(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const session = sessionManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const member = interaction.member as GuildMember | null;
  await stopSession(session, 'manual', {
    id: interaction.user.id,
    name: member?.displayName ?? interaction.user.username,
  });
  await interaction.editReply(t(l, 'record.stopped', { url: session.pageUrl }));
}

/**
 * Nota é conteúdo da gravação: exige poder VER o canal gravado (salas
 * restritas não recebem notas de quem está de fora).
 */
function canAnnotate(session: RecordingSession, member: GuildMember | null): boolean {
  if (!member) return false;
  return session.voiceChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

async function handleNota(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const session = sessionManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember;
  if (!canAnnotate(session, member)) {
    await interaction.reply({
      content: t(l, 'note.no-access', { channel: `#${session.voiceChannel.name}` }),
      ephemeral: true,
    });
    return;
  }
  const offset = formatOffset(session.durationMs);
  const added = session.addNote(member.displayName ?? interaction.user.username, interaction.options.getString('texto', true));
  await interaction.reply({ content: t(l, added ? 'note.added' : 'note.discarded', { offset }), ephemeral: true });
}

async function handleNoteButton(interaction: ButtonInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const session = interaction.guild ? sessionManager.get(interaction.guild.id) : undefined;
  if (!session) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  if (!canAnnotate(session, interaction.member as GuildMember)) {
    await interaction.reply({
      content: t(l, 'note.no-access', { channel: `#${session.voiceChannel.name}` }),
      ephemeral: true,
    });
    return;
  }
  const modal = new ModalBuilder()
    // customId carrega id da sessão (um modal não pode cair em outra gravação) e
    // o offset do CLIQUE (o timestamp da nota é o momento do clique, não do submit)
    .setCustomId(`${NOTE_MODAL_ID}:${session.id}:${session.durationMs}`)
    .setTitle(t(l, 'note.modal-title'))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NOTE_INPUT_ID)
          .setLabel(t(l, 'note.modal-label').slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(MAX_NOTE_LENGTH)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

async function handleNoteModal(interaction: ModalSubmitInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const session = interaction.guild ? sessionManager.get(interaction.guild.id) : undefined;
  const [, expectedSessionId, rawAt] = interaction.customId.split(':');
  if (!session || session.id !== expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  const clickAt = Number(rawAt);
  const atMs = Number.isFinite(clickAt) ? Math.min(Math.max(0, Math.trunc(clickAt)), session.durationMs) : session.durationMs;
  const member = interaction.member as GuildMember | null;
  const added = session.addNote(
    (member && 'displayName' in member ? member.displayName : null) ?? interaction.user.username,
    interaction.fields.getTextInputValue(NOTE_INPUT_ID),
    atMs,
  );
  await interaction.reply({ content: t(l, added ? 'note.added' : 'note.discarded', { offset: formatOffset(atMs) }), ephemeral: true });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const session = sessionManager.get(interaction.guild.id);
  if (!session) {
    await interaction.reply({ content: t(l, 'status.none'), ephemeral: true });
    return;
  }
  const names = session.participantNames;
  await interaction.reply({
    content: t(l, 'status.recording', {
      channel: `#${session.voiceChannel.name}`,
      duration: formatDuration(session.durationMs),
      speakers: names.length > 0 ? t(l, 'status.speakers', { names: joinNames(names, l) }) : t(l, 'status.no-speakers'),
      url: session.pageUrl,
    }),
    ephemeral: true,
  });
}

async function handleGravacoes(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const metas = listGuildMetas(interaction.guild.id, 5);
  if (metas.length === 0) {
    await interaction.reply({ content: t(l, 'recordings.none'), ephemeral: true });
    return;
  }
  const lines = metas.map((m) => {
    const live = m.status === 'recording' ? ` ${t(l, 'recordings.live')}` : '';
    const duration = m.endedAt ? formatDuration(m.endedAt - m.startedAt) : '…';
    return `• **#${m.voiceChannelName}** — <t:${Math.floor(m.startedAt / 1000)}:f> — ${duration}${live}\n  [${pageUrl(m.id)}](${pageUrl(m.id)})`;
  });
  await interaction.reply({ content: `**${t(l, 'recordings.title')}**\n${lines.join('\n')}`, ephemeral: true });
}

async function handleAutorecord(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub !== 'ver') {
    // configurar gravação automática é decisão de servidor, não de membro
    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: t(l, 'autorecord.no-permission'), ephemeral: true });
      return;
    }
  }
  if (sub === 'ligar') {
    const channel = interaction.options.getChannel('canal', true);
    const minimum = interaction.options.getInteger('minimo') ?? 1;
    autoRecordStore.set(interaction.guild.id, { channelId: channel.id, minimum, createdBy: interaction.user.id });
    setArmed(interaction.guild.id, channel.id, true);
    await interaction.reply({
      content: t(l, 'autorecord.enabled', { channel: `#${channel.name}`, min: minimum }),
      ephemeral: true,
    });
    // se o canal já está cheio, dispara
    scheduleAutoRecordCheck(interaction.guild, channel.id);
  } else if (sub === 'desligar') {
    const channel = interaction.options.getChannel('canal', true);
    const removed = autoRecordStore.remove(interaction.guild.id, channel.id);
    await interaction.reply({
      content: t(l, removed ? 'autorecord.disabled' : 'autorecord.not-set', { channel: `#${channel.name}` }),
      ephemeral: true,
    });
  } else {
    const rules = autoRecordStore.list(interaction.guild.id);
    if (rules.length === 0) {
      await interaction.reply({ content: t(l, 'autorecord.view-none'), ephemeral: true });
      return;
    }
    const lines = rules.map((r) => t(l, 'autorecord.view-line', { channel: `<#${r.channelId}>`, min: r.minimum }));
    await interaction.reply({ content: `**${t(l, 'autorecord.view-title')}**\n${lines.join('\n')}`, ephemeral: true });
  }
}

// ---------- auto-record e paradas por população ----------

const pendingChecks = new Map<string, NodeJS.Timeout>(); // `${guildId}:${channelId}`
const AUTO_DEBOUNCE_MS = 2000;

function scheduleAutoRecordCheck(guild: Guild, channelId: string): void {
  const key = `${guild.id}:${channelId}`;
  const existing = pendingChecks.get(key);
  if (existing) clearTimeout(existing);
  pendingChecks.set(
    key,
    setTimeout(() => {
      pendingChecks.delete(key);
      evaluateChannel(guild, channelId).catch((err) => console.error('Erro no auto-record:', err));
    }, AUTO_DEBOUNCE_MS),
  );
}

async function evaluateChannel(guild: Guild, channelId: string): Promise<void> {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return;
  const humans = channel.members.filter((m) => !m.user.bot).size;
  const rule = autoRecordStore.get(guild.id, channelId);
  const session = sessionManager.get(guild.id);

  // rearma quando a população cai abaixo do mínimo
  if (rule && humans < rule.minimum) setArmed(guild.id, channelId, true);

  // compara com o canal onde o bot ESTÁ (ele pode ter sido arrastado)
  if (session && session.currentChannelId === channelId) {
    const belowMinimum = session.auto && rule && humans < rule.minimum;
    if (humans === 0 || belowMinimum) {
      await stopSession(session, 'canal-vazio');
    }
    return;
  }

  if (!guildBusy(guild.id) && rule && humans >= rule.minimum && isArmed(guild.id, channelId)) {
    setArmed(guild.id, channelId, false);
    const locale = localeOf(guild.preferredLocale);
    try {
      await startSession({ guild, voiceChannel: channel, startedBy: null, locale, auto: true });
    } catch (err) {
      // rearma para tentar de novo no próximo movimento do canal
      setArmed(guild.id, channelId, true);
      console.error(`Auto-record falhou em #${channel.name}:`, err);
    }
  }
}

// ---------- eventos do Discord ----------

client.once(Events.ClientReady, async () => {
  console.log(`Kassinão online como ${client.user?.tag} 🎙️`);
  await registerCommands().catch((err) => console.error('Falha ao registrar comandos:', err));
  // canais que já estavam cheios quando o bot subiu disparam o auto-record
  for (const guild of client.guilds.cache.values()) {
    for (const rule of autoRecordStore.list(guild.id)) {
      scheduleAutoRecordCheck(guild, rule.channelId);
    }
  }
  // transcrições interrompidas por reinício voltam à fila — só agora, com o
  // client pronto, para as notificações de "pronta" conseguirem ser enviadas
  for (const meta of listMetas()) {
    if (meta.status !== 'done') continue;
    const st = meta.transcription?.status;
    const recent = (meta.endedAt ?? 0) > Date.now() - 24 * 60 * 60 * 1000;
    if (st === 'pending' || st === 'running' || (st === undefined && recent)) {
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, 'pt'));
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'gravar':
          await handleGravar(interaction);
          break;
        case 'parar':
          await handleParar(interaction);
          break;
        case 'nota':
          await handleNota(interaction);
          break;
        case 'status':
          await handleStatus(interaction);
          break;
        case 'gravacoes':
          await handleGravacoes(interaction);
          break;
        case 'autorecord':
          await handleAutorecord(interaction);
          break;
      }
    } else if (interaction.isButton() && interaction.customId === STOP_BUTTON_ID) {
      await handleParar(interaction);
    } else if (interaction.isButton() && interaction.customId === NOTE_BUTTON_ID) {
      await handleNoteButton(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(`${NOTE_MODAL_ID}:`)) {
      await handleNoteModal(interaction);
    }
  } catch (err) {
    console.error('Erro tratando interação:', err);
    if (interaction.isRepliable()) {
      const l = localeOf(interaction.locale);
      const message = { content: t(l, 'err.generic'), ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(message).catch(() => {});
      else await interaction.reply(message).catch(() => {});
    }
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = oldState.guild;
  const channels = new Set<string>();
  if (oldState.channelId) channels.add(oldState.channelId);
  if (newState.channelId) channels.add(newState.channelId);
  for (const channelId of channels) scheduleAutoRecordCheck(guild, channelId);
});

// ---------- shutdown gracioso ----------

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Recebido ${signal}: encerrando gravações ativas antes de sair...`);
  killPendingTranscriptions();
  const actives = sessionManager.all();
  await Promise.all(
    actives.map((s) =>
      stopSession(s, 'desconectado').catch((err) => console.error(`Erro ao encerrar ${s.id}:`, err)),
    ),
  );
  try {
    client.destroy();
  } catch {
    // ignore
  }
  // dá um respiro para os masters FLAC terminarem de fechar em disco
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// ---------- boot ----------

fs.mkdirSync(config.recordingsDir, { recursive: true });

const transcribeConfigError = validateTranscriptionConfig();
if (transcribeConfigError) {
  console.error(`Configuração de transcrição inválida: ${transcribeConfigError}`);
  process.exit(1);
}

recoverInterruptedRecordings();
startWebServer();
startCleanupJob();
client.login(config.token).catch((err) => {
  console.error('Falha ao autenticar no Discord (token inválido?):', err.message);
  process.exit(1);
});
