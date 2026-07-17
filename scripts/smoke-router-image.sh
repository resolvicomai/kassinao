#!/usr/bin/env bash
set -Eeuo pipefail

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || {
  printf 'usage: smoke-router-image.sh IMAGE RELEASE_DIGEST [PLATFORM]\n' >&2
  exit 64
}

export SMOKE_IMAGE="$1"
export SMOKE_RELEASE_DIGEST="$2"
export SMOKE_PLATFORM="${3:-linux/amd64}"
export SMOKE_DEPLOYMENT_FINGERPRINT=cccccccccccccccccccccccccccccccc

case "$SMOKE_RELEASE_DIGEST" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    printf 'invalid release digest\n' >&2
    exit 64
    ;;
esac

root="$(mktemp -d)"
project="kassinao-router-smoke-$$"
compose="$root/compose.yml"
SMOKE_ROUTER_HOST_PORT="$(python3 - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
    listener.bind(('127.0.0.1', 0))
    print(listener.getsockname()[1])
PY
)"
[[ "$SMOKE_ROUTER_HOST_PORT" =~ ^[1-9][0-9]*$ ]] || {
  printf 'could not reserve a candidate loopback port\n' >&2
  exit 1
}
export SMOKE_ROUTER_HOST_PORT

cleanup() {
  docker compose --project-name "$project" -f "$compose" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$root"
}
trap cleanup EXIT

cat >"$compose" <<'YAML'
services:
  core:
    image: ${SMOKE_IMAGE}
    platform: ${SMOKE_PLATFORM}
    command:
      - /usr/local/bin/node
      - -e
      - |
        const http = require('node:http');
        http.createServer((req, res) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            if (req.url === '/health') {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: true, surface: 'private' }));
              return;
            }
            if (req.url === '/api/echo' && req.method === 'POST') {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({
                body: Buffer.concat(chunks).toString('utf8'),
                forwardedHost: req.headers['x-forwarded-host'],
                forwardedProto: req.headers['x-forwarded-proto'],
              }));
              return;
            }
            res.setHeader('set-cookie', ['core_a=1; Path=/; HttpOnly', 'core_b=2; Path=/; Secure']);
            res.end('core-response');
          });
        }).listen(8082, '0.0.0.0');
    read_only: true
    user: '1000:1000'
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    networks:
      core_link:
        interface_name: core0
        aliases: [kassinao-core]

  public:
    image: ${SMOKE_IMAGE}
    platform: ${SMOKE_PLATFORM}
    command:
      - /usr/local/bin/node
      - -e
      - |
        const http = require('node:http');
        const body = Buffer.from('abcdefghij');
        http.createServer((req, res) => {
          if (req.headers.range === 'bytes=2-5') {
            res.statusCode = 206;
            res.setHeader('content-range', 'bytes 2-5/10');
            res.setHeader('content-length', '4');
            res.end(body.subarray(2, 6));
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, surface: 'public' }));
        }).listen(8081, '0.0.0.0');
    read_only: true
    user: '1000:1000'
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    networks:
      public_link:
        interface_name: public0
        aliases: [kassinao-public]

  router:
    image: ${SMOKE_IMAGE}
    platform: ${SMOKE_PLATFORM}
    command: [/usr/local/bin/node, dist/router.js]
    read_only: true
    user: '1000:1000'
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    ports: ['127.0.0.1:${SMOKE_ROUTER_HOST_PORT}:8080']
    environment:
      NODE_ENV: production
      PORT: '8080'
      WEB_BIND_INTERFACE: edge0
      APP_URL: https://app.example.test
      MCP_URL: https://mcp.example.test
      PUBLIC_URL: https://site.example.test
      DOCS_URL: https://docs.example.test
      KASSINAO_RELEASE_DIGEST: ${SMOKE_RELEASE_DIGEST}
      KASSINAO_DEPLOYMENT_FINGERPRINT: ${SMOKE_DEPLOYMENT_FINGERPRINT}
    networks:
      edge_ingress:
        interface_name: edge0
        aliases: [kassinao]
      core_link:
        interface_name: core0
      public_link:
        interface_name: public0

  probe:
    image: ${SMOKE_IMAGE}
    platform: ${SMOKE_PLATFORM}
    profiles: [probe]
    command: [/usr/local/bin/node, -e, process.exit(0)]
    read_only: true
    user: '1000:1000'
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: [/tmp]
    networks:
      edge_ingress:
        interface_name: edge0

networks:
  edge_ingress:
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
      com.docker.network.bridge.gateway_mode_ipv6: isolated
  core_link:
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
      com.docker.network.bridge.gateway_mode_ipv6: isolated
  public_link:
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
      com.docker.network.bridge.gateway_mode_ipv6: isolated
YAML

dc=(docker compose --project-name "$project" -f "$compose")
"${dc[@]}" up -d --no-build core public router

for _attempt in $(seq 1 30); do
  if "${dc[@]}" --profile probe run --rm --no-deps -T probe /usr/local/bin/node -e \
    "const http=require('node:http');const req=http.request({host:'kassinao',port:8080,path:'/health',headers:{host:'app.example.test'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));process.exit(res.statusCode===200&&body.surface==='private'?0:1)}catch{process.exit(1)}})});req.setTimeout(3000,()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(1));req.end()"
  then
    break
  fi
  [ "$_attempt" -lt 30 ] || {
    "${dc[@]}" logs router core public >&2 || true
    printf 'router topology did not become ready\n' >&2
    exit 1
  }
  sleep 1
done

router_endpoint="$("${dc[@]}" port router 8080)"
expected_router_endpoint="127.0.0.1:$SMOKE_ROUTER_HOST_PORT"
[ "$router_endpoint" = "$expected_router_endpoint" ] || {
  printf 'router host publish is not an exclusive IPv4 loopback port: %s\n' "$router_endpoint" >&2
  exit 1
}
host_body="$root/host-router-health.json"
host_code="$(
  curl --silent --show-error --max-time 10 \
    -H 'Host: app.example.test' \
    -o "$host_body" -w '%{http_code}' \
    "http://$router_endpoint/health"
)"
[ "$host_code" = 200 ] || {
  printf 'router loopback health returned HTTP %s\n' "$host_code" >&2
  exit 1
}
python3 - "$host_body" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as source:
    body = json.load(source)
if not isinstance(body, dict) or body.get('surface') != 'private':
    raise SystemExit(1)
PY

"${dc[@]}" --profile probe run --rm --no-deps -T probe /usr/local/bin/node - <<'NODE'
const assert = require('node:assert/strict');
const http = require('node:http');

function request(path, host, init = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'kassinao',
      port: 8080,
      path,
      method: init.method || 'GET',
      headers: { host, ...(init.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('router smoke request timed out')));
    req.on('error', reject);
    req.end(init.body);
  });
}

async function main() {
  const core = await request('/app', 'app.example.test');
  assert.equal(core.status, 200);
  assert.equal(core.body.toString('utf8'), 'core-response');
  assert.deepEqual(core.headers['set-cookie'], [
    'core_a=1; Path=/; HttpOnly',
    'core_b=2; Path=/; Secure',
  ]);

  const echo = await request('/api/echo', 'mcp.example.test', {
    method: 'POST',
    body: 'streamed-body',
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(echo.status, 200);
  assert.deepEqual(JSON.parse(echo.body.toString('utf8')), {
    body: 'streamed-body',
    forwardedHost: 'mcp.example.test',
    forwardedProto: 'https',
  });

  const range = await request('/asset', 'site.example.test', { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 2-5/10');
  assert.equal(range.body.toString('utf8'), 'cdef');

  assert.equal((await request('/', 'docs.example.test')).status, 200);
  assert.equal((await request('/app', 'site.example.test')).status, 404);
  assert.equal((await request('/', 'unknown.example.test')).status, 421);

  const privacy = await request('/privacy', 'site.example.test');
  assert.equal(privacy.status, 308);
  assert.equal(privacy.headers.location, 'https://app.example.test/privacy');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

"${dc[@]}" --profile probe run --rm --no-deps -T probe /usr/local/bin/node - <<'NODE'
async function mustFail(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
  } catch {
    return;
  }
  throw new Error(`unexpected direct reachability: ${url}`);
}

async function main() {
  await mustFail('http://kassinao-core:8082/health');
  await mustFail('http://kassinao-public:8081/health');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

for service in core public; do
  "${dc[@]}" exec -T "$service" /usr/local/bin/kassinao-no-dump \
    --preload /usr/local/lib/libkassinao-no-dump.so -- /usr/local/bin/node -e \
    "fetch('http://router:8080/health',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1),()=>process.exit(0))"
done

"${dc[@]}" exec -T router /usr/local/bin/kassinao-no-dump \
  --preload /usr/local/lib/libkassinao-no-dump.so -- /usr/local/bin/node -e \
  "fetch('https://example.com',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1),()=>process.exit(0))"

printf 'router_topology_smoke=ok\n'
