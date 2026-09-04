import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonState, writeJsonStateAtomic } from './stateFile';
import { resolveDeadline } from './deadlines';
import type { ArtifactReference, ArtifactSnapshot, IntegrationClient, IntegrationContext } from './integrations/types';

export type CommitmentStatus = 'mentioned' | 'confirmed' | 'completed' | 'cancelled';
export interface CommitmentSource {
  startMs: number;
  endMs: number;
  quote: string;
}
export interface CommitmentActionInput {
  tarefa: string;
  responsavel?: string;
  prazo?: string;
  source?: CommitmentSource;
}
export interface CommitmentMeetingInput {
  id: string;
  guildId: string;
  voiceChannelId: string;
  startedAt: number;
}
export interface CommitmentPreference {
  mode: 'follow' | 'mute';
  snoozedUntil?: number;
  feedback?: 'useful' | 'dismissed';
  feedbackAt?: number;
}
export type CommitmentCompletionRule = { kind: 'manual' } | { kind: 'artifact'; url: string; state: 'done' | 'merged' };
export interface CommitmentHistory {
  at: number;
  actorId: string;
  kind: 'status' | 'link' | 'relation' | 'completion-rule';
  before: string;
  after: string;
  /** Internal provenance, checked independently before exposing historical text. */
  reference?: ArtifactReference;
  relatedId?: string;
}
export const COMPLETION_EVIDENCE_MAX_AGE_MS = 60 * 60_000;
export interface CommitmentLink {
  reference: ArtifactReference;
  addedAt: number;
  snapshot?: ArtifactSnapshot;
}
export interface Commitment {
  id: string;
  meetingId: string;
  guildId: string;
  channelId: string;
  meetingStartedAt: number;
  task: string;
  assignee?: string;
  deadline?: string;
  source?: CommitmentSource;
  /** Missing from a regenerated summary is not the same as cancelled or delivered. */
  sourcePresent: boolean;
  status: CommitmentStatus;
  lastStatusBy?: string;
  lastStatusAt?: number;
  createdAt: number;
  updatedAt: number;
  links: CommitmentLink[];
  relatedIds?: string[];
  history?: CommitmentHistory[];
  completionRule?: CommitmentCompletionRule;
}
export interface CommitmentView extends Commitment {
  /** Some external ACL checks failed or exceeded this read's budget; those sources stay hidden. */
  sourceAccessIncomplete?: boolean;
  /** Derived exclusively from visible records in this response. */
  groupId?: string;
  directRelatedIds?: string[];
  /** Web-only navigation; each direct neighbour is independently authorized, even outside this page. */
  relatedMentions?: Pick<Commitment, 'id' | 'meetingStartedAt' | 'task'>[];
  channelFollowed?: boolean;
  effectiveCompletion?: { url: string; state: 'done' | 'merged'; checkedAt: number };
  preference: CommitmentPreference;
  deadlineState: 'unknown' | 'upcoming' | 'due' | 'overdue' | 'settled';
  deadlineDate?: string;
  lastNotice?: { reason: string; at: number };
}
export interface CommitmentDigestItem {
  commitment: CommitmentView;
  fingerprint: string;
  reason: string;
}
export interface CommitmentDigest {
  id: string;
  createdAt: number;
  items: CommitmentDigestItem[];
}
interface SeenState {
  fingerprint: string;
  status: CommitmentStatus;
  deadline?: string;
  sourcePresent: boolean;
  artifacts: string;
  artifactStates?: { url: string; state?: string; label?: string; title?: string; updatedAt?: string }[];
  deadlineState?: CommitmentView['deadlineState'];
}
interface UserState extends CommitmentPreference {
  /** Absent on legacy records means an explicit preference; false is feedback/ack only. */
  modeExplicit?: boolean;
  seen?: SeenState;
  lastNotice?: { reason: string; at: number; artifactUrls?: string[] };
}
interface CommitmentState {
  version: 1;
  commitments: Record<string, Commitment>;
  users: Record<string, Record<string, UserState>>;
  reconcileCursor: number;
  channelPreferences?: { userId: string; guildId: string; channelId: string; mode: 'follow' | 'mute' }[];
}
export interface CommitmentServiceOptions {
  stateDir: string;
  /** Must check the current recording ACL; false/exception denies access. */
  authorize: (userId: string, meetingId: string) => Promise<boolean>;
  /** Required for exposing each external reference and snapshot. Missing = deny. */
  authorizeArtifact?: (userId: string, reference: ArtifactReference, context: IntegrationContext) => Promise<boolean>;
  integrations?: IntegrationClient;
  now?: () => number;
  maxRequestsPerReconcile?: number;
  timezone?: string;
  /** Skip lookups for absent, paused or revoked guilds without deleting history. */
  isMeetingActive?: (meetingId: string) => boolean;
}
export class CommitmentAccessError extends Error {
  constructor() {
    super('Compromisso indisponível.');
  }
}
export class CommitmentAuthorizationUnavailableError extends Error {
  constructor() {
    super('Não foi possível confirmar a autorização agora.');
  }
}
export class CommitmentInputError extends Error {}
export class CommitmentCapacityError extends CommitmentInputError {}

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_LEGACY_STATE_BYTES = 128 * 1024 * 1024;

const statuses: CommitmentStatus[] = ['mentioned', 'confirmed', 'completed', 'cancelled'];
const hash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value: string | undefined, max: number): string | undefined {
  return typeof value === 'string'
    ? value
        .replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, max) || undefined
    : undefined;
}
function normalized(value: string | undefined): string {
  return (value || '').normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
}
function validSource(value: CommitmentSource | undefined): CommitmentSource | undefined {
  if (
    !value ||
    !Number.isFinite(value.startMs) ||
    !Number.isFinite(value.endMs) ||
    value.startMs < 0 ||
    value.endMs < value.startMs
  )
    return undefined;
  const quote = text(value.quote, 1000);
  return quote ? { startMs: value.startMs, endMs: value.endMs, quote } : undefined;
}
function empty(): CommitmentState {
  return { version: 1, commitments: {}, users: {}, reconcileCursor: 0 };
}
function validState(raw: unknown): raw is CommitmentState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const state = raw as CommitmentState;
  if (
    state.version !== 1 ||
    !state.commitments ||
    typeof state.commitments !== 'object' ||
    Array.isArray(state.commitments) ||
    !state.users ||
    typeof state.users !== 'object' ||
    Array.isArray(state.users)
  )
    return false;
  if (Object.keys(state.commitments).length > 10_000) return false;
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  const stamp = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const validReference = (v: unknown): boolean => {
    if (
      !plain(v) ||
      !['github-issue', 'github-pull', 'jira-issue', 'document'].includes(String(v.kind)) ||
      !short(v.url, 2000) ||
      !short(v.origin, 500)
    )
      return false;
    try {
      const url = new URL(v.url);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.origin === v.origin;
    } catch {
      return false;
    }
  };
  const validSnapshot = (v: unknown): boolean =>
    v === undefined ||
    (plain(v) &&
      ['open', 'closed', 'merged', 'done', 'unknown', 'unavailable', 'unverified'].includes(String(v.state)) &&
      short(v.label, 300) &&
      stamp(v.checkedAt) &&
      v.deployed === null &&
      (v.title === undefined || short(v.title, 300)) &&
      (v.updatedAt === undefined || short(v.updatedAt, 40)) &&
      (v.retryAt === undefined || stamp(v.retryAt)));
  const validRule = (v: unknown): boolean =>
    v === undefined ||
    (plain(v) &&
      (v.kind === 'manual' ||
        (v.kind === 'artifact' && short(v.url, 2000) && ['done', 'merged'].includes(String(v.state)))));
  const validHistory = (v: unknown): boolean =>
    v === undefined ||
    (Array.isArray(v) &&
      v.length <= 50 &&
      v.every(
        (event) =>
          plain(event) &&
          stamp(event.at) &&
          short(event.actorId, 100) &&
          ['status', 'link', 'relation', 'completion-rule'].includes(String(event.kind)) &&
          short(event.before, 2000) &&
          short(event.after, 2000) &&
          (event.reference === undefined || validReference(event.reference)) &&
          (event.relatedId === undefined || /^[a-f0-9]{32}$/.test(String(event.relatedId))),
      ));
  const entriesValid = Object.entries(state.commitments).every(
    ([id, item]) =>
      /^[a-f0-9]{32}$/.test(id) &&
      item?.id === id &&
      typeof item.meetingId === 'string' &&
      short(item.meetingId, 200) &&
      short(item.guildId, 100) &&
      short(item.channelId, 100) &&
      short(item.task, 2000) &&
      (item.assignee === undefined || short(item.assignee, 200)) &&
      (item.deadline === undefined || short(item.deadline, 200)) &&
      stamp(item.meetingStartedAt) &&
      stamp(item.createdAt) &&
      stamp(item.updatedAt) &&
      (item.lastStatusBy === undefined || short(item.lastStatusBy, 100)) &&
      (item.lastStatusAt === undefined || stamp(item.lastStatusAt)) &&
      typeof item.sourcePresent === 'boolean' &&
      (item.source === undefined || !!validSource(item.source)) &&
      validRule(item.completionRule) &&
      validHistory(item.history) &&
      (item.relatedIds === undefined ||
        (Array.isArray(item.relatedIds) &&
          item.relatedIds.length <= 20 &&
          item.relatedIds.every((related) => /^[a-f0-9]{32}$/.test(related) && related !== id))) &&
      statuses.includes(item.status) &&
      Array.isArray(item.links) &&
      item.links.length <= 10 &&
      item.links.every(
        (link) => plain(link) && validReference(link.reference) && stamp(link.addedAt) && validSnapshot(link.snapshot),
      ),
  );
  const usersValid =
    Object.entries(state.users).length <= 10_000 &&
    Object.entries(state.users).every(
      ([userId, preferences]) =>
        /^[a-zA-Z0-9_-]{1,100}$/.test(userId) &&
        !['__proto__', 'constructor', 'prototype'].includes(userId) &&
        plain(preferences) &&
        Object.entries(preferences).every(
          ([id, preference]) =>
            /^[a-f0-9]{32}$/.test(id) &&
            plain(preference) &&
            ['follow', 'mute'].includes(String(preference.mode)) &&
            (preference.modeExplicit === undefined || typeof preference.modeExplicit === 'boolean') &&
            (preference.lastNotice === undefined ||
              (plain(preference.lastNotice) &&
                short(preference.lastNotice.reason, 500) &&
                stamp(preference.lastNotice.at) &&
                (preference.lastNotice.artifactUrls === undefined ||
                  (Array.isArray(preference.lastNotice.artifactUrls) &&
                    preference.lastNotice.artifactUrls.length <= 10 &&
                    preference.lastNotice.artifactUrls.every((url) => short(url, 2000)))))) &&
            (preference.snoozedUntil === undefined || stamp(preference.snoozedUntil)) &&
            (preference.feedback === undefined || ['useful', 'dismissed'].includes(String(preference.feedback))) &&
            (preference.feedbackAt === undefined || stamp(preference.feedbackAt)) &&
            (preference.seen === undefined ||
              (plain(preference.seen) &&
                /^[a-f0-9]{64}$/.test(String(preference.seen.fingerprint)) &&
                statuses.includes(preference.seen.status as CommitmentStatus) &&
                typeof preference.seen.sourcePresent === 'boolean' &&
                /^[a-f0-9]{64}$/.test(String(preference.seen.artifacts)) &&
                (preference.seen.artifactStates === undefined ||
                  (Array.isArray(preference.seen.artifactStates) &&
                    preference.seen.artifactStates.length <= 10 &&
                    preference.seen.artifactStates.every(
                      (artifact) =>
                        plain(artifact) &&
                        short(artifact.url, 2000) &&
                        (artifact.state === undefined || short(artifact.state, 30)) &&
                        (artifact.label === undefined || short(artifact.label, 300)) &&
                        (artifact.title === undefined || short(artifact.title, 300)) &&
                        (artifact.updatedAt === undefined || short(artifact.updatedAt, 40)),
                    ))) &&
                (preference.seen.deadline === undefined || short(preference.seen.deadline, 200)))),
        ),
    );
  const channelsValid =
    state.channelPreferences === undefined ||
    (Array.isArray(state.channelPreferences) &&
      state.channelPreferences.length <= 10_000 &&
      state.channelPreferences.every(
        (item) =>
          plain(item) &&
          typeof item.userId === 'string' &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(item.userId) &&
          !['__proto__', 'constructor', 'prototype'].includes(item.userId) &&
          short(item.guildId, 100) &&
          short(item.channelId, 100) &&
          ['follow', 'mute'].includes(String(item.mode)),
      ) &&
      new Set(state.channelPreferences.map((item) => hash([item.userId, item.guildId, item.channelId]))).size ===
        state.channelPreferences.length);
  return (
    entriesValid &&
    usersValid &&
    channelsValid &&
    Number.isSafeInteger(state.reconcileCursor) &&
    state.reconcileCursor >= 0
  );
}
function artifactsOf(commitment: Commitment): string {
  return hash(
    commitment.links.map(({ reference, snapshot }) => ({
      url: reference.url,
      state: snapshot?.state,
      label: snapshot?.label,
      title: snapshot?.title,
      reason: snapshot?.reason,
      updatedAt: snapshot?.updatedAt,
    })),
  );
}
function completionEvidence(commitment: Commitment, at: number): CommitmentView['effectiveCompletion'] {
  const rule = commitment.completionRule;
  if (rule?.kind !== 'artifact') return undefined;
  const link = commitment.links.find((candidate) => candidate.reference.url === rule.url);
  const snapshot = link?.snapshot;
  if (
    !link ||
    !snapshot ||
    snapshot.checkedAt > at ||
    at - snapshot.checkedAt > COMPLETION_EVIDENCE_MAX_AGE_MS ||
    snapshot.state !== rule.state
  )
    return undefined;
  if (
    (rule.state === 'done' && link.reference.kind !== 'jira-issue') ||
    (rule.state === 'merged' && link.reference.kind !== 'github-pull')
  )
    return undefined;
  return { url: rule.url, state: rule.state, checkedAt: snapshot.checkedAt };
}
function appendHistory(entry: Commitment, event: CommitmentHistory): void {
  entry.history = [
    ...(entry.history ?? []),
    { ...event, before: text(event.before, 2000) || '', after: text(event.after, 2000) || '' },
  ].slice(-50);
}
function deadlineInfo(
  commitment: Commitment,
  at: number,
  timezone: string,
): Pick<CommitmentView, 'deadlineState' | 'deadlineDate'> {
  const resolved = resolveDeadline(commitment.deadline, commitment.meetingStartedAt, timezone);
  if (commitment.status === 'completed' || commitment.status === 'cancelled' || completionEvidence(commitment, at))
    return { deadlineState: 'settled', deadlineDate: resolved.status === 'resolved' ? resolved.date : undefined };
  if (commitment.completionRule?.kind === 'artifact') {
    const rule = commitment.completionRule;
    const snapshot = commitment.links.find((link) => link.reference.url === rule.url)?.snapshot;
    if (
      !snapshot ||
      snapshot.checkedAt > at ||
      at - snapshot.checkedAt > COMPLETION_EVIDENCE_MAX_AGE_MS ||
      ['unavailable', 'unknown', 'unverified'].includes(snapshot.state)
    )
      return { deadlineState: 'unknown', deadlineDate: resolved.status === 'resolved' ? resolved.date : undefined };
  }
  if (resolved.status !== 'resolved') return { deadlineState: 'unknown' };
  return {
    deadlineState: at < resolved.fromMs ? 'upcoming' : at < resolved.toMs ? 'due' : 'overdue',
    deadlineDate: resolved.date,
  };
}
function seenState(commitment: Commitment, at = 0, timezone = 'UTC'): SeenState {
  const artifacts = artifactsOf(commitment);
  const deadlineState =
    'deadlineState' in commitment
      ? (commitment as CommitmentView).deadlineState
      : deadlineInfo(commitment, at, timezone).deadlineState;
  return {
    fingerprint: hash([
      commitment.id,
      commitment.task,
      commitment.assignee,
      commitment.deadline,
      commitment.source,
      commitment.status,
      commitment.sourcePresent,
      commitment.completionRule,
      artifacts,
      deadlineState,
    ]),
    status: commitment.status,
    deadline: commitment.deadline,
    sourcePresent: commitment.sourcePresent,
    artifacts,
    artifactStates: commitment.links.map(({ reference, snapshot }) => ({
      url: reference.url,
      state: snapshot?.state,
      label: snapshot?.label,
      title: snapshot?.title,
      updatedAt: snapshot?.updatedAt,
    })),
    deadlineState,
  };
}
function changeReason(commitment: CommitmentView, previous?: SeenState): string {
  const stateLabels: Record<CommitmentStatus, string> = {
    mentioned: 'mencionado',
    confirmed: 'confirmado',
    completed: 'concluído',
    cancelled: 'cancelado',
  };
  if (previous && previous.status !== commitment.status)
    return `Estado do combinado: ${stateLabels[previous.status]} → ${stateLabels[commitment.status]}. Alteração explícita pela conta ${commitment.lastStatusBy ?? 'não registrada'}.`;
  if (commitment.effectiveCompletion && previous?.deadlineState !== 'settled')
    return `Critério escolhido atendido: ${commitment.effectiveCompletion.state === 'done' ? 'issue Done no Jira' : 'PR incorporado no GitHub'}, confirmado por leitura recente. Cobrança de prazo encerrada; implantação não foi verificada.`;
  if (previous?.deadlineState === 'settled' && commitment.deadlineState === 'unknown')
    return 'A confirmação do critério externo precisa de nova consulta. Ausência de confirmação recente não comprova atraso.';
  if (!previous)
    return commitment.deadlineState === 'overdue'
      ? 'Compromisso registrado com prazo já vencido; ainda não houve confirmação de conclusão.'
      : 'Compromisso registrado na reunião; ainda não incluído em um informativo confirmado.';
  if (previous.deadline !== commitment.deadline)
    return `Prazo registrado: ${previous.deadline || 'não definido'} → ${commitment.deadline || 'não definido'}.`;
  if (previous.deadlineState !== commitment.deadlineState && commitment.deadlineState === 'overdue')
    return 'O prazo registrado venceu e o compromisso ainda não foi marcado como concluído ou cancelado.';
  if (previous.deadlineState !== commitment.deadlineState && commitment.deadlineState === 'due')
    return 'O prazo registrado é hoje e o compromisso ainda está aberto.';
  if (previous.sourcePresent !== commitment.sourcePresent)
    return commitment.sourcePresent
      ? 'O compromisso voltou a constar na ata.'
      : 'O compromisso não consta na ata reprocessada; conclusão e cancelamento não foram inferidos.';
  if (previous.artifacts !== artifactsOf(commitment)) {
    for (const { reference, snapshot } of commitment.links) {
      const old = previous.artifactStates?.find((item) => item.url === reference.url);
      if (
        old &&
        old.state === snapshot?.state &&
        old.label === snapshot?.label &&
        old.title === snapshot?.title &&
        old.updatedAt === snapshot?.updatedAt
      )
        continue;
      const name =
        reference.issueKey || (reference.repository ? `${reference.repository}#${reference.number}` : reference.url);
      const detail =
        old?.state !== snapshot?.state || old?.label !== snapshot?.label
          ? `${old?.label || old?.state || 'sem leitura anterior'} → ${snapshot?.label || snapshot?.state || 'aguardando consulta'}`
          : old?.title !== snapshot?.title
            ? `título atualizado para “${snapshot?.title || 'não informado'}”`
            : `atualizada na origem em ${snapshot?.updatedAt || 'horário não informado'}`;
      return text(`${name}: ${detail}. Implantação não foi verificada.`, 500)!;
    }
    return 'Os vínculos visíveis foram removidos ou deixaram de estar acessíveis; isso não comprova conclusão.';
  }
  return 'As informações registradas para este compromisso mudaram.';
}

function loadCommitmentState(file: string): CommitmentState {
  try {
    if (fs.statSync(file).size > MAX_LEGACY_STATE_BYTES)
      throw new CommitmentCapacityError('Commitment state exceeds recovery size limit');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return readJsonState(file, empty(), validState);
}

function saveCommitmentState(file: string, state: CommitmentState, shrinking = false): void {
  const bytes = Buffer.byteLength(JSON.stringify(state, null, 2));
  if (bytes > MAX_STATE_BYTES && (!shrinking || bytes >= fs.statSync(file).size))
    throw new CommitmentCapacityError('Limite de armazenamento dos combinados atingido.');
  writeJsonStateAtomic(file, state);
}

/** Retention/deletion hook independent of runtime credentials, provider configuration and recipient ACLs. */
export function removeStoredMeetingCommitments(stateDir: string, meetingId: string): void {
  const file = path.join(stateDir, 'commitments.json');
  const state = loadCommitmentState(file);
  const removed = new Set<string>();
  for (const entry of Object.values(state.commitments)) {
    if (entry.meetingId === meetingId) {
      delete state.commitments[entry.id];
      removed.add(entry.id);
    }
  }
  for (const [userId, entries] of Object.entries(state.users)) {
    for (const id of removed) delete entries[id];
    if (!Object.keys(entries).length) delete state.users[userId];
  }
  for (const entry of Object.values(state.commitments)) {
    if (entry.relatedIds) entry.relatedIds = entry.relatedIds.filter((id) => !removed.has(id));
    if (entry.history)
      entry.history = entry.history.filter((event) => !event.relatedId || !removed.has(event.relatedId));
  }
  if (removed.size) saveCommitmentState(file, state, true);
}

/** Persistent commitments, exact external references and per-recipient digests. This module never sends messages. */
export function createCommitmentService(options: CommitmentServiceOptions) {
  const file = path.join(options.stateDir, 'commitments.json');
  const now = options.now ?? Date.now;
  const timezone = options.timezone ?? 'UTC';
  const maxRequests = Math.max(1, Math.min(100, options.maxRequestsPerReconcile ?? 20));
  let reconciling = false;
  // ponytail: process-local fairness cursor; restart resumes from the first followed record.
  const digestCursors = new Map<string, string>();
  function load(): CommitmentState {
    return loadCommitmentState(file);
  }
  function save(state: CommitmentState): void {
    saveCommitmentState(file, state);
  }
  async function canRead(userId: string, meetingId: string): Promise<boolean> {
    try {
      return (await options.authorize(userId, meetingId)) === true;
    } catch {
      throw new CommitmentAuthorizationUnavailableError();
    }
  }
  async function canReadArtifact(
    userId: string,
    reference: ArtifactReference,
    entry: Pick<Commitment, 'guildId' | 'channelId'>,
  ): Promise<boolean> {
    try {
      return (
        (await options.authorizeArtifact?.(userId, reference, {
          guildId: entry.guildId,
          channelId: entry.channelId,
        })) === true
      );
    } catch {
      throw new CommitmentAuthorizationUnavailableError();
    }
  }
  async function authorized(userId: string, id: string): Promise<Commitment> {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new CommitmentAccessError();
    const entry = load().commitments[id];
    if (!entry || !(await canRead(userId, entry.meetingId))) throw new CommitmentAccessError();
    return entry;
  }
  async function view(
    userId: string,
    entry: Commitment,
    userState?: UserState,
    channelFollowed = false,
  ): Promise<CommitmentView> {
    let sourceAccessIncomplete = false;
    const canExpose = async (reference: ArtifactReference): Promise<boolean> => {
      try {
        return await canReadArtifact(userId, reference, entry);
      } catch (error) {
        if (!(error instanceof CommitmentAuthorizationUnavailableError)) throw error;
        sourceAccessIncomplete = true;
        return false;
      }
    };
    const links: CommitmentLink[] = [];
    for (const link of entry.links)
      if (await canExpose(link.reference))
        links.push(
          link.reference.kind === 'document'
            ? {
                ...link,
                snapshot: {
                  state: 'unverified',
                  label: 'Referência manual; conteúdo não consultado',
                  checkedAt: link.addedAt,
                  deployed: null,
                  reason: 'manual_reference',
                },
              }
            : link,
        );
    const history: CommitmentHistory[] = [];
    for (const event of entry.history ?? []) {
      if (!event.reference || (await canExpose(event.reference))) history.push(event);
    }
    const visibleUrls = new Set(links.map((link) => link.reference.url));
    const hiddenRule = entry.completionRule?.kind === 'artifact' && !visibleUrls.has(entry.completionRule.url);
    const completionRule = hiddenRule ? undefined : entry.completionRule;
    const visible = { ...entry, links, history, completionRule };
    const lastNotice = userState?.lastNotice;
    return {
      ...visible,
      sourceAccessIncomplete,
      ...deadlineInfo(visible, now(), timezone),
      ...(hiddenRule && !['completed', 'cancelled'].includes(entry.status)
        ? { deadlineState: 'unknown' as const }
        : {}),
      channelFollowed,
      effectiveCompletion: completionEvidence(visible, now()),
      lastNotice:
        lastNotice && (!lastNotice.artifactUrls || lastNotice.artifactUrls.every((url) => visibleUrls.has(url)))
          ? { reason: lastNotice.reason, at: lastNotice.at }
          : undefined,
      preference: {
        mode: userState && userState.modeExplicit !== false ? userState.mode : channelFollowed ? 'follow' : 'mute',
        ...(userState?.snoozedUntil ? { snoozedUntil: userState.snoozedUntil } : {}),
        ...(userState?.feedback ? { feedback: userState.feedback, feedbackAt: userState.feedbackAt } : {}),
      },
    };
  }
  function checkUserId(userId: string): void {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(userId) || ['__proto__', 'constructor', 'prototype'].includes(userId))
      throw new CommitmentInputError('Identidade inválida.');
  }
  async function mutationTargets(
    userId: string,
    id: string,
    relatedIds: string[] = [],
  ): Promise<{ state: CommitmentState; entries: Commitment[] }> {
    if (
      !Array.isArray(relatedIds) ||
      relatedIds.length > 100 ||
      relatedIds.some((related) => !/^[a-f0-9]{32}$/.test(related))
    )
      throw new CommitmentInputError('Relacionamentos inválidos.');
    const ids = [...new Set([id, ...relatedIds])];
    for (const candidate of ids) await authorized(userId, candidate);
    const state = load();
    const entries = ids.map((candidate) => state.commitments[candidate]);
    if (entries.some((entry) => !entry)) throw new CommitmentAccessError();
    const allowed = new Set(ids);
    const connected = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (connected.has(current)) continue;
      connected.add(current);
      for (const next of state.commitments[current].relatedIds ?? [])
        if (allowed.has(next) && !connected.has(next)) pending.push(next);
    }
    if (ids.some((candidate) => !connected.has(candidate)))
      throw new CommitmentInputError('A propagação exige combinados relacionados e acessíveis.');
    return { state, entries };
  }
  async function relate(userId: string, id: string, otherId: string, link: boolean): Promise<void> {
    checkUserId(userId);
    if (id === otherId) throw new CommitmentInputError('Escolha outro combinado.');
    await authorized(userId, id);
    await authorized(userId, otherId);
    const state = load();
    const left = state.commitments[id],
      right = state.commitments[otherId];
    if (!left || !right) throw new CommitmentAccessError();
    if (
      link &&
      [left, right].some(
        (entry) => (entry.relatedIds?.length ?? 0) >= 20 && !entry.relatedIds?.includes(entry.id === id ? otherId : id),
      )
    )
      throw new CommitmentInputError('Limite de relações atingido.');
    let changed = false;
    for (const [entry, other] of [
      [left, right],
      [right, left],
    ]) {
      const previous = entry.relatedIds ?? [];
      if (previous.includes(other.id) === link) continue;
      entry.relatedIds = link ? [...previous, other.id] : previous.filter((candidate) => candidate !== other.id);
      entry.updatedAt = now();
      appendHistory(entry, {
        at: now(),
        actorId: userId,
        kind: 'relation',
        before: link ? 'não relacionado' : other.id,
        after: link ? other.id : 'relação removida',
        relatedId: other.id,
      });
      changed = true;
    }
    if (changed) save(state);
  }

  const service = {
    /** Relates separate source records. Neither operation changes status or subscriptions. */
    mergeForUser: (userId: string, id: string, otherId: string) => relate(userId, id, otherId, true),
    unlinkForUser: (userId: string, id: string, otherId: string) => relate(userId, id, otherId, false),
    /** Only recipients who explicitly followed at least one commitment are returned. */
    listFollowers(limit = 1000): string[] {
      const state = load();
      const individual = Object.entries(state.users)
        .filter(([, entries]) =>
          Object.entries(entries).some(
            ([id, preference]) =>
              !!state.commitments[id] && preference.mode === 'follow' && (preference.snoozedUntil || 0) <= now(),
          ),
        )
        .map(([id]) => id);
      const channels = (state.channelPreferences ?? [])
        .filter((item) => item.mode === 'follow')
        .map((item) => item.userId);
      return [...new Set([...individual, ...channels])].slice(0, Math.max(0, Math.min(1000, limit)));
    },
    syncMeeting(meta: CommitmentMeetingInput, actions: CommitmentActionInput[]): Commitment[] {
      if (
        !meta.id ||
        !meta.guildId ||
        !meta.voiceChannelId ||
        !Number.isFinite(meta.startedAt) ||
        !Array.isArray(actions) ||
        actions.length > 500
      )
        throw new CommitmentInputError('Reunião inválida.');
      const state = load();
      const found = new Set<string>();
      const occurrences = new Map<string, number>();
      const result: Commitment[] = [];
      const at = now();
      for (const action of actions) {
        const task = text(action.tarefa, 2000);
        if (!task) continue;
        const assignee = text(action.responsavel, 200);
        const identity = hash([meta.id, normalized(task), normalized(assignee)]);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        const id = hash([identity, occurrence]).slice(0, 32);
        found.add(id);
        const previous = state.commitments[id];
        const entry: Commitment = {
          id,
          meetingId: meta.id,
          guildId: meta.guildId,
          channelId: meta.voiceChannelId,
          meetingStartedAt: meta.startedAt,
          task,
          assignee,
          deadline: text(action.prazo, 200),
          source: validSource(action.source),
          sourcePresent: true,
          status: previous?.status ?? 'mentioned',
          lastStatusBy: previous?.lastStatusBy,
          lastStatusAt: previous?.lastStatusAt,
          createdAt: previous?.createdAt ?? at,
          updatedAt: previous?.updatedAt ?? at,
          links: previous?.links ?? [],
          relatedIds: previous?.relatedIds,
          history: previous?.history,
          completionRule: previous?.completionRule,
        };
        if (!previous || seenState(previous).fingerprint !== seenState(entry).fingerprint) entry.updatedAt = at;
        state.commitments[id] = entry;
        result.push(entry);
      }
      for (const entry of Object.values(state.commitments)) {
        if (entry.meetingId === meta.id && !found.has(entry.id) && entry.sourcePresent) {
          entry.sourcePresent = false;
          entry.updatedAt = at;
        }
      }
      if (Object.keys(state.commitments).length > 10_000)
        throw new CommitmentCapacityError('Limite do acervo de compromissos atingido.');
      save(state);
      return result;
    },
    async listForUser(
      userId: string,
      filter: {
        meetingId?: string;
        channelId?: string;
        commitmentId?: string;
        groupOf?: string;
        includeRelatedMentions?: boolean;
        followedOnly?: boolean;
        offset?: number;
        /** Internal digest rotation; wraps around so every followed record gets checked. */
        startAfterId?: string;
        /** Ordered, already bounded meeting page; avoids rereading state per meeting. */
        meetingIds?: string[];
        after?: { meetingId: string; commitmentId: string };
        status?: CommitmentStatus;
        limit?: number;
      } = {},
    ): Promise<CommitmentView[]> {
      checkUserId(userId);
      if (filter.meetingIds && filter.meetingIds.length > 300)
        throw new CommitmentInputError('Página de reuniões inválida.');
      if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 101))
        throw new CommitmentInputError('Limite inválido.');
      if (
        filter.offset !== undefined &&
        (!Number.isInteger(filter.offset) || filter.offset < 0 || filter.offset > 10_000)
      )
        throw new CommitmentInputError('Página inválida.');
      if (filter.status && !statuses.includes(filter.status)) throw new CommitmentInputError('Estado inválido.');
      for (const id of [filter.commitmentId, filter.groupOf])
        if (id !== undefined && !/^[a-f0-9]{32}$/.test(id)) throw new CommitmentInputError('Combinado inválido.');
      const state = load();
      const access = new Map<string, boolean>();
      const canReadEntry = async (entry: Commitment): Promise<boolean> => {
        if (!access.has(entry.meetingId)) access.set(entry.meetingId, await canRead(userId, entry.meetingId));
        return access.get(entry.meetingId)!;
      };
      let selectedGroup: Set<string> | undefined;
      if (filter.groupOf) {
        selectedGroup = new Set();
        const examined = new Set<string>();
        const pending = [filter.groupOf];
        while (pending.length) {
          const id = pending.pop()!;
          if (examined.has(id)) continue;
          examined.add(id);
          const entry = state.commitments[id];
          if (!entry || !(await canReadEntry(entry))) continue;
          selectedGroup.add(id);
          pending.push(...(entry.relatedIds ?? []));
        }
      }
      const followedChannels = new Set(
        (state.channelPreferences ?? [])
          .filter((item) => item.userId === userId && item.mode === 'follow')
          .map((item) => hash([item.guildId, item.channelId])),
      );
      const order = filter.meetingIds ? new Map(filter.meetingIds.map((id, index) => [id, index])) : undefined;
      const result: CommitmentView[] = [];
      const entries = Object.values(state.commitments)
        .filter(
          (entry) =>
            (!filter.commitmentId || entry.id === filter.commitmentId) &&
            (!selectedGroup || selectedGroup.has(entry.id)) &&
            (!filter.meetingId || entry.meetingId === filter.meetingId) &&
            (!filter.channelId || entry.channelId === filter.channelId) &&
            (!filter.followedOnly ||
              ((state.users[userId]?.[entry.id]?.snoozedUntil ?? 0) <= now() &&
                (state.users[userId]?.[entry.id] && state.users[userId][entry.id].modeExplicit !== false
                  ? state.users[userId][entry.id].mode === 'follow'
                  : followedChannels.has(hash([entry.guildId, entry.channelId]))))) &&
            (!order || order.has(entry.meetingId)) &&
            (!filter.status || entry.status === filter.status) &&
            (!filter.after || entry.meetingId !== filter.after.meetingId || entry.id > filter.after.commitmentId),
        )
        .sort(
          (a, b) =>
            (order ? order.get(a.meetingId)! - order.get(b.meetingId)! : b.meetingStartedAt - a.meetingStartedAt) ||
            a.id.localeCompare(b.id),
        );
      const rotation = filter.startAfterId ? entries.findIndex((entry) => entry.id === filter.startAfterId) + 1 : 0;
      const ordered = rotation ? [...entries.slice(rotation), ...entries.slice(0, rotation)] : entries;
      let skippedVisible = 0;
      for (const entry of ordered) {
        if (result.length >= (filter.limit ?? Infinity)) break;
        if (await canReadEntry(entry)) {
          if (skippedVisible++ < (filter.offset ?? 0)) continue;
          result.push(
            await view(
              userId,
              entry,
              state.users[userId]?.[entry.id],
              followedChannels.has(hash([entry.guildId, entry.channelId])),
            ),
          );
        }
      }
      // Never traverse hidden nodes or use their IDs in a visible group key.
      const visible = new Map(result.map((entry) => [entry.id, entry]));
      const visited = new Set<string>();
      for (const entry of result) {
        if (filter.includeRelatedMentions) {
          entry.relatedMentions = [];
          for (const id of entry.relatedIds ?? []) {
            const related = state.commitments[id];
            if (related && (await canReadEntry(related)))
              entry.relatedMentions.push({ id, meetingStartedAt: related.meetingStartedAt, task: related.task });
          }
        }
        entry.directRelatedIds = (entry.relatedIds ?? []).filter((id) => visible.has(id));
        entry.history = entry.history
          ?.filter((event) => !event.relatedId || visible.has(event.relatedId))
          .map(({ at, actorId, kind, before, after }) => ({ at, actorId, kind, before, after }));
      }
      for (const entry of result) {
        if (visited.has(entry.id)) continue;
        const ids: string[] = [];
        const pending = [entry.id];
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id)) continue;
          visited.add(id);
          ids.push(id);
          for (const next of visible.get(id)?.directRelatedIds ?? []) if (!visited.has(next)) pending.push(next);
        }
        ids.sort();
        const groupId = hash(ids).slice(0, 32);
        for (const id of ids) {
          const member = visible.get(id)!;
          member.groupId = groupId;
          member.relatedIds = ids.filter((other) => other !== id);
        }
      }
      return result;
    },
    async coverageForUser(userId: string): Promise<{
      configured: boolean;
      commitments: number;
      linked: number;
      checked: number;
      unavailable: number;
      lastCheckedAt?: number;
    }> {
      const entries = await service.listForUser(userId);
      const links = entries.flatMap((entry) => entry.links);
      const checkedAt = links.flatMap((link) => (link.snapshot ? [link.snapshot.checkedAt] : []));
      return {
        configured: !!options.integrations,
        commitments: entries.length,
        linked: links.length,
        checked: checkedAt.length,
        unavailable: links.filter((link) => link.snapshot?.state === 'unavailable').length,
        lastCheckedAt: checkedAt.length ? Math.max(...checkedAt) : undefined,
      };
    },
    async setStatus(
      userId: string,
      id: string,
      status: CommitmentStatus,
      opts: { relatedIds?: string[] } = {},
    ): Promise<void> {
      checkUserId(userId);
      if (!statuses.includes(status)) throw new CommitmentInputError('Estado inválido.');
      const { state, entries } = await mutationTargets(userId, id, opts.relatedIds);
      let changed = false;
      for (const entry of entries)
        if (entry.status !== status) {
          appendHistory(entry, { at: now(), actorId: userId, kind: 'status', before: entry.status, after: status });
          entry.status = status;
          entry.lastStatusBy = userId;
          entry.lastStatusAt = now();
          entry.updatedAt = now();
          changed = true;
        }
      if (changed) save(state);
    },
    async setLinks(userId: string, id: string, inputs: string[]): Promise<void> {
      checkUserId(userId);
      const initial = await authorized(userId, id);
      if (!options.integrations || !Array.isArray(inputs) || inputs.length > 10)
        throw new CommitmentInputError('Integração indisponível ou quantidade de vínculos excedida.');
      let references: ArtifactReference[];
      try {
        references = inputs.map((value) =>
          options.integrations!.resolve(value, { guildId: initial.guildId, channelId: initial.channelId }),
        );
      } catch {
        throw new CommitmentInputError('Vínculo inválido ou fora do contexto autorizado.');
      }
      for (const reference of references)
        if (!(await canReadArtifact(userId, reference, initial))) throw new CommitmentAccessError();
      const editableUrls = new Set<string>();
      for (const link of load().commitments[id]?.links ?? []) {
        if (await canReadArtifact(userId, link.reference, initial)) editableUrls.add(link.reference.url);
      }
      if (!(await canRead(userId, initial.meetingId))) throw new CommitmentAccessError();
      const state = load();
      const entry = state.commitments[id];
      if (!entry) throw new CommitmentAccessError();
      const previous = new Map(entry.links.map((link) => [link.reference.url, link]));
      const visibleLinks = [...new Map(references.map((ref) => [ref.url, ref])).values()].map(
        (reference) => previous.get(reference.url) ?? { reference, addedAt: now() },
      );
      // A recipient cannot delete links that their own ACL hides. Newly added
      // concurrent links were not authorized above and are preserved as well.
      const preserved = entry.links.filter((link) => !editableUrls.has(link.reference.url));
      const merged = [...new Map([...preserved, ...visibleLinks].map((link) => [link.reference.url, link])).values()];
      if (merged.length > 10) throw new CommitmentInputError('Limite de vínculos do compromisso atingido.');
      const nextUrls = new Set(merged.map((link) => link.reference.url));
      for (const old of entry.links)
        if (!nextUrls.has(old.reference.url))
          appendHistory(entry, {
            at: now(),
            actorId: userId,
            kind: 'link',
            before: old.reference.url,
            after: 'vínculo removido',
            reference: old.reference,
          });
      for (const added of merged)
        if (!previous.has(added.reference.url))
          appendHistory(entry, {
            at: now(),
            actorId: userId,
            kind: 'link',
            before: 'sem vínculo',
            after: added.reference.url,
            reference: added.reference,
          });
      if (entry.completionRule?.kind === 'artifact' && !nextUrls.has(entry.completionRule.url)) {
        const reference = previous.get(entry.completionRule.url)?.reference;
        appendHistory(entry, {
          at: now(),
          actorId: userId,
          kind: 'completion-rule',
          before: `${entry.completionRule.state}: ${entry.completionRule.url}`,
          after: 'manual; vínculo removido',
          reference,
        });
        entry.completionRule = { kind: 'manual' };
      }
      entry.links = merged;
      entry.updatedAt = now();
      save(state);
    },
    async setPreference(
      userId: string,
      id: string,
      preference: CommitmentPreference,
      opts: { relatedIds?: string[] } = {},
    ): Promise<void> {
      checkUserId(userId);
      if (
        !preference ||
        !['follow', 'mute'].includes(preference.mode) ||
        (preference.snoozedUntil !== undefined &&
          (!Number.isFinite(preference.snoozedUntil) ||
            preference.snoozedUntil < 0 ||
            preference.snoozedUntil > now() + 366 * 86400000))
      )
        throw new CommitmentInputError('Preferência inválida.');
      const { state, entries } = await mutationTargets(userId, id, opts.relatedIds);
      state.users[userId] ??= {};
      for (const entry of entries)
        state.users[userId][entry.id] = {
          ...state.users[userId][entry.id],
          mode: preference.mode,
          modeExplicit: true,
          snoozedUntil: preference.snoozedUntil,
        };
      save(state);
    },
    async setChannelPreference(userId: string, referenceCommitmentId: string, mode: 'follow' | 'mute'): Promise<void> {
      checkUserId(userId);
      if (!['follow', 'mute'].includes(mode)) throw new CommitmentInputError('Preferência de canal inválida.');
      const entry = await authorized(userId, referenceCommitmentId);
      const state = load();
      if (!state.commitments[referenceCommitmentId]) throw new CommitmentAccessError();
      state.channelPreferences ??= [];
      const preference = state.channelPreferences.find(
        (item) => item.userId === userId && item.guildId === entry.guildId && item.channelId === entry.channelId,
      );
      if (preference) preference.mode = mode;
      else {
        if (state.channelPreferences.length >= 10_000)
          throw new CommitmentInputError('Limite de assinaturas atingido.');
        state.channelPreferences.push({ userId, guildId: entry.guildId, channelId: entry.channelId, mode });
      }
      save(state);
    },
    async setFeedback(userId: string, id: string, feedback: 'useful' | 'dismissed' | undefined): Promise<void> {
      checkUserId(userId);
      if (feedback !== undefined && !['useful', 'dismissed'].includes(feedback))
        throw new CommitmentInputError('Avaliação inválida.');
      await authorized(userId, id);
      const state = load();
      if (!state.commitments[id]) throw new CommitmentAccessError();
      state.users[userId] ??= {};
      const previous = state.users[userId][id];
      state.users[userId][id] = {
        ...previous,
        mode: previous?.mode ?? 'mute',
        modeExplicit: previous ? previous.modeExplicit : false,
        feedback,
        feedbackAt: feedback ? now() : undefined,
      };
      save(state);
    },
    /** Only aggregate counts; the caller must gate this operational endpoint to the owner. */
    feedbackSummary(): { useful: number; dismissed: number; responses: number } {
      const state = load();
      let useful = 0,
        dismissed = 0;
      for (const entries of Object.values(state.users))
        for (const [id, preference] of Object.entries(entries)) {
          if (!state.commitments[id]) continue;
          if (preference.feedback === 'useful') useful++;
          if (preference.feedback === 'dismissed') dismissed++;
        }
      return { useful, dismissed, responses: useful + dismissed };
    },
    async setCompletionRule(
      userId: string,
      id: string,
      rule: CommitmentCompletionRule,
      opts: { relatedIds?: string[] } = {},
    ): Promise<void> {
      checkUserId(userId);
      if (
        !rule ||
        (rule.kind !== 'manual' &&
          (rule.kind !== 'artifact' || !['done', 'merged'].includes(rule.state) || typeof rule.url !== 'string'))
      )
        throw new CommitmentInputError('Critério inválido.');
      const initial = (await mutationTargets(userId, id, opts.relatedIds)).entries;
      // The selected source must already belong to the representative. Applying
      // it to explicit related targets is the only operation that copies a link.
      if (rule.kind === 'artifact' && !initial[0].links.some((link) => link.reference.url === rule.url))
        throw new CommitmentAccessError();
      const references = new Map<string, ArtifactReference>();
      for (const entry of initial) {
        if (entry.completionRule?.kind === 'artifact') {
          const previous = entry.completionRule;
          const link = entry.links.find((candidate) => candidate.reference.url === previous.url);
          if (!link || !(await canReadArtifact(userId, link.reference, entry))) throw new CommitmentAccessError();
        }
        if (rule.kind === 'artifact') {
          let reference: ArtifactReference;
          try {
            if (!options.integrations) throw new Error('unconfigured');
            reference = options.integrations.resolve(rule.url, { guildId: entry.guildId, channelId: entry.channelId });
          } catch {
            throw new CommitmentInputError(
              'A fonte precisa estar autorizada no contexto de todos os combinados selecionados.',
            );
          }
          if (
            (rule.state === 'done' && reference.kind !== 'jira-issue') ||
            (rule.state === 'merged' && reference.kind !== 'github-pull')
          )
            throw new CommitmentInputError('Critério incompatível com a fonte.');
          if (!(await canReadArtifact(userId, reference, entry))) throw new CommitmentAccessError();
          references.set(entry.id, reference);
        }
      }
      const { state, entries } = await mutationTargets(userId, id, opts.relatedIds);
      if (rule.kind === 'artifact' && !entries[0].links.some((link) => link.reference.url === rule.url))
        throw new CommitmentAccessError();
      // Validate every target and concurrent change before mutating any record.
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (
          hash(entry.completionRule ?? { kind: 'manual' }) !== hash(initial[index].completionRule ?? { kind: 'manual' })
        )
          throw new CommitmentInputError('O critério mudou durante a consulta. Recarregue antes de salvar.');
        const reference = references.get(entry.id);
        if (reference && !entry.links.some((link) => link.reference.url === reference.url) && entry.links.length >= 10)
          throw new CommitmentInputError('Limite de vínculos atingido em um combinado selecionado.');
      }
      const next: CommitmentCompletionRule =
        rule.kind === 'manual' ? { kind: 'manual' } : { kind: 'artifact', url: rule.url, state: rule.state };
      let changed = false;
      for (const entry of entries) {
        const reference = references.get(entry.id);
        if (reference && !entry.links.some((link) => link.reference.url === reference.url)) {
          entry.links.push({ reference, addedAt: now() });
          appendHistory(entry, {
            at: now(),
            actorId: userId,
            kind: 'link',
            before: 'sem vínculo',
            after: reference.url,
            reference,
          });
          changed = true;
        }
        if (hash(entry.completionRule ?? { kind: 'manual' }) === hash(next)) continue;
        if (entry.completionRule?.kind === 'artifact') {
          const previous = entry.completionRule;
          appendHistory(entry, {
            at: now(),
            actorId: userId,
            kind: 'completion-rule',
            before: `${previous.state}: ${previous.url}`,
            after: 'manual',
            reference: entry.links.find((link) => link.reference.url === previous.url)?.reference,
          });
        }
        if (next.kind === 'artifact')
          appendHistory(entry, {
            at: now(),
            actorId: userId,
            kind: 'completion-rule',
            before: 'manual',
            after: `${next.state}: ${next.url}`,
            reference,
          });
        entry.completionRule = { ...next };
        entry.updatedAt = now();
        changed = true;
      }
      if (changed) save(state);
    },
    async reconcile(): Promise<{ checked: number; changed: number; skipped: number }> {
      if (!options.integrations || reconciling) return { checked: 0, changed: 0, skipped: 0 };
      reconciling = true;
      let checked = 0,
        changed = 0,
        skipped = 0;
      try {
        const initial = load();
        const work = Object.values(initial.commitments).flatMap((entry) =>
          entry.links.map((link) => ({ entry, link })),
        );
        if (!work.length) return { checked, changed, skipped };
        const start = (initial.reconcileCursor || 0) % work.length;
        let examined = 0;
        const cache = new Map<string, ArtifactSnapshot>();
        while (examined < work.length && checked < maxRequests) {
          const { entry, link } = work[(start + examined++) % work.length];
          if (options.isMeetingActive && !options.isMeetingActive(entry.meetingId)) {
            skipped++;
            continue;
          }
          if (link.snapshot?.retryAt && link.snapshot.retryAt > now()) {
            skipped++;
            continue;
          }
          const key = `${entry.guildId}:${entry.channelId}:${link.reference.url}`;
          let snapshot = cache.get(key);
          if (!snapshot) {
            try {
              snapshot = await options.integrations.lookup(link.reference, {
                guildId: entry.guildId,
                channelId: entry.channelId,
              });
            } catch {
              snapshot = {
                state: 'unavailable',
                label: 'Fonte fora do contexto autorizado ou indisponível',
                checkedAt: now(),
                deployed: null,
                reason: 'access_denied',
              };
            }
            cache.set(key, snapshot);
            checked++;
          }
          const state = load();
          const fresh = state.commitments[entry.id];
          const current = fresh?.links.find((l) => l.reference.url === link.reference.url);
          if (!fresh || !current) continue;
          const before = artifactsOf(fresh);
          current.snapshot = snapshot;
          if (before !== artifactsOf(fresh)) {
            fresh.updatedAt = now();
            changed++;
          }
          state.reconcileCursor = (start + examined) % work.length;
          save(state);
        }
        return { checked, changed, skipped };
      } finally {
        reconciling = false;
      }
    },
    async prepareDigest(userId: string): Promise<CommitmentDigest> {
      const views = await service.listForUser(userId, {
        followedOnly: true,
        limit: 100,
        startAfterId: digestCursors.get(userId),
      });
      const firstIncomplete = views.findIndex((entry) => entry.sourceAccessIncomplete);
      const lastChecked = firstIncomplete < 0 ? views.at(-1) : views[Math.max(0, firstIncomplete - 1)];
      if (lastChecked) {
        digestCursors.delete(userId);
        digestCursors.set(userId, lastChecked.id);
        if (digestCursors.size > 1000) digestCursors.delete(digestCursors.keys().next().value!);
      }
      const state = load();
      const items: CommitmentDigestItem[] = [];
      for (const commitment of views) {
        if (commitment.sourceAccessIncomplete) continue;
        if (commitment.preference.mode === 'mute' || (commitment.preference.snoozedUntil || 0) > now()) continue;
        const previous = state.users[userId]?.[commitment.id]?.seen;
        const current = seenState(commitment, now(), timezone);
        if (previous?.fingerprint !== current.fingerprint)
          items.push({ commitment, fingerprint: current.fingerprint, reason: changeReason(commitment, previous) });
      }
      return {
        id: hash([userId, items.map((item) => [item.commitment.id, item.fingerprint])]).slice(0, 32),
        createdAt: now(),
        items,
      };
    },
    /** Acknowledge only after confirmed delivery. Preparing a preview changes no state. */
    async acknowledgeDigest(userId: string, digest: CommitmentDigest): Promise<void> {
      checkUserId(userId);
      if (!digest || !Array.isArray(digest.items) || digest.items.length > 10_000)
        throw new CommitmentInputError('Informativo inválido.');
      const accepted: { id: string; seen: SeenState; reason: string; artifactUrls: string[] }[] = [];
      for (const item of digest.items) {
        const entry = load().commitments[item.commitment.id];
        if (!entry || !(await canRead(userId, entry.meetingId))) continue;
        const visible = await view(userId, entry);
        if (visible.sourceAccessIncomplete) continue;
        const seen = seenState(visible, now(), timezone);
        // Do not acknowledge a change that happened after this digest was prepared.
        if (seen.fingerprint === item.fingerprint)
          accepted.push({
            id: entry.id,
            seen,
            reason: changeReason(visible, load().users[userId]?.[entry.id]?.seen),
            artifactUrls: visible.links.map((link) => link.reference.url),
          });
      }
      if (!accepted.length) return;
      const state = load();
      state.users[userId] ??= {};
      for (const { id, seen, reason, artifactUrls } of accepted)
        if (state.commitments[id])
          state.users[userId][id] = {
            ...(state.users[userId][id] ?? { mode: 'mute', modeExplicit: false }),
            seen,
            lastNotice: { reason, at: now(), artifactUrls },
          };
      save(state);
    },
    /** Called by the recording deletion/retention hook, never by untrusted external events. */
    removeMeeting(meetingId: string): void {
      removeStoredMeetingCommitments(options.stateDir, meetingId);
    },
    removeMissingMeetings(existingIds: ReadonlySet<string>): void {
      const meetings = new Set(Object.values(load().commitments).map((entry) => entry.meetingId));
      for (const meetingId of meetings) if (!existingIds.has(meetingId)) service.removeMeeting(meetingId);
    },
  };
  return service;
}

export type CommitmentService = ReturnType<typeof createCommitmentService>;
