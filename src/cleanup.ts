import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { isTranscribing } from './processing/transcribe';
import { listMetas, deleteRecording, saveMeta } from './store';
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
        removed++;
        continue;
      }
      if (meta.expiresAt && meta.expiresAt < now && !meta.audioDeleted) {
        // só o áudio expira: some faixas e cache, ficam meta + transcrição + ata
        fs.rmSync(path.join(config.recordingsDir, meta.id, 'tracks'), { recursive: true, force: true });
        fs.rmSync(path.join(config.recordingsDir, meta.id, 'cache'), { recursive: true, force: true });
        meta.audioDeleted = true;
        saveMeta(meta);
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
