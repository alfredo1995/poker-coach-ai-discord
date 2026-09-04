# =============================================================================
# Estágio 1 — build: instala TODAS as dependências e compila o TypeScript
# =============================================================================
FROM node:22-alpine AS build

WORKDIR /app

# Copiar os manifests antes do código aproveita o cache de camadas: enquanto
# package*.json não mudar, o npm ci não roda de novo.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# =============================================================================
# Estágio 2 — deps: apenas as dependências de produção
# =============================================================================
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


# =============================================================================
# Estágio 3 — runtime: imagem final, sem TypeScript nem devDependencies
# =============================================================================
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# A imagem oficial já traz o usuário sem privilégios `node` (uid 1000).
COPY --chown=node:node --from=deps  /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node

# O bot não expõe portas: fala com o Discord por WebSocket de saída.
# Healthcheck: o processo principal precisa estar vivo.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD pgrep -f "node dist/bot.js" > /dev/null || exit 1

# Forma exec: o Node vira PID 1 e recebe o SIGTERM do `docker stop`
# diretamente, acionando o encerramento limpo implementado em bot.ts.
CMD ["node", "dist/bot.js"]
