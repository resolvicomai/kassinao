# Security Policy

Kassinão records people's voices and handles Discord tokens and OAuth secrets, so we take security seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/resolvicomai/kassinao/security/advisories/new)** (repo → **Security** tab → **Report a vulnerability**). We'll acknowledge within a few days and keep you posted on the fix.

## Good to know

- A hostname or VPS IP is public information, not an access control. A private instance must set `ALLOWED_GUILD_IDS`, keep `ALLOW_ALL_GUILDS=false`, and enforce Discord membership plus each recording's ACL. The maintainer-operated app has no public signup.
- Keep the application port bound to loopback or reachable only through a private tunnel/reverse proxy. The bundled Compose always publishes the host port on `127.0.0.1`; do not remove that address from the port mapping. Bare-node runs default to `WEB_BIND_ADDRESS=127.0.0.1`; never use `0.0.0.0` or `::` outside an isolated container unless a host firewall and trusted reverse proxy deliberately form the perimeter. Close unsolicited inbound VPS ports and keep SSH key-only.
- Configured secrets live in `.env`, which must remain owned by the deployment user with mode `0600`; when `COOKIE_SECRET` is omitted, the generated cookie secret lives in `recordings/.cookie-secret`. Both paths are git-ignored and must stay out of backups and logs.
- Recording access requires Discord OAuth plus current membership in the source server. Private calls stay limited to their participants/starter and current admins; gaining channel access later does not unlock their history.
- Off-site backups must use an encrypted `rclone crypt` remote. The bundled script enforces that type, excludes cookie secrets and web/MCP session registries, locks concurrent runs, and verifies every upload. Prefer provider lifecycle/object lock for retention; if remote deletion is necessary, run the separate retention script with a distinct, narrowly scoped credential.
- For maximum privacy, run transcription **locally** (`TRANSCRIBE_PROVIDER=command`) or enable **Zero Data Retention** on your cloud provider so audio isn't retained by third parties. Cloud fallback, meeting context, AI minutes, OpenRouter attribution and webhooks require separate opt-ins.
- A configured minutes webhook must use HTTPS outside localhost and a dedicated `MINUTES_WEBHOOK_SECRET` that is different from every app/provider credential; boot fails on reuse. Deliveries are signed and receivers must verify the HMAC before processing the payload.
- Rotate `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `TUNNEL_TOKEN` and API keys immediately if they are ever exposed.

Before exposing a production hostname, run `sudo ./scripts/audit-vps-security.sh` on the VPS. It exits non-zero when SSH password/root login, the firewall, public listeners, container privileges, read-only rootfs, capabilities, security options or secret-file modes fail the launch policy. The only public TCP port allowed by default is `22`; if SSH deliberately uses another port, pass it explicitly through `KASSINAO_ALLOWED_PUBLIC_TCP_PORTS` for that audit run.

## Supported versions

The latest release on `main` receives security fixes.
