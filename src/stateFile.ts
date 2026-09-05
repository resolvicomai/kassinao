import fs from 'node:fs';
import path from 'node:path';
import { operationalError, operationalFailure, operationalPii } from './operationalLog';

/** Read the opened inode, never reopen its path after validating type and size. */
export function readPrivateFileBounded(file: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid private file limit');
  const expected = process.platform === 'win32' ? fs.lstatSync(file) : undefined;
  if (expected && (!expected.isFile() || expected.isSymbolicLink())) throw new Error('invalid private file');
  const flags =
    fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino)))
      throw new Error('invalid private file');
    if (stat.size > maxBytes) throw new Error('private file exceeds limit');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (!read) break;
      total += read;
    }
    if (total !== stat.size) throw new Error('private file changed during read');
    return buffer.toString('utf8', 0, total);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Leitura e escrita de arquivos JSON de estado (regras de auto-record, contagem
 * de colisões, configuração por servidor). Duas garantias que os módulos
 * antigos não tinham:
 *
 * 1. Escrita atômica (tmp + fsync + rename, modo 0600): um desligamento ou disco
 *    cheio no meio da escrita nunca deixa o arquivo truncado.
 * 2. Arquivo existente mas ilegível NÃO vira silêncio: fica registrado no log
 *    operacional e o conteúdo é preservado em `<arquivo>.corrupt-<timestamp>`
 *    antes de o módulo recomeçar do zero. Sem isso, o próximo save sobrescrevia
 *    a evidência e as regras sumiam sem ninguém saber.
 */

export function readJsonState<T>(file: string, fallback: T, validate?: (parsed: unknown) => parsed is T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    operationalFailure(
      `Estado ilegível em file=${path.basename(file)} dir=${operationalPii(path.dirname(file))}: ${operationalError(err)}; usando o padrão.`,
    );
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (validate && !validate(parsed)) throw new Error('conteúdo fora do formato esperado');
    return parsed as T;
  } catch (err) {
    quarantineCorruptFile(file, err);
    return fallback;
  }
}

function quarantineCorruptFile(file: string, cause: unknown): void {
  const quarantine = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, quarantine);
    operationalFailure(
      `Estado corrompido em file=${path.basename(file)} dir=${operationalPii(path.dirname(file))} (${operationalError(cause)}); preservado em quarantine=${path.basename(quarantine)} e recomeçando do padrão.`,
    );
  } catch (err) {
    operationalFailure(
      `Estado corrompido em file=${path.basename(file)} dir=${operationalPii(path.dirname(file))} (${operationalError(cause)}) e não foi possível preservá-lo: ${operationalError(err)}.`,
    );
  }
}

export function writeJsonStateAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
