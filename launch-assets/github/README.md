# GitHub launch setup

These files prepare the repository for launch. The settings below still require an explicit update in GitHub and are not changed by the codebase.

## Repository profile

**Description**

> Open-source Discord bot that records one track per speaker and turns calls into searchable transcripts, meeting notes, tasks, and sourced answers.

**Website**

> https://kassinao.resolvicomai.app/en

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
- [ ] Publish the root `1.3.0` release and verify whether `kassinao-mcp@1.0.3` is on npm.
- [ ] Verify README links for `/en`, `/en/docs`, and `/en/demo` after deploy.

GitHub recommends a solid-background social preview at 1280×640 and under 1 MB. See [GitHub’s social preview documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).
