# Contributing to Kassinão

Bug fixes, tests, documentation, translations, accessibility improvements, and focused product changes are welcome.

## Local setup

Node.js 22+ and a C/C++ toolchain are required. The checked-in npm security configuration builds the Opus addon from its signed npm tarball and omits undeclared peer executables.

```bash
git clone https://github.com/resolvicomai/kassinao.git
cd kassinao
npm ci --userconfig .npmrc.security
cp .env.example .env
chmod 600 .env
# Add credentials for a Discord application and a test guild that you control.
npm run dev
```

For the Docker source path, Docker Engine 28.0.0+ and Docker Compose 2.36.0+
are required. Then build before starting Compose:

```bash
docker build -t kassinao-local:dev .
# In .env, keep APP_URL/MCP_URL/PUBLIC_URL/DOCS_URL on the same localhost
# origin, set ALLOW_LOCAL_APP_URL=true, PUBLIC_SURFACES_ENABLED=false,
# TRUST_PROXY_HOPS=1, and COMPOSE_PROFILES=split-public.
docker compose --profile split-public up -d --no-build
docker compose logs -f kassinao kassinao-router kassinao-public
```

Never use production credentials, recordings, domains, IDs, auth state, or backups in development fixtures, screenshots, issues, or pull requests.

## Product rules that changes must preserve

- Base recording works without AI: separate tracks for Discord accounts that speak, mix, notes, metadata, and the protected meeting page.
- Transcription, AI minutes, `/ask`, webhook, and MCP remain explicit operator opt-ins.
- The public project and an operator's private instance are separate. No upstream URL, credential, guild, provider, or archive may become a fallback for a self-hosted deployment.
- A URL is not a security boundary. Authorization stays tied to current Discord membership and the meeting ACL.
- The recording panel is technical disclosure, not proof of consent. Do not write claims such as perfect attribution, guaranteed nickname change, automatic AI by default, fixed processing time, or universal at-rest encryption.
- pt-BR and English user-facing copy must remain behaviorally equivalent. Shared bot strings belong in [`src/i18n.ts`](src/i18n.ts); page-specific copy stays next to its renderer.
- Code changes served over the network must preserve the AGPL Corresponding Source path. Secrets, runtime configuration, and meeting data stay out of source and release artifacts.

Use [`docs/research/2026-07-14-product-truth.md`](docs/research/2026-07-14-product-truth.md) as the current claim boundary and verify the implementation whenever behavior changes.

## Before opening a pull request

```bash
npm run lint
npm run build
npm run typecheck:preview
npm test
npm run format:check
```

Also:

- keep changes focused and explain the user/security impact;
- add or update tests for behavior changes;
- verify both languages and keyboard/mobile behavior for UI changes;
- use fictional data in demos and fixtures;
- update README/docs/commands/config examples together when a user-facing contract changes;
- do not claim an image, release, npm version, bundle, checksum, or attestation exists until it is publicly resolvable and verified.

## Issues and security

Use the [issue templates](https://github.com/resolvicomai/kassinao/issues/new/choose) for sanitized bug reports and feature requests.

Do not publish vulnerabilities or personal/meeting data in an issue. Report security problems through [`SECURITY.md`](SECURITY.md). Data access, correction, and deletion requests must go to the operator named in the affected instance's privacy policy, never to a public upstream issue.
