import { formatInTz, resolveRange } from './web/range';

export type DeadlineResolution =
  | {
      status: 'resolved';
      date: string;
      fromMs: number;
      toMs: number;
      basis: 'absolute' | 'relative-day' | 'weekday';
      /** Datas sem ano usam o ano civil da reunião, nunca o da consulta. */
      assumedYear: boolean;
    }
  | { status: 'unknown' | 'ambiguous' | 'invalid' };

export function validCivilDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const EN_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY =
  /\b(domingo|segunda(?: feira)?|terca(?: feira)?|quarta(?: feira)?|quinta(?: feira)?|sexta(?: feira)?|sabado|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g;

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Um prazo pertence à data e ao fuso da call. Expressões sem dia definido,
 * alternativas e condicionais continuam sem data; não consultamos calendário de sprint.
 * Dia da semana sem modificador significa a próxima ocorrência, incluindo o dia da call.
 */
export function resolveDeadline(raw: string | undefined, referenceMs: number, timezone: string): DeadlineResolution {
  if (!raw?.trim() || !Number.isFinite(referenceMs)) return { status: 'unknown' };
  const text = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const base = formatInTz(referenceMs, timezone).slice(0, 10);
  const candidates: Array<{ date: string; basis: 'absolute' | 'relative-day' | 'weekday'; assumedYear: boolean }> = [];
  let invalid = false;
  let remaining = text;
  const absolute = (year: number, month: number, day: number, assumedYear: boolean) => {
    if (!validCivilDate(year, month, day)) invalid = true;
    else
      candidates.push({
        date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        basis: 'absolute',
        assumedYear,
      });
    return ' ';
  };
  remaining = remaining.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_all, year, month, day) =>
    absolute(Number(year), Number(month), Number(day), false),
  );
  remaining = remaining.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (_all, day, month, year) =>
    absolute(
      year ? (year.length === 2 ? 2000 + Number(year) : Number(year)) : Number(base.slice(0, 4)),
      Number(month),
      Number(day),
      !year,
    ),
  );
  remaining = remaining.replace(/-/g, ' ');
  remaining = remaining.replace(
    /\b(depois de amanha|day after tomorrow|hoje|today|amanha|tomorrow|ontem|yesterday)\b/g,
    (day) => {
      const delta = /depois|after/.test(day)
        ? 2
        : /amanha|tomorrow/.test(day)
          ? 1
          : /ontem|yesterday/.test(day)
            ? -1
            : 0;
      candidates.push({ date: addDays(base, delta), basis: 'relative-day', assumedYear: false });
      return ' ';
    },
  );
  remaining = remaining.replace(WEEKDAY, (weekday) => {
    const name = weekday.replace(/ feira$/, '');
    const target = WEEKDAYS.includes(name) ? WEEKDAYS.indexOf(name) : EN_WEEKDAYS.indexOf(name);
    const current = new Date(`${base}T12:00:00Z`).getUTCDay();
    candidates.push({ date: addDays(base, (target - current + 7) % 7), basis: 'weekday', assumedYear: false });
    return ' ';
  });
  if (invalid) return { status: 'invalid' };
  if (!candidates.length) return { status: 'unknown' };
  if (new Set(candidates.map((candidate) => candidate.date)).size > 1) return { status: 'ambiguous' };
  // Modificadores como "talvez", "sexta ou segunda" ou "próxima sexta" não
  // autorizam escolher silenciosamente uma interpretação de prazo.
  if (
    /\b(ou|or|talvez|maybe|confirmar|confirm|proxim[ao]|next|passad[ao]|last|entre|between|se|if|apos|after)\b/.test(
      remaining,
    )
  )
    return { status: 'ambiguous' };
  remaining = remaining
    .replace(/\b(?:as|at)\s+\d{1,2}(?::\d{2}|h(?:\d{2})?)?(?:\s*(?:am|pm))?\b/g, ' ')
    .replace(/\b(ate|dia|prazo|em|no|na|para|on|by|due|date|o|a)\b/g, ' ')
    .replace(/[\s.,:;!?()[\]]/g, '');
  if (remaining) return { status: 'unknown' };
  const candidate = candidates[0];
  const day = resolveRange({ from: candidate.date, to: candidate.date }, referenceMs, timezone);
  return { status: 'resolved', ...candidate, fromMs: day.fromMs, toMs: day.toMs };
}
