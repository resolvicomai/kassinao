# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Older entries describe what those releases introduced. Current product claims,
defaults, security boundaries, and installation instructions are defined by the
latest README, documentation, configuration template, and tests.

## [Unreleased]

## [1.4.17] — 2026-07-16

### Added

- A secret-free edge router is now the only host-published application process. Separate listeners bind exclusively to the isolated tunnel interface and a router-only host-ingress interface, remain unready until both binds succeed, and share one admission budget. The sealed host firewall blocks new router-to-host pivots through the NAT bridge while preserving established loopback traffic; private app/MCP routes remain separated from the isolated landing/docs process and the local quickstart preserves one origin.
- Sealed transition helpers provide resumable, exact-identity topology changes for shared deployments and for upgrades from the published v1.4.14-v1.4.16 dedicated layout.
- Release and CI gates now smoke-test the real router/core/public image topology and validate the fully rendered dedicated and shared Compose models.

### Changed

- Docker Engine 28.1.0 or newer is now required alongside Docker Compose 2.36.0. Engine 28.1 is the first daemon release that applies the named-interface contract used by the split router; deploy and both production audits reject Engine 28.0 before runtime mutation.
- Docker Compose 2.36.0 or newer is required so each service receives a deterministic interface name. Core, router, public, and tunnel now have exact network membership, isolated internal links, a router-only internal host bridge with IPv4 NAT/IPv6 isolation/ICC disabled, and separate egress bridges.
- Shared-host upgrades must set the new required `KASSINAO_ROUTER_MEMORY_LIMIT` and `KASSINAO_ROUTER_CPUS` values. The router is now the sole ingress, and the obsolete `KASSINAO_PUBLIC_HOST_PORT` setting has been removed.
- The local quickstart uses the same split public/private architecture as production. Public and documentation origins may intentionally share the app origin; conflicting synthetic `www` aliases still fail closed.
- Production configuration requires `TRUST_PROXY_HOPS=1`, and deploy/audit gates verify that exact value before stopping the existing runtime.

### Security

- The router rebuilds trusted forwarding headers, rejects unsupported proxy methods, upgrades, absolute-form targets, and request expectations, and streams responses without exposing secrets or private health details. It ignores `CF-Connecting-IP` without a trusted forwarding chain; the host-proxy contract now preserves `Host`, removes that header, and overwrites `X-Forwarded-For`. Per-upstream admission limits, client-close cancellation, and a response-header deadline prevent abandoned requests from accumulating behind a slow core.
- Host hardening now proves exact bridge metadata, gateway isolation, inter-container-communication policy, immutable container identities, and the complete network set before applying egress rules. Any extra network or endpoint fails closed.
- Public privacy routes are verified as exact redirects to the private application origin; private namespaces remain unavailable from public/docs hosts.
- Deploy now proves external DNS resolution, hostname-valid TLS, and handshake availability for every configured origin before stopping the existing runtime.
- Topology transitions persist root-only state on the encrypted data filesystem and recheck that recordings are idle on every retry before removing a runtime.

## [1.4.16] — 2026-07-16

### Security

- The isolated public process now accepts the image's no-dump marker and preload only as an exact, atomic runtime-owned pair tied to its current PID. Partial, altered, or operator-injected loader configuration still fails closed without logging the supplied values.
- Dedicated and shared VPS audits now reject application containers whose sealed no-dump entrypoint or command was overridden.

### Fixed

- The split landing/docs container now starts correctly through the production image entrypoint. Release verification runs the real public process and health check on both amd64 and arm64 so this container/runtime mismatch cannot ship again.

## [1.4.15] — 2026-07-16

### Added

- The public landing now includes a local, bilingual Product Hunt launch badge with no third-party embed or tracking script.

### Changed

- Navigation, language controls, footer links, and keyboard focus states have larger and clearer interaction targets across desktop and narrow mobile layouts.
- App releases may reuse the existing immutable MCP package when its annotated tag is an ancestor of the reviewed app release and `mcp/` is byte-for-byte unchanged. An executable, behavior-tested gate enforces both conditions before the workflow verifies the remote tag, npm signatures, and package attestation against the exact MCP commit; any MCP change requires a new MCP release first.

### Fixed

- Product Hunt launch documentation now records the verified public listing instead of retaining a placeholder URL or claiming the private production gates are complete.

## [1.4.14] — 2026-07-16

### Changed

- `kassinao-mcp@1.0.12` carries the unchanged 1.0.11 connector runtime under a fresh immutable package and tag, allowing MCP and app release provenance to bind to the exact reviewed 1.4.14 commit.

### Fixed

- Shared legacy migration guidance, security policy, operator messages, and bilingual documentation now state the exact recovery boundary: the preserved plaintext is a data rollback, not an operational path back to the legacy Compose stack. After a successful cutover, service recovery is fix-forward through the shared adapter unless the operator has separately built and host-tested a reversal adapter before migration.

## [1.4.13] — 2026-07-16

### Changed

- `kassinao-mcp@1.0.11` carries the unchanged 1.0.10 connector runtime under a fresh immutable package and tag, allowing MCP and app release provenance to bind to the exact reviewed 1.4.13 commit.

### Fixed

- Shared-host inventory, legacy-layout preparation, and encrypted-storage migration now read optional Docker mount and network fields through map-safe Go-template lookups. Docker Engine 29 may omit `Name` and `Driver` from bind-mount objects instead of returning empty strings; the release now preserves `null` for those optional values while continuing to reject missing required fields and unsafe neighboring mounts.

## [1.4.12] — 2026-07-15

### Changed

- `kassinao-mcp@1.0.10` carries the unchanged 1.0.9 connector runtime under a fresh immutable package and tag, allowing MCP and app release provenance to bind to the exact reviewed 1.4.12 commit.
- Docker stop operations use the canonical `--timeout` option instead of the deprecated `--time` alias while preserving the same bounded fail-closed containment behavior.

### Fixed

- Shared-host deploy and audit gates accept Docker Engine 29 serializing a requested zero `MemorySwappiness` as `null` only when the positive configured memory limit is exact and `MemorySwap=Memory`. Positive swappiness and any configuration that leaves effective swap available remain rejected.

## [1.4.11] — 2026-07-15

### Changed

- `kassinao-mcp@1.0.9` carries the unchanged 1.0.8 connector runtime under a fresh immutable package and tag, allowing both MCP and app release provenance to bind to the exact reviewed 1.4.11 commit.

### Fixed

- Legacy v1.4.9 plaintext-to-shared migration now removes the complete proven dedicated host-control set after the old containers are gone. The new fail-closed helper treats a completely absent set as a no-op, rejects partial or drifted installations before mutation, preserves Docker and neighboring workloads, and is included in the sealed operations bundle and bilingual runbook.
- Linux no-dump gates now accept the kernel's hexadecimal all-zero `coredump_filter` representation, including `00000000`, while continuing to reject empty or non-zero values.
- Docker topology checks now render ranged Go-template values with explicit `printf` newlines, avoiding Docker 29's leading blank line from `println` in exact set comparisons.

## [1.4.10] — 2026-07-15

### Added

- A separate `shared` production host adapter supports trusted same-operator workloads on one VPS without installing a Docker service drop-in or restarting the global Docker daemon. It uses `docker-compose.shared.yml`, a LUKS2 file container mounted at the private data root, Kassinão-scoped host controls, the existing release deployer, and a read-only shared-host audit.
- `migrate-shared-storage.sh` copies an idle, exact plaintext runtime tree into a newly opened LUKS mapper, checks content and metadata before and after the mount switch, and preserves the original tree for explicit data rollback and later private destruction. After the cutover succeeds, service recovery is fix-forward through the shared adapter; the preserved tree is not an operational path back to the legacy stack.
- `check-shared-migration-rollback.sh` validates fresh, pending, and purged migration states before deploy, backup, health, full audit, and host-control removal. `finalize-shared-migration.sh` verifies the preserved tree against the encrypted manifest, removes the logical plaintext copy only under explicit confirmation, and publishes a sealed purged receipt without claiming forensic erasure.
- `uninstall-shared-host-controls.sh` removes only the verified shared-host controls after explicit confirmation, without stopping containers, restarting Docker, or deleting the release, encrypted storage, backing file, or secrets.

### Changed

- Production configuration now selects `KASSINAO_HOST_SCOPE=dedicated|shared`. The dedicated adapter remains the default and keeps its explicit dedicated-host acknowledgement; the shared adapter requires that acknowledgement to remain empty. Both adapters keep Git checkout and application source code off Kassinão's VPS paths and consume the verified operations bundle plus digest-pinned OCI image rather than cloning or building the project from Git. The bundle still contains public sealed Shell/Python controls, secret-free templates, and native runtimes; the shared adapter makes no source-layout claim about trusted neighboring workloads outside its boundary.
- In shared mode, `app.env` and the optional Cloudflare Tunnel token now live under the encrypted data root and reach only their intended container through read-only bind mounts. They are absent from the release environment and Docker `Config.Env`.
- README, security guidance, and bilingual product documentation now distinguish four configured HTTPS origins from their three-or-four hostnames, keep external origins separate from internal tunnel targets, and provide complete new-install, migration, finalization, and adapter-specific removal flows for an existing trusted shared VPS.
- `kassinao-mcp@1.0.8` keeps the macOS process-identity probe on an exact, non-secret environment while preserving the existing fail-closed credential lock.

### Security

- Official app containers now start through a multi-architecture static no-dump launcher. A constructor reapplies `PR_SET_DUMPABLE=0` after each dynamic `execve`; every service keeps a hard core limit, while app processes and the shared tunnel launcher also enforce a zero coredump filter. Local media/transcription children no longer inherit application credentials or operator-controlled loader/TLS configuration, and the macOS MCP credential lock no longer forwards the client environment to `ps`.
- Privileged operations scripts self-reexec through the architecture-matched runtime sealed in the operations-only bundle before reading secrets. The helper verifies the root-owned bundle, complete manifest, hashes, metadata, target script, and native ELF architecture before accepting its preload.
- The shared-host audit requires the privately managed, reboot-persistent host-global pair `kernel.core_pattern=/dev/null` and `fs.suid_dumpable=0` before runtime. The repository verifies but does not mutate these settings; prior values, neighbor impact, and recovery remain in the private instance runbook.
- Shared-host containers use positive memory limits with `MemorySwap=Memory`, swappiness `0`, and restart policy `no`, so they cannot silently restart before encrypted storage and scoped egress gates pass after a reboot.
- The shared storage verifier proves the configured backing file, loop device, LUKS2 mapper/UUID, exact mount, safe mount flags, private runtime directories, and mount sentinel. Backing paths, mapper/UUID values, unlock material, secrets, and organization runbooks remain private instance configuration.
- A shared plaintext migration creates an encrypted pending marker with a bounded 1-168 hour deadline. An inconsistent or expired pending state fails closed; after independent application and backup validation, explicit finalization publishes the purged receipt. Logical deletion does not imply secure erase from SSDs, journals, snapshots, backups, or provider storage.
- The shared-host preflight reserves Kassinão's project, names, Linux bridges, Docker networks, protected paths, mounts, and environment allowlists before mutation. It rejects foreign privileged/device/Docker access, all added capabilities, host or container namespaces, `volumes-from`, protected-storage overlap, or Kassinão-network membership. This adapter does not claim protection against host root, Docker administrators, or the infrastructure/hypervisor operator.
- Privileged controls resolve each expected container to its immutable Docker ID, validate the exact Compose project and service labels, revalidate immediately before mutation, and then act only on that ID. A foreign container squatting on a reserved name fails closed before firewall or lifecycle changes.
- Full shared-host audits now require all three containers to be running, both application surfaces to be healthy, and their process limits and bounded `json-file` rotation to match the release exactly. Host-control removal re-runs an ownership preflight immediately before its first mutation and refuses partial or foreign topology.
- Health-watch failures trigger the fail-closed egress containment unit instead of leaving a failed shared instance reachable until the next timer run.
- Generic bot DMs no longer disclose the private app or MCP connection origin. Recording-specific DMs still revalidate current membership and ACL before sending a private link.

## [1.4.9] — 2026-07-15

### Security

- The production image now removes bundled package managers and their global dependency trees after the build stage. Kassinão executes only `node` at runtime, so npm, npx, Corepack, Yarn, and related unused shims no longer expand the image attack surface.
- The v1.4.8 workflow passed source audit, multi-architecture build, OCI provenance, anonymous pulls, and hardened runtime execution, then stopped on fixable high-severity vulnerabilities inside the base image's unused npm installation. It produced no version or rolling image tags, operations bundle, checksum, or GitHub Release.

## [1.4.8] — 2026-07-15

### Fixed

- Every Vitest file now receives separate recording, operational-state, and authentication directories under `KASSINAO_TEST_STORAGE_ROOT`, eliminating cross-file instance-identity races while preserving the production-valid CI storage path.
- The v1.4.7 workflow stopped in the audited-source gate before image construction. It produced no application image, version or rolling tag, operations bundle, attestation, or GitHub Release.
- Includes the v1.4.7 multiarch gate correction that pulls exact amd64 and arm64 child manifests instead of the OCI index digest.

## [1.4.7] — 2026-07-15

### Fixed

- The anonymous multi-architecture release gate now extracts and pulls the exact amd64 and arm64 child manifests instead of asking Moby to overwrite a canonical multiarch-index digest with a platform-specific image ID.
- The v1.4.6 workflow stopped at that pull gate after publishing only its commit-addressed candidate and OCI attestation. It did not create a `1.4.6` image tag, rolling tags, operations bundle, or GitHub Release.
- The source runtime template now fails closed with a non-runnable image placeholder; only the verified operations bundle replaces it with the published image digest.

## [1.4.6] — 2026-07-15

### Fixed

- Republishes the reviewed v1.4.5 application changes under a new immutable tag. The v1.4.5 workflow was rejected by the repository's GitHub Actions policy before any job started, so it produced no container image, operations bundle, or GitHub Release.
- The repository Actions allowlist now explicitly permits only the Docker and Trivy action repositories required by the release workflow while keeping selected-actions mode and immutable-SHA pinning enabled.
- Linux CI uses a production-valid storage root outside `/tmp`, preserves the runtime's `PrivateTmp` fail-closed check, and safely opens layout markers without following symlinks.
- The release image installs dependencies without running unrelated install scripts, then explicitly rebuilds and smoke-tests the native Discord Opus dependency from source.

## [1.4.5] — 2026-07-14

### Added

- The release workflow is prepared to publish a multi-architecture GHCR image with SBOM, build provenance, OCI attestation, and a separately attested operations-only bundle pinned to the exact image digest. The bundle excludes Git checkout and application source code but includes public operational controls, templates, and native runtimes. These artifacts are not public until the release workflow completes.
- Split production can run landing/docs/demo in a secretless `kassinao-public` process on a separate Docker network while bot/app/MCP remain in the private core.
- New installations separate recordings, operational state, and revocable authentication state. A local instance identity binds browser and MCP tokens to the installation and configured origin.
- Operational logging redacts private identifiers, routes, origins, and error messages unless the operator explicitly enables `LOG_PII=true` for controlled diagnosis.
- Production health carries both the immutable release digest and a random per-instance deployment fingerprint, preventing a stale tunnel or different VPS from satisfying the release smoke test.
- The private core now renders an instance-specific public privacy contract with effective date/version, operator identity, purposes, lawful basis, infrastructure/edge, log and backup retention, data-request handling, and incident response.
- The operations-only bundle includes a privileged `prepare-storage.sh` gate that proves the configured data root is already on dm-crypt/LUKS before creating only the four non-root runtime directories.
- `kassinao-mcp@1.0.7` fixes canonical IPv6 localhost URL handling and carries the rewritten read-only, instance-scoped connector documentation.

### Changed

- A public source checkout builds `kassinao-local:dev` explicitly and Compose never pulls a nonexistent release image. The production bundle, once published, runs from a mode-0700 directory outside Git, uses separate Compose/app environments, and accepts only its sealed immutable `image@sha256` reference.
- `APP_URL` is blank in new templates. Production localhost now requires the explicit `ALLOW_LOCAL_APP_URL=true` exception; internet-facing instances must configure their own HTTPS origin.
- New production guidance uses the verified operations-only bundle, without a Git checkout or application source code on the VPS, instead of a platform blueprint or VPS source checkout.
- Same-instance upgrades start from each new bundle's templates instead of copying the previous release environment wholesale; the new sealed image/digest remain authoritative while reviewed instance fields and private settings are reapplied.
- The standard release image contains only external transcription-provider runtimes; local `command` transcription is an explicit custom-image flow maintained by the operator.
- Backups include operational state but refuse to include an overlapping authentication directory. Both legacy and current session/instance filenames are excluded defensively.
- The verified production bundle accepts only the split public/private topology; single-origin mode remains available for local source development, not for the hardened VPS path.
- Production documentation now verifies immutable release and asset attestations, pins provenance to the release workflow/tag/commit, maps all four public/private HTTPS routes, and prepares a new root-owned release directory without depending on the operator's shell working directory.

### Security

- Web, OAuth-state, MCP access, and MCP refresh tokens now carry instance and origin claims. Existing browser and MCP sessions must sign in or connect again after this upgrade.
- The release workflow runs dependency audits, signature verification, lint, formatting, tests, and builds before publishing. GitHub Actions remain pinned to immutable commit SHAs.
- Final amd64 and arm64 images pass a pinned Trivy gate for fixable high/critical vulnerabilities; anonymous pulls and a non-root, read-only, networkless runtime are proven before promotion.
- The production deploy gate rejects Git parents, mutable image tags, Docker-socket/source mounts, unsafe ownership/modes, unexpected services, digest mismatches, and partially unhealthy split deployments.
- Deploys pull and verify the new image before downtime, stop the only writer before a strict metadata scan and operational-state snapshot, exclude all authentication material from rollback archives, and require the exact release digest from every external health endpoint.
- The public landing/docs network denies egress and host-gateway access. Production gates require Docker Engine 28+ and Compose 2.35+, audit every container binding/host-network mode, and verify the Docker forwarding perimeter instead of relying on UFW alone.
- A host firewall unit places the Kassinão chains first, rejects host/private/metadata destinations in IPv4 and IPv6, and refuses unexpected endpoints on either application network.
- Docker now preloads the offline egress policy before the daemon can restore containers. Watchdog, backup, rollback, and deploy starts all revalidate the active unit and exact policy; a failed partial deployment is stopped and proven contained instead of remaining online.
- Each release reinstalls root-owned firewall/watchdog controls from the verified bundle; the VPS audit rejects stale files, disabled persistence, or inactive units.
- Deploy, backup, watchdog, firewall, and audit controls reject inherited Docker endpoint/context/config variables and pin operations to the VPS-local rootful socket before private instance material is processed.
- Public Host routing includes the configured port, all production origins are canonicalized before comparison, SSH auditing rejects host-based/GSSAPI/empty alternatives, and no loopback-only route exposes active-recording metadata behind a local reverse proxy.
- Production deploys require a technical dm-crypt/LUKS proof for active data; swap must be disabled or covered by the same class of encryption. Plaintext backup staging and rollback snapshots stay inside the encrypted data root instead of `/tmp` or the release directory.
- Host-wide controls require an explicit dedicated-VPS acknowledgement. Failed-deploy operational snapshots have a bounded persistent cleanup timer, and the verified uninstall path refuses drift, running/restarting containers, or pending snapshots without deleting instance data.

## [1.4.4] — 2026-07-14

### Added

- Private instances now require an explicit Discord guild allowlist. `ALLOW_ALL_GUILDS=true` is available only as a deliberate public multi-guild opt-in; `GUILD_ID` remains a command-registration filter and does not grant access.
- Self-host configuration now supports exact proxy hops, a fork-specific source URL, explicit ASR fallback/context controls, optional OpenRouter attribution, and signed minutes webhooks.

### Changed

- `APP_URL` is the canonical origin for new deployments. `BASE_URL` remains a legacy alias and conflicting values fail startup.
- External fallback, meeting context, AI minutes, OpenRouter attribution, and webhook delivery are off until the operator enables each path explicitly.
- Local transcription commands now run as a parsed executable and argv without `sh -c`; shell operators, expansion, globs, comments, and embedded placeholders fail startup.
- Public product links now lead only to the fictional demo, documentation, GitHub, and the npm connector package. Kassinão provides no hosted workspace, public signup, or shared meeting API.
- The app and docs now pin `kassinao-mcp@1.0.6`; its npm metadata points to the public self-hosting documentation instead of a private operator API.

### Fixed

- Self-host documentation now matches the hard recording quotas enforced by the runtime, including admin-inclusive guild and global limits.
- Fork-specific `SOURCE_URL` and `REPO_PUBLIC` settings now control the repository link inside private app navigation.
- Minutes webhook documentation now defines the exact signed headers, raw-body HMAC input, replay window, constant-time comparison, and delivery-id idempotency contract.

## [1.4.3] — 2026-07-13

### Changed

- Gemini transcription now defaults to `gemini-3.5-flash` because Google shut down `gemini-2.0-flash` on 2026-06-01. Operators using `TRANSCRIBE_PROVIDER=gemini` without an explicit `TRANSCRIBE_MODEL` should review the current Gemini pricing before upgrading.
- The app, docs, and Discord setup instructions now pin `kassinao-mcp@1.0.5` instead of resolving an unspecified future release.
- `kassinao-mcp` 1.0.5 adds the opaque result/scan cursor contract, rejects credential-bearing redirects, bounds token responses and stdin before allocation, and keeps the reproducible profile-scoped credential store introduced in 1.0.4.
- Native Opus is compiled from the signed npm source tarball; ffmpeg and tini come from signed Debian repositories instead of postinstall executable downloads.

### Fixed

- Every recording request revalidates current Discord membership. Historical access is limited to the starter, people who were present, and current admins; destructive actions always force a separate check.
- Public Discord panels and completion notices contain only generic status. Private details stay in freshly authorized DMs/pages, and a durable, no-delete migration neutralizes historical bot messages without overwriting concurrent edits.
- Membership REST calls, archive scans, transcript reads, notes, presence identities, candidates, guilds, payload bytes, segments, recording starts, pending processing, and private DM fanout now have durable per-user and global availability budgets. Guild timelines stay pre-indexed, web libraries use authenticated bounded cursors, and large transcript routes paginate or fail before unbounded allocation.
- Signed web tokens now reject non-canonical, Unicode-confusable, and oversized encodings; OAuth continuation input and cookies are bounded; cursor continuation is tied to its user, query, sort, purpose, expiry, and underlying content version.
- MCP aggregate endpoints now enforce current guild membership and recording ACLs before exposing results, deny orphaned recordings, resume bounded scans without skipping authorized meetings or transcript hits, and reject stale continuations after source mutation.
- The application container no longer receives the Cloudflare Tunnel token from the shared Compose environment.
- Private notification fanout is bounded and resumable; successful DMs are not duplicated, starter DMs revalidate membership, and webhook failures never log credential-bearing URLs.

## [1.4.2] — 2026-07-13

### Changed

- The app, docs, and Discord setup instructions now pin `kassinao-mcp@1.0.4` instead of resolving an unspecified future release.
- The web onboarding now issues a short-lived one-time exchange code through hidden terminal input, so refresh tokens go directly to the protected local credential store and never appear in client configuration, shell history, or process arguments.
- `kassinao-mcp` stores exchange credentials behind an explicit non-secret profile and ships a reproducible bundled dependency graph.

### Fixed

- Multiple local connector processes sharing one local client profile now serialize refresh-token rotation and reread the latest protected credential before contacting the server, preventing one process from invalidating the other as token reuse.
- Refresh rotation now persists an idempotency marker before the network request, so a dropped response, client crash, or interrupted local write can safely retry the same generation instead of revoking the connection.

## [1.4.1] — 2026-07-13

### Fixed

- Authenticated actions in the private app no longer reject the canonical configured `APP_URL` when browser Fetch Metadata classifies its form navigation as cross-site. Exact origins remain required whenever the browser sends `Origin`; sibling and external origins remain blocked.

## [1.4.0] — 2026-07-13

### Added

- Public marketing site and private `/app/*` workspace, with a fictional live demo, recordings table, tabbed meeting view, light/dark themes, and per-device MCP connection management.
- Local-only `/health/details` for safe pre-deploy checks without exposing active-call or disk metadata publicly.
- Split-origin deployment through `APP_URL`, `PUBLIC_URL`, `DOCS_URL`, and `MCP_URL`, with host isolation, canonical metadata, per-surface robots/sitemaps, and fail-closed handling for unconfigured hostnames.

### Changed

- The maintainer-operated deployment adopted separate origins for the public landing, public docs, private OAuth/archive, and private connector API. It was not a hosted workspace or public signup; unconfigured or retired origins cannot access API, OAuth, or private routes.
- `/ask` now resolves meeting dates separately from action deadlines (including relative deadlines such as `today`, `tomorrow`, and weekdays), ranks eligible meetings before applying context limits, and searches structured minutes fields including decisions, actions, owners, due dates, topics, attendance, and per-participant notes.
- `kassinao-mcp` 1.0.3 pins saved refresh tokens to their issuing instance, isolates multiple local connections, serializes concurrent refreshes, preserves sessions across transient 429/5xx responses, and reports its package version to MCP clients.
- Private web/API responses are `no-store`; session cookies are scoped to `/app`; state cookies are scoped to `/auth`; app mutations validate the exact request origin.
- Recording access now requires current server membership. Private-channel history is limited to its starter/participants and current admins; only channels public to `@everyone` when recording began may follow their current audience.
- Container capabilities are dropped and the Node, Cloudflare Tunnel, and autoheal images are pinned to immutable multi-architecture digests.

### Fixed

- `/ask` no longer drops relevant older meetings behind recency/count cuts, bounds archive/transcript work before the LLM, isolates cost quotas per user/guild, and lets the model select source IDs only; the server renders the exact sanitized evidence and authorized links.
- MCP `participantId` filtering now includes people who attended a call without speaking.
- Invalid numeric environment settings, weak manually configured signing secrets, and malformed `BASE_URL` values now fail fast instead of silently weakening sessions or disabling retention, disk guards, timeouts, or token expiry.
- Recording tabs expose complete ARIA relationships and keyboard navigation.
- Revoked Discord roles/membership can no longer survive indefinitely in the discord.js cache; membership refreshes use authoritative REST and destructive actions bypass the local TTL.
- Web logout revokes a persisted session id, cross-site GET can no longer log a user out, and unauthorized/nonexistent recording ids return indistinguishable responses.
- Off-site backups exclude cookie secrets and web/MCP session registries, preventing a leaked or restored archive from forging or resurrecting access state.

## [1.3.0] — 2026-07-07

### Added
- **Unlimited retention** — `RETENTION_DAYS=0` turns expiry off entirely (audio AND text; unlimited audio forces unlimited text). Expiry is now answered by the *current* config, not by the death date stored in each recording — flipping to unlimited retroactively saves existing recordings. `TEXT_RETENTION_DAYS=0` keeps text forever while audio still expires.
- **Recordings manager (`/gravacoes` v2)** — the web index went from "list" to "management": totals header (count, audio bytes on disk, free disk — disk info visible **only to `OWNER_IDS`**), sort by recent/oldest/largest (largest is owner-only), enriched cards (who started, notes count, relative age, per-recording disk size for the owner) and inline actions for whoever can delete.
- **"Free up space" action** — deletes only the audio (tracks + cache) and keeps transcript, minutes and notes; the perfect pair for unlimited retention (the memory stays, the gigabytes come back). Guarded like delete (initiator/admin, blocked while live/downloading/transcribing, idempotent) — new `POST /rec/:id/liberar-audio`.
- **AssemblyAI Universal-3.5-Pro prompting** — recordings transcribed with the new model now send a contextual `prompt` (`TRANSCRIBE_PROMPT`) and per-recording `keyterms_prompt`: the exact names of everyone in the call (speaking or muted) plus server/channel and the optional fixed team vocabulary `TRANSCRIBE_KEYTERMS` — proper spelling of names and jargon in the transcript, minutes and `/ask`. Gracefully degrades (retries without extras) if the API routes to a model without support.

### Changed
- Retention copy across DM/panel/help/page/landing/README is conditional: unlimited mode says "kept until someone deletes it" instead of promising an expiry that will never come.
- Deleting from the index returns to the index (with a confirmation flash) instead of a dead-end page.

## [1.2.0] — 2026-07-06

### Added
- **Web recordings index with full-text search** — `/gravacoes` on the web (Discord login) lists everything you can access across servers, with a channel filter and full-text search over transcripts, minutes and notes; results deep-link to the exact minute. The Discord `/recordings` command now links to it.
- **`/ask` (`/perguntar`)** — ask your meetings right inside Discord: the AI answers (ephemeral, only you see it) using only the transcripts *you* can access, with `[hh:mm:ss]` citations linking to the exact moment. Optional `days:` window (default 30). Requires AI minutes enabled (OpenRouter or Groq key).
- **Minutes summary posted to Discord** — when the minutes are ready, the bot posts an embed with summary, decisions and action items straight to Discord (no login needed), alongside the link.
- **`/config minutes-channel` (`/config ata-canal`)** — admins pick the text channel where the minutes summary is posted; without it, it goes to the voice channel's chat. `/config view` shows the current state.
- **📌 "Mark moment" button** on the live recording panel — stamps the current timestamp with a single click, no typing (saved as a "📌 moment marked" note).
- **Tiered retention** — `RETENTION_DAYS` (default 7) now expires only the **audio**; transcript + minutes + notes live for `TEXT_RETENTION_DAYS` (default 90, never below `RETENTION_DAYS`). The page shows "audio expired" and keeps all the text; search, `/ask` and MCP keep working.
- **Operator minutes webhook** — `MINUTES_WEBHOOK_URL` receives a POST JSON `{event:'minutes.ready', recordingId, url, guildName, channelName, startedAt, endedAt, participants, minutes}` for every finished minutes (self-hosted integrations: n8n → Notion/Jira/etc). Env-only by design — never settable via Discord, to avoid SSRF.

### Changed
- **Recording page redesign** — sticky player with 1×/1.5×/2× speed, transcript grouped by speaker with per-speaker colors, in-transcript search/filter, karaoke-style follow-along, clickable time bar, and one-click copy of action items.
- Error messages shown to users are humanized (no more raw provider/stack errors).
- Audio cooking (mix/downloads) now runs at lower CPU priority (`nice`) and respects the disk guard.

### Fixed
- Partial transcriptions no longer disappear — partial results always stay visible while missing tracks are retried.
- Event anti-spam — join/leave floods no longer spam the live panel timeline.
- VAD now splits speech segments longer than 20 minutes (avoids provider upload limits on long monologues).
- Recordings stuck in an error state are recovered on boot.
- `/status` now reports the correct voice room.

## [1.1.0] — 2026-07-06

### Added
- **Real VAD (voice activity detection)** — speech segments are normally sent to the transcription API after silence-padded tracks are trimmed with ffmpeg `silencedetect`; fixed chunks are the safety fallback when detection fails. Cuts cost/quota dramatically and adds a post-filter for known hallucinated phrases and repetition loops.
- **AssemblyAI transcription provider** (`TRANSCRIBE_PROVIDER=assemblyai`, model `universal`) — top-3 for pt-BR; automatically falls back to Groq Whisper when a `GROQ_API_KEY` is present.
- **OpenRouter provider for AI minutes** (`OPENROUTER_API_KEY`, `MINUTES_PROVIDER`, default model `google/gemini-2.5-flash`) — huge context window, no more HTTP 413 on long calls; Groq path now uses map-reduce with rate-limit-aware pacing.
- **Call presence** — everyone in the voice channel is registered (`meta.presence`), even if muted the whole time: they get access to the recording, show up on the page ("also in the call"), and the timeline logs joins/leaves.
- **Wall-clock times on the timeline** — events and notes now show the real time of day (in the viewer's timezone) next to the relative offset.
- **Partial transcription state** — when the provider rate-limits mid-job, finished tracks are delivered, missing ones are retried automatically (per-track resume, no re-spending quota), and the page/Discord say exactly what is missing.
- `TRANSCRIBE_PROMPT` (context prompt for Whisper) and `temperature: 0` for less hallucination and better jargon spelling.

### Changed
- Groq default transcription model: `whisper-large-v3-turbo` → `whisper-large-v3` (better pt-BR).
- Transcription requests now wait out provider `429`s (Retry-After / "try again in Xm" aware) instead of failing the track.
- The audio mix is **pre-cooked** right after a recording ends — the player no longer takes minutes to start on first click.
- First-speech timeline event reworded ("spoke for the first time"); channel join/leave are their own events.

### Fixed
- Transcription no longer reports "done" when tracks were skipped by rate limits (the cause of "only 2 of 5 people transcribed").
- Meeting minutes no longer fail with `HTTP 413` on long calls.
- Muted participants no longer lose access to recordings of calls they attended.

## [1.0.0] — 2026-07-04

First public release.

### Added
- **Multi-track recording** — one separate, sample-aligned FLAC track per speaker.
- **Automatic transcription** with exact speaker attribution (no AI diarization), pluggable engine: Groq, OpenAI, Gemini, or a local command (faster-whisper / whisper.cpp).
- **AI meeting minutes** — summary, decisions, action items (with owner/due), timestamped topics, and a per-participant breakdown.
- **Recording web page** (Discord OAuth login) with audio player, clickable timestamps, and downloads: MP3, FLAC, single mix, and an Audacity project.
- **Access control** — only call participants, people who can see the channel, the initiator, or server admins can open a recording.
- **Live panel** in the voice channel chat with Stop / Add note buttons and a `[RECORDING]` nickname indicator.
- **Timestamped notes** (`/note` and panel button).
- **Auto-record** — starts on its own when people join a configured channel and stops when it empties.
- **Interactive onboarding** — `/help` with per-topic buttons; DMing the bot also replies with the guide.
- Bilingual (pt-BR / English), HTTPS via Cloudflare Tunnel, silence warnings, auto-stop, retention/expiry, crash recovery, and graceful shutdown.

[Unreleased]: https://github.com/resolvicomai/kassinao/compare/v1.4.17...HEAD
[1.4.17]: https://github.com/resolvicomai/kassinao/compare/v1.4.16...v1.4.17
[1.4.16]: https://github.com/resolvicomai/kassinao/compare/v1.4.15...v1.4.16
[1.4.15]: https://github.com/resolvicomai/kassinao/compare/v1.4.14...v1.4.15
[1.4.14]: https://github.com/resolvicomai/kassinao/compare/v1.4.13...v1.4.14
[1.4.13]: https://github.com/resolvicomai/kassinao/compare/v1.4.12...v1.4.13
[1.4.12]: https://github.com/resolvicomai/kassinao/compare/v1.4.11...v1.4.12
[1.4.11]: https://github.com/resolvicomai/kassinao/compare/v1.4.10...v1.4.11
[1.4.10]: https://github.com/resolvicomai/kassinao/compare/v1.4.9...v1.4.10
[1.4.9]: https://github.com/resolvicomai/kassinao/compare/v1.4.8...v1.4.9
[1.4.8]: https://github.com/resolvicomai/kassinao/compare/v1.4.7...v1.4.8
[1.4.7]: https://github.com/resolvicomai/kassinao/compare/v1.4.6...v1.4.7
[1.4.6]: https://github.com/resolvicomai/kassinao/compare/v1.4.5...v1.4.6
[1.4.5]: https://github.com/resolvicomai/kassinao/compare/v1.4.4...v1.4.5
[1.4.4]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.4
[1.4.3]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.3
[1.4.2]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.2
[1.4.1]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.1
[1.4.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.4.0
[1.3.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.3.0
[1.2.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.2.0
[1.1.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.1.0
[1.0.0]: https://github.com/resolvicomai/kassinao/releases/tag/v1.0.0
