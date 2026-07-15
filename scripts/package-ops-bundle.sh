#!/usr/bin/env bash
# Monta o kit operacional sem source, Git ou credenciais. Executado na release
# depois que a imagem existe, para gravar no template o digest OCI publicado.
set -euo pipefail
umask 022

TAG="${1:?uso: package-ops-bundle.sh vX.Y.Z DIRETORIO_SAIDA image@sha256:digest}"
OUTPUT_DIR="${2:?diretório de saída obrigatório}"
IMAGE="${3:?imagem por digest obrigatória}"
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
  "$DEST/deploy/tmpfiles.d" "$OUTPUT_DIR"
install -m 0644 "$ROOT/docker-compose.yml" "$DEST/docker-compose.yml"
install -m 0644 "$ROOT/deploy/runtime/compose.env.example" "$DEST/compose.env.example"
install -m 0600 "$ROOT/deploy/runtime/app.env.example" "$DEST/app.env.example"
install -m 0644 "$ROOT/SECURITY.md" "$ROOT/LICENSE" "$DEST/"
install -m 0755 \
  "$ROOT/scripts/deploy-release.sh" \
  "$ROOT/scripts/inject-secrets.sh" \
  "$ROOT/scripts/backup.sh" \
  "$ROOT/scripts/backup-retention.sh" \
  "$ROOT/scripts/health-watch.sh" \
  "$ROOT/scripts/prepare-storage.sh" \
  "$ROOT/scripts/verify-storage-encryption.sh" \
  "$ROOT/scripts/harden-docker-egress.sh" \
  "$ROOT/scripts/egress-fail-closed.sh" \
  "$ROOT/scripts/install-host-controls.sh" \
  "$ROOT/scripts/uninstall-host-controls.sh" \
  "$ROOT/scripts/audit-vps-security.sh" \
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
