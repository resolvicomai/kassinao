# Security Policy

Kassinão records people's voices and handles Discord tokens and OAuth secrets, so we take security seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/resolvicomai/kassinao/security/advisories/new)** (repo → **Security** tab → **Report a vulnerability**). We'll acknowledge within a few days and keep you posted on the fix.

## Good to know

- Configured secrets live in `.env`, which must remain owned by the deployment user with mode `0600`; when `COOKIE_SECRET` is omitted, the generated cookie secret lives in `recordings/.cookie-secret`. Both paths are git-ignored and must stay out of backups and logs.
- Recording access requires Discord OAuth plus current membership in the source server. Private calls stay limited to their participants/starter and current admins; gaining channel access later does not unlock their history.
- Off-site backups must use an encrypted `rclone crypt` remote. The bundled script enforces that type, excludes cookie secrets and web/MCP session registries, locks concurrent runs, and verifies every upload. Prefer provider lifecycle/object lock for retention; if remote deletion is necessary, run the separate retention script with a distinct, narrowly scoped credential.
- For maximum privacy, run transcription **locally** (`TRANSCRIBE_PROVIDER=command`) or enable **Zero Data Retention** on your cloud provider so audio isn't retained by third parties.
- Rotate `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `TUNNEL_TOKEN` and API keys immediately if they are ever exposed.

## Supported versions

The latest release on `main` receives security fixes.
