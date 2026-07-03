# --- build ---
FROM node:22-bookworm-slim AS build
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
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# Transcrição local (TRANSCRIBE_PROVIDER=command): build com --build-arg LOCAL_TRANSCRIBE=1
# para instalar Python + faster-whisper na imagem. Padrão 0 (providers de API só precisam do Node).
ARG LOCAL_TRANSCRIBE=0
RUN if [ "$LOCAL_TRANSCRIBE" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
      pip3 install --break-system-packages --no-cache-dir faster-whisper && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# tini como init: garante que o SIGTERM do 'docker stop' chegue ao Node (PID 1
# sem init ignora SIGTERM), permitindo o shutdown gracioso das gravações.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
