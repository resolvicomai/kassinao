// Variáveis mínimas para os módulos que validam config no import não abortarem o processo.
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.APPLICATION_ID ||= 'test-app';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.COOKIE_SECRET ||= 'test-cookie-secret';
process.env.RECORDINGS_DIR ||= '/tmp/kassinao-test-recordings';
// MCP habilitado nos testes, com segredo DISTINTO do cookie (isolamento exigido no boot).
process.env.MCP_SECRET ||= 'test-mcp-secret-distinct-from-cookie';
process.env.OWNER_IDS ||= '111';
