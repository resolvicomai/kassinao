# Publicar uma versão do Kassinão

Os workflows de release verificam sete pré-condições e recusam a tag quando uma falha.
Este documento coloca todas no mesmo lugar, na ordem em que precisam ser atendidas.
`scripts/release-preflight.sh` confere as que dá para conferir localmente, em segundos,
antes de criar qualquer tag.

## Antes de tudo: o conector MCP

O app só publica se a pasta `mcp/` estiver byte a byte igual à última tag `mcp-v*` já
publicada no npm com attestation. Qualquer mudança em `mcp/` (inclusive um bump de
dependência) exige uma release nova do conector ANTES da release do app.

O conector tem a versão em seis lugares que precisam bater: `mcp/package.json`,
`mcp/npm-shrinkwrap.json` (dois campos), `src/productVersions.ts` e quatro linhas de
`mcp/README.md`. `tests/product-versions.test.ts` falha se algum ficar para trás.

## Sequência

1. Uma única PR de release em `main` com: o bump do conector (se `mcp/` mudou), o bump de
   `package.json` do app, e o CHANGELOG com `## [Unreleased]` renomeado para
   `## [X.Y.Z] — AAAA-MM-DD` (e um `## [Unreleased]` vazio recriado acima).
2. Rode `bash scripts/release-preflight.sh` no head de `main` depois do merge.
3. Se `mcp/` mudou, crie a tag anotada do conector no head exato de `main` e espere o
   workflow "Publish MCP" terminar e `npm view kassinao-mcp@X.Y.Z version` responder:

   ```bash
   git tag -a mcp-vX.Y.Z -m "Kassinao MCP vX.Y.Z" origin/main
   git push origin mcp-vX.Y.Z
   ```

4. Crie a tag anotada do app no MESMO head e envie:

   ```bash
   git tag -a vX.Y.Z -m "Kassinão vX.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

5. Não mescle nada em `main` até "Publish app image" terminar (uns 35 minutos). O workflow
   exige que a tag aponte para o head de `origin/main` no momento do run.
6. Confira `gh release view vX.Y.Z` e o digest da imagem em `ghcr.io/resolvicomai/kassinao`.

## O que os workflows exigem

- Variáveis do repositório `IMMUTABLE_RELEASES_ENABLED`, `RELEASE_TAG_RULESET_ENABLED` e
  `MCP_RELEASE_TAG_RULESET_ENABLED` em `true` (já estão).
- Criação de tags `v*` e `mcp-v*` restrita à conta do mantenedor (ruleset
  `restrict-release-tag-creation`). Um push feito pela conta errada é recusado.
- Tags anotadas (`git tag -a`), tanto para o app quanto para o conector.
- `package.json` igual à tag (`vX.Y.Z` = `X.Y.Z`).
- Seção `## [X.Y.Z]` do CHANGELOG não vazia. A checagem roda no primeiro step, antes do
  build, para uma release sem notas não queimar o número da versão (a tag é imutável).
- Para o app: `mcp-v<versão de mcp/package.json>` publicada no npm com attestation, e
  `mcp/` inalterado desde aquela tag.

## Depois

A imagem publicada só chega à produção com um deploy explícito (ver README, seção de
deploy). Nada acontece na VPS por causa da tag.
