/*
 * Kassinão — gravador de voz self-hosted para Discord.
 * Copyright (C) 2026 Mauro Marques
 *
 * Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo sob
 * os termos da GNU Affero General Public License, publicada pela Free Software
 * Foundation, na versão 3 ou (a seu critério) qualquer versão posterior.
 * Veja <https://www.gnu.org/licenses/> para o texto completo.
 */
import fs from 'node:fs';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Events,
  Guild,
  GuildBasedChannel,
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
import { answerQuestion, authorizeAskMetas, resolveAskTemporalIntent } from './ask';
import { AskLimiter, AskRateLimitError } from './askLimiter';
import { guildConfigStore } from './guildConfig';
import { minutesEnabled } from './processing/minutes';
import { allowMinutesBroadcast, safeSlice, shortError } from './util';
import { startCleanupJob } from './cleanup';
import { freeMB } from './disk';
import { client } from './discord/client';
import { markClientReady } from './discord/ready';
import { alertOwners, startMonitor } from './monitor';
import { Locale, localeOf, t } from './i18n';
import { autoRecordStore, isArmed, setArmed } from './recorder/autorecord';
import { sessionManager } from './recorder/manager';
import { ManualRecordingStartLimiter } from './recorder/manualStartLimiter';
import { reportManualRecordingStartFailure } from './recorder/manualStartFailure';
import {
  BoundedIdSet,
  canManuallyStartRecording,
  controlSessionId,
  MarkClickDeduper,
  shouldRearmAutoRecord,
} from './recorder/lifecycle';
import { cook } from './processing/cook';
import {
  formatDuration,
  formatOffset,
  MARK_BUTTON_ID,
  MAX_NOTE_LENGTH,
  NOTE_BUTTON_ID,
  RecordingStartCancelledError,
  RecordingSession,
  STOP_BUTTON_ID,
  StopReason,
} from './recorder/RecordingSession';
import {
  enqueueMinutesOnly,
  enqueueTranscription,
  killPendingTranscriptions,
  MAX_TRANSCRIPTION_ATTEMPTS,
  transcriptionEnabled,
  validateTranscriptionConfig,
} from './processing/transcribe';
import { safeName } from './sanitize';
import {
  audioExpiryOf,
  listGuildMetas,
  listGuildMetasInRange,
  listMetas,
  pageUrl,
  readMeta,
  readMinutes,
  readTranscript,
  RecordingMeta,
  recoverInterruptedRecordings,
  saveMeta,
  transcriptReady,
} from './store';
import { forgetGuildMembers, forgetMember, recordingIdentityGrant } from './web/access';
import { createExchangeCode, revokeUser } from './web/mcpTokens';
import { resolveRange } from './web/range';
import { startWebServer } from './web/server';

const NOTE_MODAL_ID = 'kassinao_note_modal';
const NOTE_INPUT_ID = 'kassinao_note_text';
let shuttingDown = false;
let recoveredRecordings: RecordingMeta[] = [];

// Código-fonte oficial. Exibido no /sobre para creditar a autoria e cumprir a
// obrigação da AGPL §13 (oferecer o fonte a quem interage com o bot pela rede).
const SOURCE_URL = 'https://github.com/resolvicomai/kassinao';

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
    .setDescription('🔴 Grava a call — uma faixa por pessoa + transcrição e ata automáticas')
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
  localized(gravar, 'record', '🔴 Record the call — per-person tracks + auto transcript & minutes');

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

  const ajuda = new SlashCommandBuilder()
    .setName('ajuda')
    .setDescription('❓ Como usar o Kassinão (comandos e passo a passo)');
  localized(ajuda, 'help', '❓ How to use Kassinão (commands and quick start)');

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
      sc.setDescriptionLocalizations({
        'en-US': 'Enable auto-record in a voice channel',
        'en-GB': 'Enable auto-record in a voice channel',
      });
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
      sc.setDescriptionLocalizations({
        'en-US': 'Disable auto-record in a voice channel',
        'en-GB': 'Disable auto-record in a voice channel',
      });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('ver').setDescription('Mostra os auto-records configurados');
      sc.setNameLocalizations({ 'en-US': 'view', 'en-GB': 'view' });
      sc.setDescriptionLocalizations({
        'en-US': 'Show configured auto-records',
        'en-GB': 'Show configured auto-records',
      });
      return sc;
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  localized(autorecord, 'autorecord', '🤖 Automatic recording when people join a voice channel');

  const sobre = new SlashCommandBuilder()
    .setName('sobre')
    .setDescription('ℹ️ Sobre o Kassinão: autor, licença e código-fonte');
  localized(sobre, 'about', 'ℹ️ About Kassinão: author, license and source code');

  const perguntar = new SlashCommandBuilder()
    .setName('perguntar')
    .setDescription('🤖 Pergunte às suas reuniões — a IA responde com base nas transcrições que você pode ver')
    .addStringOption((o) => {
      o.setName('pergunta')
        .setDescription('Pergunte por tema, pessoa ou data (ex.: ações da Ana ontem)')
        .setMaxLength(300)
        .setRequired(true);
      o.setNameLocalizations({ 'en-US': 'question', 'en-GB': 'question' });
      o.setDescriptionLocalizations({
        'en-US': "Ask by topic, person or date (e.g.: Ana's actions yesterday)",
        'en-GB': "Ask by topic, person or date (e.g.: Ana's actions yesterday)",
      });
      return o;
    })
    .addIntegerOption((o) => {
      o.setName('dias')
        .setDescription('Janela de busca em dias (padrão: 30)')
        .setMinValue(1)
        .setMaxValue(365)
        .setRequired(false);
      o.setNameLocalizations({ 'en-US': 'days', 'en-GB': 'days' });
      o.setDescriptionLocalizations({
        'en-US': 'Search window in days (default: 30)',
        'en-GB': 'Search window in days (default: 30)',
      });
      return o;
    });
  localized(perguntar, 'ask', '🤖 Ask your meetings — AI answers from the transcripts you can access');

  const configCmd = new SlashCommandBuilder()
    .setName('config')
    .setDescription('⚙️ Configurações do Kassinão neste servidor (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => {
      sc.setName('ata-canal')
        .setDescription('Define (ou limpa) o canal onde a ata resumida é postada')
        .addChannelOption((o) => {
          o.setName('canal')
            .setDescription('Canal de texto (vazio = limpar)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false);
          o.setNameLocalizations({ 'en-US': 'channel', 'en-GB': 'channel' });
          o.setDescriptionLocalizations({
            'en-US': 'Text channel (empty = clear)',
            'en-GB': 'Text channel (empty = clear)',
          });
          return o;
        });
      sc.setNameLocalizations({ 'en-US': 'minutes-channel', 'en-GB': 'minutes-channel' });
      sc.setDescriptionLocalizations({
        'en-US': 'Set (or clear) the channel where the minutes summary is posted',
        'en-GB': 'Set (or clear) the channel where the minutes summary is posted',
      });
      return sc;
    })
    .addSubcommand((sc) => {
      sc.setName('ver').setDescription('Mostra a configuração atual');
      sc.setNameLocalizations({ 'en-US': 'view', 'en-GB': 'view' });
      sc.setDescriptionLocalizations({
        'en-US': 'Show the current configuration',
        'en-GB': 'Show the current configuration',
      });
      return sc;
    });
  localized(configCmd, 'config', '⚙️ Kassinão settings for this server (admin)');

  const cmds = [gravar, parar, nota, status, ajuda, gravacoes, autorecord, perguntar, configCmd, sobre];

  // /mcp só existe quando o conector de IA está habilitado (MCP_SECRET definido).
  if (config.mcpEnabled) {
    const mcp = new SlashCommandBuilder()
      .setName('mcp')
      .setDescription('🔌 Conecta seu assistente de IA (Claude/Cursor) às gravações')
      .addSubcommand((sc) => {
        sc.setName('novo').setDescription('Gera um código para conectar seu assistente de IA');
        sc.setNameLocalizations({ 'en-US': 'new', 'en-GB': 'new' });
        sc.setDescriptionLocalizations({
          'en-US': 'Generate a code to connect your AI assistant',
          'en-GB': 'Generate a code to connect your AI assistant',
        });
        return sc;
      })
      .addSubcommand((sc) => {
        sc.setName('revogar-tudo').setDescription('Revoga todos os seus conectores de IA');
        sc.setNameLocalizations({ 'en-US': 'revoke-all', 'en-GB': 'revoke-all' });
        sc.setDescriptionLocalizations({
          'en-US': 'Revoke all your AI connectors',
          'en-GB': 'Revoke all your AI connectors',
        });
        return sc;
      });
    localized(mcp, 'mcp', '🔌 Connect your AI assistant (Claude/Cursor) to the recordings');
    cmds.push(mcp);
  }

  return cmds.map((c) => c.toJSON());
}

async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.token);
  const body = buildCommands();
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body });
    console.log(`Comandos registrados no servidor ${config.guildId}.`);
  } else {
    // Sem GUILD_ID: registra em cada servidor onde o bot está (aparecem na hora,
    // sem esperar a propagação global de até 1h). Fallback global se ainda não
    // estiver em nenhum servidor.
    const guildIds = [...client.guilds.cache.keys()];
    if (guildIds.length > 0) {
      await Promise.all(
        guildIds.map((gid) => rest.put(Routes.applicationGuildCommands(config.applicationId, gid), { body })),
      );
      console.log(`Comandos registrados em ${guildIds.length} servidor(es) (aparecem na hora).`);
    } else {
      await rest.put(Routes.applicationCommands(config.applicationId), { body });
      console.log('Comandos registrados globalmente (podem levar até 1h para aparecer).');
    }
  }
}

// ---------- ciclo de vida das sessões ----------

function guildBusy(guildId: string): boolean {
  return sessionManager.isBusy(guildId);
}

class RecordingBusyError extends Error {
  constructor(readonly phase: 'starting' | 'recording' | 'stopping') {
    super(`recording ${phase}`);
    this.name = 'RecordingBusyError';
  }
}

function currentBusyError(guildId: string): RecordingBusyError {
  if (sessionManager.startingInfo(guildId)) return new RecordingBusyError('starting');
  if (sessionManager.stoppingSession(guildId)) return new RecordingBusyError('stopping');
  return new RecordingBusyError('recording');
}

async function startSession(opts: {
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  startedBy: { id: string; name: string } | null;
  locale: Locale;
  auto: boolean;
}): Promise<RecordingSession> {
  if (shuttingDown) {
    throw new Error(opts.locale === 'pt' ? 'o bot está reiniciando' : 'the bot is restarting');
  }
  // Reserva ANTES do primeiro await. Dois /gravar, manual + automático ou duas
  // regras no mesmo guild nunca atravessam juntos esta fronteira.
  const reservation = sessionManager.reserveStart(opts.guild.id, opts.voiceChannel.id, opts.voiceChannel.name);
  if (!reservation) throw currentBusyError(opts.guild.id);
  let session: RecordingSession | undefined;
  try {
    // Guarda de disco: não começa uma gravação que vai corromper por falta de espaço.
    const free = freeMB();
    if (free < config.minFreeMbStart) {
      throw new Error(
        opts.locale === 'pt'
          ? `sem espaço em disco suficiente no servidor (${free} MB livres) — apague gravações antigas primeiro`
          : `not enough disk space on the server (${free} MB free) — delete old recordings first`,
      );
    }

    session = new RecordingSession(opts);
    if (!sessionManager.attachStarting(reservation, session)) throw new RecordingStartCancelledError();
    session.onAutoStop = (s, reason) => {
      void stopSession(s, reason).catch((err) => console.error(`Erro encerrando ${s.id}:`, err));
    };
    await session.start(reservation.signal);
    if (shuttingDown || reservation.signal.aborted) throw new RecordingStartCancelledError();
    if (opts.guild.members.me?.voice.channelId !== opts.voiceChannel.id) {
      throw new Error(
        opts.locale === 'pt'
          ? 'fui movido para outro canal durante o início; não gravei nenhum dos dois'
          : 'I was moved to another channel while starting; neither channel was recorded',
      );
    }
    if (session.meta.status !== 'recording' || !sessionManager.commitStart(reservation, session)) {
      throw new RecordingStartCancelledError();
    }

    // Uma regra automática no mesmo canal fica desarmada mesmo quando o início
    // foi manual. Assim /parar não religa a gravação enquanto a sala segue cheia.
    if (autoRecordStore.get(opts.guild.id, opts.voiceChannel.id)) {
      setArmed(opts.guild.id, opts.voiceChannel.id, false);
    }
    // quem entrou DURANTE o start não disparou presença (a sessão ainda não
    // estava ativa no manager) — completa agora e reavalia sala vazia.
    session.snapshotPresence();
    scheduleAutoRecordCheck(opts.guild, session.currentChannelId);
    return session;
  } catch (err) {
    if (session && sessionManager.get(opts.guild.id) === session) {
      sessionManager.delete(opts.guild.id, session);
    }
    if (session?.meta.status === 'recording') await session.abortStart().catch(() => {});
    throw err;
  } finally {
    sessionManager.releaseStart(reservation);
  }
}

/** Sessões já processadas por afterSessionEnd — o hook não é idempotente sozinho
 *  (stopSession e onAutoStop podem correr para a mesma sessão). */
const endedSessions = new BoundedIdSet(500);

/** Pós-fim de gravação: rearma o auto-record quando faz sentido, reavalia os canais e transcreve. */
function afterSessionEnd(session: RecordingSession, reason: StopReason): void {
  if (!endedSessions.addOnce(session.id)) return; // roda uma única vez por sessão

  // O shutdown não inicia trabalho novo, mas deixa a intenção persistida antes
  // de sair. A limpeza não pode apagar o áudio no intervalo até o próximo boot.
  if (session.meta.participants.length > 0 && !session.meta.transcription) {
    session.meta.transcription = transcriptionEnabled() ? { status: 'pending', attempts: 0 } : { status: 'disabled' };
    saveMeta(session.meta);
  }

  // Em SHUTDOWN nada de trabalho novo: nem rearme de auto-record (dispararia uma
  // sessão-fantasma que morre no exit), nem cook/transcrição (queimaria attempts).
  // O boot recovery cobre tudo do zero.
  if (shuttingDown) return;

  const channelId = session.voiceChannel.id;
  // Limite de horas com a reunião ainda rolando: rearma para recomeçar sozinha
  // e cobrir o resto. Kick/movimento não rearma: pode ser ação de moderação.
  const channelHasAutoRule = autoRecordStore.get(session.guild.id, channelId) !== undefined;
  if (shouldRearmAutoRecord(session.auto || channelHasAutoRule, reason)) {
    setArmed(session.guild.id, channelId, true);
  }
  if (channelHasAutoRule && (reason === 'desconectado' || reason === 'canal-alterado')) {
    void alertOwners(
      `autorecord-interrupted:${session.guild.id}:${channelId}`,
      `A gravação em **#${safeName(session.voiceChannel.name)}** (canal com auto-record) foi ${reason === 'canal-alterado' ? 'interrompida porque moveram o bot' : 'encerrada após desconexão'}. Não reiniciei sozinho para respeitar uma possível ação de moderação.`,
    );
  }
  // Reavalia o canal da sessão E todas as regras do guild: enquanto este servidor
  // estava ocupado, outro canal com auto-record pode ter enchido sem disparar.
  scheduleAutoRecordCheck(session.guild, channelId);
  for (const rule of autoRecordStore.list(session.guild.id)) {
    scheduleAutoRecordCheck(session.guild, rule.channelId);
  }
  // Pré-cozinha o mix MP3 em segundo plano: o primeiro clique no player deixa de
  // esperar minutos de ffmpeg (o cook tem semáforo próprio e cacheia o resultado).
  if (session.meta.participants.length > 0) {
    cook(session.meta, 'mix').catch((err) =>
      console.warn(`Pré-cook do mix de ${session.id} falhou (fica pro primeiro clique):`, (err as Error).message),
    );
    enqueueTranscription(session.id, (meta) => notifyTranscription(meta, session.locale));
  } else {
    // gravação vazia: marca 'disabled' JÁ (a página não pode prometer "na fila"
    // por minutos enquanto a fila serial chega numa transcrição que nunca haverá)
    const meta = readMeta(session.id);
    if (meta && !meta.transcription) {
      meta.transcription = { status: 'disabled' };
      saveMeta(meta);
    }
  }
}

/** Avisa no chat do canal de voz (e na DM de quem iniciou) que a transcrição terminou. */
async function notifyTranscription(meta: RecordingMeta, locale: Locale): Promise<void> {
  const state = meta.transcription;
  if (!state || (state.status !== 'done' && state.status !== 'partial' && state.status !== 'error')) return;
  const minutesDone = meta.minutes?.status === 'done';
  // gravação curtinha sem fala detectada: não prometer "transcrição pronta!"
  const emptyDone = state.status === 'done' && (readTranscript(meta.id)?.length ?? 0) === 0;
  const text = emptyDone
    ? t(locale, 'transcript.empty-note', { url: pageUrl(meta.id) })
    : state.status === 'done'
      ? minutesDone
        ? t(locale, 'minutes.ready', { url: pageUrl(meta.id) }) // ata + transcrição prontas
        : t(locale, 'transcript.ready', { url: pageUrl(meta.id) })
      : state.status === 'partial'
        ? t(locale, 'transcript.partial', {
            names:
              (state.pendingTracks ?? []).map((n) => safeName(n)).join(', ') ||
              (locale === 'pt' ? 'algumas faixas' : 'some tracks'),
            url: pageUrl(meta.id),
          })
        : t(locale, 'transcript.failed', { error: shortError(state.error, locale) });

  // A ata visível SEM login é o momento "uau": resumo + decisões + ações direto
  // no Discord (o link continua sendo a fonte completa).
  const embeds = minutesDone ? buildMinutesEmbed(meta, locale) : [];

  // canal de destino configurável (/config ata-canal); fallback = chat do canal de voz.
  // ACESSO: só transmitir a ata pro canal configurado se a gravação for de um canal de voz
  // visível a @everyone. Senão, a audiência do canal público excede quem tem acesso à
  // gravação (checkAccess concede view via ViewChannel no canal de voz), vazando resumo/
  // decisões de uma reunião RESTRITA. Restrito → chat do canal de voz (audiência = conjunto
  // de acesso) + DM do iniciador, que já casam com a regra de acesso.
  const cfg = guildConfigStore.get(meta.guildId);
  let allowConfigured = false;
  if (minutesDone && cfg.minutesChannelId) {
    // três estados, decididos por allowMinutesBroadcast: canal avaliável (checagem ao
    // vivo vence), canal DELETADO (efêmero → vale o snapshot do início da gravação),
    // indeterminado/transitório (fail-closed).
    let liveEveryoneViewable: boolean | undefined;
    let channelDeleted = false;
    try {
      const guild = client.guilds.cache.get(meta.guildId);
      let vc = guild ? (guild.channels.cache.get(meta.voiceChannelId) ?? null) : null;
      if (guild && !vc) {
        try {
          vc = await guild.channels.fetch(meta.voiceChannelId);
        } catch (err) {
          // 10003 Unknown Channel = confirmado apagado; qualquer outro erro = transitório
          if (err && typeof err === 'object' && (err as { code?: unknown }).code === 10003) channelDeleted = true;
          else throw err;
        }
      }
      if (guild && vc && 'permissionsFor' in vc) {
        liveEveryoneViewable = vc.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
      }
    } catch {
      // transitório: liveEveryoneViewable fica undefined e channelDeleted false → nega
    }
    allowConfigured = allowMinutesBroadcast({
      liveEveryoneViewable,
      channelDeleted,
      snapshotEveryoneViewable: meta.sourceEveryoneViewable,
    });
    if (!allowConfigured) {
      // sem isso o admin do /config ata-canal acha que "às vezes não posta" é bug
      console.log(
        `Ata de ${meta.id}: origem restrita/indeterminada — redirecionada do canal configurado pro chat do canal de voz + DM.`,
      );
    }
  }
  const targetId = allowConfigured && cfg.minutesChannelId ? cfg.minutesChannelId : meta.voiceChannelId;
  let delivered = false;
  try {
    const channel = (await client.channels.fetch(targetId)) as TextBasedChannel | null;
    // defesa em profundidade: NUNCA postar ata fora do servidor da gravação
    // (channels.fetch é global; um guildconfig.json corrompido não pode vazar ata)
    const sameGuild = channel && 'guildId' in channel && channel.guildId === meta.guildId;
    if (channel && sameGuild && 'send' in channel) {
      await channel.send({ content: text, embeds });
      delivered = true;
    } else if (!sameGuild) throw new Error('canal de outro servidor');
  } catch {
    // sem acesso ao canal configurado — tenta o chat do canal de voz como fallback
    if (targetId !== meta.voiceChannelId) {
      try {
        const vc = (await client.channels.fetch(meta.voiceChannelId)) as TextBasedChannel | null;
        if (vc && 'send' in vc) {
          await vc.send({ content: text, embeds });
          delivered = true;
        }
      } catch {
        // a página continua mostrando tudo
      }
    }
  }
  if (meta.startedBy) {
    try {
      await client.users.send(meta.startedBy.id, { content: text, embeds });
      delivered = true;
    } catch {
      // DM fechada — canal cobre
    }
  }
  // Marca o aviso como entregue SÓ se algum send funcionou — falha transiente
  // de rede não pode significar "o link nunca chega"; o boot re-tenta.
  if (delivered) {
    const fresh = readMeta(meta.id);
    if (fresh && !fresh.notifiedAt) {
      fresh.notifiedAt = Date.now();
      saveMeta(fresh);
    }
  }
  if (minutesDone) await deliverMinutesWebhookIfNeeded(meta);
}

const webhookDeliveries = new Map<string, Promise<void>>();

/** Webhook persistente e idempotente em memória; o boot retoma os não confirmados. */
function deliverMinutesWebhookIfNeeded(meta: RecordingMeta): Promise<void> {
  if (!config.minutesWebhookUrl || meta.minutes?.status !== 'done') return Promise.resolve();
  const existing = webhookDeliveries.get(meta.id);
  if (existing) return existing;
  const task = (async () => {
    const fresh = readMeta(meta.id);
    if (!fresh || fresh.webhookSentAt) return;
    try {
      await postMinutesWebhook(fresh);
      const ok = readMeta(meta.id);
      if (ok && !ok.webhookSentAt) {
        ok.webhookSentAt = Date.now();
        saveMeta(ok);
      }
    } catch (err) {
      console.warn(`Webhook da ata (${meta.id}) falhou (vai retentar no próximo boot):`, (err as Error).message);
    }
  })().finally(() => webhookDeliveries.delete(meta.id));
  webhookDeliveries.set(meta.id, task);
  return task;
}

/** Embed com o essencial da ata (resumo + decisões + ações), truncado com folga. */
function buildMinutesEmbed(meta: RecordingMeta, locale: Locale): EmbedBuilder[] {
  const minutes = readMinutes(meta.id);
  if (!minutes) return [];
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(safeSlice(`📋 ${t(locale, 'minutes.embed-title', { channel: safeName(meta.voiceChannelName) })}`, 256))
    .setURL(pageUrl(meta.id));
  if (minutes.resumo) embed.setDescription(safeSlice(safeName(minutes.resumo), 2000));
  if (minutes.decisoes.length > 0) {
    embed.addFields({
      name: t(locale, 'minutes.embed-decisions'),
      value: safeSlice(
        minutes.decisoes
          .slice(0, 5)
          .map((d) => `• ${safeName(d)}`)
          .join('\n'),
        1024,
      ),
    });
  }
  if (minutes.acoes.length > 0) {
    embed.addFields({
      name: t(locale, 'minutes.embed-actions'),
      value: safeSlice(
        minutes.acoes
          .slice(0, 8)
          .map((a) => {
            const extra = [a.responsavel && safeName(a.responsavel), a.prazo && safeName(a.prazo)]
              .filter(Boolean)
              .join(' — ');
            return `☐ ${safeName(a.tarefa)}${extra ? ` *(${extra})*` : ''}`;
          })
          .join('\n'),
        1024,
      ),
    });
  }
  return [embed];
}

/** POST da ata pro webhook do operador (JSON estruturado, não formato Discord). */
async function postMinutesWebhook(meta: RecordingMeta): Promise<void> {
  const minutes = readMinutes(meta.id);
  if (!minutes) return;
  const response = await fetch(config.minutesWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'minutes.ready',
      recordingId: meta.id,
      url: pageUrl(meta.id),
      guildName: meta.guildName,
      channelName: meta.voiceChannelName,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      participants: meta.participants.map((p) => p.name),
      minutes,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

// ---------- /config (por servidor, admin) ----------

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: t(l, 'config.no-permission'), ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === 'ata-canal') {
    const channel = interaction.options.getChannel('canal');
    if (channel) {
      guildConfigStore.set(interaction.guild.id, { minutesChannelId: channel.id, updatedBy: interaction.user.id });
      await interaction.reply({
        content: t(l, 'config.minutes-channel-set', { channel: `<#${channel.id}>` }),
        ephemeral: true,
      });
    } else {
      guildConfigStore.set(interaction.guild.id, { minutesChannelId: undefined, updatedBy: interaction.user.id });
      await interaction.reply({ content: t(l, 'config.minutes-channel-cleared'), ephemeral: true });
    }
    return;
  }
  // ver
  const cfg = guildConfigStore.get(interaction.guild.id);
  const lines = [
    `**${t(l, 'config.title')}**`,
    cfg.minutesChannelId
      ? t(l, 'config.view-minutes-channel', { channel: `<#${cfg.minutesChannelId}>` })
      : t(l, 'config.view-minutes-channel-none'),
  ];
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

// ---------- /perguntar (RAG nas reuniões, dentro do Discord) ----------

/** Teto de concorrência e custo por processo (o bot roda em uma única instância). */
const MAX_CONCURRENT_ASKS = 2;
const MAX_ASK_ATTEMPTS_PER_HOUR = 30;
const MAX_ASK_ATTEMPTS_PER_HOUR_GUILD = 120;
const MAX_ASKS_PER_HOUR = 10;
const MAX_ASKS_PER_HOUR_GUILD = 30;
const MAX_ASKS_PER_HOUR_GLOBAL = 60;
const askLimiter = new AskLimiter({
  maxConcurrent: MAX_CONCURRENT_ASKS,
  maxAttemptsPerUser: MAX_ASK_ATTEMPTS_PER_HOUR,
  maxAttemptsPerGuild: MAX_ASK_ATTEMPTS_PER_HOUR_GUILD,
  maxPerUser: MAX_ASKS_PER_HOUR,
  maxPerGuild: MAX_ASKS_PER_HOUR_GUILD,
  maxGlobal: MAX_ASKS_PER_HOUR_GLOBAL,
  windowMs: 60 * 60 * 1000,
});
const manualRecordingStartLimiter = new ManualRecordingStartLimiter({
  userCooldownMs: config.manualRecordUserCooldownSec * 1000,
  guildCooldownMs: config.manualRecordGuildCooldownSec * 1000,
  maxStartsPerGuild24h: config.manualRecordGuildStartsPer24h,
});

async function handlePerguntar(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  if (!minutesEnabled()) {
    await interaction.reply({ content: t(l, 'ask.disabled'), ephemeral: true });
    return;
  }
  const question = interaction.options.getString('pergunta', true);
  const days = interaction.options.getInteger('dias') ?? 30;
  const admission = askLimiter.reserve(interaction.user.id, interaction.guild.id);
  if (admission !== 'accepted') {
    const key = admission.startsWith('rate-') ? 'ask.rate-limit' : 'ask.busy';
    await interaction.reply({ content: t(l, key), ephemeral: true });
    return;
  }
  try {
    await interaction.deferReply({ ephemeral: true });
    const member = interaction.member as GuildMember;
    const nowMs = Date.now();
    const temporal = resolveAskTemporalIntent(question, nowMs, config.timezone, l);
    const period = temporal.label ?? t(l, 'ask.period-days', { days });
    const range = temporal.range ?? resolveRange({ last: `${days}d` }, nowMs, config.timezone);
    // MESMA regra de acesso da web: só reuniões que essa pessoa pode abrir
    // A data escrita na pergunta vence a opção `dias`; sem data, vale a janela do comando.
    const candidates = listGuildMetasInRange(interaction.guild.id, range.fromMs, range.toMs)
      .filter((m) => m.status === 'done')
      .filter((m) => transcriptReady(m));
    const authorized = authorizeAskMetas(candidates, (meta) => memberCanAccessRecording(member, meta));
    if (authorized.metas.length === 0) {
      await interaction.editReply(
        temporal.label ? t(l, 'ask.no-period', { period: temporal.label }) : t(l, 'ask.no-meetings', { days }),
      );
      return;
    }
    const result = await answerQuestion(question, authorized, l, {
      nowMs,
      timezone: config.timezone,
      fallbackRange: range,
      fallbackPeriodLabel: period,
      beforeLlm: () => {
        const charge = askLimiter.charge(interaction.user.id, interaction.guild!.id);
        if (charge !== 'accepted') throw new AskRateLimitError(charge);
      },
    });
    if (!result.answer) {
      await interaction.editReply(t(l, 'ask.no-evidence'));
      return;
    }
    console.log(
      `Perguntar concluído: guild=${interaction.guild.id} período=${period} candidatas=${result.candidateMeetings} com-evidência=${result.matchedMeetings} reuniões=${result.meetingsUsed} chunks=${result.chunksUsed} contexto=${result.contextChars}`,
    );
    await interaction.editReply(`${result.answer}\n\n${t(l, 'ask.footer', { n: result.meetingsUsed, period })}`);
  } catch (err) {
    if (err instanceof AskRateLimitError) {
      await interaction.editReply(t(l, 'ask.rate-limit')).catch(() => {});
      return;
    }
    console.error('Erro no /perguntar:', err);
    await interaction.editReply(t(l, 'ask.error', { error: shortError((err as Error).message, l) })).catch(() => {});
  } finally {
    askLimiter.release(interaction.user.id);
  }
}

async function stopSession(
  session: RecordingSession,
  reason: StopReason,
  stoppedBy?: { id: string; name: string },
): Promise<void> {
  const claim = sessionManager.beginStop(session.guild.id, session);
  try {
    await session.stop(reason, stoppedBy);
    afterSessionEnd(session, reason);
  } finally {
    if (claim === 'claimed') sessionManager.finishStop(session.guild.id, session);
  }
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
  if (existing) {
    await interaction.reply({
      content: canAnnotate(existing, member)
        ? t(l, 'err.already-recording', { channel: `#${existing.voiceChannel.name}` })
        : t(l, 'err.recording-busy'),
      ephemeral: true,
    });
    return;
  }
  const starting = sessionManager.startingInfo(interaction.guild.id);
  if (starting) {
    const startingChannel = interaction.guild.channels.cache.get(starting.channelId);
    const canSeeStarting = startingChannel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    await interaction.reply({
      content: canSeeStarting
        ? t(l, 'err.recording-starting', { channel: `#${starting.channelName}` })
        : t(l, 'err.recording-busy'),
      ephemeral: true,
    });
    return;
  }
  const stoppingSession = sessionManager.stoppingSession(interaction.guild.id);
  if (stoppingSession) {
    await interaction.reply({
      content: canAnnotate(stoppingSession, member) ? t(l, 'err.recording-stopping') : t(l, 'err.recording-busy'),
      ephemeral: true,
    });
    return;
  }
  const manualAccess = {
    canView: voiceChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false,
    isPresent: member.voice.channelId === voiceChannel.id,
    canManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
  };
  if (!manualAccess.canView) {
    await interaction.reply({
      content: t(l, 'err.record-no-access', { channel: `#${voiceChannel.name}` }),
      ephemeral: true,
    });
    return;
  }
  if (!canManuallyStartRecording(manualAccess)) {
    await interaction.reply({
      content: t(l, 'err.must-join-target', { channel: `#${voiceChannel.name}` }),
      ephemeral: true,
    });
    return;
  }
  if (!recordingChannelReady(voiceChannel)) {
    await interaction.reply({
      content: t(l, 'err.cannot-record-here', { channel: `#${voiceChannel.name}` }),
      ephemeral: true,
    });
    return;
  }

  const reservation = manualRecordingStartLimiter.reserve(
    interaction.guild.id,
    interaction.user.id,
    manualAccess.canManageGuild,
  );
  if (!reservation.ok) {
    await interaction.reply({
      content: t(l, 'err.recording-start-limited', { wait: formatDuration(reservation.retryAfterMs) }),
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    const session = await startSession({
      guild: interaction.guild,
      voiceChannel,
      startedBy: { id: interaction.user.id, name: member.displayName ?? interaction.user.username },
      locale: l,
      auto: false,
    });
    reservation.commit();
    const panel = session.panelJumpUrl;
    await interaction.editReply(
      panel
        ? t(l, 'record.started', { channel: `#${voiceChannel.name}`, panel })
        : t(l, 'record.started-no-panel', { channel: `#${voiceChannel.name}`, url: session.pageUrl }),
    );
  } catch (err) {
    reservation.rollback();
    if (err instanceof RecordingStartCancelledError) {
      await interaction.editReply(t(l, 'record.start-cancelled'));
    } else if (err instanceof RecordingBusyError) {
      const info = sessionManager.startingInfo(interaction.guild.id);
      if (err.phase === 'recording') {
        const active = sessionManager.get(interaction.guild.id);
        await interaction.editReply(
          active && canAnnotate(active, member)
            ? t(l, 'err.already-recording', { channel: `#${active.voiceChannel.name}` })
            : t(l, 'err.recording-busy'),
        );
      } else {
        if (err.phase === 'starting' && info) {
          const channel = interaction.guild.channels.cache.get(info.channelId);
          const canSee = channel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
          await interaction.editReply(
            canSee ? t(l, 'err.recording-starting', { channel: `#${info.channelName}` }) : t(l, 'err.recording-busy'),
          );
        } else {
          const stopping = sessionManager.stoppingSession(interaction.guild.id);
          await interaction.editReply(
            stopping && canAnnotate(stopping, member) ? t(l, 'err.recording-stopping') : t(l, 'err.recording-busy'),
          );
        }
      }
    } else {
      await interaction.editReply(reportManualRecordingStartFailure(err, l));
    }
  }
}

async function handleParar(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const expectedSessionId = interaction.isButton() ? controlSessionId(interaction.customId, STOP_BUTTON_ID) : undefined;
  if (interaction.isButton() && !expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
    return;
  }

  const session = sessionManager.get(interaction.guild.id);
  if (session && expectedSessionId && session.id !== expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
    return;
  }
  if (!session) {
    const starting = sessionManager.startingInfo(interaction.guild.id);
    const controlsThisStart =
      !interaction.isButton() || (expectedSessionId !== undefined && starting?.session?.id === expectedSessionId);
    if (starting && controlsThisStart) {
      const member = interaction.member as GuildMember | null;
      const channel = interaction.guild.channels.cache.get(starting.channelId);
      if (!member || !channel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
        await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
        return;
      }
      const cancelled = sessionManager.cancelStart(interaction.guild.id);
      if (cancelled?.session) void cancelled.session.abortStart().catch(() => {});
      await interaction.reply({ content: t(l, 'record.start-cancelled'), ephemeral: true });
      return;
    }
    if (starting && interaction.isButton()) {
      await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
      return;
    }
    const stopping = sessionManager.stoppingSession(interaction.guild.id);
    if (stopping) {
      if (expectedSessionId && stopping.id !== expectedSessionId) {
        await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
        return;
      }
      const member = interaction.member as GuildMember | null;
      await interaction.reply({
        content: canAnnotate(stopping, member) ? t(l, 'record.stopping') : t(l, 'err.no-recording'),
        ephemeral: true,
      });
      return;
    }
    if (interaction.isButton()) {
      await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
      return;
    }
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember | null;
  // Encerrar é destrutivo e irreversível — exige o mesmo acesso do /nota (ver o canal).
  if (!canAnnotate(session, member)) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  const empty = session.participantNames.length === 0;
  // A chamada entra no estado "encerrando" sincronamente, antes do primeiro
  // await. Dois /parar não podem ambos assumir a mesma sessão.
  const stopping = stopSession(session, 'manual', {
    id: interaction.user.id,
    name: member?.displayName ?? interaction.user.username,
  });
  await interaction.deferReply({ ephemeral: true });
  try {
    await stopping;
    const key = session.meta.audioIncomplete
      ? 'record.stopped-incomplete'
      : empty
        ? 'record.stopped-empty'
        : 'record.stopped';
    await interaction.editReply(t(l, key, { url: session.pageUrl }));
  } catch (err) {
    console.error(`Erro encerrando ${session.id}:`, err);
    await interaction.editReply(t(l, 'record.stop-failed', { url: session.pageUrl }));
  }
}

/** Permissões mínimas para entrar E avisar visivelmente antes de captar áudio. */
function recordingChannelReady(channel: VoiceBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me || !channel.joinable || !channel.isTextBased()) return false;
  return (
    channel
      .permissionsFor(me)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ]) ?? false
  );
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
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  const offset = formatOffset(session.durationMs);
  const added = session.addNote(
    member.displayName ?? interaction.user.username,
    interaction.options.getString('texto', true),
  );
  await interaction.reply({ content: t(l, added ? 'note.added' : 'note.discarded', { offset }), ephemeral: true });
}

const markClicks = new MarkClickDeduper();

/** 📌 de um toque: marca o momento SEM modal/digitação — a fricção mata o bookmark. */
async function handleMarkButton(interaction: ButtonInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const expectedSessionId = controlSessionId(interaction.customId, MARK_BUTTON_ID);
  if (!expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
    return;
  }
  const session = interaction.guild ? sessionManager.get(interaction.guild.id) : undefined;
  if (!session || session.id !== expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
    return;
  }
  if (!canAnnotate(session, interaction.member as GuildMember)) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  if (!markClicks.accept(session.id, interaction.user.id)) {
    await interaction.reply({ content: t(l, 'note.mark-duplicate'), ephemeral: true });
    return;
  }
  const atMs = session.durationMs;
  const member = interaction.member as GuildMember | null;
  const added = session.addNote(
    (member && 'displayName' in member ? member.displayName : null) ?? interaction.user.username,
    t(session.locale, 'note.mark-text'),
    atMs,
  );
  await interaction.reply({
    content: t(l, added ? 'note.marked' : 'note.discarded', { offset: formatOffset(atMs) }),
    ephemeral: true,
  });
}

async function handleNoteButton(interaction: ButtonInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const expectedSessionId = controlSessionId(interaction.customId, NOTE_BUTTON_ID);
  if (!expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
    return;
  }
  const session = interaction.guild ? sessionManager.get(interaction.guild.id) : undefined;
  if (!session || session.id !== expectedSessionId) {
    await interaction.reply({ content: t(l, 'err.stale-control'), ephemeral: true });
    return;
  }
  if (!canAnnotate(session, interaction.member as GuildMember)) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
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
  const member = interaction.member as GuildMember | null;
  // A permissão pode mudar entre abrir e enviar o modal. Revalida no submit.
  if (!canAnnotate(session, member)) {
    await interaction.reply({ content: t(l, 'err.no-recording'), ephemeral: true });
    return;
  }
  const clickAt = Number(rawAt);
  const atMs = Number.isFinite(clickAt)
    ? Math.min(Math.max(0, Math.trunc(clickAt)), session.durationMs)
    : session.durationMs;
  const added = session.addNote(
    (member && 'displayName' in member ? member.displayName : null) ?? interaction.user.username,
    interaction.fields.getTextInputValue(NOTE_INPUT_ID),
    atMs,
  );
  await interaction.reply({
    content: t(l, added ? 'note.added' : 'note.discarded', { offset: formatOffset(atMs) }),
    ephemeral: true,
  });
}

const HELP_BUTTON_PREFIX = 'kassinao_help';
const HELP_TOPICS: Record<string, { btn: string; topic: string }> = {
  record: { btn: 'help.btn-record', topic: 'help.topic-record' },
  ask: { btn: 'help.btn-ask', topic: 'help.topic-ask' },
  downloads: { btn: 'help.btn-downloads', topic: 'help.topic-downloads' },
  privacy: { btn: 'help.btn-privacy', topic: 'help.topic-privacy' },
  auto: { btn: 'help.btn-auto', topic: 'help.topic-auto' },
};

function buildHelpEmbed(l: Locale): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(t(l, 'help.title'))
    .setDescription(t(l, 'help.intro'))
    .addFields(
      { name: t(l, 'help.commands'), value: t(l, 'help.cmd-list') },
      { name: t(l, 'help.flow'), value: t(l, 'help.flow-body') },
      { name: t(l, 'help.perms'), value: t(l, 'help.perms-body') },
    );
  // só mostra o conector de IA quando ele está ligado neste servidor
  if (config.mcpEnabled) {
    embed.addFields({ name: t(l, 'help.mcp-title'), value: t(l, 'help.mcp-body', { url: config.appUrl }) });
  }
  return embed.setFooter({ text: t(l, 'help.footer') });
}

/** Payload do /ajuda com botões pra explorar cada tópico (onboarding interativo). */
function buildHelpPayload(l: Locale) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...Object.entries(HELP_TOPICS).map(([key, v]) =>
      new ButtonBuilder()
        .setCustomId(`${HELP_BUTTON_PREFIX}:${key}`)
        .setLabel(t(l, v.btn))
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [buildHelpEmbed(l)], components: [row] };
}

async function handleAjuda(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  await interaction.reply({ ...buildHelpPayload(l), ephemeral: true });
}

async function handleHelpButton(interaction: ButtonInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const key = interaction.customId.split(':')[1];
  const topic = HELP_TOPICS[key]?.topic;
  // passa os valores REAIS de config pros tópicos (limite de horas, retenção, url).
  // A frase de retenção muda inteira quando RETENTION_DAYS=0 (nada expira sozinho).
  const days = config.retentionDays;
  const vars = {
    hours: config.maxRecordingHours,
    days,
    url: config.appUrl,
    retention: t(l, config.audioRetentionUnlimited ? 'help.retention-unlimited' : 'help.retention-limited', { days }),
    retentionPrivacy: t(
      l,
      config.audioRetentionUnlimited ? 'help.retention-privacy-unlimited' : 'help.retention-privacy-limited',
      { days },
    ),
  };
  await interaction.reply({ content: topic ? t(l, topic, vars) : t(l, 'help.intro'), ephemeral: true });
}

async function handleSobre(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎙️ Kassinão')
    .setDescription(t(l, 'about.desc'))
    .addFields(
      { name: t(l, 'about.author'), value: 'Mauro Marques' },
      { name: t(l, 'about.license'), value: 'GNU AGPL-3.0-or-later' },
      { name: t(l, 'about.source'), value: SOURCE_URL },
    )
    .setFooter({ text: t(l, 'about.footer') });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const session = sessionManager.get(interaction.guild.id);
  if (!session) {
    const member = interaction.member as GuildMember | null;
    const starting = sessionManager.startingInfo(interaction.guild.id);
    if (starting) {
      const channel = interaction.guild.channels.cache.get(starting.channelId);
      const startingSession = starting.session;
      const canAccess =
        !!member &&
        (startingSession
          ? memberCanAccessRecording(member, startingSession.meta)
          : (channel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false));
      if (!canAccess) {
        await interaction.editReply(t(l, 'status.none'));
      } else {
        await interaction.editReply(t(l, 'status.starting', { channel: `#${safeName(starting.channelName)}` }));
      }
      return;
    }
    const stopping = sessionManager.stoppingSession(interaction.guild.id);
    if (stopping) {
      await interaction.editReply(
        member && memberCanAccessRecording(member, stopping.meta) ? t(l, 'record.stopping') : t(l, 'status.none'),
      );
      return;
    }
    await interaction.editReply(t(l, 'status.none'));
    return;
  }
  const member = interaction.member as GuildMember | null;
  if (!member || !memberCanAccessRecording(member, session.meta)) {
    await interaction.editReply(t(l, 'status.none'));
    return;
  }
  // sala ATUAL do bot (ele pode ter sido arrastado depois do início)
  const currentChannel = interaction.guild.channels.cache.get(session.currentChannelId);
  const room = currentChannel?.isVoiceBased() ? currentChannel : session.voiceChannel;
  const inRoom = room.members.filter((m) => !m.user.bot).size;
  const starter = session.meta.startedBy ? safeName(session.meta.startedBy.name) : t(l, 'recordings.by-auto');
  await interaction.editReply(
    t(l, 'status.recording', {
      channel: `#${safeName(session.voiceChannel.name)}`,
      duration: formatDuration(session.durationMs),
      inRoom,
      spoke: session.participantNames.length,
      notes: session.meta.notes.length,
      starter,
      url: session.pageUrl,
    }),
  );
}

/**
 * No Discord a própria interaction já prova membership atual. O histórico fica
 * limitado a quem iniciou/esteve presente e admins, em qualquer tipo de canal.
 * Mesma política do acesso web/MCP.
 */
function memberCanAccessRecording(member: GuildMember, meta: RecordingMeta): boolean {
  if (recordingIdentityGrant(member.id, meta).view) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return false;
}

async function handleGravacoes(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember;
  // Filtra para SÓ as gravações que esta pessoa pode acessar (não vaza as outras).
  const all = listGuildMetas(interaction.guild.id, 100).filter((m) => memberCanAccessRecording(member, m));
  if (all.length === 0) {
    await interaction.reply({ content: t(l, 'recordings.none'), ephemeral: true });
    return;
  }
  const metas = all.slice(0, 5);
  const lines = metas.map((m) => {
    const when = `<t:${Math.floor(m.startedAt / 1000)}:f>`;
    const badge = recordingBadge(m, l);
    const who = m.startedBy ? `👤 ${safeName(m.startedBy.name)}` : `🤖 ${t(l, 'recordings.by-auto')}`;
    const dur = m.endedAt ? formatDuration(m.endedAt - m.startedAt) : `🔴 ${t(l, 'recordings.live')}`;
    // expiração pela CONFIG ATUAL (retenção ilimitada = sem ⏳, mesmo em meta antigo com data gravada)
    const exp = audioExpiryOf(m);
    const expires = exp && m.status !== 'recording' ? ` • ⏳ <t:${Math.floor(exp / 1000)}:R>` : '';
    return `**#${safeName(m.voiceChannelName)}** — ${when} • ${dur} • ${who} • 🎙️ ${m.participants.length} • ${badge}${expires}\n[${t(l, 'recordings.open')}](${pageUrl(m.id)})`;
  });
  let content = `**${t(l, 'recordings.title')}**\n${lines.join('\n')}`;
  if (all.length > metas.length) content += `\n${t(l, 'recordings.more', { n: all.length - metas.length })}`;
  // o índice web mostra TODAS (com busca) — aqui só cabem 5
  content += `\n${t(l, 'recordings.web', { url: `${config.appUrl}/app` })}`;
  content = safeSlice(content, 2000); // nomes de canal markdown-pesados estouram o limite do Discord
  await interaction.reply({ content, ephemeral: true });
}

/** Selo do estado de transcrição/ata pra lista de gravações. */
function recordingBadge(m: RecordingMeta, l: Locale): string {
  if (m.status === 'recording') return `🔴 ${t(l, 'recordings.live')}`;
  if (m.minutes?.status === 'done') return t(l, 'recordings.badge-ready');
  // erro com retry agendado ainda vai se resolver sozinho — não é falha definitiva
  if (m.transcription?.status === 'error' && !m.transcription.retryScheduled) return t(l, 'recordings.badge-failed');
  const ts = m.transcription?.status;
  const ms = m.minutes?.status;
  if (
    ts === 'pending' ||
    ts === 'running' ||
    ((ts === 'partial' || ts === 'error') && m.transcription?.retryScheduled) ||
    ms === 'pending' ||
    ms === 'running'
  )
    return t(l, 'recordings.badge-processing');
  if (ts === 'partial') return t(l, 'recordings.badge-partial');
  if (ts === 'done') return t(l, 'recordings.badge-transcript');
  return t(l, 'recordings.badge-none');
}

async function handleAutorecord(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!interaction.guild) {
    await interaction.reply({ content: t(l, 'err.guild-only'), ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  // Regras podem revelar canais privados e controlam gravação sem ação humana:
  // ligar, desligar E listar exigem Gerenciar Servidor.
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: t(l, 'autorecord.no-permission'), ephemeral: true });
    return;
  }
  if (sub === 'ligar') {
    const channel = interaction.options.getChannel('canal', true);
    const voiceChannel = interaction.guild.channels.cache.get(channel.id);
    const minimum = interaction.options.getInteger('minimo') ?? 1;
    if (!voiceChannel?.isVoiceBased() || !recordingChannelReady(voiceChannel)) {
      await interaction.reply({
        content: t(l, 'err.cannot-record-here', { channel: `#${channel.name}` }),
        ephemeral: true,
      });
      return;
    }
    const existed = autoRecordStore.get(interaction.guild.id, voiceChannel.id) !== undefined;
    autoRecordStore.set(interaction.guild.id, {
      channelId: voiceChannel.id,
      minimum,
      createdBy: interaction.user.id,
    });
    const activeHere =
      sessionManager.get(interaction.guild.id)?.voiceChannel.id === voiceChannel.id ||
      sessionManager.startingInfo(interaction.guild.id)?.channelId === voiceChannel.id ||
      sessionManager.stoppingSession(interaction.guild.id)?.voiceChannel.id === voiceChannel.id;
    setArmed(interaction.guild.id, voiceChannel.id, !activeHere);
    await interaction.reply({
      content: t(l, existed ? 'autorecord.updated' : 'autorecord.enabled', {
        channel: `#${channel.name}`,
        min: minimum,
        hours: config.maxRecordingHours,
      }),
      ephemeral: true,
    });
    // se o canal já está cheio, dispara
    scheduleAutoRecordCheck(interaction.guild, channel.id);
  } else if (sub === 'desligar') {
    const channel = interaction.options.getChannel('canal', true);
    const removed = autoRecordStore.remove(interaction.guild.id, channel.id);
    // se havia uma gravação automática rolando NESTE canal, avisa que ela continua
    const s = sessionManager.get(interaction.guild.id);
    const liveHere = removed && s?.auto && s.currentChannelId === channel.id && s.meta.status === 'recording';
    const key = liveHere ? 'autorecord.disabled-live' : removed ? 'autorecord.disabled' : 'autorecord.not-set';
    await interaction.reply({ content: t(l, key, { channel: `#${channel.name}` }), ephemeral: true });
  } else {
    const rules = autoRecordStore.list(interaction.guild.id);
    if (rules.length === 0) {
      await interaction.reply({ content: t(l, 'autorecord.view-none'), ephemeral: true });
      return;
    }
    const session = sessionManager.get(interaction.guild.id);
    const lines = rules.map((r) => {
      const recordingHere =
        session?.auto && session.currentChannelId === r.channelId && session.meta.status === 'recording';
      const state = recordingHere
        ? t(l, 'autorecord.state-recording')
        : isArmed(interaction.guild!.id, r.channelId)
          ? t(l, 'autorecord.state-armed')
          : t(l, 'autorecord.state-waiting');
      return t(l, 'autorecord.view-line', {
        state,
        channel: `<#${r.channelId}>`,
        min: r.minimum,
        by: r.createdBy ? `<@${r.createdBy}>` : '—',
      });
    });
    await interaction.reply({
      content: safeSlice(
        `**${t(l, 'autorecord.view-title')}**\n${lines.join('\n')}\n${t(l, 'autorecord.view-hint')}`,
        2000,
      ),
      ephemeral: true,
    });
  }
}

async function handleMcp(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  if (!config.mcpEnabled) {
    await interaction.reply({ content: t(l, 'err.generic'), ephemeral: true });
    return;
  }
  // /mcp é só para donos (allowlist explícita OWNER_IDS). Membros comuns usam
  // a página /app/conectar-ia (self-serve, com o próprio acesso) — não inferimos
  // "dono" de estar numa DM. Resposta SEMPRE efêmera; o código nunca é logado.
  if (!config.ownerIds.includes(interaction.user.id)) {
    await interaction.reply({
      // o template já traz o caminho ({url}/app/conectar-ia): passa SÓ a origem do app
      content: t(l, 'mcp.web-only', { url: config.appUrl }),
      ephemeral: true,
    });
    return;
  }
  const member = interaction.member as GuildMember | null;
  const name = (member && 'displayName' in member ? member.displayName : null) ?? interaction.user.username;
  if (interaction.options.getSubcommand() === 'novo') {
    const code = createExchangeCode(interaction.user.id, name);
    await interaction.reply({
      content: t(l, 'mcp.new', { code, mcpUrl: config.mcpUrl, appUrl: config.appUrl }),
      ephemeral: true,
    });
  } else {
    const n = revokeUser(interaction.user.id);
    await interaction.reply({ content: t(l, 'mcp.revoked', { n }), ephemeral: true });
  }
}

// ---------- auto-record e paradas por população ----------

const pendingChecks = new Map<string, NodeJS.Timeout>(); // `${guildId}:${channelId}`
const AUTO_DEBOUNCE_MS = 2000;

function scheduleAutoRecordCheck(guild: Guild, channelId: string): void {
  if (shuttingDown) return;
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
  if (shuttingDown) return;
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
      await stopSession(session, humans === 0 ? 'canal-vazio' : 'abaixo-minimo');
    }
    return;
  }

  if (!guildBusy(guild.id) && rule && humans >= rule.minimum && isArmed(guild.id, channelId)) {
    setArmed(guild.id, channelId, false);
    // preferredLocale só é real em servidores Community (nos demais é sempre en-US);
    // pro auto-record, DEFAULT_LOCALE do operador é um sinal muito melhor
    const locale: Locale = guild.preferredLocale?.toLowerCase().startsWith('pt') ? 'pt' : config.defaultLocale;
    try {
      await startSession({ guild, voiceChannel: channel, startedBy: null, locale, auto: true });
    } catch (err) {
      // rearma para tentar de novo no próximo movimento do canal
      setArmed(guild.id, channelId, true);
      console.error(`Auto-record falhou em #${channel.name}:`, err);
      void alertOwners(
        `autorecord-start:${guild.id}:${channelId}`,
        `O auto-record não conseguiu iniciar em **#${safeName(channel.name)}** (${safeName(guild.name)}): ${shortError((err as Error).message, locale)}`,
      );
    }
  }
}

// ---------- eventos do Discord ----------

async function repairRecoveredSurfaces(): Promise<void> {
  // Crash pode deixar o apelido [GRAVANDO] preso. Remove apenas o prefixo
  // conhecido; não inventa qual era o apelido anterior.
  const recoveredGuilds = new Set(recoveredRecordings.map((meta) => meta.guildId));
  for (const guild of client.guilds.cache.values()) {
    if (!recoveredGuilds.has(guild.id)) continue;
    const me = guild.members.me;
    const nick = me?.nickname;
    const clean = nick?.replace(/^(?:\[GRAVANDO\]|\[RECORDING\])\s*/u, '');
    if (me && nick && clean !== nick) await me.setNickname(clean || null).catch(() => {});
  }

  // Sessões criadas nesta versão persistem a mensagem do painel. Depois de um
  // crash, neutraliza o painel vermelho e remove todos os controles antigos.
  for (const meta of recoveredRecordings) {
    if (!meta.panelChannelId || !meta.panelMessageId) continue;
    try {
      const channel = await client.channels.fetch(meta.panelChannelId);
      const sameGuild = channel && 'guildId' in channel && channel.guildId === meta.guildId;
      if (!sameGuild || !channel || !('messages' in channel)) continue;
      const message = await channel.messages.fetch(meta.panelMessageId);
      const l: Locale = meta.locale === 'en' ? 'en' : meta.locale === 'pt' ? 'pt' : config.defaultLocale;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel(t(l, 'panel.btn-page')).setStyle(ButtonStyle.Link).setURL(pageUrl(meta.id)),
      );
      await message.edit({
        content: t(l, 'panel.recovered-after-restart', { url: pageUrl(meta.id) }),
        embeds: [],
        components: [row],
      });
    } catch (err) {
      console.warn(`Não consegui neutralizar painel recuperado de ${meta.id}:`, (err as Error).message);
    }
  }
}

client.once(Events.ClientReady, async () => {
  // Marca ANTES de qualquer await: a partir daqui os caches de guild/canal são
  // confiáveis e o checkAccess (web + API do MCP) pode avaliar acesso de verdade.
  markClientReady();
  startMonitor(); // alertas por DM ao dono (disco, etc.)
  console.log(`Kassinão online como ${client.user?.tag} 🎙️`);
  await repairRecoveredSurfaces();
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
    const recent = (meta.endedAt ?? 0) > Date.now() - 24 * 60 * 60 * 1000;
    const st = meta.transcription?.status;
    const tries = meta.transcription?.attempts ?? 0;
    // idioma da sessão persiste no meta — o recovery não pode chutar 'pt' num guild en
    const loc: Locale = meta.locale === 'en' ? 'en' : meta.locale === 'pt' ? 'pt' : config.defaultLocale;
    if (st === 'pending' || st === 'running' || (st === undefined && recent)) {
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, loc));
    } else if (st === 'partial' && tries < MAX_TRANSCRIPTION_ATTEMPTS) {
      // rodada agendada morreu com o reinício — retoma só as faixas que faltam
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, loc));
    } else if (
      st === 'error' &&
      tries < MAX_TRANSCRIPTION_ATTEMPTS &&
      (meta.transcription?.retryScheduled === true || recent)
    ) {
      // erro com tentativas sobrando (ex.: 429 em cadeia + deploy no meio):
      // sem isso a gravação ficaria em erro pra sempre, em silêncio
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, loc));
    } else if (st === 'done' || st === 'partial') {
      const ms = meta.minutes?.status;
      if (ms === 'pending' || ms === 'running') {
        // Retoma SÓ a ata que ficou pela metade num reinício. generateMinutesStep
        // grava 'running' como 1º passo, então interrupção real deixa pending/running.
        enqueueMinutesOnly(meta.id, (m) => {
          // só avisa se a ata retomada REALMENTE ficou pronta (não re-notifica a transcrição)
          if (m.minutes?.status === 'done') notifyTranscription(m, loc);
        });
      } else if (
        !meta.notifiedAt &&
        (meta.minutes?.finishedAt ?? meta.transcription?.finishedAt ?? 0) > Date.now() - 30 * 60 * 1000
      ) {
        // terminou tudo mas o processo morreu ANTES do aviso (janela de 30min:
        // metas antigas do upgrade não têm notifiedAt e JÁ foram avisadas — não spamear)
        void notifyTranscription(meta, loc);
      }
    }
    if (meta.minutes?.status === 'done' && !meta.webhookSentAt) {
      void deliverMinutesWebhookIfNeeded(meta);
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
        case 'ajuda':
          await handleAjuda(interaction);
          break;
        case 'gravacoes':
          await handleGravacoes(interaction);
          break;
        case 'autorecord':
          await handleAutorecord(interaction);
          break;
        case 'perguntar':
          await handlePerguntar(interaction);
          break;
        case 'config':
          await handleConfig(interaction);
          break;
        case 'mcp':
          await handleMcp(interaction);
          break;
        case 'sobre':
          await handleSobre(interaction);
          break;
      }
    } else if (
      interaction.isButton() &&
      (interaction.customId === STOP_BUTTON_ID || interaction.customId.startsWith(`${STOP_BUTTON_ID}:`))
    ) {
      await handleParar(interaction);
    } else if (
      interaction.isButton() &&
      (interaction.customId === NOTE_BUTTON_ID || interaction.customId.startsWith(`${NOTE_BUTTON_ID}:`))
    ) {
      await handleNoteButton(interaction);
    } else if (
      interaction.isButton() &&
      (interaction.customId === MARK_BUTTON_ID || interaction.customId.startsWith(`${MARK_BUTTON_ID}:`))
    ) {
      await handleMarkButton(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith(`${HELP_BUTTON_PREFIX}:`)) {
      await handleHelpButton(interaction);
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

// Boas-vindas ao entrar num servidor novo: onboarding sem precisar procurar nada.
client.on(Events.GuildCreate, async (guild) => {
  const l = localeOf(guild.preferredLocale);
  // Registra os comandos NESTE servidor na hora — sem isso, o registro global do
  // boot pode levar até 1h, e a pessoa digita /gravar logo após convidar e não vê nada.
  try {
    await new REST()
      .setToken(config.token)
      .put(Routes.applicationGuildCommands(config.applicationId, guild.id), { body: buildCommands() });
    console.log(`Comandos registrados no novo servidor ${guild.name} (${guild.id}).`);
  } catch (err) {
    console.error(`Falha ao registrar comandos no servidor ${guild.id}:`, err);
  }
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(t(l, 'welcome.title'))
    .setDescription(t(l, 'welcome.body'))
    .setFooter({ text: t(l, 'help.footer') });
  // Enviar embed exige Ver Canal + Enviar Mensagens + Inserir Links. E só canais de
  // TEXTO de verdade (não voz/palco/thread). Tenta o canal de sistema; senão, o 1º válido.
  const me = guild.members.me;
  const canPostEmbed = (ch: GuildBasedChannel | null | undefined): boolean =>
    !!ch &&
    !!me &&
    (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) &&
    !!ch
      .permissionsFor(me)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);

  let channel: GuildBasedChannel | undefined = guild.systemChannel ?? undefined;
  if (!canPostEmbed(channel)) {
    channel = guild.channels.cache.find(canPostEmbed);
  }
  try {
    if (channel && channel.isTextBased()) await channel.send({ embeds: [embed] });
  } catch {
    // sem canal onde eu possa postar — /ajuda continua disponível
  }
});

client.on(Events.GuildDelete, (guild) => {
  forgetGuildMembers(guild.id);
});

// DM ao bot → responde o guia (onboarding). Não lê o conteúdo além de detectar
// a FORMA "/comando" no início — pra explicar na lata por que não rodou.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guildId) return; // só DMs de pessoas
  // DM não expõe o locale do usuário → usa DEFAULT_LOCALE (padrão 'en' no repo;
  // defina DEFAULT_LOCALE=pt pra responder em português). Em servidores cada um vê no seu idioma.
  const l: Locale = config.defaultLocale;
  // "/perguntar ..." digitado como texto na DM: o comando nem existe aqui (são
  // registrados por servidor, onde dá pra checar o que a pessoa pode ver).
  // Responder o guia genérico confundia — explica o motivo + o caminho de fora.
  const cmd = /^\s*\/([\p{L}\w-]{1,32})/u.exec(message.content ?? '');
  console.log(`DM recebida de ${message.author.id} — respondendo ${cmd ? `dica do /${cmd[1]}` : 'o guia'}.`);
  try {
    // o canal de DM pode chegar PARCIAL (Partials.Channel) — completa antes de enviar
    if (message.channel.partial) await message.channel.fetch();
    if (cmd) {
      await message.channel.send(t(l, 'help.dm-command', { cmd: `/${cmd[1]}`, url: config.appUrl }));
      return;
    }
    await message.channel.send({ content: t(l, 'help.dm-hint'), ...buildHelpPayload(l) });
  } catch (err) {
    console.error(`Falha ao responder DM de ${message.author.id}:`, err);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = oldState.guild;

  // Presença na gravação ativa: entrar/sair do canal gravado vira registro no
  // meta (acesso à gravação) + evento na linha do tempo — mesmo sem desmutar.
  const session = sessionManager.get(guild.id);
  // Mover o bot não pode trocar silenciosamente a fonte de áudio mantendo
  // metadados/ACL do canal antigo. Mudança para outro canal encerra na hora;
  // desconexão para `null` mantém a janela de recuperação de 5 s da sessão.
  if (
    session &&
    newState.id === guild.members.me?.id &&
    oldState.channelId === session.voiceChannel.id &&
    newState.channelId !== null &&
    newState.channelId !== session.voiceChannel.id
  ) {
    void stopSession(session, 'canal-alterado').catch((err) =>
      console.error(`Erro encerrando ${session.id} após mudança de canal:`, err),
    );
  }
  if (session && newState.member && !newState.member.user.bot) {
    const recordedChannel = session.currentChannelId;
    const name = newState.member.displayName;
    if (newState.channelId === recordedChannel && oldState.channelId !== recordedChannel) {
      session.noteVoiceJoin(newState.member.id, name);
    } else if (oldState.channelId === recordedChannel && newState.channelId !== recordedChannel) {
      session.noteVoiceLeave(newState.member.id, name);
    }
  }

  const channels = new Set<string>();
  if (oldState.channelId) channels.add(oldState.channelId);
  if (newState.channelId) channels.add(newState.channelId);
  for (const channelId of channels) scheduleAutoRecordCheck(guild, channelId);
});

// Se a intent privilegiada GuildMembers estiver habilitada no futuro, invalida
// imediatamente remoções/trocas de cargo. Sem ela, access.ts revalida via REST
// autoritativo no máximo após o TTL (e SEM cache antes de exclusões).
client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
  forgetMember(newMember.guild.id, newMember.id);
});

client.on(Events.GuildMemberRemove, (member) => {
  try {
    forgetMember(member.guild.id, member.id);
    if (config.mcpEnabled) {
      const n = revokeUser(member.id);
      if (n > 0) console.log(`MCP: ${n} sessão(ões) revogada(s) — ${member.id} saiu de ${member.guild.name}.`);
    }
  } catch (err) {
    console.error('Erro revogando sessões MCP no guildMemberRemove:', err);
  }
});

// ---------- shutdown gracioso ----------

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Recebido ${signal}: encerrando gravações ativas antes de sair...`);
  killPendingTranscriptions();
  for (const timeout of pendingChecks.values()) clearTimeout(timeout);
  pendingChecks.clear();
  const starts = sessionManager.cancelAllStarts();
  await Promise.all(starts.map((s) => s.abortStart().catch((err) => console.error(`Erro abortando ${s.id}:`, err))));
  const actives = sessionManager.all();
  const alreadyStopping = sessionManager.allStopping();
  await Promise.all(
    // 'reinicio' e não 'desconectado': a timeline conta a história certa pro usuário
    [...actives.map((s) => stopSession(s, 'reinicio')), ...alreadyStopping.map((s) => s.stop('reinicio'))].map((p) =>
      p.catch((err) => console.error('Erro ao encerrar sessão no shutdown:', err)),
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

recoveredRecordings = recoverInterruptedRecordings();
startWebServer();
startCleanupJob();
client.login(config.token).catch((err) => {
  console.error('Falha ao autenticar no Discord (token inválido?):', err.message);
  process.exit(1);
});
