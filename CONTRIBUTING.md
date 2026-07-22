# Contributing to Kassinão

Thanks for your interest! Contributions of all kinds are welcome — bug reports, docs, and code.

## Development setup

```bash
git clone https://github.com/resolvicomai/kassinao.git
cd kassinao
npm install
cp .env.example .env   # fill in at least DISCORD_TOKEN, APPLICATION_ID, DISCORD_CLIENT_SECRET
npm run dev            # runs with auto-reload (tsx)
```

Node.js **22+** is required (see `.nvmrc`). The project is TypeScript with `strict` mode.

## Before opening a PR

- Run `npm run build` — it must compile with **zero** errors (CI enforces this).
- Keep the style of the surrounding code (2-space indent, see `.editorconfig`).
- Match the existing bilingual pattern: shared bot strings live in [`src/i18n.ts`](src/i18n.ts); page-specific copy stays next to its renderer with complete `pt` and `en` variants.
- Write a clear PR description: what changed and why. Link the issue it closes.

## Reporting bugs / requesting features

Use the [issue templates](https://github.com/resolvicomai/kassinao/issues/new/choose). For a bug, include your setup (Docker vs local), the relevant logs (`docker compose logs kassinao`), and steps to reproduce.

## Security

Please **do not** open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
