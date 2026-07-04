import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Guild,
  Message,
  VoiceBasedChannel,
} from 'discord.js';
import prism from 'prism-media';
import { config } from '../config';
import { Locale, t } from '../i18n';
import { pageUrl, RecordingMeta, saveMeta, tracksDir } from '../store';
import { safeSlice } from '../util';
import { UserTrack } from './UserTrack';

export type StopReason = 'manual' | 'tempo-maximo' | 'canal-vazio' | 'desconectado';

export const STOP_BUTTON_ID = 'kassinao_stop';
export const NOTE_BUTTON_ID = 'kassinao_note';
export const MAX_NOTE_LENGTH = 500;

const SILENCE_WARN_MS = 5 * 60 * 1000;
const PANEL_EDIT_MIN_INTERVAL_MS = 2500;
const MAX_PANEL_EVENTS = 10;

export class RecordingSession {
  readonly id: string;
  readonly guild: Guild;
  readonly voiceChannel: VoiceBasedChannel;
  readonly startedAt: number;
  readonly meta: RecordingMeta;
  readonly locale: Locale;
  /** true quando iniciada pelo auto-record (afeta a regra de parada por população). */
  readonly auto: boolean;

  /** Chamado quando a gravação termina sem interação direta (limite, canal vazio, queda). */
  onAutoStop?: (session: RecordingSession, reason: StopReason) => void;

  private connection!: VoiceConnection;
  private tracks = new Map<string, UserTrack>();
  private activeStreams = new Set<string>();
  private stopping = false;
  private stopPromise?: Promise<RecordingMeta>;
  private maxDurationTimer?: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  private lastAudioAt: number;
  private silenceWarned = false;

  private panelMessage?: Message;
  private panelLastEditAt = 0;
  private panelEditPending?: NodeJS.Timeout;
  private originalNickname: string | null | undefined; // undefined = não conseguiu mudar

  constructor(opts: {
    guild: Guild;
    voiceChannel: VoiceBasedChannel;
    startedBy: { id: string; name: string } | null;
    locale: Locale;
    auto: boolean;
  }) {
    this.id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}`;
    this.guild = opts.guild;
    this.voiceChannel = opts.voiceChannel;
    this.locale = opts.locale;
    this.auto = opts.auto;
    this.startedAt = Date.now();
    this.lastAudioAt = this.startedAt;

    fs.mkdirSync(tracksDir(this.id), { recursive: true });
    this.meta = {
      id: this.id,
      guildId: this.guild.id,
      guildName: this.guild.name,
      voiceChannelId: this.voiceChannel.id,
      voiceChannelName: this.voiceChannel.name,
      startedBy: opts.startedBy,
      startedAt: this.startedAt,
      status: 'recording',
      participants: [],
      events: [],
      notes: [],
    };
    this.addEvent(
      opts.startedBy
        ? t(this.locale, 'event.started', { name: opts.startedBy.name })
        : t(this.locale, 'event.started-auto'),
    );
    saveMeta(this.meta);
  }

  get pageUrl(): string {
    return pageUrl(this.id);
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }

  get participantNames(): string[] {
    return this.meta.participants.map((p) => p.name);
  }

  /** Canal onde o bot está de fato agora (ele pode ter sido arrastado após o início). */
  get currentChannelId(): string {
    return this.guild.members.me?.voice.channelId ?? this.voiceChannel.id;
  }

  async start(): Promise<void> {
    // Defesa em profundidade: @discordjs/voice mantém UMA conexão por guild —
    // entrar de novo moveria a conexão de uma gravação em andamento.
    if (getVoiceConnection(this.guild.id)) {
      fs.rmSync(path.dirname(tracksDir(this.id)), { recursive: true, force: true });
      throw new Error(
        this.locale === 'pt'
          ? 'já existe uma conexão de voz neste servidor'
          : 'there is already a voice connection in this server',
      );
    }

    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.connection.destroy();
      fs.rmSync(path.dirname(tracksDir(this.id)), { recursive: true, force: true });
      throw new Error(
        this.locale === 'pt' ? 'não consegui conectar no canal a tempo' : 'could not connect to the channel in time',
      );
    }

    this.connection.on('error', (err) => console.error(`Erro na conexão de voz (${this.id}):`, err.message));
    this.connection.receiver.speaking.on('start', (userId) => this.onSpeakingStart(userId));

    // Se o bot for desconectado (kick, canal apagado...), tenta se recuperar;
    // se não conseguir em 5 s, finaliza a gravação para não perder o áudio.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.stopping) return;
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await this.stop('desconectado').catch(() => {});
        this.onAutoStop?.(this, 'desconectado');
      }
    });

    this.maxDurationTimer = setTimeout(
      async () => {
        await this.stop('tempo-maximo').catch(() => {});
        this.onAutoStop?.(this, 'tempo-maximo');
      },
      config.maxRecordingHours * 60 * 60 * 1000,
    );

    this.silenceTimer = setInterval(() => this.checkSilence(), 30_000);

    await this.setRecordingNickname();
    await this.createPanel();
    this.sendStartDM();
  }

  /** Consentimento visível: o bot vira "[GRAVANDO] ..." enquanto grava. */
  private async setRecordingNickname(): Promise<void> {
    try {
      const me = this.guild.members.me;
      if (!me) return;
      this.originalNickname = me.nickname;
      const tag = this.locale === 'pt' ? '[GRAVANDO]' : '[RECORDING]';
      // corta por code points — apelido com emoji não pode ser partido ao meio
      const nick = [...`${tag} ${this.originalNickname ?? me.user.username}`].slice(0, 32).join('');
      await me.setNickname(nick);
    } catch {
      this.originalNickname = undefined; // sem permissão (ou outra falha) — segue sem o indicador
      this.addEvent(t(this.locale, 'event.no-nickname'));
      saveMeta(this.meta);
    }
  }

  private async restoreNickname(): Promise<void> {
    if (this.originalNickname === undefined) return;
    try {
      await this.guild.members.me?.setNickname(this.originalNickname);
    } catch {
      // paciência — melhor apelido preso que gravação travada
    }
  }

  /** DM para quem iniciou, com o link da página (o acesso continua controlado pelo login). */
  private sendStartDM(): void {
    const startedBy = this.meta.startedBy;
    if (!startedBy) return;
    const l = this.locale;
    this.guild.client.users
      .send(startedBy.id, {
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle(t(l, 'dm.title-start'))
            .setDescription(
              t(l, 'dm.desc-start', {
                channel: `#${this.voiceChannel.name}`,
                guild: this.guild.name,
                url: this.pageUrl,
                hours: config.maxRecordingHours,
                expiresDays: config.retentionDays,
              }),
            )
            .setFooter({ text: t(l, 'panel.footer') }),
        ],
      })
      .catch(() => {
        // DMs fechadas — o painel e o /gravacoes cobrem
      });
  }

  private sendStopDM(): void {
    const startedBy = this.meta.startedBy;
    if (!startedBy) return;
    const l = this.locale;
    const endedAt = this.meta.endedAt ?? Date.now();
    // users.send funciona mesmo se a pessoa saiu do servidor (members.fetch não)
    this.guild.client.users
      .send(startedBy.id, {
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle(t(l, 'dm.title-stop'))
            .setDescription(
              t(l, 'dm.desc-stop', {
                channel: `#${this.voiceChannel.name}`,
                duration: formatDuration(endedAt - this.startedAt),
                url: this.pageUrl,
                expires: `<t:${Math.floor((this.meta.expiresAt ?? endedAt) / 1000)}:D>`,
              }),
            )
            .setFooter({ text: t(l, 'panel.footer') }),
        ],
      })
      .catch(() => {});
  }

  /**
   * Nota com timestamp — vai para o log, o info.txt, os labels do Audacity e
   * a transcrição. Retorna false se a nota foi descartada (gravação parando
   * ou texto vazio) para o handler não confirmar sucesso à toa.
   */
  addNote(author: string, text: string, atMs?: number): boolean {
    if (this.stopping) return false;
    const clean = safeSlice(text.trim(), MAX_NOTE_LENGTH);
    if (!clean) return false;
    const cleanAuthor = author.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    const at = atMs ?? Date.now() - this.startedAt;
    this.meta.notes.push({ atMs: at, author: cleanAuthor, text: clean });
    this.addEvent(`📝 ${cleanAuthor}: ${safeSlice(clean, 120)}`);
    saveMeta(this.meta);
    this.schedulePanelUpdate();
    return true;
  }

  // ---------- captura ----------

  private onSpeakingStart(userId: string): void {
    if (this.stopping) return;

    // Realinha a faixa a CADA "começou a falar" — o Discord re-emite o evento
    // após pausas curtas (>=100ms) dentro da mesma subscription, sem enviar
    // nenhum áudio durante a pausa. Sem isso as faixas dessincronizam.
    const track = this.getOrCreateTrack(userId);
    track.beginSegment();

    if (this.activeStreams.has(userId)) return;
    this.activeStreams.add(userId);

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    decoder.on('data', (chunk: Buffer) => {
      this.lastAudioAt = Date.now();
      this.silenceWarned = false;
      track.write(chunk);
    });
    decoder.on('error', (err) => console.error(`Erro no decoder (${userId}):`, err.message));
    opusStream.on('error', (err) => console.error(`Erro no stream de voz (${userId}):`, err.message));

    const cleanup = () => {
      this.activeStreams.delete(userId);
      decoder.destroy();
    };
    opusStream.once('end', cleanup);
    opusStream.once('close', cleanup);

    opusStream.pipe(decoder);
  }

  private getOrCreateTrack(userId: string): UserTrack {
    let track = this.tracks.get(userId);
    if (track) return track;

    const index = this.tracks.size + 1;
    const trackFile = `${index}-${userId}.flac`;
    track = new UserTrack(userId, path.join(tracksDir(this.id), trackFile), this.startedAt);
    this.tracks.set(userId, track);

    const participant = {
      id: userId,
      name: `usuario-${userId}`,
      avatar: null as string | null,
      trackFile,
      index,
    };
    this.meta.participants.push(participant);
    saveMeta(this.meta);

    // Nome e avatar chegam via REST em segundo plano (não atrasa o áudio).
    // Se a resposta chegar depois do stop, não regrava o meta (poderia
    // "ressuscitar" uma gravação recém-apagada) nem mexe no painel final.
    this.guild.members
      .fetch(userId)
      .then((member) => {
        if (this.stopping) return;
        participant.name = member.displayName;
        participant.avatar = member.displayAvatarURL({ size: 128, extension: 'png' });
        this.addEvent(t(this.locale, 'event.joined', { name: member.displayName }));
        saveMeta(this.meta);
        this.schedulePanelUpdate();
      })
      .catch(() => {
        if (this.stopping) return;
        this.addEvent(t(this.locale, 'event.joined', { name: participant.name }));
        saveMeta(this.meta);
        this.schedulePanelUpdate();
      });

    return track;
  }

  private checkSilence(): void {
    if (this.stopping || this.silenceWarned) return;
    if (Date.now() - this.lastAudioAt >= SILENCE_WARN_MS) {
      this.silenceWarned = true;
      this.addEvent(t(this.locale, 'event.silence'));
      saveMeta(this.meta);
      this.schedulePanelUpdate();
    }
  }

  // ---------- eventos e painel ----------

  private addEvent(text: string): void {
    this.meta.events.push({ atMs: Date.now() - this.startedAt, text });
  }

  private async createPanel(): Promise<void> {
    const payload = this.buildPanelPayload();
    // O painel vai no chat do próprio canal de voz: só quem enxerga o canal vê o link.
    try {
      if (this.voiceChannel.isTextBased()) {
        this.panelMessage = await this.voiceChannel.send(payload);
        return;
      }
    } catch {
      // sem permissão de enviar no chat do canal de voz — segue sem painel
    }
    this.panelMessage = undefined;
  }

  private buildPanelPayload() {
    const l = this.locale;
    const isDone = this.meta.status === 'done';
    const embed = new EmbedBuilder()
      .setColor(isDone ? 0x57f287 : 0xed4245)
      .setTitle(t(l, isDone ? 'panel.title-done' : 'panel.title-recording', { channel: `#${this.voiceChannel.name}` }))
      .setFooter({ text: t(l, 'panel.footer') });

    if (isDone) {
      const endedAt = this.meta.endedAt ?? Date.now();
      embed.setDescription(
        safeSlice(
          t(l, 'panel.desc-done', {
            duration: formatDuration(endedAt - this.startedAt),
            participants: joinNames(this.participantNames, l) || t(l, 'panel.no-participants'),
            url: this.pageUrl,
            expires: `<t:${Math.floor((this.meta.expiresAt ?? endedAt) / 1000)}:D>`,
          }),
          4000,
        ),
      );
    } else {
      embed.setDescription(
        t(l, 'panel.desc-recording', {
          rel: `<t:${Math.floor(this.startedAt / 1000)}:R>`,
          starter: this.meta.startedBy ? `<@${this.meta.startedBy.id}>` : 'auto-record',
          url: this.pageUrl,
        }),
      );
      embed.addFields(
        { name: t(l, 'panel.field-id'), value: `\`${this.id}\``, inline: true },
        { name: t(l, 'panel.field-limit'), value: `${config.maxRecordingHours}h`, inline: true },
      );
    }

    // eventos mais recentes primeiro a entrar; corta por LINHA para não truncar no meio
    const lines: string[] = [];
    for (const e of this.meta.events.slice(-MAX_PANEL_EVENTS).reverse()) {
      const line = safeSlice(`\`${formatOffset(e.atMs)}\` ${e.text}`, 180);
      if (lines.join('\n').length + line.length + 1 > 1024) break;
      lines.unshift(line);
    }
    if (lines.length > 0) {
      embed.addFields({ name: t(l, 'panel.field-events'), value: lines.join('\n') });
    }

    const row = new ActionRowBuilder<ButtonBuilder>();
    if (!isDone) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(STOP_BUTTON_ID)
          .setLabel(t(l, 'panel.btn-stop'))
          .setEmoji('⏹️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(NOTE_BUTTON_ID)
          .setLabel(t(l, 'panel.btn-note'))
          .setEmoji('📝')
          .setStyle(ButtonStyle.Secondary),
      );
    }
    row.addComponents(
      new ButtonBuilder().setLabel(t(l, 'panel.btn-page')).setStyle(ButtonStyle.Link).setURL(this.pageUrl),
    );

    return { embeds: [embed], components: [row] };
  }

  /** Edita o painel com throttle para não estourar o rate limit do Discord. */
  private schedulePanelUpdate(): void {
    if (this.stopping || !this.panelMessage || this.panelEditPending) return;
    const wait = Math.max(0, PANEL_EDIT_MIN_INTERVAL_MS - (Date.now() - this.panelLastEditAt));
    this.panelEditPending = setTimeout(async () => {
      this.panelEditPending = undefined;
      this.panelLastEditAt = Date.now();
      if (this.stopping) return; // stop() cuida do painel final; não recriar aqui
      try {
        await this.panelMessage!.edit(this.buildPanelPayload());
      } catch {
        // painel apagado — recria uma única vez, a menos que já esteja parando
        if (this.stopping) return;
        this.panelMessage = undefined;
        this.createPanel().catch(() => {});
      }
    }, wait);
  }

  get panelJumpUrl(): string | undefined {
    return this.panelMessage?.url;
  }

  // ---------- parada ----------

  /** Para a gravação e finaliza os masters FLAC. Idempotente. */
  stop(reason: StopReason, stoppedBy?: { id: string; name: string }): Promise<RecordingMeta> {
    if (!this.stopPromise) {
      this.stopping = true;
      this.stopPromise = this.doStop(reason, stoppedBy);
    }
    return this.stopPromise;
  }

  private async doStop(reason: StopReason, stoppedBy?: { id: string; name: string }): Promise<RecordingMeta> {
    const endedAt = Date.now();
    clearTimeout(this.maxDurationTimer);
    clearInterval(this.silenceTimer);
    if (this.panelEditPending) clearTimeout(this.panelEditPending);
    this.panelEditPending = undefined;

    try {
      this.connection.destroy();
    } catch {
      // conexão já destruída
    }
    await this.restoreNickname();

    await Promise.all([...this.tracks.values()].map(StopTrack(endedAt)));

    this.meta.status = 'done';
    this.meta.endedAt = endedAt;
    this.meta.expiresAt = endedAt + config.retentionDays * 24 * 60 * 60 * 1000;
    const eventKey = `event.stopped-${reason}` as const;
    this.addEvent(
      reason === 'manual'
        ? t(this.locale, 'event.stopped-manual', { name: stoppedBy?.name ?? '?' })
        : t(this.locale, eventKey, { hours: config.maxRecordingHours }),
    );
    saveMeta(this.meta);

    // edição final do painel, sem throttle; se o painel sumiu, manda mensagem nova
    // para o resumo (com o link) nunca se perder
    try {
      const payload = this.buildPanelPayload();
      if (this.panelMessage) {
        await this.panelMessage.edit(payload);
      } else if (this.voiceChannel.isTextBased()) {
        await this.voiceChannel.send(payload);
      }
    } catch {
      try {
        if (this.voiceChannel.isTextBased()) await this.voiceChannel.send(this.buildPanelPayload());
      } catch {
        // sem permissão — o link continua acessível via /gravacoes
      }
    }

    this.sendStopDM();
    return this.meta;
  }
}

function StopTrack(endedAt: number) {
  return (track: UserTrack) =>
    track.finalize(endedAt).catch((err) => console.error(`Erro finalizando faixa ${track.userId}:`, err));
}

/** Junta nomes com limite — calls grandes não estouram os limites de tamanho do Discord. */
export function joinNames(names: string[], locale: Locale, max = 12): string {
  const shown = names.slice(0, max).map((n) => `**${n}**`);
  const rest = names.length - max;
  if (rest > 0) shown.push(locale === 'pt' ? `e mais ${rest}` : `and ${rest} more`);
  return shown.join(', ');
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}min ${s}s`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

export function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9-_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'participante'
  );
}
