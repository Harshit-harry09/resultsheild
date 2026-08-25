FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# The backend listens on 3000.
# IMPORTANT: No EXPOSE or port publishing here — Traefik routes to us via the
# internal Docker network. Publishing a host port would prevent scaling past 1
# replica (docker compose would refuse with "port already allocated").
# Only `expose:` in docker-compose.yml is used — that's an internal-only hint.

ENV NODE_ENV=production
ENV PORT=3000

# Health check for Docker itself (separate from Traefik's label-based check)
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
