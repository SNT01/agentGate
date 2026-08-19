# AgentGate token broker + optional admin dashboard.
#
# The broker itself has zero runtime dependencies — the final stage below
# is just Node plus the source, small, fast to build, and nothing to audit
# but our own code. The dashboard (agentgate/ui) is a React/Vite project
# with build-time-only dependencies; it is compiled in an isolated stage so
# its node_modules never reaches the runtime image.

FROM node:20-alpine AS ui-build
WORKDIR /ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci
COPY ui/ ./
RUN npm run build
# Output lands at /src/ui/dist per ui/vite.config.js's outDir; copied below.

FROM node:20-alpine
WORKDIR /app

# Copy only what the broker needs at runtime.
COPY package.json ./
COPY src ./src
COPY --from=ui-build /src/ui/dist ./src/ui/dist

# The GitHub App token exchange is the one optional dependency, kept out of
# package.json so the default image has nothing to audit but our own code.
# Build with `--build-arg WITH_GITHUB_APP=1` for deployments that mint real
# GitHub credentials; without it the broker issues AgentGate session tokens
# only. The AGENTGATE_GITHUB_* variables are supplied at run time (`-e`), and
# the private key is mounted, never baked into a layer.
ARG WITH_GITHUB_APP=0
RUN if [ "$WITH_GITHUB_APP" = "1" ]; then npm install --no-save --no-package-lock @octokit/auth-app; fi

# Run as a non-root user. The data directory holds the organisation's root
# signing key, so it is owned by that user and nothing else can read it.
RUN addgroup -S agentgate && adduser -S agentgate -G agentgate \
    && mkdir -p /data && chown -R agentgate:agentgate /data /app
USER agentgate

# Binding to all interfaces is required inside a container — the published
# port, not the bind address, is the real network boundary here — so the
# public-bind confirmation is set deliberately. Terminating TLS in front of
# this container remains the operator's responsibility.
ENV NODE_ENV=production \
    AGENTGATE_DATA_DIR=/data \
    AGENTGATE_BROKER_HOST=0.0.0.0 \
    AGENTGATE_ALLOW_PUBLIC_BIND=1 \
    AGENTGATE_BROKER_PORT=4790

# Mount a volume here — losing it means losing the registry root key.
VOLUME ["/data"]

EXPOSE 4790

# The port comes from the environment: hardcoding it meant overriding
# AGENTGATE_BROKER_PORT at runtime left the healthcheck probing a port nothing
# listened on, and the container reported itself unhealthy while working fine.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.AGENTGATE_BROKER_PORT||4790;require('http').get('http://127.0.0.1:'+p+'/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/broker/server.js"]
