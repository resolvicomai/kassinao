# Security Policy

Kassinão records people's voices and handles Discord tokens and OAuth secrets, so we take security seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/resolvicomai/kassinao/security/advisories/new)** (repo → **Security** tab → **Report a vulnerability**). We'll acknowledge within a few days and keep you posted on the fix.

## Good to know

- Secrets live only in `.env` (git-ignored) and never in the repository.
- Recording access requires Discord OAuth plus current membership in the source server. Private calls stay limited to their participants/starter and current admins; gaining channel access later does not unlock their history.
- Off-site backups should use an encrypted `rclone crypt` remote. The bundled script excludes cookie secrets and web/MCP session registries so restoring an archive cannot resurrect revoked access.
- For maximum privacy, run transcription **locally** (`TRANSCRIBE_PROVIDER=command`) or enable **Zero Data Retention** on your cloud provider so audio isn't retained by third parties.
- Rotate `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `TUNNEL_TOKEN` and API keys immediately if they are ever exposed.

## Supported versions

The latest release on `main` receives security fixes.
