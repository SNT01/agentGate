# AgentGate token broker.
# The core service has no runtime dependencies, so this image is just Node
# plus the source — small, fast to build, and nothing to audit but our own code.
FROM node:20-alpine

WORKDIR /app

# Copy only what the service needs at runtime.
COPY package.json ./
COPY src ./src

# Run as a non-root user. The data directory holds the organisation's root
# signing key, so it is owned by that user and nothing else can read it.
RUN addgroup -S agentgate && adduser -S agentgate -G agentgate \
    && mkdir -p /data && chown -R agentgate:agentgate /data /app
USER agentgate

ENV NODE_ENV=production \
    AGENTGATE_DATA_DIR=/data \
    AGENTGATE_BROKER_HOST=0.0.0.0 \
    AGENTGATE_BROKER_PORT=4790

# Mount a volume here — losing it means losing the registry root key.
VOLUME ["/data"]

EXPOSE 4790

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4790/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/broker/server.js"]
