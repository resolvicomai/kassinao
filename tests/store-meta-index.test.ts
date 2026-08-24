import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { deleteRecording, listMetas, readMeta, recordingDir, RecordingMeta, saveMeta } from '../src/store';

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

  it('continua devolvendo undefined para id inexistente e para id fora do formato', () => {
    expect(readMeta('nao-existe-nem-no-disco')).toBeUndefined();
    expect(readMeta('../fora-do-diretorio')).toBeUndefined();
    expect(readMeta('')).toBeUndefined();
    expect(fs.existsSync(path.join(config.recordingsDir, '..', 'fora-do-diretorio'))).toBe(false);
  });
});
