import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { autoRecordStore } from '../src/recorder/autorecord';
import { readJsonState, writeJsonStateAtomic } from '../src/stateFile';

const RULES = path.join(config.stateDir, 'autorecord.json');

function cleanRules(): void {
  for (const entry of fs.readdirSync(config.stateDir)) {
    if (entry.startsWith('autorecord.json')) fs.rmSync(path.join(config.stateDir, entry), { force: true });
  }
}

describe('estado em JSON: escrita atômica e arquivo corrompido', () => {
  afterEach(() => {
    cleanRules();
    vi.restoreAllMocks();
  });

  it('grava por tmp + rename, sem deixar arquivo temporário nem permissão aberta', () => {
    const file = path.join(config.stateDir, 'state-file-atomic.json');
    writeJsonStateAtomic(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(fs.readdirSync(config.stateDir).filter((entry) => entry.startsWith('state-file-atomic.json.'))).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    fs.rmSync(file, { force: true });
  });

  it('arquivo ausente devolve o padrão sem log', () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readJsonState(path.join(config.stateDir, 'nao-existe.json'), { x: true })).toEqual({ x: true });
    expect(failure).not.toHaveBeenCalled();
  });

  it('um autorecord.json truncado não apaga as regras em silêncio: fica em quarentena e é logado', () => {
    cleanRules();
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(RULES, '{"g1":[{"channelId":"c1","minimum":2,"cr'); // escrita interrompida
    // O /autorecord seguinte precisa funcionar (e registrar a nova regra)...
    autoRecordStore.set('g1', { channelId: 'c2', minimum: 3, createdBy: 'u1' });
    expect(autoRecordStore.list('g1')).toEqual([{ channelId: 'c2', minimum: 3, createdBy: 'u1' }]);
    // ...sem destruir a evidência do arquivo corrompido nem esconder o fato no log.
    const quarantined = fs
      .readdirSync(config.stateDir)
      .filter((entry) => /^autorecord\.json\.corrupt-\d+$/.test(entry));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(config.stateDir, quarantined[0]), 'utf8')).toContain('"c1"');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(String(failure.mock.calls[0][0])).toContain('Estado corrompido');
  });

  it('conteúdo com formato errado (array em vez de objeto) também vai para quarentena', () => {
    cleanRules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(RULES, '[1,2,3]');
    expect(autoRecordStore.list('g1')).toEqual([]);
    expect(fs.existsSync(RULES)).toBe(false);
    expect(fs.readdirSync(config.stateDir).some((entry) => entry.startsWith('autorecord.json.corrupt-'))).toBe(true);
  });
});
