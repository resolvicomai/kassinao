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
}

const FILE = path.join(config.recordingsDir, '.mcp-sessions.json');
const sessions = new Map<string, Session>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Session[];
    for (const s of arr) if (s && typeof s.sid === 'string') sessions.set(s.sid, s);
  } catch {
    // primeiro uso — arquivo ainda não existe
  }
  gcSessions();
}

function persist(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify([...sessions.values()]));
    fs.fsyncSync(fd); // durabilidade: revogação não pode "voltar" após um crash
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, FILE);
}

/** Descarta sessões expiradas. Retorna quantas saíram. */
export function gcSessions(): number {
  const now = Date.now();
  let removed = 0;
  for (const [sid, s] of sessions) {
    if (s.exp < now) {
      sessions.delete(sid);
      removed++;
    }
  }
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
  return !!s && s.exp >= Date.now();
}

export type RotateResult =
  { ok: true; gen: number; userId: string; name: string; exp: number } | { ok: false; reason: 'unknown' | 'reuse' };

/**
 * Rotaciona o refresh: confere a geração apresentada, detecta reuso e emite a
 * próxima geração. `reuse` = alguém apresentou um refresh antigo (roubado) →
 * a sessão inteira é morta por segurança.
 */
export function rotateSession(sid: string, presentedGen: number): RotateResult {
  load();
  const s = sessions.get(sid);
  if (!s || s.exp < Date.now()) return { ok: false, reason: 'unknown' };
  if (presentedGen !== s.gen) {
    sessions.delete(sid);
    persist();
    return { ok: false, reason: 'reuse' };
  }
  s.gen += 1;
  s.exp = Date.now() + config.mcpRefreshTtlDays * 86400000; // janela deslizante
  s.lastSeenAt = Date.now(); // refresh bem-sucedido = conector em uso
  persist();
  return { ok: true, gen: s.gen, userId: s.userId, name: s.name, exp: s.exp };
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
  exp: number;
}

const codes = new Map<string, PendingCode>();
const CODE_TTL_MS = 5 * 60 * 1000;

function gcCodes(): void {
  const now = Date.now();
  for (const [code, c] of codes) if (c.exp < now) codes.delete(code);
}

/** Cria um código curto de uso único (~5 min) que o binário MCP troca por tokens. */
export function createExchangeCode(userId: string, name: string): string {
  gcCodes();
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, { userId, name, exp: Date.now() + CODE_TTL_MS });
  return code;
}

/** Consome o código (uso único: apagado em qualquer tentativa). undefined se inválido/expirado. */
export function consumeExchangeCode(code: string): { userId: string; name: string } | undefined {
  const c = codes.get(code);
  if (c) codes.delete(code);
  if (!c || c.exp < Date.now()) return undefined;
  return { userId: c.userId, name: c.name };
}
