import { mkdirSync } from 'node:fs';

// Variáveis mínimas para os módulos que validam config no import não abortarem o processo.
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.APPLICATION_ID ||= 'test-app';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef';
process.env.RECORDINGS_DIR ||= '/tmp/kassinao-test-recordings';
process.env.STATE_DIR ||= '/tmp/kassinao-test-state';
process.env.AUTH_STATE_DIR ||= '/tmp/kassinao-test-auth';
for (const directory of [process.env.RECORDINGS_DIR, process.env.STATE_DIR, process.env.AUTH_STATE_DIR]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
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
