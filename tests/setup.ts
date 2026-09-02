import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

// Metade da suíte executa scripts bash reais (mapfile, declare -A, arrays vazios
// sob set -u) e exige bash >= 4.4 no PATH. O macOS traz o 3.2, então num Mac de
// fábrica 11 arquivos falhavam sem dizer o porquê. Aqui: se o bash do PATH é
// antigo e existe um moderno (Homebrew, /usr/local), ele entra na frente do PATH
// só para o processo de teste; sem nenhum moderno, o aviso é claro. No CI a
// falta é erro duro: uma suíte de segurança pulada em silêncio seria um CI verde
// que não testou nada.
function bashVersion(binary: string): [number, number] | undefined {
  try {
    const out = execFileSync(binary, ['-c', 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [major, minor] = out.trim().split('.').map(Number);
    return Number.isFinite(major) && Number.isFinite(minor) ? [major, minor] : undefined;
  } catch {
    return undefined;
  }
}
const modern = ([major, minor]: [number, number]): boolean => major > 4 || (major === 4 && minor >= 4);
const current = bashVersion('bash');
if (!current || !modern(current)) {
  const candidate = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/home/linuxbrew/.linuxbrew/bin/bash'].find(
    (binary) => existsSync(binary) && modern(bashVersion(binary) ?? [0, 0]),
  );
  if (candidate) {
    process.env.PATH = `${dirname(candidate)}${delimiter}${process.env.PATH ?? ''}`;
  } else if (process.env.CI) {
    throw new Error(
      `bash >= 4.4 é obrigatório para as suítes de scripts (encontrado ${current?.join('.') ?? 'nenhum'}); o CI não pode pular esses testes.`,
    );
  } else {
    console.warn(
      `AVISO: bash ${current?.join('.') ?? 'ausente'} no PATH; as suítes de scripts vão falhar. No macOS: brew install bash coreutils findutils.`,
    );
  }
}

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
