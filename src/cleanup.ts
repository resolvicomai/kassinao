import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { isTranscribing } from './processing/transcribe';
import { listMetas, deleteRecording } from './store';
import { hasActiveDownloads } from './web/tracker';

/** Apaga gravações expiradas e diretórios órfãos. Roda a cada hora. */
export function startCleanupJob(): void {
  const run = () => {
    const now = Date.now();
    let removed = 0;

    for (const meta of listMetas()) {
      if (
        meta.status === 'done' &&
        meta.expiresAt &&
        meta.expiresAt < now &&
        !hasActiveDownloads(meta.id) &&
        !isTranscribing(meta.id)
      ) {
        deleteRecording(meta.id);
        removed++;
        continue;
      }
      // restos de cozimentos ao vivo (work-*) e transcrições que caíram (transcribe-*) com mais de 2h
      // — mas NUNCA enquanto a transcrição desta gravação está rodando (um poll
      // longo de provedor não toca os arquivos por horas e o dir parece "velho")
      if (isTranscribing(meta.id)) continue;
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

    if (removed > 0) console.log(`Limpeza: ${removed} gravação(ões) removida(s).`);
  };

  run();
  setInterval(run, 60 * 60 * 1000);
}
