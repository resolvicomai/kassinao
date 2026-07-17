# Kassinão

**A self-hosted Discord bot that records calls and can turn them into searchable meeting memory.**

[Português (BR)](README.pt-BR.md) · [Documentation](https://docs.kassinao.cloud/en) · [Public demo](https://kassinao.cloud/demo?lang=en) · [MCP connector](mcp/README.md)

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![CI](https://github.com/resolvicomai/kassinao/actions/workflows/ci.yml/badge.svg)](https://github.com/resolvicomai/kassinao/actions/workflows/ci.yml)

<a href="https://kassinao.cloud/demo?lang=en"><img src="docs/brand/discord-demo-en-v2.gif" width="900" alt="Fictional Kassinão workflow inside Discord"></a>

<sub>Fictional demo rendered by the product interface. AI features are enabled for the example; a new installation starts with them off.</sub>

Kassinão joins an authorized Discord voice channel, publishes a visible recording panel before capture starts, and keeps a separate audio track for each Discord account that speaks. It also produces a mixed file and supports timestamped notes. After the call, authorized people can use the private web app to play or download the result.

Transcription, AI minutes, `/ask`, webhooks, and MCP are separate operator-controlled opt-ins. Kassinão does not provide a shared hosted workspace, public signup, or a central meeting archive.

Kassinão is an independent project and is not affiliated with or endorsed by Discord.

## What is included

**Base recording, without an AI provider**

- one track per Discord account that speaks, plus a mixed recording;
- presence, meeting metadata, and timestamped notes;
- a recording panel in the voice channel's chat before capture begins;
- a private meeting page with playback and downloads after recording stops;
- retention and per-meeting access controls.

**Optional capabilities**

- speech-to-text through a configured ASR provider or an operator-built local image;
- AI minutes, decisions, and action items after a transcript exists;
- `/ask` over authorized meetings, with links to supporting sources;
- signed HTTPS minutes webhooks;
- five read-only MCP tools exposed by the instance.

Speech is associated with a Discord account/stream, not identified from a mixed recording through later diarization. This preserves the platform attribution, but it does not prove a person's real-world identity or guarantee that a partial/failed track is complete.

## The real flow

1. A member runs `/record` (`/gravar` in pt-BR) in a voice channel.
2. The bot checks the guild, channel, user, and required permissions.
3. It attempts to add a recording indicator to its nickname, then publishes the recording panel. The nickname is best effort; the panel is required.
4. Each account that speaks gets its own track. Members can add timestamped notes while the call is active.
5. `/stop` closes the recording and makes the audio available.
6. If the operator enabled ASR and minutes, those jobs run asynchronously. Processing time depends on call length, queue, provider, retries, and rate limits; there is no fixed SLA.
7. The channel receives only a generic completion notice. Authorized users open details in the private app or through an authorized DM link.

The panel is a technical disclosure, not proof of consent. The operator is responsible for the notices, permissions, legal basis, and organizational rules required where the bot is used, especially before enabling auto-record.

## Public project, private instance

| Public project material | Private operator material |
| --- | --- |
| AGPL source, generic docs, Dockerfile, workflows, templates, and fictional demo | Discord/provider credentials, guild and owner IDs, domains, tunnel routes, recordings, auth state, MCP tokens, backups, retention choices, host paths, storage identifiers, and operational runbooks |

Every operator creates a separate Discord application and chooses their own URLs and storage. A new deployment must not reuse another instance's `.env`, auth volume, Discord application, OAuth callback, tunnel token, or MCP configuration.

The AGPL applies to the software. If an operator modifies the program and lets users interact with it over a network, AGPL section 13 generally requires offering those users the Corresponding Source for the running version. Runtime configuration, secrets, recordings, and organization data remain private; product code changes cannot be hidden by calling them configuration. Set `SOURCE_URL` to the source actually offered for the running version. This is a practical summary, not legal advice; [the license controls](LICENSE).

## Source quickstart

This path is for local evaluation and development. It builds the image from the checked-out source; it is not the hardened production path.

Requirements: Docker Engine 28.1.0+, Docker Compose 2.36.0+, and a Discord
application owned by you. The minimum versions are required by the router's
named interfaces and deterministic gateway selection.

```bash
git clone https://github.com/resolvicomai/kassinao.git
cd kassinao
cp .env.example .env
chmod 600 .env
mkdir -p data/{recordings,state,auth,cache}
chmod 700 data data/*
```

Set at least these values in `.env`:

```env
DISCORD_TOKEN=your_bot_token
APPLICATION_ID=your_application_id
DISCORD_CLIENT_SECRET=your_oauth_client_secret
APP_URL=http://localhost:8080
MCP_URL=http://localhost:8080
PUBLIC_URL=http://localhost:8080
DOCS_URL=http://localhost:8080
ALLOW_LOCAL_APP_URL=true
PUBLIC_SURFACES_ENABLED=false
TRUST_PROXY_HOPS=1
COMPOSE_PROFILES=split-public
OPERATOR_NAME="Local Kassinão operator"
PRIVACY_POLICY_URL="http://localhost:8080/privacy"
OPERATOR_CONTACT_URL="http://localhost:8080/privacy#contact"
DATA_DELETION_URL="http://localhost:8080/privacy#data-rights"
PRIVACY_EFFECTIVE_DATE=2026-07-14
PRIVACY_POLICY_VERSION=local-1
PRIVACY_AUDIENCE="Operator using fictional test data on localhost"
PRIVACY_PURPOSES="Local evaluation without real meeting data"
PRIVACY_LAWFUL_BASIS="Local evaluation with fictional data only"
INFRASTRUCTURE_PROVIDER="Local machine"
INFRASTRUCTURE_REGION="Local device"
EDGE_PROVIDER=none
EDGE_REGION=none
OPERATIONAL_LOG_RETENTION="Until this local test is removed"
BACKUP_STATUS=disabled
BACKUP_PROVIDER=none
BACKUP_REGION=none
BACKUP_RETENTION_DAYS=0
DATA_REQUEST_PROCESS="Remove the fictional test data from this local machine"
DATA_REQUEST_RESPONSE_DAYS=30
INCIDENT_CONTACT_URL="http://localhost:8080/privacy#contact"
INCIDENT_PROCESS="Stop the local instance and remove test credentials and data"
SOURCE_URL=https://github.com/resolvicomai/kassinao
ALLOWED_GUILD_IDS=your_test_guild_id
ALLOW_ALL_GUILDS=false
KASSINAO_IMAGE=kassinao-local:dev
KASSINAO_PULL_POLICY=never
```

Then build locally before starting Compose:

```bash
docker build -t kassinao-local:dev .
docker compose --profile split-public up -d --no-build
docker compose logs -f kassinao kassinao-router kassinao-public
```

The router is the only process published on `127.0.0.1:8080`; the core and
public process expose no host ports. For a public deployment, use your own HTTPS
origins and keep `ALLOW_LOCAL_APP_URL=false`.

## Discord application setup

Create a new application in the [Discord Developer Portal](https://discord.com/developers/applications). Each instance needs its own application.

1. Copy the **Application ID**, create the bot token, and copy the OAuth **Client Secret**.
2. For a private company instance, turn **Public Bot** off (`bot_public=false`). This prevents people other than the application owner from adding it to guilds; the runtime allowlist remains mandatory.
3. Under **Installation**, use **Guild Install** with scopes `bot` and `applications.commands`.
4. Request permissions bitfield `68242432`: View Channel, Send Messages, Embed Links, Read Message History, Connect, and Change Nickname. Change Nickname is recommended; the other five are required in the recording channel.
5. Under **OAuth2 → Redirects**, register exactly `${APP_URL}/auth/callback`.
6. Under **General Information → Privacy Policy URL**, register `${APP_URL}/privacy`. The page must be publicly reachable and describe this operator's real deployment.
7. The web login requests only OAuth scope `identify`. Membership in an allowed guild is checked separately with the bot.

Install URL template:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=68242432
```

The bot does not request privileged Gateway intents. It does inspect the minimum necessary DM content to detect an attempted slash command and return onboarding help.

## Access model

An instance URL is public information, not a security boundary. Web and MCP access require:

- Discord login;
- current membership in an allowlisted guild; and
- the meeting ACL: starter, someone recorded/present in that call, or a current member with Manage Server.

Leaving the guild removes access. Receiving channel permission later does not unlock old meetings. If Discord cannot reliably confirm membership, access fails closed or returns temporary unavailability instead of granting access. `OWNER_IDS` does not bypass meeting access.

## Production deployment

The repository contains a release workflow and operations-bundle tooling designed for a split production deployment with no Git checkout or application source code on the VPS. The bundle itself contains public sealed Shell/Python operational controls, secret-free templates, and native no-dump runtimes. Their presence in a branch is not evidence that a release, GHCR image, bundle, checksum, or attestation is public.

Only use the hardened path after the selected release is publicly verifiable:

- the GitHub release and its operations-bundle assets exist and are immutable;
- the exact OCI image resolves by `sha256` digest in GHCR;
- checksum, source/tag policy, release integrity, and GitHub attestations verify;
- a clean install from that public bundle has passed the release checks.

If any artifact is missing, build from source for local evaluation and wait for a verified release. Do not replace the missing digest with a moving tag and do not build the product on the production VPS.

The hardened topology is **split-only**: a secret-free router receives all ingress, landing/docs/demo run in a second secret-free process, and the bot/private app/MCP run in the private core. The router listens on two explicit interfaces: `edge0` for the isolated tunnel link and `host0` for the only loopback host publish. It never binds to `core0`, `public0`, `0.0.0.0`, or `::`. Docker does not materialize a published port for an internal-only container, so `host0` is a router-only, non-internal IPv4 NAT bridge with IPv6 disabled, inter-container communication disabled, and both its default host binding and the explicit publish locked to `127.0.0.1`. Before containers start, the sealed IPv4/IPv6 `DOCKER-USER` policy allows only `ESTABLISHED,RELATED` return traffic from `kas-host0` and rejects every new outbound flow on that bridge; the separate host policy rejects new router-to-host connections. The router uses one exclusive isolated link per upstream; core and public never share a network, and only core and tunnel receive dedicated egress. Both production adapters require an amd64 or arm64 Linux VPS with systemd 249+, Docker Engine 28.1.0+, Docker Compose 2.36.0+, GNU coreutils, iptables/ip6tables, iproute2, util-linux, cryptsetup, e2fsprogs, curl, Python 3, tar/gzip, and dm-crypt/LUKS storage. Engine 28.1 is the first release that applies Compose `interface_name`; a newer Compose client cannot add that daemon capability to Engine 28.0. Check architecture and versions before creating or mounting storage; the native bundle, deploy, and audit fail closed on incompatible hosts.

Choose exactly one host adapter:

Shared mode has a private host-global prerequisite before any public gate: assess every neighboring workload, then use the private instance runbook to apply and persist exactly `kernel.core_pattern=/dev/null` and `fs.suid_dumpable=0`. Record the prior values, global impact, and recovery procedure. The public bundle verifies but never changes these settings. Only after this private verification should `audit-shared-vps-security.sh --neighbors-only` run.

- **Dedicated (default):** set `KASSINAO_HOST_SCOPE=dedicated` and explicitly acknowledge `KASSINAO_DEDICATED_DOCKER_HOST_ACK=I_UNDERSTAND_THIS_VPS_MUST_RUN_ONLY_KASSINAO`. This path requires the Docker daemon and VPS to run only Kassinão because its `ExecStartPre` controls apply to the entire `docker.service`; its audit rejects unrelated containers. Mount the configured data root on dm-crypt/LUKS, then use `prepare-storage.sh`, `install-host-controls.sh`, `deploy-release.sh`, and `audit-vps-security.sh` from the verified bundle.
- **Shared, trusted host:** set `KASSINAO_HOST_SCOPE=shared` and leave `KASSINAO_DEDICATED_DOCKER_HOST_ACK` empty. This path is for other workloads controlled by the same trusted operator, not for hostile or mutually untrusted tenants. It adds `docker-compose.shared.yml`, requests swappiness `0`, keeps each Kassinão container at `MemorySwap=Memory` (zero effective swap capacity) and restart policy `no`, and does not install a Docker service drop-in or restart the global Docker daemon. Some Docker Engine versions serialize the requested runtime `MemorySwappiness` as `null`; the gates accept that representation only while the independently verified positive `MemorySwap=Memory` contract still leaves no swap available, and continue to reject positive swappiness or an open swap limit. Before opening or mounting storage, run `audit-shared-vps-security.sh --neighbors-only`. A new install then mounts a LUKS2 file container at `KASSINAO_DATA_ROOT` and runs `prepare-shared-storage.sh`; the script seeds encrypted `config/app.env` from safe public defaults and creates the maintenance lock required by the injector. A legacy plaintext install without `KASSINAO_HOST_SCOPE` must first pass `validate-legacy-dedicated-installation.sh`; its exact old watchdog is removed only after byte-match, and its stopped containers remain present while `prepare-legacy-shared-layout.sh` proves and consolidates recordings/cache mounts. The helper records only the legacy `.env` path, filesystem identity, metadata, and hash, then moves that private transition record into a root-only directory directly under `DATA_ROOT`, outside every runtime-writable bind; no source manifest remains in the plaintext release after preparation. Only then are those containers removed and `migrate-shared-storage.sh` called with the new mapper open but unmounted. The migration imports only operational keys present in the public template; host, Compose, tunnel-token, and unknown values never cross into encrypted app configuration. Preparation, migration, and injection repeat the neighbor gate before protected writes. Continue with `install-shared-host-controls.sh`, `deploy-release.sh`, and the full audit. The shared audit reserves Kassinão's project, names, bridges, networks, mounts, and environment allowlists and rejects neighboring workloads with privileged, device, Docker, namespace, capability, protected-storage, source-layout, or Kassinão-network access.

The shared adapter limits Kassinão's interaction with neighboring workloads; it does not protect the instance from the host's root user, Docker administrators, or the infrastructure/hypervisor operator. Use the dedicated adapter when those are not all trusted.

For the legacy v1.4.9 layout, root metadata files under `recordings/` are restricted to seven known names. Preparation preserves their old co-located paths in both the source and plaintext rollback. Only encrypted migration staging maps them into `state/` and `auth/`, writes the exact `state/.layout-v2` marker, and leaves `auth/.instance-id` for the first new runtime boot. An unknown root file or a conflict with an explicit state/auth mount fails closed.

The v1.4.9 cutover order is strict: apply the private host-global core policy before the first public helper; validate the live legacy project; remove the exact health-watch; stop but retain its containers; prepare the consolidated plaintext layout; and only then run Compose down. After the containers are absent, `remove-legacy-dedicated-host-controls.sh` proves the prepared v3 marker, original `.env`, legacy bundle, remaining installed files, effective systemd hooks, firewall policy, Docker PID, and neighboring-container snapshot before removing only the dedicated allowlist. A fully absent set is a safe no-op; any partial, foreign, or drifted set fails before mutation. The helper never restarts Docker, mutates containers, deletes either data root, deletes the old release or `.env`, or removes the maintenance lock.

In shared mode, the eight explicit `KASSINAO_{CORE,ROUTER,PUBLIC,TUNNEL}_{MEMORY_LIMIT,CPUS}` limits must leave at least 25% of physical RAM and online CPUs for neighboring workloads. The audit compares `compose.env`, the overlay, actual host capacity, and Docker runtime. Because the storage device varies, the adapter does not invent an I/O throttle: monitor latency and throughput and size processing and backup windows accordingly.

Shared mode also requires explicit `KASSINAO_UID` and `KASSINAO_GID` values in the private range `61000..61183`. Choose an unused pair only after checking host accounts/groups, subordinate-ID ranges, processes, protected files, neighboring container `Config.User` values, and prior Kassinão trees. Do not create a Linux account or group for that pair. Public examples leave both values blank, and preparation/audit fail closed on collisions. Dedicated and local installs may keep their documented `1000:1000` default.

The following rules apply to both adapters:

- Kassinão's production footprint holds only a verified root-owned operations bundle, private environment files, and data volumes — no Kassinão Git checkout, compiler, or GitHub credential. On a dedicated host this applies to the VPS; on a shared host it applies to Kassinão's reserved paths and processes without making claims about trusted neighboring workloads;
- the release image is pinned by digest;
- active data, authentication state, cache, and deployment snapshots remain inside the adapter's verified dm-crypt/LUKS boundary;
- in the shared adapter, application secrets and the tunnel token also remain inside that boundary and reach only their intended non-root container through read-only bind mounts;
- after the storage boundary is mounted and secured, the matching preparation script proves it before creating only the four runtime directories as mode `0700` under the configured non-root UID/GID;
- a successful deploy attempts to delete its rollback snapshot immediately. If that cleanup or the deploy fails, operational state and recording metadata, but not auth or audio tracks, may remain until the persistent host timer removes them within the configured `KASSINAO_ROLLBACK_RETENTION_HOURS` window (72 hours by default, 168 maximum);
- host firewall, SSH, scoped egress, file modes, backup, and external host checks must pass before the instance is published.

There is no universal shared-storage size. Capacity planning must include retained recordings, maximum duration and concurrency, temporary processing tracks, cache, growth, and a recovery margin while preserving explicit free space for every neighboring workload. The LUKS backing file is preallocated and does not grow automatically. Review `MIN_FREE_MB_START`, `MIN_FREE_MB_ABORT`, and `DISK_ALERT_PCT` for the chosen capacity, monitor both the encrypted filesystem and its host filesystem, and use the documented offline growth procedure before either boundary becomes tight.

All four configured HTTPS origins must resolve before `deploy-release.sh`, because its final gate tests every surface externally. `MCP_URL` may equal `APP_URL`, and `DOCS_URL` may equal `PUBLIC_URL`; the public group must never share a host with the private core. Keep the bot uninvited and the instance unannounced until deploy and audit both pass.

`APP_URL`, `MCP_URL`, `PUBLIC_URL`, and `DOCS_URL` remain the external HTTPS origins. In Cloudflare Tunnel, point every hostname to the single ingress `http://kassinao:8080`; that name is an edge-network alias owned by the router, not the core. A host proxy uses only the `KASSINAO_HOST_PORT` loopback port. The core and public process publish no host ports and must never be connected directly to the tunnel or internet.

When using Nginx on the host instead of the bundled tunnel, preserve the requested host, remove Cloudflare's identity header, and overwrite rather than append the client-IP chain. The router discards every incoming forwarded host/protocol value and rebuilds them from the configured origin:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header CF-Connecting-IP "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Host "";
    proxy_set_header X-Forwarded-Proto "";
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Keep that loopback port unreachable from the network. An equivalent proxy must preserve `Host`, delete `CF-Connecting-IP`, and set `X-Forwarded-For` from its own authenticated connection rather than accepting a client-supplied value.

Detailed production, legacy-plaintext migration, reboot, storage-growth, and safe host-control removal procedures live in the [documentation](https://docs.kassinao.cloud/en). Modern dedicated/shared adapter conversion requires a separately audited procedure because its `DATA_ROOT` is already mounted; never run the plaintext migrator on it. `uninstall-host-controls.sh` and `uninstall-shared-host-controls.sh` both reject running/restarting containers, pending snapshots, and drift; neither stops containers, restarts Docker, or deletes the release, storage, backing file, or secrets. A legacy shared migration preserves `DATA_ROOT.plaintext-before-shared-luks` and writes an encrypted `pending` marker with a 1-168 hour deadline. That plaintext copy is a data rollback, not a turnkey operational rollback. The public bundle includes a sealed, resumable topology-transition primitive for exact verified bundles, but it intentionally does not contain an organization's rescue environment, host paths, credentials, or private runbook. Operational reversal exists only when the operator prepared and host-tested a separate root-only adapter before migration; otherwise service recovery is fix-forward through the shared adapter. Never manually restart the legacy Compose stack or reinstall dedicated controls on the shared host. While the marker exists, the checker rejects inconsistent state; after the deadline, deploy, backup, health, and audit fail closed. After validating the app, access, a real recording, and a restorable backup, stop only Kassinão, purge original legacy sources with `prepare-legacy-shared-layout.sh --purge-originals`, and only then run `finalize-shared-migration.sh --confirm-destroy-plaintext-rollback`. The confirmed purge rechecks the exact legacy `.env` bytes and identity before unlinking that one file; it never deletes other files from the old release tree. This is logical deletion only: provider backups, snapshots, and storage remnants may retain old secret material, so rotate every migrated Discord, provider, MCP, tunnel, and session credential after validation. On reboot, leave Kassinão stopped until an operator enters the LUKS passphrase directly at the `cryptsetup` prompt, verifies storage, and runs the scoped deploy and audit; never store unlock material in the VPS, an environment file, cloud-init, or a systemd unit. Keep secrets, host paths, LUKS backing/mapper/UUID values, unlock material, operational evidence, the reversal adapter, and organization-specific policy out of this repository and the public image.

## Privacy and data flow

A fresh installation defaults to audio recording with external AI egress disabled:

- `TRANSCRIBE_PROVIDER=none`
- `TRANSCRIBE_FALLBACK_PROVIDER=none`
- `MINUTES_ENABLED=false`
- MCP off until `MCP_SECRET` is set
- audio retention: 7 days
- text/metadata retention: 90 days

Enabling cloud ASR, AI minutes, a webhook, remote backup, or MCP sends the data necessary for that feature to the destination configured by the operator. “Self-hosted” does not mean data can never leave the server.

[`PRIVACY.md`](PRIVACY.md) explains what the public project does and provides an operator checklist. It is not a substitute for the deployment's policy. Production requires the operator to publish accurate identity/contact, privacy, and data-deletion information and expose it at `APP_URL/privacy`.

Security controls and operator responsibilities are documented in [`SECURITY.md`](SECURITY.md). Never place credentials, private URLs, identifiers, logs with meeting content, recordings, `.env`, auth state, or data requests in a public issue.

## MCP connector

When enabled by the operator, [`kassinao-mcp`](mcp/README.md) runs locally as a stdio client and requests authorized meeting data from that instance over HTTPS. It requires its own `KASSINAO_URL`; there is no shared hosted API and no upstream fallback. The five tools in this version are read-only, do not serve audio, and are subject to the same current-membership and meeting ACL checks as the web app.

## Commands

Commands use pt-BR names by default and English localizations in Discord.

| pt-BR | English | Availability |
| --- | --- | --- |
| `/gravar`, `/parar`, `/nota`, `/status` | `/record`, `/stop`, `/note`, `/status` | Base recording |
| `/gravacoes`, `/ajuda`, `/sobre` | `/recordings`, `/help`, `/about` | Base app/help |
| `/privacidade` | `/privacy` | Base instance policy and operator contact |
| `/autorecord`, `/config` | same names/localized options | Manage Server where required |
| `/perguntar` | `/ask` | Only when the minutes/LLM capability is enabled |
| `/mcp` | `/mcp` | Only when MCP is enabled; hidden behind Manage Server and enforced by `OWNER_IDS` |

Members create and revoke their own MCP connections in the private app when that capability is enabled.

## Development

Node.js 22+ is required.

```bash
npm ci --userconfig .npmrc.security
cp .env.example .env
npm run dev
```

Before a pull request:

```bash
npm run lint
npm run build
npm run typecheck:preview
npm test
npm run format:check
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), and the [research snapshot behind the product claims](docs/research/2026-07-14-product-truth.md).

## License and costs

Kassinão is licensed under [AGPL-3.0-or-later](LICENSE). The software has no license fee, but every operator pays for and is responsible for their own infrastructure, storage, domain, backups, and any external providers they enable.
