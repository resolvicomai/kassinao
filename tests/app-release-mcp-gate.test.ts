import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-app-release-mcp.cjs');
const temporaryDirectories: string[] = [];

function git(directory: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  return result.stdout.trim();
}

function commit(directory: string, message: string): string {
  git(directory, 'add', '.');
  git(directory, 'commit', '-q', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

function repository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kassinao-app-release-mcp-'));
  temporaryDirectories.push(directory);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'Kassinao Test');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  mkdirSync(path.join(directory, 'mcp'));
  writeFileSync(path.join(directory, 'mcp', 'package.json'), '{"name":"kassinao-mcp","version":"1.0.12"}\n');
  writeFileSync(path.join(directory, 'app.txt'), 'app-v1\n');
  commit(directory, 'initial');
  return directory;
}

function runGate(directory: string, releaseCommit: string) {
  return spawnSync(process.execPath, [SCRIPT, 'refs/tags/mcp-v1.0.12', releaseCommit], {
    cwd: directory,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('app release MCP gate', () => {
  it('aceita um release descendente com mcp intacto e retorna o commit exato da tag', () => {
    const directory = repository();
    const mcpCommit = git(directory, 'rev-parse', 'HEAD');
    git(directory, 'tag', '-a', 'mcp-v1.0.12', '-m', 'MCP 1.0.12');
    writeFileSync(path.join(directory, 'app.txt'), 'app-v2\n');
    const releaseCommit = commit(directory, 'app-only release');

    const result = runGate(directory, releaseCommit);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(mcpCommit);
  });

  it('recusa um release que não descende da tag MCP', () => {
    const directory = repository();
    const initialCommit = git(directory, 'rev-parse', 'HEAD');
    writeFileSync(path.join(directory, 'mcp', 'release.txt'), 'published MCP release\n');
    commit(directory, 'mcp release');
    git(directory, 'tag', '-a', 'mcp-v1.0.12', '-m', 'MCP 1.0.12');
    git(directory, 'checkout', '-q', '--detach', initialCommit);
    writeFileSync(path.join(directory, 'app.txt'), 'sibling-app-release\n');
    const releaseCommit = commit(directory, 'non-descendant app release');

    const result = runGate(directory, releaseCommit);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not an ancestor of the app release');
  });

  it('recusa qualquer alteração em mcp depois da tag', () => {
    const directory = repository();
    git(directory, 'tag', '-a', 'mcp-v1.0.12', '-m', 'MCP 1.0.12');
    writeFileSync(path.join(directory, 'mcp', 'package.json'), '{"name":"kassinao-mcp","version":"1.0.13"}\n');
    const releaseCommit = commit(directory, 'changed mcp');

    const result = runGate(directory, releaseCommit);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mcp/ changed after refs/tags/mcp-v1.0.12');
  });

  it('recusa uma tag MCP leve', () => {
    const directory = repository();
    git(directory, 'tag', 'mcp-v1.0.12');
    writeFileSync(path.join(directory, 'app.txt'), 'app-v2\n');
    const releaseCommit = commit(directory, 'app-only release');

    const result = runGate(directory, releaseCommit);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not an annotated tag');
  });
});
