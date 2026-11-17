# Frameo-clone WebRTC signalling server.
# Small, non-root, single dependency ("ws"). Nothing is built or transpiled.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    BIND_ADDR=0.0.0.0 \
    PUBLIC_DIR=/app/public \
    ROSTER_PATH=/config/roster.json \
    ADMINS_PATH=/config/admins.json \
    CALL_LOG_PATH=/data/calls.jsonl \
    SESSION_STORE_PATH=/data/sessions.json \
    UPLOAD_TMP_DIR=/data/uploads-tmp

WORKDIR /app

# Install dependencies first so this layer is cached across code edits.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Application code. Every module the server requires must be listed here — a missing file is
# a container that crash-loops on `Cannot find module`, which is a very bad 03:00 surprise.
#   server.js       HTTP + WebSocket + the auth gate
#   auth.js         sessions, admin accounts, rate limiting, CSRF, security headers
#   scrypt.js       password hashing, shared with the CLI
#   admin.js        /api/admin/* routes
#   immich.js       Immich v3 client: list / upload / album membership / delete
#   multipart.js    streaming multipart parser (no dependency, no buffering)
#   ice.js          ICE / TURN credential minting
#   hash-password.js + tools/  the deployer's password-hash CLI
COPY server.js auth.js scrypt.js admin.js immich.js multipart.js ice.js weather.js hash-password.js ./
COPY tools ./tools

# Runtime directories. The image ships an empty ./public so the server starts even before the
# client bundle is mounted; compose is expected to bind-mount the real client over it.
# /data/uploads-tmp is where an in-flight photo upload is streamed to disk before it is
# forwarded to Immich, so it must exist and be writable by uid 1000.
RUN mkdir -p /app/public /config /data /data/uploads-tmp \
    && chown -R node:node /app /data

# node:alpine already provides the unprivileged "node" user (uid 1000).
USER node

EXPOSE 8080

# Uses the same health endpoint the operator uses. No extra tools installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
