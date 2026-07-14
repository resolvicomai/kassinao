import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/**
 * Sessões web ATIVAS. O cookie continua assinado e carrega a identidade, mas o
 * `jti` também precisa existir aqui; logout remove o registro e invalida até uma
 * cópia roubada do cookie. Persistência atômica mantém a revogação após restart.
 */
export type WebSessionScope = 'full' | 'revoke-only';

interface WebSession {
  sid: string;
  userId: string;
  scope: WebSessionScope;
  exp: number;
  createdAt: number;
}

const FILE = path.join(config.recordingsDir, '.web-sessions.json');
const sessions = new Map<string, WebSession>();
let loaded = false;
const MAX_SESSIONS_PER_USER = 10;
const MAX_SESSIONS_TOTAL = 5_000;

function validSession(value: unknown): value is WebSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<WebSession>;
  return (
    typeof s.sid === 'string' &&
    s.sid.length > 0 &&
    typeof s.userId === 'string' &&
    s.userId.length > 0 &&
    (s.scope === 'full' || s.scope === 'revoke-only') &&
    typeof s.exp === 'number' &&
    Number.isFinite(s.exp) &&
    typeof s.createdAt === 'number' &&
    Number.isFinite(s.createdAt)
  );
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) if (validSession(value)) sessions.set(value.sid, value);
  } catch (err) {
    // Primeiro uso: ainda não existe arquivo. Qualquer outro erro também fica
    // fail-closed (nenhum cookie antigo é aceito), sem impedir o bot de subir.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`Sessões web ignoradas por arquivo inválido/indisponível: ${(err as Error).message}`);
  }
  gcWebSessions(false);
}

function persist(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify([...sessions.values()]));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, FILE);
}

function gcWebSessions(write = true): number {
  const now = Date.now();
  let removed = 0;
  for (const [sid, session] of sessions) {
    if (session.exp <= now) {
      sessions.delete(sid);
      removed++;
    }
  }
  if (removed > 0 && write) persist();
  return removed;
}

export function createWebSession(userId: string, exp: number, scope: WebSessionScope = 'full'): string {
  load();
  gcWebSessions(false);
  // OAuth repetido não pode fazer o arquivo crescer sem limite e transformar a
  // persistência síncrona em vetor de DoS. Mantém só os logins mais recentes.
  const owned = [...sessions.values()]
    .filter((session) => session.userId === userId)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (owned.length >= MAX_SESSIONS_PER_USER) {
    const oldest = owned.shift();
    if (oldest) sessions.delete(oldest.sid);
  }
  if (sessions.size >= MAX_SESSIONS_TOTAL) {
    const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (sessions.size >= MAX_SESSIONS_TOTAL) {
      const session = oldest.shift();
      if (!session) break;
      sessions.delete(session.sid);
    }
  }
  const sid = crypto.randomUUID();
  sessions.set(sid, { sid, userId, scope, exp, createdAt: Date.now() });
  persist();
  return sid;
}

export function isActiveWebSession(sid: string, userId: string): boolean {
  load();
  const session = sessions.get(sid);
  if (!session || session.userId !== userId) return false;
  if (session.exp <= Date.now()) {
    sessions.delete(sid);
    persist();
    return false;
  }
  return true;
}

/** Retorna o escopo persistido; cookie e registro precisam concordar. */
export function webSessionScope(sid: string, userId: string): WebSessionScope | undefined {
  load();
  const session = sessions.get(sid);
  if (!session || session.userId !== userId) return undefined;
  if (session.exp <= Date.now()) {
    sessions.delete(sid);
    persist();
    return undefined;
  }
  return session.scope;
}

export function revokeWebSession(sid: string): boolean {
  load();
  const removed = sessions.delete(sid);
  if (removed) persist();
  return removed;
}

/** Revoga todos os logins de uma conta sem depender do cookie apresentado. */
export function revokeWebSessionsForUser(userId: string): number {
  load();
  let removed = 0;
  for (const [sid, session] of sessions) {
    if (session.userId !== userId) continue;
    sessions.delete(sid);
    removed++;
  }
  if (removed > 0) persist();
  return removed;
}
