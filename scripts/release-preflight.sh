#!/usr/bin/env bash
# Confere, em segundos e só lendo, as pré-condições de release que os workflows
# só recusariam depois de minutos de build. Uso: bash scripts/release-preflight.sh
# (no head de main, com origin atualizado). Sai com 1 na primeira falha e lista
# o que falta.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
ok()   { printf 'ok    %s\n' "$*"; }
bad()  { printf 'FALTA %s\n' "$*"; fail=1; }
info() { printf '      %s\n' "$*"; }

app_version="$(node -p "require('./package.json').version")"
mcp_version="$(node -p "require('./mcp/package.json').version")"
info "app $app_version / conector $mcp_version"

# 1. Versão do app em SemVer e CHANGELOG com a seção preenchida.
if [[ "$app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
  ok "package.json usa SemVer ($app_version)"
else
  bad "package.json não usa SemVer: $app_version"
fi
notes="$(awk -v heading="## [$app_version]" '
  index($0, heading) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found && NF { print }
' CHANGELOG.md)"
if [ -n "$notes" ]; then
  ok "CHANGELOG tem a seção ## [$app_version]"
else
  bad "CHANGELOG.md não tem notas em ## [$app_version] (renomeie [Unreleased])"
fi
if git tag -l "v$app_version" | grep -q .; then
  bad "a tag v$app_version já existe; suba a versão"
else
  ok "tag v$app_version ainda não existe"
fi

# 2. Conector: versão coerente nos seis lugares e mcp/ igual à última tag publicada.
shrink_version="$(node -p "require('./mcp/npm-shrinkwrap.json').version")"
shrink_root_version="$(node -p "require('./mcp/npm-shrinkwrap.json').packages[''].version")"
product_version="$(grep -oE "MCP_PACKAGE_VERSION\s*=\s*'[^']+'" src/productVersions.ts | grep -oE "'[^']+'" | tr -d "'")"
readme_hits="$(grep -c "kassinao-mcp@$mcp_version" mcp/README.md || true)"
if [ "$shrink_version" = "$mcp_version" ] && [ "$shrink_root_version" = "$mcp_version" ] \
  && [ "$product_version" = "$mcp_version" ] && [ "$readme_hits" -ge 1 ]; then
  ok "versão do conector coerente ($mcp_version) em package.json, shrinkwrap, productVersions.ts e README"
else
  bad "versão do conector divergente: package.json=$mcp_version shrinkwrap=$shrink_version/$shrink_root_version productVersions.ts=${product_version:-?} README=${readme_hits}x"
fi

mcp_tag="mcp-v$mcp_version"
if git rev-parse -q --verify "refs/tags/$mcp_tag" >/dev/null 2>&1; then
  if [ "$(git cat-file -t "$mcp_tag")" = tag ]; then
    ok "tag $mcp_tag existe e é anotada"
  else
    bad "tag $mcp_tag existe mas é leve (o workflow exige git tag -a)"
  fi
  if git diff --quiet "$mcp_tag" HEAD -- mcp; then
    ok "mcp/ está igual a $mcp_tag"
  else
    bad "mcp/ mudou depois de $mcp_tag: suba a versão do conector e publique mcp-v<nova> antes do app"
  fi
  if npm view "kassinao-mcp@$mcp_version" version >/dev/null 2>&1; then
    ok "kassinao-mcp@$mcp_version está no npm"
  else
    bad "kassinao-mcp@$mcp_version ainda não está no npm (publique a tag $mcp_tag e espere o workflow)"
  fi
else
  info "tag $mcp_tag ainda não existe: ela precisa ser criada e publicada ANTES da tag v$app_version"
  if npm view "kassinao-mcp@$mcp_version" version >/dev/null 2>&1; then
    bad "kassinao-mcp@$mcp_version já existe no npm sem tag local: versão precisa subir"
  fi
fi

# 3. Head limpo, igual a origin/main, com a conta certa.
if git diff --quiet && git diff --cached --quiet; then
  ok "árvore de trabalho limpa"
else
  bad "há mudanças não commitadas"
fi
if git fetch -q origin main 2>/dev/null; then
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
    ok "HEAD é o head de origin/main"
  else
    bad "HEAD difere de origin/main (a tag precisa apontar para o head exato de main)"
  fi
fi
if command -v gh >/dev/null 2>&1; then
  login="$(gh api /user --jq .login 2>/dev/null || true)"
  if [ "$login" = resolvicomai ]; then
    ok "gh autenticado como $login (única conta autorizada a criar tags de release)"
  else
    bad "gh autenticado como '${login:-?}'; troque para resolvicomai antes do push da tag"
  fi
fi

if [ "$fail" = 0 ]; then
  if git rev-parse -q --verify "refs/tags/$mcp_tag" >/dev/null 2>&1; then
    printf '\nPronto para: git tag -a v%s -m "Kassinão v%s" origin/main && git push origin v%s\n' "$app_version" "$app_version" "$app_version"
  else
    printf '\nPronto para: git tag -a %s (publicar e esperar o npm) e depois git tag -a v%s, nessa ordem.\n' "$mcp_tag" "$app_version"
  fi
else
  printf '\nCorrija os itens FALTA antes de criar qualquer tag.\n'
  exit 1
fi
