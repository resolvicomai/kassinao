#!/usr/bin/env bash
# Host-side watchdog: restarts only Kassinão when Docker marks it unhealthy.
set -euo pipefail
umask 077

CONTAINER="${KASSINAO_CONTAINER:-kassinao}"
DOCKER="${DOCKER_BIN:-docker}"
LOCK_FILE="${HEALTH_WATCH_LOCK_FILE:-/run/lock/kassinao-health-watch.lock}"

case "$CONTAINER" in
  '' | *[!A-Za-z0-9_.-]*)
    echo 'nome de contêiner inválido' >&2
    exit 2
    ;;
esac

command -v flock >/dev/null 2>&1 || {
  echo 'flock não instalado' >&2
  exit 1
}
[ ! -L "$LOCK_FILE" ] || {
  echo 'lock não pode ser link simbólico' >&2
  exit 1
}
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

status="$("$DOCKER" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER")"
case "$status" in
  healthy | running | starting | restarting)
    exit 0
    ;;
  unhealthy)
    echo "$(date -Is) reiniciando $CONTAINER: healthcheck unhealthy" >&2
    # Sem --timeout: herda o StopTimeout do contêiner (45s no Compose), em vez
    # de encurtar o shutdown e arriscar SIGKILL durante a finalização do áudio.
    "$DOCKER" restart "$CONTAINER" >/dev/null
    ;;
  *)
    echo "estado inesperado de $CONTAINER: $status" >&2
    exit 1
    ;;
esac
