import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';

// Cada setup pertence a um único arquivo de teste. Um diretório temporário por
// arquivo evita que módulos isolados persistam identidades diferentes no mesmo
// STATE_DIR/AUTH_STATE_DIR quando o Vitest executa arquivos em paralelo.
const configuredStorageRoot = process.env.KASSINAO_TEST_STORAGE_ROOT?.trim();
const storageRoot = resolve(configuredStorageRoot || tmpdir());
mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
const testStorageRoot = mkdtempSync(join(storageRoot, 'kassinao-vitest-'));

// Variáveis mínimas para os módulos que validam config no import não abortarem o processo.
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.APPLICATION_ID ||= 'test-app';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef';
process.env.RECORDINGS_DIR = join(testStorageRoot, 'recordings');
process.env.STATE_DIR = join(testStorageRoot, 'state');
process.env.AUTH_STATE_DIR = join(testStorageRoot, 'auth');
for (const directory of [process.env.RECORDINGS_DIR, process.env.STATE_DIR, process.env.AUTH_STATE_DIR]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
afterAll(() => rmSync(testStorageRoot, { recursive: true, force: true }));
// Não herdar URLs do shell/runner: testes usam a origem canônica moderna.
process.env.APP_URL = 'http://localhost:8080';
delete process.env.BASE_URL;
delete process.env.PUBLIC_URL;
delete process.env.DOCS_URL;
delete process.env.MCP_URL;
// A suíte usa IDs fictícios por teste; o opt-in explícito evita transformar a
// configuração global de teste numa allowlist impossível de compartilhar.
process.env.ALLOW_ALL_GUILDS = 'true';
delete process.env.ALLOWED_GUILD_IDS;
delete process.env.GUILD_ID;
process.env.RETENTION_DAYS = '7';
process.env.TEXT_RETENTION_DAYS = '90';
process.env.TZ = 'America/Sao_Paulo';
// MCP habilitado nos testes, com segredo DISTINTO do cookie (isolamento exigido no boot).
process.env.MCP_SECRET = 'test-mcp-secret-distinct-from-cookie';
process.env.OWNER_IDS ||= '111';
