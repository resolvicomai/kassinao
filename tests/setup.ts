// Variáveis mínimas para os módulos que validam config no import não abortarem o processo.
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.APPLICATION_ID ||= 'test-app';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef';
process.env.RECORDINGS_DIR ||= '/tmp/kassinao-test-recordings';
// Não herdar BASE_URL do shell/runner: testes precisam de uma origem absoluta estável.
process.env.BASE_URL = 'http://localhost:8080';
delete process.env.APP_URL;
delete process.env.PUBLIC_URL;
delete process.env.DOCS_URL;
delete process.env.MCP_URL;
delete process.env.LEGACY_URL;
process.env.RETENTION_DAYS = '7';
process.env.TEXT_RETENTION_DAYS = '90';
// MCP habilitado nos testes, com segredo DISTINTO do cookie (isolamento exigido no boot).
process.env.MCP_SECRET = 'test-mcp-secret-distinct-from-cookie';
process.env.OWNER_IDS ||= '111';
