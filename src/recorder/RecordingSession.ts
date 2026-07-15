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
  MessageCreateOptions,
  VoiceBasedChannel,
} from 'discord.js';
import prism from 'prism-media';
import { config } from '../config';
import { freeMB } from '../disk';
import { DISCORD_SURFACE_POLICY_VERSION } from '../discordSurfaceMigration';
import { DiscordCapabilities, Locale, t, tCapability } from '../i18n';
import { alertOwners } from '../monitor';
import { operationalError, operationalFailure, operationalPii } from '../operationalLog';
import { safeName } from '../sanitize';
import {
  MAX_NOTES_PER_RECORDING,
  MAX_PRESENCE_IDENTITIES,
  MAX_PRESENCE_IDENTITIES_PER_RESPONSE,
} from '../securityLimits';
import { deleteRecording, pageUrl, RecordingMeta, saveMeta, tracksDir } from '../store';
import { NOTIFICATION_POLICY_VERSION } from '../transcriptionNotification';
import { safeSlice } from '../util';
import { withFreshMembershipBudget } from '../web/access';
import { UserTrack } from './UserTrack';

export type StopReason =
  | 'manual'
  | 'tempo-maximo'
  | 'canal-vazio'
  | 'abaixo-minimo'
  | 'desconectado'
  | 'canal-alterado'
  | 'disco-cheio'
  | 'limite-presenca'
  | 'reinicio';

export const STOP_BUTTON_ID = 'kassinao_stop';
export const NOTE_BUTTON_ID = 'kassinao_note';
export const MARK_BUTTON_ID = 'kassinao_mark';
export const MAX_NOTE_LENGTH = 500;
export { MAX_NOTES_PER_RECORDING, MAX_PRESENCE_IDENTITIES } from '../securityLimits';

export class RecordingStartCancelledError extends Error {
  constructor() {
    super('recording start cancelled');
    this.name = 'RecordingStartCancelledError';
  }
}

const SILENCE_WARN_MS = 5 * 60 * 1000;
const PANEL_EDIT_MIN_INTERVAL_MS = 2500;
/** Teto de faixas simultâneas (1 ffmpeg por falante) — protege CPU/processos num VPS pequeno. */
const MAX_TRACKS = 25;
/** Teto do log de eventos no meta (entra/sai em loop não pode inflar o JSON sem limite). */
const MAX_EVENTS = 300;
/** Anti-spam: entra/sai da MESMA pessoa dentro desta janela não gera novo evento. */
const PRESENCE_EVENT_COOLDOWN_MS = 60_000;

export function identityNameMayBeExposed(presence: RecordingMeta['presence'], userId: string): boolean {
  const index = presence?.findIndex((entry) => entry.id === userId) ?? -1;
  return index >= 0 && index < MAX_PRESENCE_IDENTITIES_PER_RESPONSE;
}

export class RecordingSession {
  readonly id: string;
  /** Token efêmero dos controles Discord; nunca revela o id/URL da gravação. */
  readonly controlToken: string;
  readonly guild: Guild;
  readonly voiceChannel: VoiceBasedChannel;
  startedAt: number;
  readonly meta: RecordingMeta;
  readonly locale: Locale;
  /** true quando iniciada pelo auto-record (afeta a regra de parada por população). */
  readonly auto: boolean;
  /** Snapshot das capacidades anunciado no início desta gravação. */
  readonly capabilities: Pick<DiscordCapabilities, 'transcription' | 'minutes'>;

  /** Chamado quando a gravação termina sem interação direta (limite, canal vazio, queda). */
  onAutoStop?: (session: RecordingSession, reason: StopReason) => void;

  private connection?: VoiceConnection;
  private tracks = new Map<string, UserTrack>();
  private activeStreams = new Set<string>();
  private stopping = false;
  private captureStarted = false;
  private startPromise?: Promise<void>;
  private abortPromise?: Promise<void>;
  private stopPromise?: Promise<RecordingMeta>;
  private maxDurationTimer?: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  private lastAudioAt: number;
  private silenceWarned = false;
  private trackCapWarned = false;

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
    capabilities?: Pick<DiscordCapabilities, 'transcription' | 'minutes'>;
  }) {
    this.id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}`;
    this.controlToken = crypto.randomBytes(12).toString('hex');
    this.guild = opts.guild;
    this.voiceChannel = opts.voiceChannel;
    this.locale = opts.locale;
    this.auto = opts.auto;
    this.capabilities = opts.capabilities ?? { transcription: false, minutes: false };
    this.startedAt = Date.now();
    this.lastAudioAt = this.startedAt;

    this.meta = {
      id: this.id,
      guildId: this.guild.id,
      guildName: this.guild.name,
      voiceChannelId: this.voiceChannel.id,
      voiceChannelName: this.voiceChannel.name,
      startedBy: opts.startedBy,
      locale: this.locale,
      startedAt: this.startedAt,
      status: 'recording',
      participants: [],
      presence: [],
      events: [],
      notes: [],
      notificationPolicyVersion: NOTIFICATION_POLICY_VERSION,
      discordSurfacePolicyVersion: DISCORD_SURFACE_POLICY_VERSION,
    };
    this.addEvent(
      opts.startedBy
        ? t(this.locale, 'event.started', { name: safeName(opts.startedBy.name) })
        : t(this.locale, 'event.started-auto'),
    );
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

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Identidade imutável da gravação. Se o bot for movido, a sessão é encerrada. */
  get currentChannelId(): string {
    return this.voiceChannel.id;
  }

  /** Início idempotente e transacional: qualquer falha desfaz conexão, painel e arquivos. */
  start(signal?: AbortSignal): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart(signal);
    return this.startPromise;
  }

  private async doStart(signal?: AbortSignal): Promise<void> {
    try {
      throwIfStartCancelled(signal);
      // Defesa em profundidade: @discordjs/voice mantém UMA conexão por guild —
      // entrar de novo moveria a conexão de uma gravação em andamento.
      if (getVoiceConnection(this.guild.id)) {
        throw new Error(
          this.locale === 'pt'
            ? 'já existe uma conexão de voz neste servidor'
            : 'there is already a voice connection in this server',
        );
      }

      fs.mkdirSync(tracksDir(this.id), { recursive: true });

      const connection = joinVoiceChannel({
        channelId: this.voiceChannel.id,
        guildId: this.guild.id,
        adapterCreator: this.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      this.connection = connection;

      try {
        await abortable(entersState(connection, VoiceConnectionStatus.Ready, 20_000), signal);
      } catch (err) {
        if (err instanceof RecordingStartCancelledError) throw err;
        throw new Error(
          this.locale === 'pt' ? 'não consegui conectar no canal a tempo' : 'could not connect to the channel in time',
          { cause: err },
        );
      }

      connection.on('error', (err) =>
        operationalFailure(
          `Erro na conexão de voz recording=${operationalPii(this.id)} error=${operationalError(err)}.`,
        ),
      );

      // Se o bot for desconectado (kick, canal apagado...), tenta se recuperar;
      // se não conseguir em 5 s, finaliza a gravação para não perder o áudio.
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (this.stopping) return;
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (!this.captureStarted) {
            await this.abortStart().catch(() => {});
            return;
          }
          this.requestAutoStop('desconectado');
        }
      });

      // Antes de captar qualquer áudio, o aviso precisa estar visível no próprio
      // canal. Os awaits têm teto e respeitam cancelamento; promessas REST tardias
      // se autocorrigem em setRecordingNickname/createPanel.
      const startupTimeout =
        this.locale === 'pt'
          ? 'o Discord demorou demais para iniciar a gravação'
          : 'Discord took too long to start recording';
      await startStep(this.setRecordingNickname(), signal, 5_000, startupTimeout);
      // O relógio público e o alinhamento das faixas começam junto do aviso,
      // não nos segundos gastos conectando ao Discord.
      this.startedAt = Date.now();
      this.lastAudioAt = this.startedAt;
      this.meta.startedAt = this.startedAt;
      for (const event of this.meta.events) event.atMs = 0;
      const panelVisible = await startStep(this.createPanel(), signal, 10_000, startupTimeout);
      if (!panelVisible) {
        throw new Error(
          this.locale === 'pt'
            ? 'não consegui publicar o aviso no chat do canal (preciso de Enviar Mensagens, Inserir Links e Ler Histórico)'
            : 'could not post the recording notice in the channel chat (I need Send Messages, Embed Links, and Read Message History)',
        );
      }
      throwIfStartCancelled(signal);

      // Faz a checagem imediatamente antes de ligar a captura. Se a sala já
      // começa no teto, não existe uma identidade excedente para descartar:
      // o início inteiro é desfeito de forma transacional, sem áudio gravado.
      if (this.currentHumanMemberCount() >= MAX_PRESENCE_IDENTITIES) {
        throw new Error(
          this.locale === 'pt'
            ? `o canal atingiu o limite seguro de ${MAX_PRESENCE_IDENTITIES} pessoas — a gravação não foi iniciada`
            : `the channel reached the safe ${MAX_PRESENCE_IDENTITIES}-person limit — recording was not started`,
        );
      }

      this.captureStarted = true;
      // Primeiro estado persistido = painel visível e captura pronta. Uma queda
      // antes disso deixa só um diretório órfão, nunca uma gravação fantasma.
      saveMeta(this.meta);
      connection.receiver.speaking.on('start', (userId) => this.onSpeakingStart(userId));
      this.maxDurationTimer = setTimeout(
        () => this.requestAutoStop('tempo-maximo'),
        config.maxRecordingHours * 60 * 60 * 1000,
      );
      this.silenceTimer = setInterval(() => this.checkSilence(), 30_000);

      // Presença: quem JÁ está na sala entra no registro agora (mesmo que nunca
      // desmute) — presença na call dá acesso à gravação, falar não é requisito.
      if (!this.snapshotPresence()) {
        await this.stopPromise?.catch(() => {});
        throw new RecordingStartCancelledError();
      }
      this.sendStartDM();
    } catch (err) {
      await this.abortStart();
      throw err;
    }
  }

  /** Rollback idempotente de uma inicialização que ainda não virou sessão ativa. */
  abortStart(): Promise<void> {
    if (!this.abortPromise) {
      this.stopping = true;
      this.abortPromise = this.doAbortStart();
    }
    return this.abortPromise;
  }

  private async doAbortStart(): Promise<void> {
    clearTimeout(this.maxDurationTimer);
    clearInterval(this.silenceTimer);
    if (this.panelEditPending) clearTimeout(this.panelEditPending);
    this.panelEditPending = undefined;
    try {
      this.connection?.destroy();
    } catch {
      // já destruída
    }
    await Promise.all([...this.tracks.values()].map((track) => track.finalize(Date.now()).catch(() => false)));
    await withTimeout(this.restoreNickname(), 5_000);
    try {
      await this.panelMessage?.delete();
    } catch {
      // painel já removido/sem permissão
    }
    this.panelMessage = undefined;
    deleteRecording(this.id);
  }

  // ---------- presença (quem está na call, falando ou não) ----------

  private currentHumanMemberCount(): number {
    const ids = new Set<string>();
    for (const [, member] of this.voiceChannel.members) {
      if (!member.user.bot) ids.add(member.id);
    }
    return ids.size;
  }

  /**
   * Adiciona uma identidade sem jamais ultrapassar o teto. `limitReached`
   * significa que esta própria identidade completou o ACL e a sessão deve
   * encerrar antes de aceitar mais conteúdo.
   */
  private addPresenceIdentity(userId: string, name: string): { added: boolean; limitReached: boolean } {
    const list = (this.meta.presence ??= []);
    if (list.some((entry) => entry.id === userId)) {
      return { added: false, limitReached: list.length >= MAX_PRESENCE_IDENTITIES };
    }
    if (list.length >= MAX_PRESENCE_IDENTITIES) {
      return { added: false, limitReached: true };
    }
    list.push({ id: userId, name, joinedAtMs: Date.now() - this.startedAt });
    return { added: true, limitReached: list.length >= MAX_PRESENCE_IDENTITIES };
  }

  /**
   * Para primeiro, depois entrega o hook de ciclo de vida. Assim a proteção
   * continua segura mesmo se o hook estiver ausente, falhar ou demorar; o hook
   * de produção reencontra a mesma Promise idempotente em stop().
   */
  private stopAtPresenceLimit(): void {
    if (this.stopping) return;
    const reason: StopReason = 'limite-presenca';
    const stopping = this.stop(reason);
    if (this.onAutoStop) this.onAutoStop(this, reason);
    else
      void stopping.catch((err) =>
        operationalFailure(
          `Erro encerrando gravação recording=${operationalPii(this.id)} error=${operationalError(err)}.`,
        ),
      );
  }

  /** Falha de persistência torna inseguro continuar captando: para em `finally`. */
  private persistPresenceOrStop(limitReached: boolean): boolean {
    let persisted = false;
    try {
      saveMeta(this.meta);
      persisted = true;
      return true;
    } catch {
      operationalFailure(`Falha ao persistir presença recording=${operationalPii(this.id)}; encerrando a captura.`);
      return false;
    } finally {
      if (!persisted || limitReached) this.stopAtPresenceLimit();
    }
  }

  /**
   * Registra quem está no canal AGORA (idempotente — só adiciona quem falta).
   * Chamado no start() e de novo quando a sessão entra no manager: quem entrou
   * na janela entre os dois (o start leva ~1-2s de REST) não pode ficar de fora.
   */
  snapshotPresence(): boolean {
    if (this.stopping) return false;
    const addedIdentities: Array<{ id: string; name: string }> = [];
    let limitReached = (this.meta.presence?.length ?? 0) >= MAX_PRESENCE_IDENTITIES;
    for (const [, member] of this.voiceChannel.members) {
      if (member.user.bot) continue;
      const result = this.addPresenceIdentity(member.id, member.displayName);
      if (result.limitReached) {
        limitReached = true;
      }
      if (result.added) addedIdentities.push({ id: member.id, name: member.displayName });
      if (result.limitReached) break;
    }
    if (addedIdentities.length > 0) {
      const visibleNames = addedIdentities
        .filter(({ id }) => this.presenceNameMayBeExposed(id))
        .map(({ name }) => name);
      const hiddenCount = addedIdentities.length - visibleNames.length;
      // no início vira UMA linha ("Na call: A, B, C"); retardatários da janela ganham linha própria
      if (this.meta.events.length <= 1) {
        const boundedNames = visibleNames.map((n) => safeName(n)).join(', ');
        const suffix = hiddenCount > 0 ? `, +${hiddenCount}` : '';
        this.addEvent(t(this.locale, 'event.present-initial', { names: `${boundedNames}${suffix}` }));
      } else {
        for (const n of visibleNames) this.addEvent(t(this.locale, 'event.voice-joined', { name: safeName(n) }));
        if (hiddenCount > 0)
          this.addEvent(
            this.locale === 'pt'
              ? `👥 +${hiddenCount} outras pessoas na call`
              : `👥 +${hiddenCount} other people in call`,
          );
      }
      this.persistPresenceOrStop(limitReached);
    } else if (limitReached) this.stopAtPresenceLimit();
    return !this.stopping;
  }

  /** Último evento de entra/sai por pessoa (anti-spam: loop de entra/sai não enche a timeline). */
  private lastPresenceEventAt = new Map<string, number>();

  private presenceEventAllowed(userId: string): boolean {
    const last = this.lastPresenceEventAt.get(userId) ?? 0;
    if (Date.now() - last < PRESENCE_EVENT_COOLDOWN_MS) return false;
    this.lastPresenceEventAt.set(userId, Date.now());
    return true;
  }

  private presenceNameMayBeExposed(userId: string): boolean {
    return identityNameMayBeExposed(this.meta.presence, userId);
  }

  private addFirstSpeechEvent(userId: string, name: string): void {
    this.addEvent(
      this.presenceNameMayBeExposed(userId)
        ? t(this.locale, 'event.joined', { name: safeName(name) })
        : this.locale === 'pt'
          ? '🎤 Uma pessoa falou pela primeira vez'
          : '🎤 Someone spoke for the first time',
    );
  }

  /** Alguém entrou no canal gravado (chamado pelo VoiceStateUpdate). */
  noteVoiceJoin(userId: string, name: string): void {
    if (this.stopping) return;
    const list = (this.meta.presence ??= []);
    const existing = list.find((p) => p.id === userId);
    let limitReached = list.length >= MAX_PRESENCE_IDENTITIES;
    let eventAllowed: boolean;
    if (existing) {
      // voltou depois de sair: reabre a presença (mantém o 1º joinedAtMs)
      if (existing.leftAtMs === undefined) {
        if (limitReached) this.stopAtPresenceLimit();
        return; // já estava dentro (evento duplicado)
      }
      // Alternância da mesma identidade dentro da janela não muda nem persiste
      // presença; isso limita fsync/structuredClone a uma transição por minuto.
      if (!this.presenceEventAllowed(userId)) return;
      eventAllowed = true;
      delete existing.leftAtMs;
    } else {
      const result = this.addPresenceIdentity(userId, name);
      limitReached = result.limitReached;
      // O teto já estava completo: a identidade não ganhou grant, portanto não
      // a registra na timeline nem mantém a captura viva por mais um evento.
      if (!result.added) {
        this.stopAtPresenceLimit();
        return;
      }
      eventAllowed = this.presenceEventAllowed(userId);
    }
    if (eventAllowed) {
      this.addEvent(
        this.presenceNameMayBeExposed(userId)
          ? t(this.locale, 'event.voice-joined', { name: safeName(name) })
          : this.locale === 'pt'
            ? '👥 Uma pessoa entrou na call'
            : '👥 Someone joined the call',
      );
      this.schedulePanelUpdate();
    }
    this.persistPresenceOrStop(limitReached);
  }

  /** Alguém saiu do canal gravado. */
  noteVoiceLeave(userId: string, name: string): void {
    if (this.stopping) return;
    const entry = this.meta.presence?.find((p) => p.id === userId && p.leftAtMs === undefined);
    if (!entry) return; // não estava registrado (ex.: bot) — nada a fazer
    if (!this.presenceEventAllowed(`out:${userId}`)) return;
    entry.leftAtMs = Date.now() - this.startedAt;
    this.addEvent(
      this.presenceNameMayBeExposed(userId)
        ? t(this.locale, 'event.voice-left', { name: safeName(name) })
        : this.locale === 'pt'
          ? '🚪 Uma pessoa saiu da call'
          : '🚪 Someone left the call',
    );
    this.schedulePanelUpdate();
    this.persistPresenceOrStop(false);
  }

  /** Indicador visual extra: tenta usar "[GRAVANDO] ..." enquanto grava. */
  private async setRecordingNickname(): Promise<void> {
    try {
      const me = this.guild.members.me;
      if (!me) return;
      this.originalNickname = me.nickname;
      const tag = this.locale === 'pt' ? '[GRAVANDO]' : '[RECORDING]';
      // corta por code points — apelido com emoji não pode ser partido ao meio
      const nick = [...`${tag} ${this.originalNickname ?? me.user.username}`].slice(0, 32).join('');
      await me.setNickname(nick);
      // A chamada REST pode terminar depois do timeout/cancelamento. Nesse caso,
      // não deixa o indicador preso num início que já foi desfeito.
      if (this.stopping) await me.setNickname(this.originalNickname).catch(() => {});
    } catch {
      if (this.stopping) return;
      this.originalNickname = undefined; // sem permissão (ou outra falha) — segue sem o indicador
      this.addEvent(t(this.locale, 'event.no-nickname'));
      if (this.captureStarted) saveMeta(this.meta);
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

  /** Confirma membership atual antes de colocar qualquer detalhe privado numa DM. */
  private async sendStarterDM(payload: MessageCreateOptions): Promise<void> {
    const startedBy = this.meta.startedBy;
    if (!startedBy) return;
    try {
      await withFreshMembershipBudget(startedBy.id, () =>
        this.guild.members.fetch({ user: startedBy.id, force: true, cache: false }),
      );
      await this.guild.client.users.send(startedBy.id, payload);
    } catch {
      // Saiu do servidor, Discord indisponível ou DM fechada: falha fechado.
    }
  }

  /** DM para quem iniciou, com o link da página (o acesso continua controlado pelo login). */
  private sendStartDM(): void {
    const l = this.locale;
    void this.sendStarterDM({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(t(l, 'dm.title-start'))
          .setDescription(
            t(l, config.audioRetentionUnlimited ? 'dm.desc-start-unlimited' : 'dm.desc-start', {
              channel: `#${safeName(this.voiceChannel.name)}`,
              guild: safeName(this.guild.name),
              url: this.pageUrl,
              hours: config.maxRecordingHours,
              expiresDays: config.retentionDays,
              processing: tCapability(l, 'dm.processing-start', this.capabilities),
            }),
          )
          .setFooter({ text: t(l, 'panel.footer') }),
      ],
    });
  }

  private sendStopDM(): void {
    const startedBy = this.meta.startedBy;
    if (!startedBy) return;
    const l = this.locale;
    const endedAt = this.meta.endedAt ?? Date.now();
    const empty = this.meta.participants.length === 0;
    const desc = this.meta.audioIncomplete
      ? t(l, 'dm.desc-stop-incomplete', { channel: `#${safeName(this.voiceChannel.name)}`, url: this.pageUrl })
      : empty
        ? t(l, 'dm.desc-stop-empty', { channel: `#${safeName(this.voiceChannel.name)}` })
        : t(l, config.audioRetentionUnlimited ? 'dm.desc-stop-unlimited' : 'dm.desc-stop', {
            channel: `#${safeName(this.voiceChannel.name)}`,
            duration: formatDuration(endedAt - this.startedAt),
            url: this.pageUrl,
            expires: `<t:${Math.floor((this.meta.expiresAt ?? endedAt) / 1000)}:D>`,
            processing: tCapability(l, 'dm.processing-stop', this.capabilities),
          });
    void this.sendStarterDM({
      embeds: [
        new EmbedBuilder()
          .setColor(this.meta.audioIncomplete ? 0xfee75c : empty ? 0x949ba4 : 0x57f287)
          .setTitle(t(l, 'dm.title-stop'))
          .setDescription(desc)
          .setFooter({ text: t(l, 'panel.footer') }),
      ],
    });
  }

  /**
   * Nota com timestamp — vai para o log, o info.txt, os labels do Audacity e
   * a transcrição. Retorna false se a nota foi descartada (gravação parando
   * ou texto vazio) para o handler não confirmar sucesso à toa.
   */
  addNote(author: string, text: string, atMs?: number): boolean {
    if (this.stopping || this.meta.notes.length >= MAX_NOTES_PER_RECORDING) return false;
    const clean = safeSlice(text.trim(), MAX_NOTE_LENGTH);
    if (!clean) return false;
    const cleanAuthor = author.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    const at = atMs ?? Date.now() - this.startedAt;
    this.meta.notes.push({ atMs: at, author: cleanAuthor, text: clean });
    this.addEvent(`📝 ${safeName(cleanAuthor)}: ${safeName(safeSlice(clean, 120))}`);
    saveMeta(this.meta);
    this.schedulePanelUpdate();
    return true;
  }

  // ---------- captura ----------

  private onSpeakingStart(userId: string): void {
    if (this.stopping) return;

    // Bots não viram faixa: um bot de música "falando" 2h consumiria transcrição
    // e poluiria a ata. (Cache basta: membros de canal de voz estão no cache.)
    if (this.guild.members.cache.get(userId)?.user.bot) return;

    // O VoiceStateUpdate pode ter se perdido numa reconexão. Falar também prova
    // presença, portanto o ACL precisa ser atualizado ANTES de criar faixa. Se
    // esta identidade completar o teto, ela ganha acesso e a captura para aqui.
    const presence = this.addPresenceIdentity(userId, `usuario-${userId}`);
    if (presence.added && !this.persistPresenceOrStop(presence.limitReached)) return;
    if (presence.limitReached) {
      this.stopAtPresenceLimit();
      return;
    }

    // Teto de faixas: cada falante = 1 ffmpeg contínuo. Num VPS pequeno, uma sala
    // gigante esgotaria CPU/processos. Novos falantes além do teto não são gravados
    // (os já em gravação continuam) — avisa uma vez no painel.
    if (!this.tracks.has(userId) && this.tracks.size >= MAX_TRACKS) {
      if (!this.trackCapWarned) {
        this.trackCapWarned = true;
        this.addEvent(t(this.locale, 'event.track-cap', { max: MAX_TRACKS }));
        saveMeta(this.meta);
        this.schedulePanelUpdate();
      }
      return;
    }

    // Realinha a faixa a CADA "começou a falar" — o Discord re-emite o evento
    // após pausas curtas (>=100ms) dentro da mesma subscription, sem enviar
    // nenhum áudio durante a pausa. Sem isso as faixas dessincronizam.
    const track = this.getOrCreateTrack(userId);
    track.beginSegment();

    if (this.activeStreams.has(userId)) return;
    this.activeStreams.add(userId);

    const opusStream = this.connection!.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    decoder.on('data', (chunk: Buffer) => {
      this.lastAudioAt = Date.now();
      this.silenceWarned = false;
      track.write(chunk);
    });
    decoder.on('error', (err) =>
      operationalFailure(`Erro no decoder user=${operationalPii(userId)} error=${operationalError(err)}.`),
    );
    opusStream.on('error', (err) =>
      operationalFailure(`Erro no stream de voz user=${operationalPii(userId)} error=${operationalError(err)}.`),
    );

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
        const pres = this.meta.presence?.find((p) => p.id === userId);
        if (pres && pres.name.startsWith('usuario-')) pres.name = member.displayName;
        this.addFirstSpeechEvent(userId, member.displayName);
        saveMeta(this.meta);
        this.schedulePanelUpdate();
      })
      .catch(() => {
        if (this.stopping) return;
        this.addFirstSpeechEvent(userId, participant.name);
        saveMeta(this.meta);
        this.schedulePanelUpdate();
      });

    return track;
  }

  private checkSilence(): void {
    if (this.stopping) return;
    // Guarda de disco: se o espaço estiver acabando, encerra AGORA — melhor uma
    // gravação curta e íntegra do que uma faixa cortada/corrompida sem aviso.
    if (freeMB() < config.minFreeMbAbort) {
      void alertOwners(
        'disk-abort',
        `Encerrei uma gravação em **#${this.voiceChannel.name}** porque o disco está quase cheio (**${freeMB()} MB** livres).`,
      );
      this.requestAutoStop('disco-cheio');
      return;
    }
    if (this.silenceWarned) return;
    if (Date.now() - this.lastAudioAt >= SILENCE_WARN_MS) {
      this.silenceWarned = true;
      this.addEvent(t(this.locale, 'event.silence'));
      saveMeta(this.meta);
      this.schedulePanelUpdate();
    }
  }

  private requestAutoStop(reason: StopReason): void {
    if (this.stopping) return;
    if (this.onAutoStop) this.onAutoStop(this, reason);
    else
      void this.stop(reason).catch((err) =>
        operationalFailure(
          `Erro encerrando gravação recording=${operationalPii(this.id)} error=${operationalError(err)}.`,
        ),
      );
  }

  // ---------- eventos e painel ----------

  private addEvent(text: string, force = false): void {
    // Teto duro: uma pessoa entrando/saindo em loop não infla o meta.json sem
    // limite (DoS de disco) nem enterra o painel. O último slot vira reticências.
    // `force` fura o teto para eventos estruturais (ex.: o encerramento).
    if (!force && this.meta.events.length >= MAX_EVENTS) {
      if (this.meta.events[this.meta.events.length - 1]?.text !== '…') {
        this.meta.events.push({ atMs: Date.now() - this.startedAt, text: '…' });
      }
      return;
    }
    this.meta.events.push({ atMs: Date.now() - this.startedAt, text });
  }

  private async createPanel(): Promise<boolean> {
    const payload = this.buildPanelPayload();
    // O painel vai no chat do próprio canal de voz: só quem enxerga o canal vê o link.
    let sent: Message | undefined;
    try {
      if (this.voiceChannel.isTextBased()) {
        sent = await this.voiceChannel.send(payload);
        // Uma resposta REST tardia não pode ressuscitar um painel de uma sessão
        // cujo início já foi cancelado/abortado.
        if (this.stopping) {
          await sent.delete().catch(() => {});
          return false;
        }
        this.panelMessage = sent;
        this.meta.panelChannelId = sent.channelId;
        this.meta.panelMessageId = sent.id;
        return true;
      }
    } catch {
      await sent?.delete().catch(() => {});
      // sem permissão de enviar no chat do canal de voz — o início falha fechado
    }
    this.panelMessage = undefined;
    return false;
  }

  private buildPanelPayload() {
    const l = this.locale;
    const isDone = this.meta.status === 'done';

    // O canal serve para o aviso visível obrigatório e controles durante a captura.
    // Identidade, notas, eventos, id e URL ficam exclusivamente em superfícies
    // autenticadas/DMs revalidadas, inclusive depois que a gravação termina.
    if (isDone) {
      return {
        content: t(l, 'panel.greeting-done-private'),
        embeds: [],
        components: [],
      };
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(t(l, 'panel.title-recording', { channel: `#${safeName(this.voiceChannel.name)}` }))
      .setDescription(t(l, 'panel.desc-recording-private'))
      .setFooter({ text: t(l, 'panel.footer') });

    const row = new ActionRowBuilder<ButtonBuilder>();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${STOP_BUTTON_ID}:${this.controlToken}`)
        .setLabel(t(l, 'panel.btn-stop'))
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${MARK_BUTTON_ID}:${this.controlToken}`)
        .setLabel(t(l, 'panel.btn-mark'))
        .setEmoji('📌')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${NOTE_BUTTON_ID}:${this.controlToken}`)
        .setLabel(t(l, 'panel.btn-note'))
        .setEmoji('📝')
        .setStyle(ButtonStyle.Secondary),
    );

    return {
      content: t(l, 'panel.greeting-recording', {
        processing: tCapability(l, 'panel.processing', this.capabilities),
      }),
      embeds: [embed],
      components: [row],
    };
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
      this.connection?.destroy();
    } catch {
      // conexão já destruída
    }

    // O ÁUDIO PRIMEIRO: fechar os FLACs é a única etapa que perde dados se o
    // processo for morto (SIGKILL após o grace do Docker). REST do Discord
    // (apelido/painel) vem depois, cada um com teto — um rate-limit pendurado
    // não pode segurar o shutdown até o SIGKILL.
    const trackResults = await Promise.all([...this.tracks.values()].map(StopTrack(endedAt)));
    if (trackResults.some((complete) => !complete)) {
      this.meta.audioIncomplete = true;
      this.addEvent(t(this.locale, 'event.audio-incomplete'), true);
    }

    await withTimeout(this.restoreNickname(), 5_000);

    this.meta.status = 'done';
    this.meta.endedAt = endedAt;
    // retenção ilimitada: sem data de morte no meta — apagar é decisão humana
    if (!config.audioRetentionUnlimited) this.meta.expiresAt = endedAt + config.retentionDays * 24 * 60 * 60 * 1000;
    if (!config.textRetentionUnlimited)
      this.meta.textExpiresAt = endedAt + config.textRetentionDays * 24 * 60 * 60 * 1000;
    const eventKey = `event.stopped-${reason}` as const;
    this.addEvent(
      reason === 'manual'
        ? t(this.locale, 'event.stopped-manual', { name: safeName(stoppedBy?.name ?? '?') })
        : reason === 'limite-presenca'
          ? this.locale === 'pt'
            ? `⏹️ Limite seguro de ${MAX_PRESENCE_IDENTITIES} pessoas atingido — gravação encerrada`
            : `⏹️ Safe ${MAX_PRESENCE_IDENTITIES}-person limit reached — recording stopped`
          : t(this.locale, eventKey, { hours: config.maxRecordingHours }),
      true, // evento de encerramento sempre entra, mesmo com o log no teto
    );
    saveMeta(this.meta);

    // Edição final estritamente genérica. Link, participantes, eventos e notas
    // seguem apenas por DM revalidada e nas superfícies autenticadas.
    await withTimeout(
      (async () => {
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
      })(),
      10_000,
    );

    this.sendStopDM();
    return this.meta;
  }
}

/** Promise com teto: resolve no que vier primeiro (a operação ou o timeout). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

function throwIfStartCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RecordingStartCancelledError();
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfStartCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RecordingStartCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function startStep<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  try {
    return await abortable(Promise.race([promise, timeout]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function StopTrack(endedAt: number) {
  return (track: UserTrack) =>
    track.finalize(endedAt).catch((err) => {
      operationalFailure(`Erro finalizando faixa user=${operationalPii(track.userId)} error=${operationalError(err)}.`);
      return false;
    });
}

/** Junta nomes com limite — calls grandes não estouram os limites de tamanho do Discord. */
export function joinNames(names: string[], locale: Locale, max = 12): string {
  // safeName escapa markdown/masked-link — o nome é de terceiro (apelido no Discord)
  const shown = names.slice(0, max).map((n) => `**${safeName(n)}**`);
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
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'participante'
  );
}
