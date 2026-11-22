# ATOMICXR FUSION Cloud processing container (Bunny Magic Containers).
# = the official OpenDroneMap NodeODM 3.6.2 image (same engine version as FUSION Desktop)
# + the FUSION worker, which only makes outbound requests to atomicxr.com (no open ports needed).
# Built by GitHub Actions (.github/workflows/build.yml) and published to ghcr.io/xcelerated1/fusion-cloud.
# Run:  docker run -e FUSION_WORKER_TOKEN=… -e FUSION_WORKER_ID=bunny-cloud-1 fusion-cloud:3.6.2
FROM opendronemap/nodeodm:3.6.2

# The worker needs Node 20 (fetch/FormData); NodeODM keeps its own Node. Checked against nodejs.org's SHASUMS.
ARG NODE_VERSION=20.18.3
RUN set -eux; \
    (command -v curl && command -v xz) || (apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates && rm -rf /var/lib/apt/lists/*); \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/node20; tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt/node20 --strip-components=1; \
    rm -f node-v* SHASUMS256.txt

WORKDIR /fusion
COPY engine/util.mjs engine/outputs.mjs ./fusion-desktop/engine/
COPY worker.mjs ./fusion-worker/worker.mjs
COPY cloud-entrypoint.sh ./entrypoint.sh

ENV FUSION_WORKER_MODE=cloud \
    FUSION_SERVER=https://atomicxr.com \
    FUSION_NODEODM=http://127.0.0.1:3000 \
    FUSION_WORK_DIR=/var/fusion/jobs \
    FUSION_ODM_PYTHON=/usr/bin/python3

ENTRYPOINT ["/bin/bash", "/fusion/entrypoint.sh"]
