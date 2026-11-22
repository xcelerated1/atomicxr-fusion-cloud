# ATOMICXR FUSION Cloud container

The processing container for FUSION Cloud on Bunny Magic Containers: the official OpenDroneMap NodeODM 3.6.2 image plus the FUSION worker, which only makes outbound requests to atomicxr.com (no open ports).

Image: `ghcr.io/xcelerated1/fusion-cloud:3.6.2` (built by GitHub Actions on every push to `main`).

Environment:

| Variable | |
|---|---|
| `FUSION_WORKER_TOKEN` | Connection key from atomicxr.com Admin → FUSION → Processing (set as a secret, never in this repo) |
| `FUSION_WORKER_ID` | Optional name shown in Admin, e.g. `bunny-cloud-1` |

Generated from the ATOMICXR monorepo (`apps/fusion-worker`, `apps/fusion-desktop/engine`). Edit there, not here.
