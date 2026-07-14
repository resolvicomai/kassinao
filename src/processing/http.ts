import { AsyncLocalStorage } from 'node:async_hooks';

/** fetch com retry/backoff ciente de rate-limit — compartilhado por transcrição e ata. */

interface RetryOpts {
  /** Tentativas totais (inclui a primeira). */
  attempts?: number;
  /** Teto de espera em UMA tentativa (429 com "try again in 8m" espera de verdade, até este teto). */
  maxWaitMs?: number;
}

export type UpstreamHttpCategory = 'context-fields-rejected' | 'generic';

/** Erro HTTP sem corpo remoto: logs nunca recebem prompt, transcrição ou chave ecoada. */
export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly category: UpstreamHttpCategory = 'generic',
  ) {
    super(`upstream HTTP ${status} (${category})`);
    this.name = 'UpstreamHttpError';
  }
}

/**
 * Cancelamento operacional, diferente de falha do provider. Quando uma guild
 * sai do perímetro, o pipeline guarda o checkpoint e espera uma retomada em vez
 * de consumir retry/cota ou transformar a gravação em erro.
 */
export class GuildWorkPausedError extends Error {
  readonly code = 'GUILD_WORK_PAUSED';

  constructor(readonly guildId: string) {
    super(`processamento pausado para a guild ${guildId}`);
    this.name = 'GuildWorkPausedError';
  }
}

export function isGuildWorkPausedError(error: unknown): error is GuildWorkPausedError {
  return (
    error instanceof GuildWorkPausedError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'GUILD_WORK_PAUSED')
  );
}

export interface GuildWorkContext {
  readonly guildId: string;
  readonly signal: AbortSignal;
  readonly isAllowed: () => boolean;
}

const guildControllers = new Map<string, AbortController>();
const pausedGuilds = new Set<string>();
const guildWorkStorage = new AsyncLocalStorage<GuildWorkContext>();

function controllerFor(guildId: string): AbortController {
  const current = guildControllers.get(guildId);
  if (current) return current;
  const controller = new AbortController();
  if (pausedGuilds.has(guildId)) controller.abort(new GuildWorkPausedError(guildId));
  guildControllers.set(guildId, controller);
  return controller;
}

/** Captura uma geração do trabalho. Uma retomada nunca reativa jobs antigos. */
export function createGuildWorkContext(guildId: string, isAllowed: () => boolean): GuildWorkContext {
  return { guildId, signal: controllerFor(guildId).signal, isAllowed };
}

/** Propaga a lease sem acoplar consumidores intermediários ao pipeline HTTP. */
export function runWithGuildWorkContext<T>(context: GuildWorkContext, task: () => Promise<T>): Promise<T> {
  return guildWorkStorage.run(context, task);
}

export function currentGuildWorkContext(): GuildWorkContext | undefined {
  return guildWorkStorage.getStore();
}

/** Aborta fetches, esperas e comandos em voo e fecha a admissão de novos jobs. */
export function pauseGuildProcessing(guildId: string): void {
  pausedGuilds.add(guildId);
  const controller = controllerFor(guildId);
  if (!controller.signal.aborted) controller.abort(new GuildWorkPausedError(guildId));
}

/** Rearma uma nova geração; os sinais capturados antes continuam abortados. */
export function resumeGuildProcessing(guildId: string): void {
  const wasPaused = pausedGuilds.delete(guildId);
  const current = guildControllers.get(guildId);
  // GuildAvailable pode repetir sem uma pausa correspondente. Nesse caso,
  // manter o controller é essencial: uma troca silenciosa deixaria jobs presos
  // ao sinal antigo, invisíveis ao próximo pause.
  if (wasPaused || !current || current.signal.aborted) guildControllers.set(guildId, new AbortController());
}

function abortReason(signal: AbortSignal, fallback?: Error): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : (fallback ?? new DOMException('The operation was aborted', 'AbortError'));
}

export function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Revalida sinal + política imediatamente antes de cada unidade com egress. */
export function assertGuildWorkActive(context: GuildWorkContext): void {
  throwIfAborted(context.signal);
  if (!context.isAllowed()) throw new GuildWorkPausedError(context.guildId);
}

/** Espera cancelável usada nos backoffs e no map-reduce. */
export function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Extrai quanto esperar de uma resposta 429/413: header Retry-After ou o texto
 * "try again in 8m4.5s" que a Groq devolve no corpo. Retorna ms (0 se não achou).
 */
export function parseRetryAfterMs(headers: Headers, body: string): number {
  const h = headers.get('retry-after');
  if (h && /^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const m = body.match(/try again in\s+(?:(\d+)m)?([\d.]+)s/i);
  if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000;
  return 0;
}

/**
 * Retry com backoff. 5xx/rede: backoff exponencial curto. 429: espera o que o
 * provedor pedir (limitado a maxWaitMs) — rate limit por hora/minuto se resolve
 * esperando, não martelando. Demais 4xx: falha na hora (retry não ajuda).
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  let lastErr: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    throwIfAborted(init.signal);
    let waitMs = 2000 * (i + 1);
    try {
      const resp = await fetch(url, init);
      throwIfAborted(init.signal);
      if (resp.ok) return resp;
      const body = (await resp.text()).slice(0, 400);
      lastErr = new UpstreamHttpError(
        resp.status,
        /prompt|keyterm/i.test(body) ? 'context-fields-rejected' : 'generic',
      );
      if (resp.status === 429) {
        const suggested = parseRetryAfterMs(resp.headers, body);
        if (suggested > maxWaitMs) break; // espera longa demais — melhor falhar e reagendar a faixa
        waitMs = Math.max(waitMs, suggested + 2000); // +2s de folga sobre o que o provedor pediu
      } else if (resp.status < 500) {
        break; // 4xx (menos 429) não melhora com retry
      }
    } catch (err) {
      // Abort operacional/timeout é terminal. Retentar com o mesmo sinal só
      // martelaria o provider depois de a guild ter saído do perímetro.
      if (init.signal?.aborted) throw abortReason(init.signal, err as Error);
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastErr = err as Error;
    }
    if (i < attempts - 1) await abortableDelay(waitMs, init.signal);
  }
  throw lastErr ?? new Error('falha de rede');
}
