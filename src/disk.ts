import { statfsSync } from 'node:fs';
import { config } from './config';

/**
 * Espaço em disco do volume onde ficam as gravações. Usado pra:
 *  - recusar iniciar gravação sem espaço (evita faixa corrompida no meio),
 *  - abortar com aviso se o disco encher durante a gravação,
 *  - alertar o dono quando o uso passa do limite.
 * Na dúvida (erro ao medir), NÃO bloqueia — retorna "espaço infinito".
 */

/** Espaço livre em bytes (Infinity se não der pra medir). */
export function freeBytes(dir: string = config.recordingsDir): number {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

/** Espaço livre em MB (Infinity se não der pra medir). */
export function freeMB(dir?: string): number {
  const b = freeBytes(dir);
  return b === Infinity ? Infinity : Math.floor(b / (1024 * 1024));
}

/** Uso do disco em % (0..100); 0 se não der pra medir. */
export function diskUsedPct(dir: string = config.recordingsDir): number {
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    if (total <= 0) return 0;
    const free = s.bavail * s.bsize;
    return Math.round(((total - free) / total) * 100);
  } catch {
    return 0;
  }
}
