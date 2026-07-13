# --- build ---
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf
WORKDIR /app
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1

# Transcrição local (TRANSCRIBE_PROVIDER=command): build com --build-arg LOCAL_TRANSCRIBE=1
# para instalar Python + faster-whisper na imagem. Padrão 0 (providers de API só precisam do Node).
COPY requirements-whisper.txt ./
ARG LOCAL_TRANSCRIBE=0
RUN if [ "$LOCAL_TRANSCRIBE" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
      pip3 install --break-system-packages --no-cache-dir --require-hashes \
        --only-binary=:all: -r requirements-whisper.txt && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# tini como init: garante que o SIGTERM do 'docker stop' chegue ao Node (PID 1
# sem init ignora SIGTERM), permitindo o shutdown gracioso das gravações.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/recordings /home/node/.cache \
    && chown -R node:node /app /home/node/.cache

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs ./docs
EXPOSE 8080
STOPSIGNAL SIGTERM
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
