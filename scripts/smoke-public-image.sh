#!/usr/bin/env bash
set -Eeuo pipefail

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || {
  printf 'usage: smoke-public-image.sh IMAGE RELEASE_DIGEST [PLATFORM]\n' >&2
  exit 64
}

image="$1"
release_digest="$2"
platform="${3-}"
platform_args=()
[ -z "$platform" ] || platform_args=(--platform "$platform")

container="$(
  docker run -d "${platform_args[@]}" --network none --read-only --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m \
    -e PORT=8081 \
    -e WEB_BIND_ADDRESS=127.0.0.1 \
    -e PUBLIC_URL=http://127.0.0.1:8081 \
    -e DOCS_URL=http://127.0.0.1:8081 \
    -e SOURCE_URL=https://github.com/resolvicomai/kassinao \
    -e "KASSINAO_RELEASE_DIGEST=$release_digest" \
    -e KASSINAO_DEPLOYMENT_FINGERPRINT=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    -e TRUST_PROXY_HOPS=0 \
    -e REPO_PUBLIC=true \
    "$image" /usr/local/bin/node dist/public.js
)"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for attempt in $(seq 1 30); do
  if docker exec "$container" /usr/local/bin/node -e \
    "fetch('http://127.0.0.1:8081/health').then(async response => { const body = await response.json(); process.exit(response.ok && body.surface === 'public' ? 0 : 1) }, () => process.exit(1))"
  then
    exit 0
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
    break
  fi
  sleep 1
done

docker logs "$container" >&2 || true
printf 'Public image entrypoint did not become ready%s\n' "${platform:+ for $platform}" >&2
exit 1
