#!/usr/bin/env bash
# Monta o kit operacional sem checkout Git, código-fonte da aplicação ou
# credenciais. O kit contém somente controles operacionais públicos selados,
# templates sem segredos e runtimes nativos, e grava o digest OCI publicado.
set -euo pipefail
umask 022

TAG="${1:?uso: package-ops-bundle.sh vX.Y.Z DIRETORIO_SAIDA image@sha256:digest DIRETORIO_RUNTIME_NATIVO}"
OUTPUT_DIR="${2:?diretório de saída obrigatório}"
IMAGE="${3:?imagem por digest obrigatória}"
NATIVE_RUNTIME_DIR="${4:?diretório com runtime/linux-amd64 e runtime/linux-arm64 obrigatório}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || {
  echo "tag de release inválida: $TAG" >&2
  exit 1
}
[[ "$IMAGE" =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] || {
  echo "imagem precisa usar @sha256:<64 hex>" >&2
  exit 1
}

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
VERSION="${TAG#v}"
BUNDLE="kassinao-ops-$TAG"
STAGE="$(mktemp -d)"
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT

DEST="$STAGE/$BUNDLE"
install -d -m 0700 "$DEST"
install -d -m 0755 \
  "$DEST/scripts" "$DEST/deploy/systemd" "$DEST/deploy/systemd/docker.service.d" \
  "$DEST/deploy/tmpfiles.d" "$DEST/deploy/docker-client" \
  "$DEST/runtime/linux-amd64" "$DEST/runtime/linux-arm64" "$OUTPUT_DIR"

validate_native_artifact() {
  local file="$1" architecture="$2" kind="$3"
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%h' "$file" 2>/dev/null || stat -f '%l' "$file")" = 1 ] || {
    echo "artefato nativo ausente, irregular ou com hardlink: $file" >&2
    exit 1
  }
  python3 - "$file" "$architecture" "$kind" <<'PY'
import pathlib
import struct
import sys

path = pathlib.Path(sys.argv[1])
architecture = sys.argv[2]
kind = sys.argv[3]
data = path.read_bytes()
if len(data) < 64 or data[:4] != b'\x7fELF' or data[4:7] != b'\x02\x01\x01':
    raise SystemExit(f'{path}: ELF64 little-endian inválido')
elf_type, machine = struct.unpack_from('<HH', data, 16)
expected_machine = {'amd64': 62, 'arm64': 183}[architecture]
if machine != expected_machine:
    raise SystemExit(f'{path}: arquitetura ELF divergente')
if kind == 'preload' and elf_type != 3:
    raise SystemExit(f'{path}: preload não é ELF shared object')
if kind == 'launcher':
    if elf_type not in (2, 3):
        raise SystemExit(f'{path}: launcher não é ELF executável')
    program_offset = struct.unpack_from('<Q', data, 32)[0]
    program_entry_size, program_count = struct.unpack_from('<HH', data, 54)
    if program_count and (program_entry_size < 56 or program_offset + program_entry_size * program_count > len(data)):
        raise SystemExit(f'{path}: program headers ELF inválidos')
    for index in range(program_count):
        program_type = struct.unpack_from('<I', data, program_offset + index * program_entry_size)[0]
        if program_type == 3:
            raise SystemExit(f'{path}: launcher precisa ser estático, sem PT_INTERP')
PY
}

for architecture in amd64 arm64; do
  source_dir="$NATIVE_RUNTIME_DIR/linux-$architecture"
  launcher="$source_dir/kassinao-no-dump"
  preload="$source_dir/libkassinao-no-dump.so"
  validate_native_artifact "$launcher" "$architecture" launcher
  validate_native_artifact "$preload" "$architecture" preload
  install -m 0555 "$launcher" "$DEST/runtime/linux-$architecture/kassinao-no-dump"
  install -m 0444 "$preload" "$DEST/runtime/linux-$architecture/libkassinao-no-dump.so"
done
install -m 0644 \
  "$ROOT/docker-compose.yml" \
  "$ROOT/docker-compose.shared.yml" \
  "$DEST/"
install -m 0644 "$ROOT/deploy/runtime/compose.env.example" "$DEST/compose.env.example"
install -m 0600 "$ROOT/deploy/runtime/app.env.example" "$DEST/app.env.example"
install -m 0644 "$ROOT/SECURITY.md" "$ROOT/LICENSE" "$DEST/"
install -m 0755 \
  "$ROOT/scripts/deploy-release.sh" \
  "$ROOT/scripts/no-dump-exec.py" \
  "$ROOT/scripts/inject-secrets.sh" \
  "$ROOT/scripts/backup.sh" \
  "$ROOT/scripts/backup-retention.sh" \
  "$ROOT/scripts/health-watch.sh" \
  "$ROOT/scripts/prepare-storage.sh" \
  "$ROOT/scripts/prepare-shared-storage.sh" \
  "$ROOT/scripts/validate-legacy-dedicated-installation.sh" \
  "$ROOT/scripts/remove-legacy-health-watch.sh" \
  "$ROOT/scripts/prepare-legacy-shared-layout.sh" \
  "$ROOT/scripts/migrate-shared-storage.sh" \
  "$ROOT/scripts/check-shared-migration-rollback.sh" \
  "$ROOT/scripts/finalize-shared-migration.sh" \
  "$ROOT/scripts/verify-storage-encryption.sh" \
  "$ROOT/scripts/verify-shared-luks-storage.sh" \
  "$ROOT/scripts/harden-docker-egress.sh" \
  "$ROOT/scripts/egress-fail-closed.sh" \
  "$ROOT/scripts/install-host-controls.sh" \
  "$ROOT/scripts/install-shared-host-controls.sh" \
  "$ROOT/scripts/uninstall-host-controls.sh" \
  "$ROOT/scripts/uninstall-shared-host-controls.sh" \
  "$ROOT/scripts/audit-vps-security.sh" \
  "$ROOT/scripts/audit-shared-vps-security.sh" \
  "$DEST/scripts/"
install -m 0644 \
  "$ROOT/deploy/systemd/kassinao-docker-egress.service" \
  "$ROOT/deploy/systemd/kassinao-egress-fail-closed.service" \
  "$ROOT/deploy/systemd/kassinao-health-watch.service" \
  "$ROOT/deploy/systemd/kassinao-health-watch.timer" \
  "$ROOT/deploy/systemd/kassinao-rollback-clean.service.in" \
  "$ROOT/deploy/systemd/kassinao-rollback-clean.timer" \
  "$DEST/deploy/systemd/"
install -m 0644 \
  "$ROOT/deploy/systemd/docker.service.d/kassinao-egress.conf" \
  "$DEST/deploy/systemd/docker.service.d/"
install -m 0644 "$ROOT/deploy/tmpfiles.d/kassinao.conf" "$DEST/deploy/tmpfiles.d/"
install -m 0644 "$ROOT/deploy/tmpfiles.d/kassinao-rollback.conf.in" "$DEST/deploy/tmpfiles.d/"
install -m 0444 "$ROOT/deploy/docker-client/config.json" "$DEST/deploy/docker-client/config.json"

escaped_image="${IMAGE//&/\\&}"
release_digest="${IMAGE##*@}"
sed -i.bak "s|^KASSINAO_IMAGE=.*$|KASSINAO_IMAGE=$escaped_image|" "$DEST/compose.env.example"
sed -i.bak "s|^KASSINAO_RELEASE_DIGEST=.*$|KASSINAO_RELEASE_DIGEST=$release_digest|" "$DEST/compose.env.example"
rm -f -- "$DEST/compose.env.example.bak"
grep -Fqx "KASSINAO_IMAGE=$IMAGE" "$DEST/compose.env.example"
grep -Fqx "KASSINAO_RELEASE_DIGEST=$release_digest" "$DEST/compose.env.example"

# O deploy verifica este manifesto antes de executar qualquer controle. Env
# preenchido e dados da instância não fazem parte dele.
(
  cd -- "$DEST"
  find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256
)
# O metadata do tar também é público. Normalize tempos e identidade para não
# publicar usuário/grupo da máquina que empacotou manualmente o kit.
find "$DEST" -exec touch -h -t 197001010000 {} +

ARCHIVE="$OUTPUT_DIR/$BUNDLE.tar.gz"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -cf - -C "$STAGE" "$BUNDLE" | gzip -n > "$ARCHIVE"
else
  # bsdtar (macOS): normalize owner/group também no caminho manual.
  COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname root \
    -cf - -C "$STAGE" "$BUNDLE" | gzip -n > "$ARCHIVE"
fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd -- "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")") > "$ARCHIVE.sha256"
else
  (cd -- "$OUTPUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE")") > "$ARCHIVE.sha256"
fi
printf 'Kit operacional %s criado para %s\n' "$ARCHIVE" "$VERSION"
