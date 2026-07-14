import crypto from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_CHARS = 2_048;
const MAX_PLAINTEXT_BYTES = 1_024;
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

export class OpaqueCursorError extends Error {
  constructor() {
    super('cursor inválido ou expirado');
    this.name = 'OpaqueCursorError';
  }
}

export interface OpaqueCursorOptions {
  /** Segredo do servidor; nunca é serializado no token. */
  secret: string;
  /** Separa criptograficamente cursores de rotas/finalidades diferentes. */
  purpose: string;
  /** Identidade autorizada a reutilizar o cursor. */
  subject: string;
  /** Fingerprint canônico de janela, filtros e ordenação. */
  context: string;
  ttlMs?: number;
  nowMs?: number;
}

interface CursorEnvelope<T> {
  v: 1;
  exp: number;
  value: T;
}

function invalid(): never {
  throw new OpaqueCursorError();
}

function validatedOptions(options: OpaqueCursorOptions): {
  nowMs: number;
  ttlMs: number;
  key: Buffer;
  aad: Buffer;
} {
  if (
    typeof options.secret !== 'string' ||
    options.secret.length < 16 ||
    typeof options.purpose !== 'string' ||
    options.purpose.length === 0 ||
    options.purpose.length > 100 ||
    typeof options.subject !== 'string' ||
    options.subject.length === 0 ||
    options.subject.length > 256 ||
    typeof options.context !== 'string' ||
    options.context.length > 1_024
  )
    return invalid();

  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
    return invalid();

  // Chave própria de cursor: não reutiliza diretamente a chave HMAC de sessão.
  const key = crypto.createHmac('sha256', options.secret).update('kassinao/opaque-cursor/aes-256-gcm/v1').digest();
  const aad = Buffer.from(JSON.stringify([options.purpose, options.subject, options.context]), 'utf8');
  return { nowMs, ttlMs, key, aad };
}

export function isOpaqueCursorToken(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 40 ||
    value.length > MAX_TOKEN_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return false;
  try {
    const raw = Buffer.from(value, 'base64url');
    return raw.length > NONCE_BYTES + TAG_BYTES && raw.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function sealOpaqueCursor<T>(value: T, options: OpaqueCursorOptions): string {
  const { nowMs, ttlMs, key, aad } = validatedOptions(options);
  const plaintext = Buffer.from(
    JSON.stringify({ v: 1, exp: nowMs + ttlMs, value } satisfies CursorEnvelope<T>),
    'utf8',
  );
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) return invalid();

  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const token = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  if (token.length > MAX_TOKEN_CHARS) return invalid();
  return token;
}

export function openOpaqueCursor<T>(token: unknown, options: OpaqueCursorOptions): T {
  const { nowMs, key, aad } = validatedOptions(options);
  if (!isOpaqueCursorToken(token)) return invalid();
  try {
    const raw = Buffer.from(token, 'base64url');
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES);
    if (ciphertext.length === 0 || ciphertext.length > MAX_PLAINTEXT_BYTES + 32) return invalid();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) return invalid();
    const envelope = JSON.parse(plaintext.toString('utf8')) as Partial<CursorEnvelope<T>>;
    if (
      envelope.v !== 1 ||
      !Number.isSafeInteger(envelope.exp) ||
      (envelope.exp as number) <= nowMs ||
      !('value' in envelope)
    )
      return invalid();
    return envelope.value as T;
  } catch {
    return invalid();
  }
}
