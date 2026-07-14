import { describe, expect, it } from 'vitest';
import { acquireDownload, hasActiveDownloads } from '../src/web/tracker';

describe('cota de downloads em andamento', () => {
  it('limita por usuário e libera a gravação de forma idempotente', () => {
    const first = acquireDownload('rec-a', 'user-a');
    const second = acquireDownload('rec-b', 'user-a');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(acquireDownload('rec-c', 'user-a')).toBeUndefined();
    expect(hasActiveDownloads('rec-a')).toBe(true);

    first?.release();
    first?.release();
    expect(hasActiveDownloads('rec-a')).toBe(false);

    const replacement = acquireDownload('rec-c', 'user-a');
    expect(replacement).toBeDefined();
    replacement?.release();
    second?.release();
  });

  it('limita o total global de streams em andamento', () => {
    const leases = Array.from({ length: 16 }, (_, i) => acquireDownload(`rec-${i}`, `user-${i}`));
    expect(leases.every(Boolean)).toBe(true);
    expect(acquireDownload('rec-overflow', 'user-overflow')).toBeUndefined();
    for (const lease of leases) lease?.release();
  });
});
