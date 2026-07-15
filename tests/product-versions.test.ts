import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';
import { MCP_NPX_PACKAGE, MCP_PACKAGE_VERSION } from '../src/productVersions';

describe('versões públicas do produto', () => {
  it('mantém pacote, bot, app e README do MCP na mesma release', () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'mcp', 'package.json'), 'utf8')) as {
      version: string;
    };
    const readme = readFileSync(path.join(process.cwd(), 'mcp', 'README.md'), 'utf8');

    expect(MCP_PACKAGE_VERSION).toBe(packageJson.version);
    expect(MCP_NPX_PACKAGE).toBe(`kassinao-mcp@${packageJson.version}`);
    expect(readme).toContain(MCP_NPX_PACKAGE);
    const documentedVersions = [...readme.matchAll(/kassinao-mcp@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    expect([...new Set(documentedVersions)]).toEqual([packageJson.version]);
    expect(t('pt', 'mcp.new')).toContain(MCP_NPX_PACKAGE);
    expect(t('en', 'mcp.new')).toContain(MCP_NPX_PACKAGE);
  });
});
