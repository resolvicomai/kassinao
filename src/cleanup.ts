import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { isTranscribing } from './processing/transcribe';
import {
  audioExpiryOf,
  deleteAudioOnly,
  forgetAudioBytes,
  listMetas,
  deleteRecording,
  saveMeta,
  transcriptionNeedsAudio,
} from './store';
import { hasActiveDownloads } from './web/tracker';

/**
 * A transcrição ainda vai reler as faixas? Então o trim de áudio da retenção NÃO pode
 * apagá-las. No gap de ~12min entre rodadas parciais (rate limit) o id sai da fila em
 * memória (isTranscribing=false), mas `retryScheduled` fica persistido no meta.json;
 * pending/running cobrem uma queda antes do recovery de boot re-enfileirar.
 */
export const transcriptionBlocksAudioTrim = transcriptionNeedsAudio;

const RECORDING_DIRECTORY = /^\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/;

/** Somente diretórios que o próprio RecordingSession pode criar entram no expurgo. */
export function isCanonicalRecordingDirectory(name: string): boolean {
  return RECORDING_DIRECTORY.test(name);
}

/** Apaga gravações expiradas e diretórios órfãos. Roda a cada hora. */
export function startCleanupJob(): void {
  const run = () => {
    const now = Date.now();
    let removed = 0;
    let trimmed = 0;

    for (const meta of listMetas()) {
      if (meta.status !== 'done' || hasActiveDownloads(meta.id) || isTranscribing(meta.id)) {
        continue;
      }
      // Retenção em camadas: o texto (transcrição/ata/meta) vive mais que o áudio.
      // Gravações antigas sem textExpiresAt ganham CARÊNCIA de 7 dias a partir de
      // agora (persistida) — um upgrade não pode apagar histórico na primeira hora.
      // Modo ILIMITADO: expurgo desligado por completo (delete é 100% manual);
      // a data de morte gravada no meta é ignorada de propósito — a config atual manda.
      if (!config.textRetentionUnlimited) {
        let textExpiresAt = meta.textExpiresAt;
        if (!textExpiresAt) {
          const computed = meta.endedAt ? meta.endedAt + config.textRetentionDays * 24 * 60 * 60 * 1000 : undefined;
          textExpiresAt = computed !== undefined ? Math.max(computed, now + 7 * 24 * 60 * 60 * 1000) : undefined;
          if (textExpiresAt) {
            meta.textExpiresAt = textExpiresAt;
            saveMeta(meta);
          }
        }

        if (textExpiresAt && textExpiresAt < now) {
          if (transcriptionBlocksAudioTrim(meta)) {
            // O bot pode ter ficado desligado além da retenção. Não apaga tudo
            // antes de o recovery reler o áudio; concede a mesma carência de 7
            // dias usada na migração de metas antigas.
            meta.textExpiresAt = now + 7 * 24 * 60 * 60 * 1000;
            saveMeta(meta);
          } else {
            deleteRecording(meta.id);
            forgetAudioBytes(meta.id);
            removed++;
            continue;
          }
        }
      }
      // Não trimar o áudio enquanto a transcrição ainda vai reler as faixas (ver a função).
      const audioExpiresAt = audioExpiryOf(meta);
      if (audioExpiresAt && audioExpiresAt < now && !meta.audioDeleted && !transcriptionBlocksAudioTrim(meta)) {
        // só o áudio expira: some faixas e cache, ficam meta + transcrição + ata
        deleteAudioOnly(meta);
        trimmed++;
        continue;
      }
      // restos de cozimentos ao vivo (work-*) e transcrições que caíram (transcribe-*) com mais de 2h
      const cache = path.join(config.recordingsDir, meta.id, 'cache');
      try {
        for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (!entry.name.startsWith('work-') && !entry.name.startsWith('transcribe-')) continue;
          const dir = path.join(cache, entry.name);
          if (fs.statSync(dir).mtimeMs < now - 2 * 60 * 60 * 1000) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      } catch {
        // sem cache
      }
    }

    // diretórios sem meta.json (restos de falhas) com mais de 1 dia
    try {
      for (const entry of fs.readdirSync(config.recordingsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !isCanonicalRecordingDirectory(entry.name)) continue;
        const dir = path.join(config.recordingsDir, entry.name);
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        if (fs.existsSync(path.join(dir, 'meta.json'))) continue;
        try {
          if (stat.mtimeMs < now - 24 * 60 * 60 * 1000) {
            fs.rmSync(dir, { recursive: true, force: true });
            removed++;
          }
        } catch {
          // removido em paralelo
        }
      }
    } catch {
      // diretório de gravações ainda não existe
    }

    if (removed > 0 || trimmed > 0)
      console.log(`Limpeza: ${removed} gravação(ões) removida(s), ${trimmed} com áudio expirado (texto mantido).`);
  };

  run();
  setInterval(run, 60 * 60 * 1000);
}
