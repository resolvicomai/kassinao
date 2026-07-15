# Security Policy

Kassinão processes voice recordings, Discord API data, OAuth sessions, and optional AI/MCP traffic. Its security boundary is the authenticated instance and host controls, not an undisclosed URL.

## Report a vulnerability

Do not open a public issue or attach exploit details, credentials, private URLs, IDs, recordings, logs with meeting content, `.env`, `app.env`, auth state, or backups.

Use GitHub's [private vulnerability reporting](https://github.com/resolvicomai/kassinao/security/advisories/new). If that channel is unavailable, contact the maintainer through the private contact method on the repository profile and include only enough information to establish a safe follow-up channel.

We do not publish a fixed response or remediation SLA. Reports are triaged according to reproducibility, impact, affected releases, and the safety of disclosure.

Requests to access, correct, or delete meeting data belong to the operator of the affected instance, not to the upstream security tracker. Follow that instance's `APP_URL/privacy` process and never submit personal data in a public issue.

## Responsibility boundaries

### Public project

The public project is responsible for the generic source, release workflow, templates, documentation, and security fixes it publishes. A checked-in workflow or template does not prove that a particular image, release asset, host, or deployment is secure or even publicly available.

The AGPL covers the software. An operator who modifies the program and offers network interaction must comply with the license's Corresponding Source requirements. Runtime secrets, organization configuration, recordings, sessions, logs, and backups are not meant to be published.

### Instance operator

Each operator is responsible for their Discord application, allowlisted guilds, domains, TLS/tunnel, provider choices, legal basis and notices, retention, data requests, incident handling, backups, host hardening, and verification of the running release.

An operator must publish an accurate instance-specific privacy policy and contact/deletion process. The upstream [`PRIVACY.md`](PRIVACY.md) is not a substitute.

## Application security model

- Keep `ALLOW_ALL_GUILDS=false` and configure an explicit `ALLOWED_GUILD_IDS`. For a private company application, also disable **Public Bot** in the Discord Developer Portal.
- A hostname or VPS IP is public information. Web and MCP authorization require Discord authentication, current membership in an allowed guild, and the meeting ACL. `OWNER_IDS` is not a universal recording-access bypass.
- Bind application ports to loopback or an intentionally isolated container network behind a trusted HTTPS tunnel/reverse proxy. Do not expose the core directly with `0.0.0.0` or `::` without a reviewed host perimeter.
- Keep the core's public surfaces disabled in split production. Route landing/docs/demo only to the secret-free public process; route private app/MCP hosts only to the core.
- Keep credentials and auth material outside Git, images, release assets, logs, and support bundles. Do not reuse another deployment's environment, auth volume, cookie secret, instance identity, Discord application, callback, or MCP secret.
- Rotate every exposed Discord, tunnel, provider, webhook, backup, cookie, and MCP credential. A domain change also requires new OAuth/MCP connections; do not reuse tokens issued for another origin.
- The bot does not request privileged Gateway intents. In direct messages to the bot, it reads only what is needed to detect an attempted slash command and return onboarding help.

## Data and egress

A fresh installation disables cloud ASR, fallback ASR, AI minutes, webhook, and MCP until the operator opts in. Enabling any external provider sends the data required for that function to the configured destination. Self-hosting alone does not guarantee that data never leaves the server.

- Use a dedicated secret for each integration. The signed minutes webhook must use HTTPS outside localhost and a secret different from application/provider credentials; receivers must verify the HMAC before processing.
- Treat meeting content, names, notes, transcripts, and MCP results as untrusted input. Sanitization and content warnings reduce risk but do not prove immunity to prompt injection in every MCP host/model.
- Enable `LOG_PII` only for controlled diagnosis. Those logs become private meeting data and must be protected and removed under the operator's retention policy.
- Keep authentication state out of portable backups. Do not move auth volumes between instances.

## Storage and backups

Kassinão's container permissions, read-only filesystem, non-root UID, separated volumes, and encrypted backup tooling are useful controls, but they do **not** encrypt active host volumes.

Production data, authentication state, cache, swap, and deployment snapshots must live on storage whose at-rest encryption is verified by the operator. The standard operations bundle has one machine-verifiable contract:

- LUKS/dm-crypt covering every relevant mount; and
- swap disabled or covered by encrypted storage.

A custom deployment may rely on a provider-managed encrypted volume only when the operator has independent evidence for every relevant mount and replaces the standard verifier with an equivalently fail-closed control. The bundled verifier does not accept a provider dashboard claim as machine proof.

Backup encryption is a separate layer and does not replace active-volume encryption. Keep evidence of mount coverage and the most recent verification in the instance's private runbook. Do not advertise “encrypted at rest” for an instance until that host-level control has been verified.

Off-site backups should use a dedicated encrypted destination and credential. Create a consistent snapshot with the sole writer stopped, validate the archive, restart the core, then upload and verify the remote object. Retention/deletion credentials should be narrower than upload credentials where the provider allows it.

## Hardened production releases

The intended production model is source-free and split: a verified operations bundle on a root-owned VPS, no Git checkout/compiler/GitHub credential, exact OCI digest, private mode-`0600` environment files, mode-`0700` data roots, loopback-only host bindings, and installed firewall/watchdog controls.

The standard host controls require a VPS and Docker daemon dedicated to Kassinão. Their `ExecStartPre` hooks apply to the entire `docker.service`, and the audit rejects unrelated containers. Installation and deployment fail unless `.env` contains the exact explicit acknowledgement documented by the bundle. Do not install these controls on a shared Docker host.

Mount the configured data root on dm-crypt/LUKS first and set that root to mode `0700`, owned by `root:root`. Then run the verified bundle's `prepare-storage.sh`: it validates bundle integrity and the private environment, proves encryption before any mutation, and creates or normalizes only `recordings`, `state`, `auth`, and `cache` as mode `0700` under the configured non-root UID/GID. It never creates, owns, or deletes the data root itself.

A successful deployment removes its operational rollback snapshot immediately. A failed deployment may retain state and recording metadata, but not authentication state or audio tracks, for `KASSINAO_ROLLBACK_RETENTION_HOURS` (default 72, accepted range 1–168). A persistent host timer enforces that limit even without another deployment. This snapshot is not a backup and must live on the same verified encrypted storage boundary.

Do not infer availability from repository files. Before deploying, independently verify that the selected release, operations bundle, checksum, GHCR digest, and attestations are public and match the protected source/tag policy. Do not replace a missing digest with a moving tag.

For a verified bundle, run its host-control installer before the first container start, then its deployment and read-only security audit. The audit must cover at least:

- SSH key-only access and intentional public listeners;
- Docker/Compose versions and the rootful local daemon only;
- host and Docker forwarding firewalls, metadata/private-network egress, and IPv4/IPv6 isolation;
- loopback bindings, container user/capabilities/read-only filesystem/security options;
- ownership and modes of release, environment, and data paths;
- split host routing, health digest/fingerprint, backup behavior, and external access tests.

Keep the previous verified bundle until Discord recording, private app, MCP (when enabled), backup, and every public/private host pass after an upgrade. Rollback after container replacement is manual and may invalidate sessions.

When moving or decommissioning an instance, stop/remove every Kassinão container first (or stop it and set restart policy to `no`) and use the bundle's explicit `uninstall-host-controls.sh --confirm-remove-kassinao-host-controls` path. It rejects pending snapshots and drift, removes only the exact installed controls, does not stop containers, does not restart Docker, and never deletes `KASSINAO_DATA_ROOT`. Never automate this uninstall as part of an application deploy.

## Supported versions

Security fixes target the latest publicly released version. Older releases may be unsupported. A commit on `main`, an unmerged branch, or an unpublished tag is not a supported release.
