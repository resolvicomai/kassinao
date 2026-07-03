#!/usr/bin/env bash
# Injeta os 3 segredos no .env SEM eles passarem por chat/mensagem.
# Rode este script UMA vez, cole cada valor quando pedido e aperte Enter.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Arquivo .env não encontrado — rode este script dentro da pasta do Kassinão."
  exit 1
fi

set_kv() {
  local key="$1" val="$2"
  # remove linha antiga (se houver) e adiciona a nova
  if grep -q "^${key}=" .env; then
    grep -v "^${key}=" .env > .env.tmp && mv .env.tmp .env
  fi
  printf '%s=%s\n' "$key" "$val" >> .env
}

echo "== Configuração dos segredos do Kassinão =="
echo "(o que você colar aqui NÃO aparece em lugar nenhum além deste servidor)"
echo

read -rp "1) DISCORD_TOKEN (Bot > Token): " DTOKEN
read -rp "2) DISCORD_CLIENT_SECRET (OAuth2 > Client Secret): " DSECRET
read -rp "3) TUNNEL_TOKEN (token do túnel da Cloudflare): " TTOKEN

set_kv DISCORD_TOKEN "$DTOKEN"
set_kv DISCORD_CLIENT_SECRET "$DSECRET"
set_kv TUNNEL_TOKEN "$TTOKEN"

echo
echo "✅ Segredos gravados no .env. Pode fechar este terminal."
