# GitHub launch setup

This is a pre-launch checklist. Repository settings, protected tags, immutable releases, package visibility, and social-preview uploads require explicit verification in GitHub; files in the worktree do not change or prove those controls.

## Repository profile draft

**Description**

> AGPL self-hosted Discord bot for separate speaking-account tracks, searchable meeting memory, and optional AI/MCP.

**Website**

> https://kassinao.cloud/en

Use the website only after it opens the public English landing without redirecting to OAuth or a private app.

**Topics**

> discord-bot, voice-recording, self-hosted, open-source, meeting-notes, mcp, typescript, ai

**Social preview**

Upload `docs/brand/github-social-preview-1280x640.png` under **Settings → General → Social preview** only after recapturing it from final copy. It must use fictional data and contain no private app hostname, Discord/guild/application ID, meeting content, or credential.

Regenerate the checked-in social preview and shared Open Graph image with `npm run assets:launch`, then inspect both files before upload.

Kassinão is an independent project and is not affiliated with or endorsed by Discord.

## Repository gate

- [ ] `main` requires current CI checks and blocks force pushes/deletion.
- [ ] `v*` release tags are protected against update and deletion.
- [ ] The immutable-release setting is enabled and verified in the live repository.
- [ ] Private vulnerability reporting is enabled; public issue forms warn against secrets, personal data, private URLs, and recordings.
- [ ] `PRIVACY.md`, `SECURITY.md`, both READMEs, docs, commands, config examples, and launch assets describe the same optionality/access model.
- [ ] The latest advertised release is actually public. Do not name an unreleased version in profile copy or installation instructions.
- [ ] Release assets, checksum, OCI digest, SBOM/provenance/attestations, and source/tag identity verify from a clean machine.
- [ ] The public GHCR package is pullable by digest without a private maintainer credential.
- [ ] The published npm version equals the pinned connector version in generated examples and is testable from a clean npm cache.
- [ ] Source quickstart builds `kassinao-local:dev` before Compose and does not depend on an unpublished image.
- [ ] Hardened production instructions require a public verified bundle, split-only topology, no Git/build on the VPS, exact digest, and verified at-rest encryption.
- [ ] Public landing/demo/docs, npm, canonical URLs, Open Graph images, and GitHub links pass in a logged-out browser.
- [ ] No public CTA reaches the private app or MCP API.
- [ ] Dependabot/CodeQL/CI status is reviewed without claiming “fully green” when a check is pending or failing.
- [ ] Discussions/contact links are either enabled and monitored or removed from the issue chooser.

GitHub recommends a solid-background 1280×640 social image under 1 MB. See [GitHub's social preview documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).
