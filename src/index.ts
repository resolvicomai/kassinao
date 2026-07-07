/*
 * Kassinão — gravador de voz self-hosted para Discord.
 * Copyright (C) 2026 Mauro Marques (resolvicomai)
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
import { answerQuestion } from './ask';
import { guildConfigStore } from './guildConfig';
import { minutesEnabled } from './processing/minutes';
import { safeSlice, shortError } from './util';
import { startCleanupJob } from './cleanup';
import { freeMB } from './disk';
import { client } from './discord/client';
import { markClientReady } from './discord/ready';
import { startMonitor } from './monitor';
import { Locale, localeOf, t } from './i18n';
import { autoRecordStore, isArmed, setArmed } from './recorder/autorecord';
import { sessionManager } from './recorder/manager';
import { cook } from './processing/cook';
import {
  formatDuration,
  formatOffset,
  MARK_BUTTON_ID,
  MAX_NOTE_LENGTH,
  NOTE_BUTTON_ID,
  RecordingSession,
  STOP_BUTTON_ID,
  StopReason,
} from './recorder/RecordingSession';
import {
  enqueueMinutesOnly,
  enqueueTranscription,
  killPendingTranscriptions,
  MAX_TRANSCRIPTION_ATTEMPTS,
  validateTranscriptionConfig,
} from './processing/transcribe';
import { safeName } from './sanitize';
import {
  listGuildMetas,
  listMetas,
  pageUrl,
  readMeta,
  readMinutes,
  RecordingMeta,
  recoverInterruptedRecordings,
  saveMeta,
  transcriptReady,
} from './store';
import { forgetMember } from './web/access';
import { createExchangeCode, revokeUser } from './web/mcpTokens';
import { startWebServer } from './web/server';

const NOTE_MODAL_ID = 'kassinao_note_modal';
const NOTE_INPUT_ID = 'kassinao_note_text';

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
    });
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
        .setDescription('O que você quer saber? (ex.: o que decidimos sobre o deploy?)')
        .setMaxLength(300)
        .setRequired(true);
      o.setNameLocalizations({ 'en-US': 'question', 'en-GB': 'question' });
      o.setDescriptionLocalizations({
        'en-US': 'What do you want to know? (e.g.: what did we decide about the deploy?)',
        'en-GB': 'What do you want to know? (e.g.: what did we decide about the deploy?)',
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
    throw new Error(
      opts.locale === 'pt' ? 'já existe uma gravação neste servidor' : 'a recording already exists in this server',
    );
  }
  // Guarda de disco: não começa uma gravação que vai corromper por falta de espaço.
  const free = freeMB();
  if (free < config.minFreeMbStart) {
    throw new Error(
      opts.locale === 'pt'
        ? `sem espaço em disco suficiente no servidor (${free} MB livres) — apague gravações antigas primeiro`
        : `not enough disk space on the server (${free} MB free) — delete old recordings first`,
    );
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
      // quem entrou no canal DURANTE o start (~1-2s de REST) não disparou o
      // handler de presença (a sessão ainda não estava no manager) — completa agora
      session.snapshotPresence();
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
  const text =
    state.status === 'done'
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

  // canal de destino configurável (/config ata-canal); fallback = chat do canal de voz
  const cfg = guildConfigStore.get(meta.guildId);
  const targetId = (minutesDone && cfg.minutesChannelId) || meta.voiceChannelId;
  try {
    const channel = (await client.channels.fetch(targetId)) as TextBasedChannel | null;
    // defesa em profundidade: NUNCA postar ata fora do servidor da gravação
    // (channels.fetch é global; um guildconfig.json corrompido não pode vazar ata)
    const sameGuild = channel && 'guildId' in channel && channel.guildId === meta.guildId;
    if (channel && sameGuild && 'send' in channel) await channel.send({ content: text, embeds });
    else if (!sameGuild) throw new Error('canal de outro servidor');
  } catch {
    // sem acesso ao canal configurado — tenta o chat do canal de voz como fallback
    if (targetId !== meta.voiceChannelId) {
      try {
        const vc = (await client.channels.fetch(meta.voiceChannelId)) as TextBasedChannel | null;
        if (vc && 'send' in vc) await vc.send({ content: text, embeds });
      } catch {
        // a página continua mostrando tudo
      }
    }
  }
  if (meta.startedBy) {
    client.users.send(meta.startedBy.id, { content: text, embeds }).catch(() => {});
  }
  // webhook do operador (env) — integrações self-hosted (n8n → Notion/Jira...).
  // Dedupe persistido SÓ após sucesso: falha de rede num deploy não pode
  // significar "nunca mais tenta"; o resume pós-reinício re-dispara.
  if (minutesDone && config.minutesWebhookUrl) {
    const fresh = readMeta(meta.id);
    if (fresh && !fresh.webhookSentAt) {
      postMinutesWebhook(meta)
        .then(() => {
          const ok = readMeta(meta.id);
          if (ok) {
            ok.webhookSentAt = Date.now();
            saveMeta(ok);
          }
        })
        .catch((err) =>
          console.warn(`Webhook da ata (${meta.id}) falhou (vai retentar no resume):`, (err as Error).message),
        );
    }
  }
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
  await fetch(config.minutesWebhookUrl, {
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

/** Uma pergunta por pessoa por vez (chamada de LLM custa tempo/dinheiro). */
const asking = new Set<string>();
/** Teto GLOBAL de perguntas simultâneas + orçamento por pessoa/hora (LLM não é grátis). */
const MAX_CONCURRENT_ASKS = 2;
const MAX_ASKS_PER_HOUR = 10;
const askHistory = new Map<string, number[]>();

function askBudgetOk(userId: string): boolean {
  const now = Date.now();
  const hist = (askHistory.get(userId) ?? []).filter((ts) => now - ts < 60 * 60 * 1000);
  if (hist.length >= MAX_ASKS_PER_HOUR) return false;
  hist.push(now);
  askHistory.set(userId, hist);
  if (askHistory.size > 500) askHistory.clear(); // teto de memória
  return true;
}

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
  if (asking.has(interaction.user.id) || asking.size >= MAX_CONCURRENT_ASKS || !askBudgetOk(interaction.user.id)) {
    await interaction.reply({ content: t(l, 'ask.busy'), ephemeral: true });
    return;
  }
  const question = interaction.options.getString('pergunta', true);
  const days = interaction.options.getInteger('dias') ?? 30;
  await interaction.deferReply({ ephemeral: true });
  asking.add(interaction.user.id);
  try {
    const member = interaction.member as GuildMember;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    // MESMA regra de acesso da web: só reuniões que essa pessoa pode abrir
    const metas = listGuildMetas(interaction.guild.id, 100)
      .filter((m) => m.status === 'done' && m.startedAt >= cutoff)
      .filter((m) => memberCanAccessRecording(member, m, interaction.guild!))
      .filter((m) => transcriptReady(m));
    if (metas.length === 0) {
      await interaction.editReply(t(l, 'ask.no-meetings', { days }));
      return;
    }
    const result = await answerQuestion(question, metas, l);
    if (!result.answer) {
      await interaction.editReply(t(l, 'ask.no-meetings', { days }));
      return;
    }
    await interaction.editReply(`${result.answer}\n\n${t(l, 'ask.footer', { n: result.meetingsUsed })}`);
  } catch (err) {
    console.error('Erro no /perguntar:', err);
    await interaction.editReply(t(l, 'ask.error', { error: shortError((err as Error).message, l) })).catch(() => {});
  } finally {
    asking.delete(interaction.user.id);
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
    await interaction.reply({
      content: t(l, 'err.cannot-join', { channel: `#${voiceChannel.name}` }),
      ephemeral: true,
    });
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
  const member = interaction.member as GuildMember | null;
  // Encerrar é destrutivo e irreversível — exige o mesmo acesso do /nota (ver o canal).
  if (!canAnnotate(session, member)) {
    await interaction.reply({
      content: t(l, 'err.stop-no-access', { channel: `#${session.voiceChannel.name}` }),
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const empty = session.participantNames.length === 0;
  await stopSession(session, 'manual', {
    id: interaction.user.id,
    name: member?.displayName ?? interaction.user.username,
  });
  await interaction.editReply(t(l, empty ? 'record.stopped-empty' : 'record.stopped', { url: session.pageUrl }));
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
  const added = session.addNote(
    member.displayName ?? interaction.user.username,
    interaction.options.getString('texto', true),
  );
  await interaction.reply({ content: t(l, added ? 'note.added' : 'note.discarded', { offset }), ephemeral: true });
}

/** 📌 de um toque: marca o momento SEM modal/digitação — a fricção mata o bookmark. */
async function handleMarkButton(interaction: ButtonInteraction): Promise<void> {
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
  const atMs = Number.isFinite(clickAt)
    ? Math.min(Math.max(0, Math.trunc(clickAt)), session.durationMs)
    : session.durationMs;
  const member = interaction.member as GuildMember | null;
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
    embed.addFields({ name: t(l, 'help.mcp-title'), value: t(l, 'help.mcp-body', { url: config.baseUrl }) });
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
  // passa os valores REAIS de config pros tópicos (limite de horas, retenção, url)
  const vars = { hours: config.maxRecordingHours, days: config.retentionDays, url: config.baseUrl };
  await interaction.reply({ content: topic ? t(l, topic, vars) : t(l, 'help.intro'), ephemeral: true });
}

async function handleSobre(interaction: ChatInputCommandInteraction): Promise<void> {
  const l = localeOf(interaction.locale);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎙️ Kassinão')
    .setDescription(t(l, 'about.desc'))
    .addFields(
      { name: t(l, 'about.author'), value: 'Mauro Marques (resolvicomai)' },
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
 * Uma pessoa só pode ver/listar uma gravação se: iniciou, esteve na call
 * (falando ou não), é admin, ou enxerga o canal de voz de origem. Mesma regra
 * do controle de acesso da página web — aqui aplicada para o /gravacoes não
 * vazar metadados.
 */
function memberCanAccessRecording(member: GuildMember, meta: RecordingMeta, guild: Guild): boolean {
  if (meta.startedBy?.id === member.id) return true;
  if (meta.participants.some((p) => p.id === member.id)) return true;
  if (meta.presence?.some((p) => p.id === member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const channel = guild.channels.cache.get(meta.voiceChannelId);
  if (channel && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) return true;
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
  const all = listGuildMetas(interaction.guild.id, 100).filter((m) =>
    memberCanAccessRecording(member, m, interaction.guild!),
  );
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
    const expires = m.expiresAt && m.status !== 'recording' ? ` • ⏳ <t:${Math.floor(m.expiresAt / 1000)}:R>` : '';
    return `**#${safeName(m.voiceChannelName)}** — ${when} • ${dur} • ${who} • 🎙️ ${m.participants.length} • ${badge}${expires}\n[${t(l, 'recordings.open')}](${pageUrl(m.id)})`;
  });
  let content = `**${t(l, 'recordings.title')}**\n${lines.join('\n')}`;
  if (all.length > metas.length) content += `\n${t(l, 'recordings.more', { n: all.length - metas.length })}`;
  // o índice web mostra TODAS (com busca) — aqui só cabem 5
  content += `\n${t(l, 'recordings.web', { url: `${config.baseUrl}/gravacoes` })}`;
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
      content: t(l, 'autorecord.enabled', {
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
      content: `**${t(l, 'autorecord.view-title')}**\n${lines.join('\n')}\n${t(l, 'autorecord.view-hint')}`,
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
  // a página /conectar-ia (self-serve, com o próprio acesso) — não inferimos
  // "dono" de estar numa DM. Resposta SEMPRE efêmera; o código nunca é logado.
  if (!config.ownerIds.includes(interaction.user.id)) {
    await interaction.reply({
      content: t(l, 'mcp.web-only', { url: `${config.baseUrl}/conectar-ia` }),
      ephemeral: true,
    });
    return;
  }
  const member = interaction.member as GuildMember | null;
  const name = (member && 'displayName' in member ? member.displayName : null) ?? interaction.user.username;
  if (interaction.options.getSubcommand() === 'novo') {
    const code = createExchangeCode(interaction.user.id, name);
    await interaction.reply({ content: t(l, 'mcp.new', { code, url: config.baseUrl }), ephemeral: true });
  } else {
    const n = revokeUser(interaction.user.id);
    await interaction.reply({ content: t(l, 'mcp.revoked', { n }), ephemeral: true });
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
  // Marca ANTES de qualquer await: a partir daqui os caches de guild/canal são
  // confiáveis e o checkAccess (web + API do MCP) pode avaliar acesso de verdade.
  markClientReady();
  startMonitor(); // alertas por DM ao dono (disco, etc.)
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
    const recent = (meta.endedAt ?? 0) > Date.now() - 24 * 60 * 60 * 1000;
    const st = meta.transcription?.status;
    const tries = meta.transcription?.attempts ?? 0;
    if (st === 'pending' || st === 'running' || (st === undefined && recent)) {
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, 'pt'));
    } else if (st === 'partial' && tries < MAX_TRANSCRIPTION_ATTEMPTS) {
      // rodada agendada morreu com o reinício — retoma só as faixas que faltam
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, 'pt'));
    } else if (st === 'error' && tries < MAX_TRANSCRIPTION_ATTEMPTS && recent) {
      // erro com tentativas sobrando (ex.: 429 em cadeia + deploy no meio):
      // sem isso a gravação ficaria em erro pra sempre, em silêncio
      enqueueTranscription(meta.id, (m) => notifyTranscription(m, 'pt'));
    } else if (st === 'done' || st === 'partial') {
      // Retoma SÓ a ata que ficou pela metade num reinício. generateMinutesStep
      // grava 'running' como 1º passo, então interrupção real deixa pending/running —
      // 'undefined' significaria "nunca tentou" (não fazer backfill em massa no 1º deploy).
      const ms = meta.minutes?.status;
      if (ms === 'pending' || ms === 'running') {
        enqueueMinutesOnly(meta.id, (m) => {
          // só avisa se a ata retomada REALMENTE ficou pronta (não re-notifica a transcrição)
          if (m.minutes?.status === 'done') notifyTranscription(m, 'pt');
        });
      }
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
    } else if (interaction.isButton() && interaction.customId === STOP_BUTTON_ID) {
      await handleParar(interaction);
    } else if (interaction.isButton() && interaction.customId === NOTE_BUTTON_ID) {
      await handleNoteButton(interaction);
    } else if (interaction.isButton() && interaction.customId === MARK_BUTTON_ID) {
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

// DM ao bot → responde o guia (onboarding). Não lê o conteúdo, só reage ao evento.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guildId) return; // só DMs de pessoas
  // DM não expõe o locale do usuário → usa DEFAULT_LOCALE (padrão 'en' no repo;
  // defina DEFAULT_LOCALE=pt pra responder em português). Em servidores cada um vê no seu idioma.
  const l: Locale = config.defaultLocale;
  console.log(`DM recebida de ${message.author.id} — respondendo o guia.`);
  try {
    // o canal de DM pode chegar PARCIAL (Partials.Channel) — completa antes de enviar
    if (message.channel.partial) await message.channel.fetch();
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

// Saiu do servidor → mata as sessões MCP dele e limpa o cache de membership.
// OBS: só dispara se a intent privilegiada GuildMembers estiver habilitada; sem
// ela, ex-membros perdem o acesso pelas camadas de servidor no próximo query
// (checkAccess refaz o members.fetch), mantendo só participante/iniciador — a
// mesma política da página web. Revogação total manual: /mcp revoke-all.
if (config.mcpEnabled) {
  client.on(Events.GuildMemberRemove, (member) => {
    try {
      const n = revokeUser(member.id);
      forgetMember(member.guild.id, member.id);
      if (n > 0) console.log(`MCP: ${n} sessão(ões) revogada(s) — ${member.id} saiu de ${member.guild.name}.`);
    } catch (err) {
      console.error('Erro revogando sessões MCP no guildMemberRemove:', err);
    }
  });
}

// ---------- shutdown gracioso ----------

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Recebido ${signal}: encerrando gravações ativas antes de sair...`);
  killPendingTranscriptions();
  const actives = sessionManager.all();
  await Promise.all(
    // 'reinicio' e não 'desconectado': a timeline conta a história certa pro usuário
    actives.map((s) => stopSession(s, 'reinicio').catch((err) => console.error(`Erro ao encerrar ${s.id}:`, err))),
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
