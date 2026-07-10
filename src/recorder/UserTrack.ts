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
  private writeFailed = false;
  private finalizePromise?: Promise<boolean>;

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
      this.writeFailed = true;
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
    this.queue = this.queue.then(task).catch(() => {
      this.writeFailed = true;
    });
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
  finalize(sessionEndMs: number): Promise<boolean> {
    if (!this.finalizePromise) this.finalizePromise = this.doFinalize(sessionEndMs);
    return this.finalizePromise;
  }

  private async doFinalize(sessionEndMs: number): Promise<boolean> {
    this.closed = true;
    const target = Math.floor(((sessionEndMs - this.sessionStartMs) * SAMPLE_RATE) / 1000);
    // Silêncio de CAUDA capado em 60s: quem falou na hora 1 de uma call de 6h
    // teria ~4 GB de zeros pra encodar aqui (15s+ de CPU por faixa) — estoura o
    // grace do Docker no shutdown e trava o /parar. A cauda só equaliza duração;
    // o mix usa duration=longest e o alinhamento é pelo INÍCIO, nada quebra.
    const deficit = Math.min(target - this.logicalSamples, 60 * SAMPLE_RATE);
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

    const cleanExit = await new Promise<boolean>((resolve) => {
      if (!this.proc.stdin || this.proc.exitCode !== null) {
        resolve(this.proc.exitCode === 0 && !this.writeFailed);
        return;
      }
      const timeout = setTimeout(() => {
        console.warn(`ffmpeg da faixa ${this.userId} demorou para fechar — master pode estar incompleto.`);
        this.proc.kill('SIGKILL');
        resolve(false);
        // 20s: precisa caber DENTRO do stop_grace_period do Docker (30s), senão
        // o SIGKILL externo derruba o node antes de os outros FLACs fecharem
      }, 20_000);
      this.proc.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve(code === 0 && signal === null && !this.writeFailed);
      });
      this.proc.stdin.end();
    });
    return cleanExit;
  }
}
