import { ChildProcess } from 'node:child_process';
import { spawnFfmpegStdin } from '../processing/ffmpeg';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // PCM 16-bit
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;

/** 1 segundo de silêncio, compartilhado por todas as faixas (evita alloc em loop). */
const SILENCE_1S = Buffer.alloc(SAMPLE_RATE * FRAME_BYTES);

/**
 * Faixa contínua de um único participante, encodada em FLAC em tempo real
 * (um processo ffmpeg por falante, alimentado por PCM via stdin).
 *
 * O Discord só envia áudio de quem está falando; entre as falas não chega
 * nada. Para que todas as faixas fiquem sincronizadas entre si, sempre que
 * o usuário volta a falar preenchemos o intervalo decorrido com silêncio —
 * silêncio digital comprime para quase zero em FLAC.
 *
 * Todas as escritas passam por uma fila serializada que respeita o
 * backpressure do stdin (aguarda 'drain'), então horas de silêncio não
 * acumulam gigabytes em memória.
 */
export class UserTrack {
  readonly userId: string;
  readonly flacPath: string;

  private proc: ChildProcess;
  /** Posição lógica da faixa em amostras por canal (contabilizada no enfileiramento). */
  private logicalSamples = 0;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    userId: string,
    flacPath: string,
    private sessionStartMs: number,
  ) {
    this.userId = userId;
    this.flacPath = flacPath;
    this.proc = spawnFfmpegStdin([
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      String(CHANNELS),
      '-i',
      'pipe:0',
      '-c:a',
      'flac',
      '-y',
      flacPath,
    ]);
    let stderr = '';
    this.proc.stderr?.on('data', (d) => (stderr += d));
    this.proc.on('close', (code) => {
      if (code !== 0 && !this.closed) {
        console.error(`ffmpeg da faixa ${userId} morreu (código ${code}): ${stderr.slice(-400)}`);
      }
    });
    this.proc.stdin?.on('error', () => {
      // EPIPE se o ffmpeg morrer — não derruba o processo do bot
    });
  }

  /**
   * Chamado a CADA evento de "começou a falar" (inclusive re-disparos após
   * pausas curtas): alinha a posição da faixa com o relógio da sessão.
   * Idempotente — se a faixa já está no ponto certo, não escreve nada.
   */
  beginSegment(): void {
    if (this.closed) return;
    const expected = Math.floor(((Date.now() - this.sessionStartMs) * SAMPLE_RATE) / 1000);
    this.enqueueSilence(expected - this.logicalSamples);
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    this.logicalSamples += chunk.length / FRAME_BYTES;
    this.enqueue(() => this.writeToStdin(chunk));
  }

  private enqueueSilence(samples: number): void {
    if (samples <= 0) return;
    this.logicalSamples += samples;
    this.enqueue(async () => {
      let left = samples;
      while (left > 0) {
        const n = Math.min(left, SAMPLE_RATE);
        left -= n;
        await this.writeToStdin(SILENCE_1S.subarray(0, n * FRAME_BYTES));
      }
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {});
  }

  /** Escreve respeitando o backpressure do pipe. */
  private writeToStdin(buf: Buffer): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin || !stdin.writable) return Promise.resolve();
    if (stdin.write(buf)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        stdin.off('drain', done);
        stdin.off('error', done);
        stdin.off('close', done);
        resolve();
      };
      stdin.once('drain', done);
      stdin.once('error', done);
      stdin.once('close', done);
    });
  }

  /** Preenche com silêncio até o fim da gravação, esvazia a fila e fecha o encoder. */
  async finalize(sessionEndMs: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const target = Math.floor(((sessionEndMs - this.sessionStartMs) * SAMPLE_RATE) / 1000);
    const deficit = target - this.logicalSamples;
    if (deficit > 0) {
      this.logicalSamples += deficit;
      const fill = async () => {
        let left = deficit;
        while (left > 0) {
          const n = Math.min(left, SAMPLE_RATE);
          left -= n;
          await this.writeToStdin(SILENCE_1S.subarray(0, n * FRAME_BYTES));
        }
      };
      this.queue = this.queue.then(fill).catch(() => {});
    }
    await this.queue;

    await new Promise<void>((resolve) => {
      if (!this.proc.stdin || this.proc.exitCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        console.warn(`ffmpeg da faixa ${this.userId} demorou para fechar — master pode estar incompleto.`);
        this.proc.kill('SIGKILL');
        resolve();
      }, 60_000);
      this.proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.proc.stdin.end();
    });
  }
}
