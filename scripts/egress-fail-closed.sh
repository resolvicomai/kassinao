#!/usr/bin/env bash
# Contém os componentes privados quando o hardening não pode ser aplicado.
# Stop failures não são ignorados: kill é o fallback e o estado final é provado.
set -Eeuo pipefail
umask 077

[ "$(id -u)" -eq 0 ] || { echo 'ERRO: execute como root' >&2; exit 1; }
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
  if declare -p "$name" >/dev/null 2>&1; then
    echo "ERRO: $name não pode vir do ambiente; fail-closed exige o daemon local" >&2
    exit 1
  fi
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
command -v docker >/dev/null 2>&1 || { echo 'ERRO: docker não encontrado' >&2; exit 1; }

if ! containers="$(docker ps -a --format '{{.Names}}')"; then
  echo 'ERRO: não foi possível enumerar containers no daemon local' >&2
  exit 1
fi

status=0
for container in kassinao kassinao-tunnel; do
  grep -Fqx "$container" <<<"$containers" || continue
  if ! docker stop --time 30 "$container" >/dev/null 2>&1; then
    docker kill "$container" >/dev/null 2>&1 || status=1
    # docker kill pode acionar a restart policy. Um segundo stop registra uma
    # parada administrativa e mantém o container desligado até ação explícita.
    docker stop --time 10 "$container" >/dev/null 2>&1 || true
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)"
  if [ "$running" = true ] || [ -z "$running" ]; then
    echo "ERRO: não foi possível provar $container parado" >&2
    status=1
  fi
done

[ "$status" -eq 0 ] || exit 1
echo 'Componentes privados confirmados como parados após falha de egress.'
