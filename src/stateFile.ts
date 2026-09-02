import fs from 'node:fs';
import path from 'node:path';
import { operationalError, operationalFailure, operationalPii } from './operationalLog';

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
