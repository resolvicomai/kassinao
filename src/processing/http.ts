/** fetch com retry/backoff ciente de rate-limit — compartilhado por transcrição e ata. */

interface RetryOpts {
  /** Tentativas totais (inclui a primeira). */
  attempts?: number;
  /** Teto de espera em UMA tentativa (429 com "try again in 8m" espera de verdade, até este teto). */
  maxWaitMs?: number;
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
    let waitMs = 2000 * (i + 1);
    try {
      const resp = await fetch(url, init);
      if (resp.ok) return resp;
      const body = (await resp.text()).slice(0, 400);
      lastErr = new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      if (resp.status === 429) {
        const suggested = parseRetryAfterMs(resp.headers, body);
        if (suggested > maxWaitMs) break; // espera longa demais — melhor falhar e reagendar a faixa
        waitMs = Math.max(waitMs, suggested + 2000); // +2s de folga sobre o que o provedor pediu
      } else if (resp.status < 500) {
        break; // 4xx (menos 429) não melhora com retry
      }
    } catch (err) {
      lastErr = err as Error;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw lastErr ?? new Error('falha de rede');
}
