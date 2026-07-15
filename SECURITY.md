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

Production data, authentication state, cache, memory spill, and deployment snapshots must stay inside a boundary whose at-rest protection is verified by the operator. The operations bundle provides two machine-verifiable contracts:

- the `dedicated` adapter requires LUKS/dm-crypt to cover every relevant mount and requires host swap to be disabled or covered by encrypted storage; and
- the `shared` adapter requires a LUKS2 file container mounted as the exact `KASSINAO_DATA_ROOT` and denies swap separately for every Kassinão container with a positive memory limit, `MemorySwap=Memory`, and swappiness `0`.

The shared adapter's backing path, mapper, UUID, unlock material, and mount procedure are private instance configuration. They do not belong in Git, release assets, logs, or public support material.

A custom deployment may rely on a provider-managed encrypted volume only when the operator has independent evidence for every relevant mount and replaces the matching bundled verifier with an equivalently fail-closed control. Neither bundled verifier accepts a provider dashboard claim as machine proof.

Backup encryption is a separate layer and does not replace active-volume encryption. Keep evidence of mount coverage and the most recent verification in the instance's private runbook. Do not advertise “encrypted at rest” for an instance until that host-level control has been verified.

Off-site backups should use a dedicated encrypted destination and credential. In shared mode, upload and retention use distinct mode-`0600`, single-link configs at the exact `KASSINAO_DATA_ROOT/config/backup-upload-rclone.conf` and `backup-retention-rclone.conf` paths inside LUKS. Create a consistent snapshot with the sole writer stopped; reject links, special files, nested filesystems, and hardlinks; re-inventory after tar; validate every archive member, size, and hash; restart the core; then upload and verify the remote object. Retention/deletion credentials should be narrower than upload credentials where the provider allows it.

## Hardened production releases

The intended Kassinão production footprint is split and contains no Kassinão Git checkout, compiler, application source code, or GitHub credential on the VPS. The verified operations bundle itself contains public sealed Shell/Python operational controls, secret-free templates, and native no-dump runtimes, together with an exact OCI digest, under a root-owned release path. Data roots are mode `0700`, host bindings are loopback-only, and firewall/watchdog controls are installed. On a dedicated host this boundary covers the VPS; on a shared host it covers Kassinão's reserved paths and processes and does not claim that trusted neighboring workloads contain no source or registry credentials. Kassinão controls must use their own empty sealed Docker client configuration and never consume a neighboring operator's Docker credential store. The release `.env` is mode `0600`; dedicated `app.env` is also `0600`. In shared mode, encrypted `config/app.env` is mode `0440` for `root:KASSINAO_GID` and the optional encrypted tunnel-token file is mode `0444` under its mode-`0700` root-owned parent so only the intended read-only container bind can consume it. Private host paths, storage identifiers, credentials, and organization-specific runbooks remain outside the public repository.

Select exactly one host adapter:

- `KASSINAO_HOST_SCOPE=dedicated` is the default and requires a VPS and Docker daemon dedicated to Kassinão. Its `ExecStartPre` hooks apply to the entire `docker.service`, and its audit rejects unrelated containers. Installation and deployment fail unless `.env` contains the exact dedicated-host acknowledgement documented by the bundle.
- `KASSINAO_HOST_SCOPE=shared` is limited to a host whose neighboring workloads and root/Docker administrators are controlled by the same trusted operator. Its dedicated-host acknowledgement must remain empty. It uses `docker-compose.shared.yml`, Kassinão-scoped controls, per-container no-swap limits, and restart policy `no`; `install-shared-host-controls.sh` refuses existing Kassinão containers with any other restart policy, does not install a Docker service drop-in, and does not restart the global Docker daemon.

The shared adapter is not a tenant-isolation boundary and does not protect Kassinão from host root, Docker administrators, or the infrastructure/hypervisor operator. Its read-only audit reserves the Kassinão Compose project, container names, Linux bridges, Docker networks, protected paths, mounts, and environment allowlists. It fails closed on foreign privileged/device/Docker access, added capabilities, host or container namespaces, `volumes-from`, protected-storage overlap, or Kassinão-network membership. Use the dedicated adapter if those trust conditions are not true.

Shared production also requires explicit CPU and memory limits for core, public, and tunnel services whose sum leaves at least 25% of physical RAM and online CPUs for neighboring workloads. The audit proves those values across the private Compose environment, sealed overlay, and Docker runtime. I/O remains a monitored operator responsibility because no safe device throttle can be sealed without a stable host device.

Core-dump isolation is process-scoped. The published image starts its dynamic processes through a static launcher plus a post-`execve` preload that reapplies `PR_SET_DUMPABLE=0`; every service has a hard `RLIMIT_CORE=0`, and the image processes plus the shared tunnel launcher set `coredump_filter=0`. Privileged host scripts self-reexec through the architecture-matched no-dump runtime from the sealed operations bundle before reading secrets, and reject any manifest, metadata, hash, or ELF mismatch. Local media/transcription children receive a minimal environment without bot or provider credentials. The static Cloudflare binary cannot use the post-exec preload, and a pipe handler can ignore `RLIMIT_CORE=0` and still receive register notes. Before any public shared gate, the operator must assess every neighboring workload and use the private host runbook to apply and persist exactly `kernel.core_pattern=/dev/null` and `fs.suid_dumpable=0`, recording both previous values, global impact, and recovery procedure. The public bundle never changes these host-global settings. `--neighbors-only` tolerates another non-piped core destination for diagnostic compatibility, but still requires `fs.suid_dumpable=0`; every preflight, full audit, and uninstall gate requires the exact final pair `/dev/null` and `0`.

For the dedicated adapter, mount the configured data root on dm-crypt/LUKS first and set that root to mode `0700`, owned by `root:root`. Then run the verified bundle's `prepare-storage.sh`: it validates bundle integrity and the private environment, proves encryption before any mutation, and creates or normalizes only `recordings`, `state`, `auth`, and `cache` as mode `0700` under the configured non-root UID/GID. It never creates, owns, or deletes the data root itself.

For a new shared installation, first complete and verify the private host-global core policy described above. Then run the sealed `audit-shared-vps-security.sh --neighbors-only` before creating, opening, or mounting storage. Create, open, and mount a LUKS2 file container as the configured `KASSINAO_DATA_ROOT`, with the backing file, mapper, UUID, and unlock procedure kept private. There is no universal backing size: retain explicit host headroom for neighboring workloads and account for retention, peak tracks, temporary processing, cache, growth, and recovery space. The preallocated backing does not grow automatically. `prepare-shared-storage.sh` repeats the neighbor gate before its first mutation, proves the file-to-loop-to-dm-crypt-to-mount chain and safe mount options, creates the root-only maintenance lock, and prepares the four runtime directories, safe-default `config/app.env`, empty `config/cloudflared-token`, and the mount sentinel. Shared `KASSINAO_UID` and `KASSINAO_GID` must be an explicit unused pair in `61000..61183`, absent from host accounts/groups, subordinate-ID ranges, processes, protected files, neighboring container identities, and prior Kassinão trees; no matching Linux account/group is created. Review `MIN_FREE_MB_START`, `MIN_FREE_MB_ABORT`, and `DISK_ALERT_PCT` for the chosen filesystem. `inject-secrets.sh` repeats the neighbor gate immediately before writing. The two configuration files stay inside LUKS and are exposed only as read-only bind mounts to their intended non-root containers; they are absent from the release and Docker `Config.Env`.

The bundled plaintext migration accepts only the legacy installation that predates `KASSINAO_HOST_SCOPE`; modern dedicated/shared adapter roots are already mounted and require a separately audited conversion. First prove the legacy project with `validate-legacy-dedicated-installation.sh`. `remove-legacy-health-watch.sh` removes only the three exact old watchdog artifacts after runtime provenance, root-only metadata, effective systemd fragment, empty drop-ins, and byte-match checks; it does not touch Docker or neighboring workloads. Stop but do not remove the legacy containers, then run `prepare-legacy-shared-layout.sh`: it derives recordings/cache sources from the stopped core, rejects links, hardlinks, nested mounts, active recordings, neighbor mounts/binds, and `volumes-from`, and consolidates the exact four-tree layout while preserving originals. It seals the exact legacy `.env` path, filesystem identity, metadata, and hash in a root-only control directory directly under `DATA_ROOT`, outside runtime-writable binds; the plaintext release copy of that transition manifest is removed after preparation. Only then remove the legacy containers. Open a newly formatted mapper without mounting it and run `migrate-shared-storage.sh` with that same proven legacy `.env` as `KASSINAO_MIGRATION_SOURCE_APP_ENV`; a different root-owned `0600` file or any byte/identity drift is rejected. Only operational keys present in `app.env.example` are imported; host, Compose, tunnel-token, and unknown keys are excluded without printing values. The migrator repeats the neighbor gate before copying and switching, compares content and metadata, keeps `DATA_ROOT.plaintext-before-shared-luks`, and writes an encrypted `pending` marker with a 1-168 hour deadline. After independently validating app access, a real recording, and a restorable backup, stop only Kassinão, run `prepare-legacy-shared-layout.sh --purge-originals` while the consolidated rollback still exists, and only then run `finalize-shared-migration.sh`. The purge revalidates and unlinks only the proven legacy `.env` plus the proven source contents; the finalizer refuses to destroy rollback until the encrypted control proves that step. These operations remove logical filesystem copies without claiming forensic erasure from SSDs, journals, snapshots, backups, or provider storage. Rotate all migrated credentials after validation because prior backups or snapshots can retain them.

After a shared-host reboot, Kassinão remains stopped until the operator enters the LUKS passphrase directly at the `cryptsetup` prompt, mounts with `rw,nodev,nosuid,noexec`, runs the sealed storage verifier, and starts only the scoped Kassinão project through `deploy-release.sh`. Never store the unlock key on the VPS, in an environment file, cloud-init, shell history, or a systemd unit. Growing the backing requires downtime, a tested backup, explicit neighbor headroom, unmount/close, monotonic file growth, manual reopen, `e2fsck`/`resize2fs`, remount, verifier, deploy, and full audit; it has no automatic shrink or rollback.

`deploy-release.sh` adds the shared Compose overlay and refuses to start when the shared storage, secret-file, no-swap, restart, network, or host-scope contract is not satisfied.

A successful deployment removes its operational rollback snapshot immediately. A failed deployment may retain state and recording metadata, but not authentication state or audio tracks, for `KASSINAO_ROLLBACK_RETENTION_HOURS` (default 72, accepted range 1-168). A persistent host timer enforces that limit even without another deployment. This snapshot is not a backup and must live on the same verified encrypted storage boundary.

Do not infer availability from repository files. Before deploying, independently verify that the selected release, operations bundle, checksum, GHCR digest, and attestations are public and match the protected source/tag policy. Do not replace a missing digest with a moving tag.

For a verified bundle, run the installer, deployment, and read-only audit that match the configured adapter: `install-host-controls.sh` / `audit-vps-security.sh` for `dedicated`, or `install-shared-host-controls.sh` / `audit-shared-vps-security.sh` for `shared`. Both paths use `deploy-release.sh`. Together with operator verification of host-level settings outside their scope, the selected path's release gates must cover at least:

- SSH key-only access and intentional public listeners;
- Docker/Compose versions and the rootful local daemon only;
- host and Docker forwarding firewalls, metadata/private-network egress, and IPv4/IPv6 isolation;
- loopback bindings, container user/capabilities/read-only filesystem/security options;
- ownership and modes of release, environment, and data paths;
- the selected adapter's storage, swap, restart, and neighboring-container contract;
- exact, reboot-persistent `kernel.core_pattern=/dev/null` and `fs.suid_dumpable=0` host policy plus process-level no-dump guards;
- split host routing, health digest/fingerprint, backup behavior, and external access tests.

Keep the previous verified bundle until Discord recording, private app, MCP (when enabled), backup, and every public/private host pass after an upgrade. Rollback after container replacement is manual and may invalidate sessions.

When moving or decommissioning an instance, first use the adapter-specific, fully scoped Compose command to remove Kassinão containers. Then run `uninstall-host-controls.sh --confirm-remove-kassinao-host-controls` for dedicated or `uninstall-shared-host-controls.sh --confirm-remove-kassinao-shared-host-controls` for shared. Both reject pending snapshots, running or automatically restarting containers, unexpected artifacts, and drift; remove only the exact installed controls; do not stop containers or restart Docker; and never delete the release, `KASSINAO_DATA_ROOT`, LUKS backing file, or secrets. Never substitute one adapter's uninstaller for the other or automate host-control removal as part of an application deploy.

## Supported versions

Security fixes target the latest publicly released version. Older releases may be unsupported. A commit on `main`, an unmerged branch, or an unpublished tag is not a supported release.
