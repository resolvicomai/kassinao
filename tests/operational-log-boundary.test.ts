import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

describe('operational logging boundary', () => {
  it('keeps recorder, processing and private state modules behind operationalLog', () => {
    const protectedFiles = [
      path.join(ROOT, 'src', 'monitor.ts'),
      path.join(ROOT, 'src', 'store.ts'),
      path.join(ROOT, 'src', 'minutesWebhook.ts'),
      path.join(ROOT, 'src', 'web', 'webSessions.ts'),
      ...typescriptFiles(path.join(ROOT, 'src', 'recorder')),
      ...typescriptFiles(path.join(ROOT, 'src', 'processing')),
    ];
    const offenders = protectedFiles.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      const calls = source.match(/\bconsole\.(?:log|info|warn|error|debug)\s*\(/g) ?? [];
      return calls.map((call) => `${path.relative(ROOT, file)}: ${call}`);
    });

    // This is intentionally stricter than trying to recognize only `id`,
    // `name`, paths, stderr or raw Error interpolations. Those heuristics age;
    // a single console boundary makes every new field fail closed instead.
    expect(offenders).toEqual([]);
  });
});
