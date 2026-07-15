import { ChildProcess, spawn } from 'node:child_process';
import { buildSafeChildEnvironment } from './childEnvironment';

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

// Watchdog contra ffmpeg TRAVADO, não contra encode lento: uma faixa de 6h
// num VPS de 1 vCPU pode legitimamente levar >10 min para virar MP3.
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Roda o ffmpeg até o fim; rejeita sem copiar stderr para o erro/log. Watchdog de 30 min.
 * `fullStderr`: capturar TUDO (até 8 MB) — obrigatório para quem PARSEIA o stderr
 * (ex.: silencedetect emite uma linha por silêncio; numa faixa longa as primeiras
 * linhas estouram a janela de 8 KB e o VAD "enxergaria" fala onde há silêncio).
 * `nice`: baixa prioridade de CPU — exports/mix não podem competir de igual pra
 * igual com uma GRAVAÇÃO ao vivo (decode Opus + ffmpeg por falante) em 2 vCPU.
 */
export function runFfmpeg(
  args: string[],
  loglevel = 'error',
  opts: { fullStderr?: boolean; nice?: boolean } = {},
): Promise<string> {
  const cap = opts.fullStderr ? 8 * 1024 * 1024 : 8192;
  const ffArgs = ['-hide_banner', '-loglevel', loglevel, ...args];
  const [cmd, spawnArgs] = opts.nice ? ['nice', ['-n', '15', ffmpegPath(), ...ffArgs]] : [ffmpegPath(), ffArgs];
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd as string, spawnArgs as string[], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: buildSafeChildEnvironment(process.env),
    });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-cap)));
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg excedeu o tempo limite (30 min) e foi morto'));
    }, FFMPEG_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg saiu com código ${code}`));
    });
  });
}

/** Inicia um ffmpeg que consome PCM cru pelo stdin (para encoding contínuo durante a captura). */
export function spawnFfmpegStdin(args: string[]): ChildProcess {
  return spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: buildSafeChildEnvironment(process.env),
  });
}
