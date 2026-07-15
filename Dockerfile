# --- build ---
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ musl-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY native/no-dump-exec.c ./native/no-dump-exec.c
# Launcher estático sela as defesas preservadas por execve. A biblioteca roda
# depois de cada exec dinâmico e reaplica PR_SET_DUMPABLE antes de main().
COPY native/no-dump-preload.c ./native/no-dump-preload.c
RUN musl-gcc -std=c11 -Os -Wall -Wextra -Werror -static -s \
      -o /usr/local/bin/kassinao-no-dump native/no-dump-exec.c \
    && cc -std=c11 -Os -Wall -Wextra -Werror -fPIC -shared \
      -o /usr/local/lib/libkassinao-no-dump.so native/no-dump-preload.c \
    && chmod 0555 /usr/local/bin/kassinao-no-dump \
    && chmod 0444 /usr/local/lib/libkassinao-no-dump.so \
    && /usr/local/bin/kassinao-no-dump -- /bin/sh -c \
      '/usr/local/bin/kassinao-no-dump --check-preserved'
COPY package*.json ./
# Instala o lockfile sem executar hooks de dependências. Depois recompila somente
# @discordjs/opus: seu C/C++ vem no tarball assinado do npm, sem baixar prebuild.
RUN npm ci --omit=peer --ignore-scripts \
    && npm_config_build_from_source=true npm rebuild @discordjs/opus \
    && node -e "require('@discordjs/opus')"
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=peer --ignore-scripts \
    && test ! -e node_modules/ffmpeg-static

# --- runtime ---
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf
WORKDIR /app
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1

# Imagem customizada opcional (TRANSCRIBE_PROVIDER=command): o operador pode
# compilar com --build-arg LOCAL_TRANSCRIBE=1 para incluir Python +
# faster-whisper. A imagem publicada pelo projeto mantém o padrão 0.
COPY requirements-whisper.txt ./
ARG LOCAL_TRANSCRIBE=0
RUN if [ "$LOCAL_TRANSCRIBE" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
      pip3 install --break-system-packages --no-cache-dir --require-hashes \
        --only-binary=:all: -r requirements-whisper.txt && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# ffmpeg e tini vêm dos repositórios Debian assinados. Não usamos ffmpeg-static:
# seu postinstall baixa um executável fora do tarball verificado do npm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*

# A aplicação em produção executa somente `node`. Gerenciadores de pacote
# pertencem ao estágio de build; removê-los do runtime reduz a superfície e
# evita carregar árvores globais que não participam da execução do Kassinão.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

RUN mkdir -p /app/recordings /app/state /app/auth /app/data /home/node/.cache \
    && chown -R node:node /app /home/node/.cache

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --from=build /usr/local/bin/kassinao-no-dump /usr/local/bin/kassinao-no-dump
COPY --from=build /usr/local/lib/libkassinao-no-dump.so /usr/local/lib/libkassinao-no-dump.so
COPY --chown=node:node package.json ./
# Runtime recebe somente o adapter local de transcrição. Scripts de deploy,
# backup, auditoria e preview ficam no kit operacional, nunca dentro do app.
COPY --chown=node:node scripts/transcribe-local.py ./scripts/transcribe-local.py
COPY --chown=node:node docs ./docs
EXPOSE 8080
STOPSIGNAL SIGTERM
USER node
# Prova em cada plataforma que o constructor pós-exec rodou dentro do Node e
# que filtro/limites sobreviveram. Falha antes de publicar uma imagem quebrada.
RUN /usr/local/bin/kassinao-no-dump --preload /usr/local/lib/libkassinao-no-dump.so -- node -e \
  "const{readFileSync}=require('node:fs');if(process.env.KASSINAO_NO_DUMP_ACTIVE!==('prctl-v1:'+process.pid)||parseInt(readFileSync('/proc/self/coredump_filter','utf8'),16)!==0)process.exit(1)"
# O launcher vem antes do PID 1; o constructor protege tini, Node e filhos
# dinâmicos depois do reset de dumpable feito por cada execve.
ENTRYPOINT ["/usr/local/bin/kassinao-no-dump", "--preload", "/usr/local/lib/libkassinao-no-dump.so", "--", "/usr/bin/tini", "--"]
CMD ["/usr/local/bin/node", "dist/index.js"]
