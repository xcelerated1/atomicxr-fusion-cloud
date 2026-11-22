#!/bin/bash
# FUSION Cloud container: start the mapping engine (NodeODM, local only), then the FUSION worker.
# Idle cost is a polling loop every 30 s; processing runs only when atomicxr.com has a FUSION Cloud job.
set -euo pipefail
: "${FUSION_WORKER_TOKEN:?set FUSION_WORKER_TOKEN}"
export FUSION_WORKER_ID="${FUSION_WORKER_ID:-cloud-$(hostname)}"
mkdir -p "$FUSION_WORK_DIR"

cd /var/www
node index.js --port 3000 --parallel_queue_processing 1 --cleanup_tasks_after 60 &
ENGINE=$!
for _ in $(seq 1 90); do
  curl -fs http://127.0.0.1:3000/info >/dev/null && break
  sleep 2
done

# If either process stops, stop the container so the platform restarts it cleanly.
/opt/node20/bin/node /fusion/fusion-worker/worker.mjs &
WORKER=$!
wait -n "$ENGINE" "$WORKER"
exit 1
