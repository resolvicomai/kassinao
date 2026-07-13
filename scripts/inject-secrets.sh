#!/usr/bin/env bash
# Injeta os 3 segredos no .env SEM eles passarem por chat/mensagem.
# Rode este script UMA vez, cole cada valor quando pedido e aperte Enter.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

ENV_FILE=".env"
TMP_FILE=""

cleanup() {
  if [ -n "$TMP_FILE" ]; then
    rm -f -- "$TMP_FILE"
  fi
  unset DTOKEN DSECRET TTOKEN
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  echo "Arquivo .env não encontrado — rode este script dentro da pasta do Kassinão."
  exit 1
fi
if [ ! -O "$ENV_FILE" ]; then
  echo "ERRO: o .env precisa pertencer ao usuário atual antes de receber segredos." >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

read_secret() {
  local prompt="$1" destination="$2" value
  IFS= read -r -s -p "$prompt" value
  printf '\n'
  if [ -z "$value" ]; then
    echo "ERRO: o segredo não pode ficar vazio." >&2
    exit 1
  fi
  printf -v "$destination" '%s' "$value"
}

echo "== Configuração dos segredos do Kassinão =="
echo "(o que você colar aqui NÃO aparece em lugar nenhum além deste servidor)"
echo

read_secret "1) DISCORD_TOKEN (Bot > Token): " DTOKEN
read_secret "2) DISCORD_CLIENT_SECRET (OAuth2 > Client Secret): " DSECRET
read_secret "3) TUNNEL_TOKEN (token do túnel da Cloudflare): " TTOKEN

TMP_FILE="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
awk '
  !/^DISCORD_TOKEN=/ &&
  !/^DISCORD_CLIENT_SECRET=/ &&
  !/^TUNNEL_TOKEN=/
' "$ENV_FILE" > "$TMP_FILE"
printf '%s=%s\n' DISCORD_TOKEN "$DTOKEN" >> "$TMP_FILE"
printf '%s=%s\n' DISCORD_CLIENT_SECRET "$DSECRET" >> "$TMP_FILE"
printf '%s=%s\n' TUNNEL_TOKEN "$TTOKEN" >> "$TMP_FILE"
chmod 600 "$TMP_FILE"
mv -f -- "$TMP_FILE" "$ENV_FILE"
TMP_FILE=""

echo
echo "✅ Segredos gravados no .env com permissão 0600. Pode fechar este terminal."
