# --- build ---
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
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

RUN mkdir -p /app/recordings /app/state /app/auth /app/data /home/node/.cache \
    && chown -R node:node /app /home/node/.cache

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
# Runtime recebe somente o adapter local de transcrição. Scripts de deploy,
# backup, auditoria e preview ficam no kit operacional, nunca dentro do app.
COPY --chown=node:node scripts/transcribe-local.py ./scripts/transcribe-local.py
COPY --chown=node:node docs ./docs
EXPOSE 8080
STOPSIGNAL SIGTERM
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
