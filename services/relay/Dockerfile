# Opaque relay: build from the repository root context:
#   docker build -f services/relay/Dockerfile -t locallab-relay .
# The image ships only the packages the relay imports; no runtime secrets are
# baked in (credentials/tickets arrive from connecting peers, never the image).
#
# The install uses the pinned pnpm workspace (packageManager in the root
# package.json, pnpm-lock.yaml, pnpm-workspace.yaml) filtered to the relay's
# dependency closure; npm ci was never viable here (no package-lock.json and
# no npm workspaces, so workspace:* deps could not link).
FROM node:26-slim AS runtime
WORKDIR /app
RUN npm install -g pnpm@8.15.9
# Lockfile inputs first for layer caching: manifests + patchedDependency patches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches/ patches/
COPY services/relay/package.json services/relay/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/service-contracts/package.json packages/service-contracts/package.json
COPY packages/remote/crypto/package.json packages/remote/crypto/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @locallab/relay...
# Sources after install so code edits do not invalidate the dependency layer.
COPY services/relay/ services/relay/
COPY packages/contracts packages/contracts
COPY packages/service-contracts packages/service-contracts
COPY packages/remote/crypto packages/remote/crypto
EXPOSE 8790
ENV RELAY_PORT=8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
# tsx resolves the TS sources and the .js->.ts relative specifiers; plain
# node --experimental-strip-types cannot remap those specifiers.
CMD ["pnpm", "--filter", "@locallab/relay", "exec", "tsx", "src/cli.ts"]
