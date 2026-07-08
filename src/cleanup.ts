import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { isTranscribing } from './processing/transcribe';
import { audioExpiryOf, deleteAudioOnly, forgetAudioBytes, listMetas, deleteRecording, saveMeta } from './store';
import { hasActiveDownloads } from './web/tracker';

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
          deleteRecording(meta.id);
          forgetAudioBytes(meta.id);
          removed++;
          continue;
        }
      }
      // Não trimar o áudio enquanto a transcrição não está resolvida: no gap de ~12min
      // entre rodadas parciais (rate limit) o id sai da fila em memória (isTranscribing=false),
      // mas as faixas ainda serão relidas na próxima rodada. retryScheduled fica persistido
      // no meta.json durante o gap; pending/running cobrem uma queda antes do recover re-enfileirar.
      const txIncomplete =
        meta.transcription?.retryScheduled === true ||
        meta.transcription?.status === 'pending' ||
        meta.transcription?.status === 'running';
      const audioExpiresAt = audioExpiryOf(meta);
      if (audioExpiresAt && audioExpiresAt < now && !meta.audioDeleted && !txIncomplete) {
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
        if (!entry.isDirectory()) continue;
        const dir = path.join(config.recordingsDir, entry.name);
        if (fs.existsSync(path.join(dir, 'meta.json'))) continue;
        try {
          if (fs.statSync(dir).mtimeMs < now - 24 * 60 * 60 * 1000) {
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
