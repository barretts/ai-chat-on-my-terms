FROM node:22-slim
# Python + coreutils (timeout) for the second language job. No build tools,
# no package managers used at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY worker.mjs run.sh /worker/
RUN chmod 0555 /worker/run.sh /worker/worker.mjs
