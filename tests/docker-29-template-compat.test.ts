import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function shellScripts(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return shellScripts(absolute);
    return entry.isFile() && entry.name.endsWith('.sh') ? [absolute] : [];
  });
}

describe('compatibilidade dos conjuntos renderizados pelo Docker 29', () => {
  it('usa printf com newline explícito em vez de println nos templates Go', () => {
    const sources = shellScripts(path.join(ROOT, 'scripts')).map(
      (file) => [path.relative(ROOT, file), readFileSync(file, 'utf8')] as const,
    );

    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/\{\{\s*println\b/);
    }

    const combined = sources.map(([, source]) => source).join('\n');
    expect(combined).toContain('{{range .Config.Env}}{{printf "%s\\n" .}}{{end}}');
    expect(combined).toContain('{{range $name, $_ := .NetworkSettings.Networks}}{{printf "%s\\n" $name}}{{end}}');
    expect(combined).toContain('{{range .Containers}}{{printf "%s\\n" .Name}}{{end}}');
    expect(combined).toContain('{{range .Mounts}}{{printf "%s|%s|%s\\n" .Type .Source .Destination}}{{end}}');

    const orderedNetworkSets = combined
      .split('\n')
      .filter((line) => line.includes('NetworkSettings.Networks') && line.includes('sort -u'));
    expect(orderedNetworkSets.length).toBeGreaterThanOrEqual(4);
    for (const line of orderedNetworkSets) {
      expect(line).toContain("| sed '/^$/d' | sort -u");
    }

    const exactEmptyFilter = spawnSync('sed', ['/^$/d'], {
      encoding: 'utf8',
      input: '\nprivate\n \n',
    });
    expect(exactEmptyFilter.status).toBe(0);
    expect(exactEmptyFilter.stdout).toBe('private\n \n');
  });
});
