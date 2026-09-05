import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { config } from '../src/config';
import { assertDeletionsReconciled, readDeletionLedger, recordDeletionTombstone } from '../src/deletionLedger';

it('reconcilia snapshot antigo com ledger atual, preserva texto ao apagar só áudio e recusa caminho hostil', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-reconcile-')));
  const originalState = config.stateDir;
  const recordings = path.join(directory, 'restored');
  config.stateDir = path.join(directory, 'state');
  const ledger = path.join(config.stateDir, 'deletion-ledger.json');
  const run = (...extra: string[]) =>
    execFileSync(
      process.execPath,
      [
        path.resolve('scripts/reconcile-restored-deletions.cjs'),
        '--ledger',
        ledger,
        '--recordings-dir',
        recordings,
        ...extra,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  try {
    for (const id of ['deleted', 'audio-only', 'retained']) {
      fs.mkdirSync(path.join(recordings, id, 'tracks'), { recursive: true });
      fs.writeFileSync(path.join(recordings, id, 'tracks', 'voice.flac'), 'audio');
      fs.writeFileSync(path.join(recordings, id, 'meta.json'), JSON.stringify({ id, audioDeleted: false }));
      fs.writeFileSync(path.join(recordings, id, 'transcript.json'), '[]');
    }
    recordDeletionTombstone('deleted');
    recordDeletionTombstone('audio-only', 'audio');
    expect(readDeletionLedger()).toHaveLength(2);
    expect(() => assertDeletionsReconciled(recordings)).toThrow('offline reconciliation');
    expect(JSON.parse(run())).toMatchObject({ mode: 'dry-run', targets: 2 });
    expect(fs.existsSync(path.join(recordings, 'deleted'))).toBe(true);
    const validLedger = fs.readFileSync(ledger, 'utf8');
    fs.writeFileSync(
      ledger,
      JSON.stringify([
        ...JSON.parse(validLedger),
        { recordingId: '../outside', kind: 'recording', requestedAt: Date.now() },
      ]),
    );
    expect(() => run('--apply')).toThrow();
    expect(fs.existsSync(path.join(recordings, 'deleted'))).toBe(true);
    fs.writeFileSync(ledger, validLedger);
    expect(JSON.parse(run('--apply'))).toMatchObject({ mode: 'applied' });
    expect(fs.existsSync(path.join(recordings, 'deleted'))).toBe(false);
    expect(fs.existsSync(path.join(recordings, 'audio-only', 'tracks'))).toBe(false);
    expect(fs.existsSync(path.join(recordings, 'audio-only', 'transcript.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(recordings, 'audio-only', 'meta.json'), 'utf8')).audioDeleted).toBe(
      true,
    );
    expect(fs.existsSync(path.join(recordings, 'retained', 'tracks', 'voice.flac'))).toBe(true);
    expect(() => assertDeletionsReconciled(recordings)).not.toThrow();
    fs.mkdirSync(path.join(recordings, 'audio-only', 'cache'));
    expect(() => assertDeletionsReconciled(recordings)).toThrow('offline reconciliation');
    fs.rmdirSync(path.join(recordings, 'audio-only', 'cache'));
    fs.writeFileSync(ledger, '{invalid');
    expect(() => recordDeletionTombstone('another')).toThrow('ledger unavailable');
    expect(fs.readFileSync(ledger, 'utf8')).toBe('{invalid');
  } finally {
    config.stateDir = originalState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
