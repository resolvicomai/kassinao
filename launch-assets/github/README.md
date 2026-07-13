# GitHub launch setup

These files prepare the repository for launch. The settings below still require an explicit update in GitHub and are not changed by the codebase.

## Repository profile

**Description**

> Open-source Discord bot that records one track per speaker and turns calls into searchable transcripts, meeting notes, tasks, and sourced answers.

**Website**

> https://kassinao.cloud/en

**Topics**

> discord-bot, meeting-transcription, voice-recording, self-hosted, open-source, mcp, typescript, ai

**Social preview**

Upload `docs/brand/github-social-preview-1280x640.png` in Settings → General → Social preview.

## Before launch

- [ ] Upload the social preview.
- [ ] Set description, website, and topics.
- [ ] Protect `main`: require the CI check, prevent force pushes, and require the branch to be up to date.
- [ ] Either enable Discussions or keep the removed Discussions contact link out of `.github/ISSUE_TEMPLATE/config.yml`.
- [ ] Resolve failing Dependabot pull requests before advertising a fully green repository.
- [ ] Preserve `v1.3.0` and the published domain migration `v1.4.0`; publish the hardened app as `v1.4.1` and verify `kassinao-mcp@1.0.4` on npm.
- [ ] Verify the English landing/demo on `kassinao.cloud`, docs on `docs.kassinao.cloud`, the private app on `app.kassinao.cloud`, and MCP discovery/API on `mcp.kassinao.cloud` after deploy.

GitHub recommends a solid-background social preview at 1280×640 and under 1 MB. See [GitHub’s social preview documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).
