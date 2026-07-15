import { cleanInline } from './sanitize';

const REDACTED = '[redacted]';
const MAX_LOG_LINE_LENGTH = 2_000;

function operationalLine(message: string): string {
  const clean = cleanInline(message);
  if (clean.length <= MAX_LOG_LINE_LENGTH) return clean;
  return `${clean.slice(0, MAX_LOG_LINE_LENGTH - 1)}…`;
}

/**
 * Single console boundary for runtime operational events. Callers must classify
 * private values with `operationalPii` and failures with `operationalError`.
 * The final pass also prevents multiline/ANSI log injection and log flooding.
 */
export function operationalInfo(message: string): void {
  console.log(operationalLine(message));
}

export function operationalWarn(message: string): void {
  console.warn(operationalLine(message));
}

export function operationalFailure(message: string): void {
  console.error(operationalLine(message));
}

/** PII logging is fail-closed: only the exact value `true` enables it. */
export function operationalPiiEnabled(raw = process.env.LOG_PII): boolean {
  return raw === 'true';
}

/**
 * Formats user-controlled identifiers and names for operational logs.
 * Values stay one-line when the operator explicitly enables PII logging.
 */
export function operationalPii(value: unknown, raw = process.env.LOG_PII): string {
  if (!operationalPiiEnabled(raw)) return REDACTED;
  if (value === undefined || value === null) return '-';
  return cleanInline(String(value)) || '-';
}

/**
 * Error messages can contain Discord names, IDs and recording paths. Keep only
 * the error class by default; the sanitized message is an explicit opt-in.
 */
export function operationalError(error: unknown, raw = process.env.LOG_PII): string {
  const candidate = error instanceof Error ? cleanInline(error.name || 'Error') : 'UnknownError';
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate) ? candidate : 'Error';
  if (!operationalPiiEnabled(raw)) return name;
  const message = error instanceof Error ? cleanInline(error.message) : cleanInline(String(error));
  return message ? `${name}: ${message}` : name;
}
