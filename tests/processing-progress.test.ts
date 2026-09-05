import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deleteRecording, recordingDir, saveMeta } from '../src/store';
import { getProcessingProgress, updateProcessingProgress } from '../src/processing/progress';

it.skipIf(process.platform === 'win32').each(['symlink', 'hardlink', 'oversized'])(
  'progresso %s fica indisponível sem impedir a atualização',
  (kind) => {
    const id = `progress-${crypto.randomUUID()}`;
    saveMeta({
      id,
      guildId: 'guild',
      guildName: 'Test',
      voiceChannelId: 'voice',
      voiceChannelName: 'Test',
      startedBy: null,
      startedAt: Date.now(),
      status: 'done',
      participants: [],
      notes: [],
      events: [],
    });
    try {
      updateProcessingProgress(id, { stage: 'transcribing', batchesCompleted: 1 });
      expect(getProcessingProgress(id)).toMatchObject({ stage: 'transcribing', batchesCompleted: 1 });
      const file = path.join(recordingDir(id), 'processing-progress.json');
      const preserved = path.join(recordingDir(id), 'preserved-progress.json');
      fs.renameSync(file, preserved);
      const original = fs.readFileSync(preserved, 'utf8');
      if (kind === 'hardlink') fs.linkSync(preserved, file);
      else if (kind === 'symlink') fs.symlinkSync(preserved, file);
      else fs.writeFileSync(file, original + ' '.repeat(16_384));
      expect(getProcessingProgress(id)).toBeUndefined();
      updateProcessingProgress(id, { stage: 'done' });
      expect(getProcessingProgress(id)).toMatchObject({ stage: 'done' });
      expect(fs.readFileSync(preserved, 'utf8')).toBe(original);
    } finally {
      deleteRecording(id);
    }
  },
);
