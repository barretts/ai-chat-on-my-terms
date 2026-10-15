# Opaque relay: build from the repository root context:
#   docker build -f services/relay/Dockerfile -t locallab-relay .
# The image ships only the packages the relay imports; no runtime secrets are
# baked in (credentials/tickets arrive from connecting peers, never the image).
FROM node:26-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/relay/package.json services/relay/package.json
COPY services/relay/tsconfig.json services/relay/tsconfig.json
COPY services/relay/src services/relay/src
COPY packages/contracts packages/contracts
COPY packages/service-contracts packages/service-contracts
COPY packages/remote/crypto packages/remote/crypto
RUN npm ci --omit=dev
EXPOSE 8790
ENV RELAY_PORT=8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "--experimental-strip-types", "services/relay/src/cli.ts"]
