import { config } from '../config';

/**
 * Motor de janela de tempo, correto no fuso do config (America/Sao_Paulo por padrão).
 *
 * O container roda em UTC, então `setHours`/`getHours` nativos erram a borda do dia
 * em até 3h. Aqui as bordas civis (00:00 de um dia no fuso) são calculadas via
 * `Intl.DateTimeFormat`/`formatToParts` + a técnica de duplo-offset (robusta a DST).
 *
 * Toda função pura e com `nowMs` injetável — testável sem relógio real.
 */

export interface RangeInput {
  /** "YYYY-MM-DD" (data civil no fuso) ou timestamp ISO-8601 completo. */
  from?: string;
  to?: string;
  /** today | yesterday | this_week | last_week | this_month | last_month | last_7_days | last_30_days */
  preset?: string;
  /** janela rolante: "7d" | "48h" | "2w". */
  last?: string;
}

export interface ResolvedRange {
  /** limite inferior inclusivo (ms epoch). */
  fromMs: number;
  /** limite superior EXCLUSIVO (ms epoch): filtro é `startedAt >= fromMs && startedAt < toMs`. */
  toMs: number;
  fromISO: string;
  toISO: string;
  label: string;
}

interface Civil {
  y: number;
  mo: number; // 1-12
  d: number;
}

/** Offset do fuso (ms que o fuso está à frente do UTC) no instante dado. */
function offsetMsAt(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUTC - utcMs;
}

/** Converte um horário de parede (interpretado no fuso) para epoch ms. Robusto a DST. */
function zonedWallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = offsetMsAt(tz, guess);
  const o2 = offsetMsAt(tz, guess - o1); // recalcula perto de transições de DST
  return guess - o2;
}

/** A data civil (Y-M-D no fuso) do instante dado. */
function civilOf(tz: string, utcMs: number): Civil {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = dtf.formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(p.find((x) => x.type === t)?.value);
  return { y: g('year'), mo: g('month'), d: g('day') };
}

/** Soma `n` dias a uma data civil (Date.UTC normaliza viradas de mês/ano). */
function addDays(c: Civil, n: number): Civil {
  const t = new Date(Date.UTC(c.y, c.mo - 1, c.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Dia da semana ISO (0=segunda … 6=domingo) de uma data civil. */
function isoWeekday(c: Civil): number {
  return (new Date(Date.UTC(c.y, c.mo - 1, c.d)).getUTCDay() + 6) % 7;
}

/** Epoch do início (00:00:00) do dia civil, no fuso. */
function startOfDay(c: Civil, tz: string): number {
  return zonedWallToEpoch(c.y, c.mo, c.d, 0, 0, 0, tz);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO-8601 com offset numérico do fuso (ex.: 2026-06-01T00:00:00-03:00). */
export function formatInTz(ms: number, tz: string = config.timezone): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = dtf.formatToParts(new Date(ms));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '00';
  const offMin = Math.round(offsetMsAt(tz, ms) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const ao = Math.abs(offMin);
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parseia um limite: "YYYY-MM-DD" = data civil (convertida no fuso por quem chama); senão ISO completo. */
function parseBoundary(s: string): { civil?: Civil; ms?: number } | undefined {
  const m = DATE_ONLY.exec(s.trim());
  if (m) return { civil: { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } };
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return { ms };
  return undefined;
}

const UNIT_MS: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000 };

export class RangeError extends Error {}

const DEFAULT_DAYS = 30;

/**
 * Resolve a janela. Sem entrada => últimos 30 dias (nunca "tudo"). `from > to` lança.
 * Toda saída ecoa fromISO/toISO no fuso para o assistente confirmar o que consultou.
 */
export function resolveRange(
  input: RangeInput | undefined,
  nowMs: number,
  tz: string = config.timezone,
): ResolvedRange {
  const today = civilOf(tz, nowMs);

  const build = (fromMs: number, toMs: number, label: string): ResolvedRange => {
    if (fromMs > toMs) throw new RangeError('A data inicial é maior que a final.');
    return { fromMs, toMs, fromISO: formatInTz(fromMs, tz), toISO: formatInTz(toMs, tz), label };
  };

  // janela rolante
  if (input?.last) {
    const m = /^(\d+)\s*(h|d|w)$/i.exec(input.last.trim());
    if (!m) throw new RangeError(`Janela inválida em "last": ${input.last} (use ex.: 7d, 48h, 2w).`);
    const span = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
    return build(nowMs - span, nowMs, `últimos ${input.last.trim().toLowerCase()}`);
  }

  // presets
  if (input?.preset) {
    const p = input.preset.trim().toLowerCase();
    switch (p) {
      case 'today':
        return build(startOfDay(today, tz), startOfDay(addDays(today, 1), tz), 'hoje');
      case 'yesterday':
        return build(startOfDay(addDays(today, -1), tz), startOfDay(today, tz), 'ontem');
      case 'this_week': {
        const start = addDays(today, -isoWeekday(today));
        return build(startOfDay(start, tz), startOfDay(addDays(start, 7), tz), 'esta semana');
      }
      case 'last_week': {
        const start = addDays(today, -isoWeekday(today) - 7);
        return build(startOfDay(start, tz), startOfDay(addDays(start, 7), tz), 'semana passada');
      }
      case 'this_month': {
        const first = { y: today.y, mo: today.mo, d: 1 };
        const nextFirst = today.mo === 12 ? { y: today.y + 1, mo: 1, d: 1 } : { y: today.y, mo: today.mo + 1, d: 1 };
        return build(startOfDay(first, tz), startOfDay(nextFirst, tz), 'este mês');
      }
      case 'last_month': {
        const first = today.mo === 1 ? { y: today.y - 1, mo: 12, d: 1 } : { y: today.y, mo: today.mo - 1, d: 1 };
        const thisFirst = { y: today.y, mo: today.mo, d: 1 };
        return build(startOfDay(first, tz), startOfDay(thisFirst, tz), 'mês passado');
      }
      case 'last_7_days':
        return build(startOfDay(addDays(today, -6), tz), startOfDay(addDays(today, 1), tz), 'últimos 7 dias');
      case 'last_30_days':
        return build(startOfDay(addDays(today, -29), tz), startOfDay(addDays(today, 1), tz), 'últimos 30 dias');
      default:
        throw new RangeError(`Preset desconhecido: ${input.preset}`);
    }
  }

  // from/to explícitos (um ou ambos)
  if (input?.from || input?.to) {
    let fromMs = 0;
    let toMs = nowMs + 1;
    if (input.from) {
      const b = parseBoundary(input.from);
      if (!b) throw new RangeError(`Data inicial inválida: ${input.from}`);
      fromMs = b.civil ? startOfDay(b.civil, tz) : (b.ms as number);
    }
    if (input.to) {
      const b = parseBoundary(input.to);
      if (!b) throw new RangeError(`Data final inválida: ${input.to}`);
      // data civil no `to` é INCLUSIVA: vai até o fim daquele dia (início do dia seguinte)
      toMs = b.civil ? startOfDay(addDays(b.civil, 1), tz) : (b.ms as number);
    }
    return build(fromMs, toMs, 'período informado');
  }

  // padrão: últimos 30 dias
  return build(
    startOfDay(addDays(today, -(DEFAULT_DAYS - 1)), tz),
    startOfDay(addDays(today, 1), tz),
    'últimos 30 dias',
  );
}
