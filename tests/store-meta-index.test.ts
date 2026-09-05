import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import {
  cacheDir,
  deleteRecording,
  listMetas,
  minutesPath,
  readMeta,
  recordingDir,
  RecordingMeta,
  saveMeta,
  tracksDir,
  transcriptPath,
} from '../src/store';

function meta(id: string): RecordingMeta {
  return {
    id,
    guildId: 'guild-index',
    guildName: 'Servidor',
    voiceChannelId: 'voice',
    voiceChannelName: 'Reunião',
    startedBy: { id: 'quem-iniciou', name: 'Quem' },
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    status: 'done',
    participants: [],
    events: [],
    notes: [],
  };
}

/**
 * O índice em memória é construído uma única vez por processo. Se ele fosse a
 * autoridade sobre existência, qualquer gravação ausente daquele scan (escrita
 * por fora, symlink, erro transitório de leitura) responderia 404 até o processo
 * reiniciar — que é exatamente o sintoma "gravação não encontrada" com o arquivo
 * intacto no disco.
 */
describe('índice de metas é cache positivo, não autoridade de existência', () => {
  it('recusa caminhos no construtor compartilhado, inclusive antes de ler ou gravar', () => {
    for (const id of ['../fora', '/tmp/fora', '..', '.', 'a/b', 'a\\b', 'a%2fb', 'a\u0000b', '']) {
      for (const location of [recordingDir, tracksDir, cacheDir, transcriptPath, minutesPath]) {
        expect(() => location(id)).toThrow('id de gravação inválido');
      }
      expect(readMeta(id)).toBeUndefined();
    }
    expect(recordingDir('recording-123')).toBe(path.join(config.recordingsDir, 'recording-123'));
  });

  it('encontra no disco uma gravação escrita depois do índice, sem reiniciar', () => {
    const seed = 'index-seed-aaaaaaaaaa';
    saveMeta(meta(seed));
    expect(listMetas().map((m) => m.id)).toContain(seed); // índice construído aqui

    // Escrita por fora do saveMeta: restauração de backup, rsync, outra réplica.
    const external = 'index-external-bbbbbbbb';
    const dir = recordingDir(external);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta(external)), { mode: 0o600 });

    expect(readMeta(external)?.id).toBe(external);

    deleteRecording(seed);
    deleteRecording(external);
  });

  it('recusa um meta.json cujo id não é o do diretório, com ou sem índice', () => {
    const dirName = 'index-mismatch-cccccccc';
    const dir = recordingDir(dirName);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta('outro-id-diferente')), { mode: 0o600 });

    // A mesma invariante do scan do índice vale no caminho de disco: o diretório manda.
    expect(readMeta(dirName)).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tira do índice a gravação cujo meta.json já sumiu, mesmo quando a remoção falha no meio', () => {
    const id = 'index-parcial-dddddddd';
    saveMeta(meta(id));
    expect(listMetas().map((m) => m.id)).toContain(id);

    // Remoção parcial: o meta.json cai e o resto trava num EACCES.
    const realRmSync = fs.rmSync;
    const target = path.resolve(recordingDir(id));
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((entry, options) => {
      if (path.resolve(String(entry)) === target) {
        fs.rmSync(path.join(target, 'meta.json'), { force: true });
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      realRmSync(entry, options);
    });

    try {
      // Quem pediu para apagar continua sabendo que falhou.
      expect(() => deleteRecording(id)).toThrow();
    } finally {
      spy.mockRestore();
    }

    // Sem meta.json ela não abre mais, então não pode seguir anunciada na listagem.
    expect(listMetas().map((m) => m.id)).not.toContain(id);
    expect(readMeta(id)).toBeUndefined();

    fs.rmSync(recordingDir(id), { recursive: true, force: true });
  });

  it('mantém no índice a gravação intacta que apenas não pôde ser lida', () => {
    const id = 'index-ilegivel-eeeeeeee';
    saveMeta(meta(id));
    expect(listMetas().map((m) => m.id)).toContain(id);

    // Diretório ilegível: nada foi apagado, só não deu para acessar. Tratar isso
    // como "não existe mais" sumiria com uma gravação íntegra do acervo inteiro.
    const target = path.resolve(recordingDir(id));
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((entry) => {
      if (path.resolve(String(entry)) === target) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
    });
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((entry) => {
      if (path.resolve(String(entry)).startsWith(target)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      throw Object.assign(new Error('unexpected'), { code: 'ENOENT' });
    });

    try {
      expect(() => deleteRecording(id)).toThrow();
    } finally {
      rmSpy.mockRestore();
      statSpy.mockRestore();
    }

    expect(listMetas().map((m) => m.id)).toContain(id);
    expect(readMeta(id)?.id).toBe(id);

    deleteRecording(id);
  });

  it('continua devolvendo undefined para id inexistente e para id fora do formato', () => {
    expect(readMeta('nao-existe-nem-no-disco')).toBeUndefined();
    expect(readMeta('../fora-do-diretorio')).toBeUndefined();
    expect(readMeta('')).toBeUndefined();
    expect(fs.existsSync(path.join(config.recordingsDir, '..', 'fora-do-diretorio'))).toBe(false);
  });
});
