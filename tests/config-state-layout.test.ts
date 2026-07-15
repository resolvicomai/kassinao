import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];
const CONFIG_ARGS = [
  '--import',
  'tsx',
  '--input-type=module',
  '-e',
  "const m=await import('./src/runtimeBootstrap.ts');const b=m.default??m;const e=b.validateAndCommitRuntimeConfiguration();if(e){console.error(e);process.exit(1)}",
] as const;

function temporaryLayout(): { root: string; recordings: string; state: string; auth: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'kassinao-state-layout-'));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const recordings = path.join(root, 'recordings');
  const state = path.join(root, 'state');
  const auth = path.join(root, 'auth');
  for (const directory of [recordings, state, auth]) mkdirSync(directory, { mode: 0o700 });
  return { root, recordings, state, auth };
}

function privateFile(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function configEnvironment(
  layout: ReturnType<typeof temporaryLayout>,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: layout.root,
    NODE_ENV: 'production',
    DISCORD_TOKEN: 'discord-token-test-only',
    APPLICATION_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'discord-client-secret-test-only',
    APP_URL: 'https://app.example.com',
    PUBLIC_URL: 'https://www.example.com',
    DOCS_URL: 'https://docs.example.com',
    MCP_URL: 'https://mcp.example.com',
    OPERATOR_NAME: 'Example Operator',
    OPERATOR_CONTACT_URL: 'https://privacy.example.com/contact',
    PRIVACY_POLICY_URL: 'https://app.example.com/privacy',
    DATA_DELETION_URL: 'https://app.example.com/privacy#data-rights',
    PRIVACY_EFFECTIVE_DATE: '2020-01-01',
    PRIVACY_POLICY_VERSION: 'test-1',
    PRIVACY_AUDIENCE: 'Members of the test Discord server.',
    PRIVACY_PURPOSES: 'Test recording and retrieval of authorized meetings.',
    PRIVACY_LAWFUL_BASIS: 'Test operator authorization and applicable agreements.',
    INFRASTRUCTURE_PROVIDER: 'Example Cloud',
    INFRASTRUCTURE_REGION: 'Example Region',
    EDGE_PROVIDER: 'none',
    EDGE_REGION: 'none',
    OPERATIONAL_LOG_RETENTION: 'Test logs are removed after 7 days.',
    BACKUP_STATUS: 'disabled',
    BACKUP_PROVIDER: 'none',
    BACKUP_REGION: 'none',
    BACKUP_RETENTION_DAYS: '0',
    DATA_REQUEST_PROCESS: 'Use the test contact page.',
    DATA_REQUEST_RESPONSE_DAYS: '30',
    INCIDENT_CONTACT_URL: 'https://privacy.example.com/contact',
    INCIDENT_PROCESS: 'Use the test incident contact page.',
    SOURCE_URL: 'https://github.com/example/kassinao',
    ALLOWED_GUILD_IDS: '987654321098765432',
    ALLOW_ALL_GUILDS: 'false',
    RECORDINGS_DIR: layout.recordings,
    STATE_DIR: layout.state,
    AUTH_STATE_DIR: layout.auth,
    PUBLIC_SURFACES_ENABLED: 'false',
    TRANSCRIBE_PROVIDER: 'none',
    TRANSCRIBE_FALLBACK_PROVIDER: 'none',
    MINUTES_ENABLED: 'false',
    TZ: 'UTC',
    ...overrides,
  };
}

function runConfig(
  layout: ReturnType<typeof temporaryLayout>,
  overrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, CONFIG_ARGS, {
    cwd: ROOT,
    encoding: 'utf8',
    env: configEnvironment(layout, overrides),
  });
}

function runConfigAsync(
  layout: ReturnType<typeof temporaryLayout>,
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, CONFIG_ARGS, {
      cwd: ROOT,
      env: configEnvironment(layout, overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('layout privado da instância', () => {
  it('copia estado operacional, move autenticação e mantém a identidade estável', () => {
    const layout = temporaryLayout();
    const secret = 'a'.repeat(64);
    privateFile(path.join(layout.recordings, '.cookie-secret'), secret);
    privateFile(path.join(layout.recordings, '.web-sessions.json'), '{"legacy":true}\n');
    privateFile(path.join(layout.recordings, '.mcp-sessions.json'), '{"mcp":true}\n');
    privateFile(path.join(layout.recordings, 'guildconfig.json'), '{"guild":"private"}\n');
    privateFile(path.join(layout.recordings, 'autorecord.json'), '{"enabled":false}\n');

    const first = runConfig(layout);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(path.join(layout.auth, '.cookie-secret'), 'utf8')).toBe(secret);
    expect(readFileSync(path.join(layout.auth, 'web-sessions.json'), 'utf8')).toBe('{"legacy":true}\n');
    expect(readFileSync(path.join(layout.auth, 'mcp-sessions.json'), 'utf8')).toBe('{"mcp":true}\n');
    expect(existsSync(path.join(layout.recordings, '.cookie-secret'))).toBe(false);
    expect(existsSync(path.join(layout.recordings, '.web-sessions.json'))).toBe(false);
    expect(existsSync(path.join(layout.recordings, '.mcp-sessions.json'))).toBe(false);
    expect(readFileSync(path.join(layout.state, 'guildconfig.json'), 'utf8')).toBe('{"guild":"private"}\n');
    expect(readFileSync(path.join(layout.recordings, 'guildconfig.json'), 'utf8')).toBe('{"guild":"private"}\n');
    expect(readFileSync(path.join(layout.state, '.layout-v2'), 'utf8')).toBe('2\n');
    const instanceId = readFileSync(path.join(layout.auth, '.instance-id'), 'utf8');
    expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);

    const second = runConfig(layout);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(path.join(layout.auth, '.instance-id'), 'utf8')).toBe(instanceId);
  });

  it('não muda disco quando uma validação posterior da configuração falha', () => {
    const layout = temporaryLayout();
    const secret = 'b'.repeat(64);
    privateFile(path.join(layout.recordings, '.cookie-secret'), secret);
    privateFile(path.join(layout.recordings, '.web-sessions.json'), '{"legacy":true}\n');

    const result = runConfig(layout, {
      MINUTES_WEBHOOK_URL: 'https://hooks.example.com/kassinao',
      MINUTES_WEBHOOK_SECRET: 'curto',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MINUTES_WEBHOOK_SECRET');
    expect(readFileSync(path.join(layout.recordings, '.cookie-secret'), 'utf8')).toBe(secret);
    expect(existsSync(path.join(layout.auth, '.cookie-secret'))).toBe(false);
    expect(existsSync(path.join(layout.state, '.layout-v2'))).toBe(false);
  });

  it('exige identidade e fluxo de privacidade específicos da instância antes de tocar no disco', () => {
    const layout = temporaryLayout();
    const result = runConfig(layout, { OPERATOR_NAME: '', PRIVACY_POLICY_URL: 'https://elsewhere.example/privacy' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('OPERATOR_NAME é obrigatória em produção');
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
    expect(existsSync(path.join(layout.state, '.layout-v2'))).toBe(false);
  });

  it('exige o source correspondente à instalação em produção antes de tocar no disco', () => {
    const layout = temporaryLayout();
    const result = runConfig(layout, { SOURCE_URL: '' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SOURCE_URL é obrigatória em produção');
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
    expect(existsSync(path.join(layout.state, '.layout-v2'))).toBe(false);
  });

  it('não muda disco quando a configuração do provider falha depois do parse base', () => {
    const layout = temporaryLayout();
    const secret = '9'.repeat(64);
    privateFile(path.join(layout.recordings, '.cookie-secret'), secret);
    privateFile(path.join(layout.auth, 'web-sessions.json'), '{"session":"must-survive"}\n');

    const result = runConfig(layout, {
      COOKIE_SECRET: '8'.repeat(64),
      TRANSCRIBE_PROVIDER: 'assemblyai',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ASSEMBLYAI_API_KEY');
    expect(readFileSync(path.join(layout.recordings, '.cookie-secret'), 'utf8')).toBe(secret);
    expect(readFileSync(path.join(layout.auth, 'web-sessions.json'), 'utf8')).toBe('{"session":"must-survive"}\n');
    expect(existsSync(path.join(layout.auth, '.cookie-secret'))).toBe(false);
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
    expect(existsSync(path.join(layout.state, '.layout-v2'))).toBe(false);
  });

  it('recusa volumes coincidentes ou aninhados antes de criar identidade', () => {
    const layout = temporaryLayout();
    const nestedState = path.join(layout.recordings, 'state');
    mkdirSync(nestedState, { mode: 0o700 });

    const result = runConfig(layout, { STATE_DIR: nestedState });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('não podem coincidir nem ficar aninhados');
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
    expect(existsSync(path.join(nestedState, '.layout-v2'))).toBe(false);
  });

  it('trata COOKIE_SECRET explícito como rotação e revoga sessões web persistidas', () => {
    const layout = temporaryLayout();
    privateFile(path.join(layout.auth, '.cookie-secret'), 'c'.repeat(64));
    privateFile(path.join(layout.auth, 'web-sessions.json'), '{"session":"old"}\n');
    privateFile(path.join(layout.auth, 'mcp-sessions.json'), '{"session":"mcp"}\n');
    const rotated = 'd'.repeat(64);

    const result = runConfig(layout, { COOKIE_SECRET: rotated });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(layout.auth, '.cookie-secret'), 'utf8')).toBe(rotated);
    expect(existsSync(path.join(layout.auth, 'web-sessions.json'))).toBe(false);
    expect(readFileSync(path.join(layout.auth, 'mcp-sessions.json'), 'utf8')).toBe('{"session":"mcp"}\n');
  });

  it('recusa migração ambígua sem escolher silenciosamente um dos estados', () => {
    const layout = temporaryLayout();
    privateFile(path.join(layout.recordings, '.cookie-secret'), 'e'.repeat(64));
    privateFile(path.join(layout.auth, '.cookie-secret'), 'f'.repeat(64));

    const result = runConfig(layout);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('origem legada e destino novo divergem');
    expect(readFileSync(path.join(layout.recordings, '.cookie-secret'), 'utf8')).toBe('e'.repeat(64));
    expect(readFileSync(path.join(layout.auth, '.cookie-secret'), 'utf8')).toBe('f'.repeat(64));
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
  });

  it('não segue symlink ao carregar segredo privado', () => {
    const layout = temporaryLayout();
    const target = path.join(layout.root, 'segredo-fora-do-volume');
    privateFile(target, 'g'.repeat(64));
    symlinkSync(target, path.join(layout.auth, '.cookie-secret'));

    const result = runConfig(layout);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Não foi possível ler o segredo de sessão');
    expect(readFileSync(target, 'utf8')).toBe('g'.repeat(64));
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
    expect(existsSync(path.join(layout.state, '.layout-v2'))).toBe(false);
  });

  it('falha fechado diante de marcador de layout incompleto', () => {
    const layout = temporaryLayout();
    privateFile(path.join(layout.state, '.layout-v2'), 'migrating\n');

    const result = runConfig(layout);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Layout privado inválido: .layout-v2 precisa conter exatamente a versão 2');
    expect(readFileSync(path.join(layout.state, '.layout-v2'), 'utf8')).toBe('migrating\n');
    expect(existsSync(path.join(layout.auth, '.instance-id'))).toBe(false);
  });

  it('retoma migração idempotente e só então confirma o marcador', () => {
    const layout = temporaryLayout();
    const recovered = '{"guild":"recovered"}\n';
    privateFile(path.join(layout.recordings, 'guildconfig.json'), recovered);
    privateFile(path.join(layout.state, 'guildconfig.json'), recovered);

    const result = runConfig(layout, { COOKIE_SECRET: 'h'.repeat(64) });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(layout.state, 'guildconfig.json'), 'utf8')).toBe(recovered);
    expect(readFileSync(path.join(layout.state, '.layout-v2'), 'utf8')).toBe('2\n');
  });

  it('aceita o marcador válido criado por outro boot na mesma corrida', async () => {
    const layout = temporaryLayout();
    privateFile(path.join(layout.auth, '.cookie-secret'), 'i'.repeat(64));
    privateFile(path.join(layout.auth, '.instance-id'), '00000000-0000-4000-8000-000000000000');

    const results = await Promise.all([runConfigAsync(layout), runConfigAsync(layout)]);

    for (const result of results) expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(layout.state, '.layout-v2'), 'utf8')).toBe('2\n');
  }, 15_000);
});
