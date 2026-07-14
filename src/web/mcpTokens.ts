import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/**
 * Registro de SESSÕES de conector MCP (fonte da verdade da revogação).
 *
 * Em vez de uma denylist que só cresce, guardamos as sessões ATIVAS: revogar =
 * remover a sessão (efeito imediato — qualquer access token com aquele `sid` para
 * de valer na hora), e o GC só descarta o que expirou. Cada sessão tem um `sid`
 * estável (vai no `jti` dos tokens) e uma `gen` que rotaciona a cada refresh —
 * apresentar uma geração antiga denuncia reuso de refresh roubado e mata a sessão.
 *
 * Persistido em disco (0600 + fsync + rename atômico) para sobreviver a reinícios.
 */

interface Session {
  sid: string;
  userId: string;
  name: string;
  /** geração atual do refresh; o próximo refresh válido tem que apresentar exatamente esta. */
  gen: number;
  /** expiração do refresh (ms epoch), deslizante a cada rotação. */
  exp: number;
  createdAt: number;
  /** apelido dado pelo usuário ao gerar ("Claude do notebook") — só exibição. */
  label?: string;
  /** último refresh bem-sucedido = conector em uso (sessões antigas não têm). */
  lastSeenAt?: number;
  /** Retry idempotente da rotação mais recente, sem guardar nenhum token. */
  lastRefreshAttempt?: {
    id: string;
    fromGen: number;
    /** Campo do schema anterior; aceito só durante a migração e ignorado. */
    replayUntil?: number;
  };
}

const FILE = path.join(config.recordingsDir, '.mcp-sessions.json');
const sessions = new Map<string, Session>();
let loaded = false;
const MAX_SESSIONS_PER_USER = 10;
const MAX_SESSIONS_TOTAL = 5_000;

export class McpSessionCapacityError extends Error {
  constructor() {
    super('limite global de sessões MCP atingido');
    this.name = 'McpSessionCapacityError';
  }
}

interface CapacitySession {
  sid: string;
  userId: string;
  createdAt: number;
}

/**
 * Planeja a admissão sem revogar terceiros: o usuário pode substituir suas
 * próprias conexões antigas, mas um registro global cheio recusa novos donos.
 */
export function planSessionCapacity(
  existing: readonly CapacitySession[],
  userId: string,
  limits = { perUser: MAX_SESSIONS_PER_USER, total: MAX_SESSIONS_TOTAL },
): { canCreate: boolean; evictSids: string[] } {
  const owned = existing.filter((session) => session.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  const evictSids = owned.slice(0, Math.max(0, owned.length - limits.perUser + 1)).map((session) => session.sid);
  if (existing.length - evictSids.length >= limits.total) return { canCreate: false, evictSids: [] };
  return { canCreate: true, evictSids };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    let needsMigration = false;
    const valid = parsed
      .filter((value): value is Session => {
        if (!value || typeof value !== 'object') return false;
        const s = value as Partial<Session>;
        return (
          typeof s.sid === 'string' &&
          s.sid.length > 0 &&
          typeof s.userId === 'string' &&
          s.userId.length > 0 &&
          typeof s.name === 'string' &&
          Number.isInteger(s.gen) &&
          (s.gen as number) >= 0 &&
          typeof s.exp === 'number' &&
          Number.isFinite(s.exp) &&
          s.exp > now &&
          typeof s.createdAt === 'number' &&
          Number.isFinite(s.createdAt) &&
          (s.lastRefreshAttempt === undefined ||
            (typeof s.lastRefreshAttempt === 'object' &&
              s.lastRefreshAttempt !== null &&
              isRefreshAttemptId(s.lastRefreshAttempt.id) &&
              Number.isInteger(s.lastRefreshAttempt.fromGen) &&
              s.lastRefreshAttempt.fromGen >= 0 &&
              s.lastRefreshAttempt.fromGen === (s.gen as number) - 1 &&
              (s.lastRefreshAttempt.replayUntil === undefined ||
                (typeof s.lastRefreshAttempt.replayUntil === 'number' &&
                  Number.isFinite(s.lastRefreshAttempt.replayUntil)))))
        );
      })
      .map((session): Session => {
        if (!session.lastRefreshAttempt) return session;
        if (session.lastRefreshAttempt.replayUntil !== undefined) needsMigration = true;
        return {
          ...session,
          lastRefreshAttempt: {
            id: session.lastRefreshAttempt.id,
            fromGen: session.lastRefreshAttempt.fromGen,
          },
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    const perUser = new Map<string, number>();
    for (const session of valid) {
      if (sessions.size >= MAX_SESSIONS_TOTAL) break;
      const owned = perUser.get(session.userId) ?? 0;
      if (owned >= MAX_SESSIONS_PER_USER || sessions.has(session.sid)) continue;
      sessions.set(session.sid, session);
      perUser.set(session.userId, owned + 1);
    }
    if (sessions.size !== parsed.length || needsMigration) persist();
  } catch {
    // primeiro uso — arquivo ainda não existe
  }
}

function persist(): void {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const tmp = `${FILE}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, JSON.stringify([...sessions.values()]));
      fs.fsyncSync(fd); // durabilidade: revogação não pode "voltar" após um crash
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, FILE);
    if (process.platform !== 'win32') {
      fs.chmodSync(FILE, 0o600);
      const directoryFd = fs.openSync(dir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Descarta sessões expiradas. Retorna quantas saíram. */
export function gcSessions(): number {
  const now = Date.now();
  let removed = 0;
  for (const [sid, s] of sessions) {
    if (s.exp <= now) {
      sessions.delete(sid);
      removed++;
    }
  }
  if (removed > 0 && loaded) persist();
  return removed;
}

export interface NewSession {
  sid: string;
  gen: number;
  exp: number;
}

/** Cria uma nova sessão de conector para um usuário (label = apelido opcional). */
export function createSession(userId: string, name: string, label?: string): NewSession {
  load();
  gcSessions();
  // Criar tokens repetidamente não pode fazer o registro crescer sem limite.
  // Mantém as conexões mais recentes do próprio usuário, sem afetar terceiros.
  const capacity = planSessionCapacity([...sessions.values()], userId);
  if (!capacity.canCreate) throw new McpSessionCapacityError();
  for (const sid of capacity.evictSids) sessions.delete(sid);
  const sid = crypto.randomUUID();
  const exp = Date.now() + config.mcpRefreshTtlDays * 86400000;
  sessions.set(sid, { sid, userId, name, gen: 0, exp, createdAt: Date.now(), label: label || undefined });
  persist();
  return { sid, gen: 0, exp };
}

/** Um access token com este `sid` ainda é válido? (sessão existe e não expirou) */
export function isActiveSession(sid: string): boolean {
  load();
  const s = sessions.get(sid);
  if (!s) return false;
  if (s.exp <= Date.now()) {
    sessions.delete(sid);
    persist();
    return false;
  }
  return true;
}

export type RotateResult =
  | { ok: true; gen: number; userId: string; name: string; exp: number; replayed: boolean }
  | { ok: false; reason: 'unknown' | 'reuse' };

export function isRefreshAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

/**
 * Rotaciona o refresh: confere a geração apresentada, detecta reuso e emite a
 * próxima geração. `reuse` = alguém apresentou um refresh antigo (roubado) →
 * a sessão inteira é morta por segurança.
 */
export function rotateSession(sid: string, presentedGen: number, attemptId?: string): RotateResult {
  load();
  const s = sessions.get(sid);
  if (!s) return { ok: false, reason: 'unknown' };
  if (s.exp <= Date.now()) {
    sessions.delete(sid);
    persist();
    return { ok: false, reason: 'unknown' };
  }
  if (
    presentedGen === s.gen - 1 &&
    attemptId !== undefined &&
    s.lastRefreshAttempt?.id === attemptId &&
    s.lastRefreshAttempt.fromGen === presentedGen
  ) {
    // A resposta anterior se perdeu depois da persistência. Reemite a mesma
    // geração em vez de interpretar o retry idêntico como roubo.
    s.lastSeenAt = Date.now();
    persist();
    return { ok: true, gen: s.gen, userId: s.userId, name: s.name, exp: s.exp, replayed: true };
  }
  if (presentedGen !== s.gen) {
    sessions.delete(sid);
    persist();
    return { ok: false, reason: 'reuse' };
  }
  const fromGen = s.gen;
  s.gen += 1;
  s.exp = Date.now() + config.mcpRefreshTtlDays * 86400000; // janela deslizante
  s.lastSeenAt = Date.now(); // refresh bem-sucedido = conector em uso
  s.lastRefreshAttempt = attemptId === undefined ? undefined : { id: attemptId, fromGen };
  persist();
  return { ok: true, gen: s.gen, userId: s.userId, name: s.name, exp: s.exp, replayed: false };
}

/** Revoga uma sessão específica pelo sid. */
export function revokeSession(sid: string): boolean {
  load();
  const had = sessions.delete(sid);
  if (had) persist();
  return had;
}

/** Revoga TODAS as sessões de um usuário (ex.: saiu do servidor). Retorna quantas. */
export function revokeUser(userId: string): number {
  load();
  let n = 0;
  for (const [sid, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(sid);
      n++;
    }
  }
  if (n) persist();
  return n;
}

/** Revoga TODAS as sessões (botão de pânico). Retorna quantas. */
export function revokeAll(): number {
  load();
  const n = sessions.size;
  sessions.clear();
  persist();
  return n;
}

/** Quantas sessões ativas um usuário tem (para exibir no /conectar-ia). */
export function countUserSessions(userId: string): number {
  load();
  gcSessions();
  let n = 0;
  for (const s of sessions.values()) if (s.userId === userId) n++;
  return n;
}

/** Resumo de uma sessão para a página de gestão (sem segredos: sid é id, não token). */
export interface SessionSummary {
  sid: string;
  label?: string;
  createdAt: number;
  lastSeenAt?: number;
  exp: number;
}

/** Lista as sessões ativas DESTE usuário (mais recentes primeiro) — pra ele ver o que revoga. */
export function listUserSessions(userId: string): SessionSummary[] {
  load();
  gcSessions();
  return [...sessions.values()]
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ sid, label, createdAt, lastSeenAt, exp }) => ({ sid, label, createdAt, lastSeenAt, exp }));
}

/** Revoga UMA sessão, só se pertencer ao usuário (a rota web usa esta, nunca a crua). */
export function revokeUserSession(userId: string, sid: string): boolean {
  load();
  const s = sessions.get(sid);
  if (!s || s.userId !== userId) return false;
  sessions.delete(sid);
  persist();
  return true;
}

// ---------- códigos de troca de uso único (fluxo headless /mcp new) ----------

interface PendingCode {
  userId: string;
  name: string;
  label?: string;
  exp: number;
  claimId?: string;
}

const codes = new Map<string, PendingCode>();
const codeByUser = new Map<string, string>();
const CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_EXCHANGE_CODES = 5_000;

interface StagedExchangeCode {
  exchangeCode: string;
  label?: string;
  exp: number;
}

// Estado efêmero do Post/Redirect/Get da interface. A URL contém apenas a rota
// fixa; o código continua no processo e só o mesmo usuário autenticado consegue
// retirá-lo uma vez para renderização.
const stagedExchangeCodes = new Map<string, StagedExchangeCode>();

export class McpExchangeCodeCapacityError extends Error {
  constructor() {
    super('limite global de códigos MCP pendentes atingido');
    this.name = 'McpExchangeCodeCapacityError';
  }
}

function gcCodes(): void {
  const now = Date.now();
  for (const [code, c] of codes) {
    if (c.exp >= now) continue;
    codes.delete(code);
    if (codeByUser.get(c.userId) === code) codeByUser.delete(c.userId);
  }
}

function gcStagedExchangeCodes(nowMs = Date.now()): void {
  for (const [userId, staged] of stagedExchangeCodes) {
    if (staged.exp < nowMs) stagedExchangeCodes.delete(userId);
  }
}

export function stageExchangeCodeForDisplay(
  userId: string,
  exchangeCode: string,
  label?: string,
  nowMs = Date.now(),
): void {
  gcStagedExchangeCodes(nowMs);
  stagedExchangeCodes.set(userId, {
    exchangeCode,
    label: label || undefined,
    exp: nowMs + CODE_TTL_MS,
  });
}

/** Retira somente o envelope de exibição; o código continua disponível à troca MCP. */
export function consumeStagedExchangeCode(
  userId: string,
  nowMs = Date.now(),
): { exchangeCode: string; label?: string } | undefined {
  gcStagedExchangeCodes(nowMs);
  const staged = stagedExchangeCodes.get(userId);
  if (!staged) return undefined;
  stagedExchangeCodes.delete(userId);
  return { exchangeCode: staged.exchangeCode, label: staged.label };
}

/** Cria um código curto de uso único (~5 min) que o binário MCP troca por tokens. */
export function createExchangeCode(userId: string, name: string, label?: string): string {
  gcCodes();
  stagedExchangeCodes.delete(userId);
  const previous = codeByUser.get(userId);
  // Um exchange já reservado termina de forma atômica; gerar outro código não
  // pode invalidá-lo entre a emissão da sessão e o commit.
  if (previous && !codes.get(previous)?.claimId) codes.delete(previous);
  if (codes.size >= MAX_PENDING_EXCHANGE_CODES) {
    codeByUser.delete(userId);
    throw new McpExchangeCodeCapacityError();
  }
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, { userId, name, label: label || undefined, exp: Date.now() + CODE_TTL_MS });
  codeByUser.set(userId, code);
  return code;
}

export interface ExchangeCodeClaim {
  code: string;
  claimId: string;
  userId: string;
  name: string;
  label?: string;
}

/** Reserva atômica: chamadas concorrentes não trocam o mesmo código duas vezes. */
export function claimExchangeCode(code: string): ExchangeCodeClaim | undefined {
  const c = codes.get(code);
  if (!c || c.exp < Date.now()) {
    if (c) {
      codes.delete(code);
      if (codeByUser.get(c.userId) === code) codeByUser.delete(c.userId);
    }
    return undefined;
  }
  if (c.claimId) return undefined;
  const claimId = crypto.randomBytes(16).toString('hex');
  c.claimId = claimId;
  return { code, claimId, userId: c.userId, name: c.name, label: c.label };
}

/** Consome definitivamente somente a reserva que ainda pertence ao chamador. */
export function commitExchangeCode(claim: ExchangeCodeClaim): boolean {
  const c = codes.get(claim.code);
  if (!c || c.claimId !== claim.claimId) return false;
  codes.delete(claim.code);
  if (codeByUser.get(c.userId) === claim.code) codeByUser.delete(c.userId);
  if (stagedExchangeCodes.get(c.userId)?.exchangeCode === claim.code) stagedExchangeCodes.delete(c.userId);
  return true;
}

/** Falha transitória libera a reserva sem renovar a validade original. */
export function releaseExchangeCode(claim: ExchangeCodeClaim): boolean {
  const c = codes.get(claim.code);
  if (!c || c.claimId !== claim.claimId) return false;
  delete c.claimId;
  return true;
}

/** Consome o código (uso único: apagado em qualquer tentativa). undefined se inválido/expirado. */
export function consumeExchangeCode(code: string): { userId: string; name: string; label?: string } | undefined {
  const claim = claimExchangeCode(code);
  if (!claim || !commitExchangeCode(claim)) return undefined;
  return { userId: claim.userId, name: claim.name, label: claim.label };
}
