/**
 * Shared FUSION engine helpers (used by FUSION Desktop, the FUSION Cloud/office worker and the PC importer).
 * Plain Node (20+), no npm dependencies.
 */
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs fn over items with n in flight. */
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export const typeFor = (f) =>
  ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", tif: "image/tiff", tiff: "image/tiff", glb: "model/gltf-binary", laz: "application/octet-stream", pdf: "application/pdf", json: "application/json", mp4: "video/mp4", mov: "video/quicktime", srt: "text/plain", dng: "image/x-adobe-dng" })[f.split(".").pop().toLowerCase()] ?? "application/octet-stream";

/**
 * atomicxr.com worker API client (x-worker-token). Retries network/5xx errors; a 409 (upload check found
 * missing files) is returned to the caller, not retried.
 */
export function apiClient(cfg) {
  return async function api(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${cfg.server}/api/fusion/worker`, { method: "POST", headers: { "content-type": "application/json", "x-worker-token": cfg.token }, body: JSON.stringify({ workerId: cfg.workerId, mode: cfg.mode, ...body }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409) return { ...j, status: 409 };
        if (r.status === 401) throw Object.assign(new Error("atomicxr.com didn't accept the connection key."), { fatal: true });
        if (r.status >= 400 && r.status < 500) throw Object.assign(new Error(j.error || `server ${r.status}`), { fatal: true });
        if (!r.ok) throw new Error(`server ${r.status}: ${j.error ?? ""}`);
        return j;
      } catch (e) {
        if (e.fatal || attempt >= 4) throw e;
        await sleep(2000 * 2 ** attempt);
      }
    }
  };
}

export async function download(url, file, bytes, headers = undefined) {
  if (existsSync(file) && (!bytes || statSync(file).size === bytes)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, headers ? { headers } : undefined);
      if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(`${file}.part`));
      await rename(`${file}.part`, file);
      if (bytes && statSync(file).size !== bytes) throw new Error(`size mismatch for ${path.basename(file)}`);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(3000 * (attempt + 1));
    }
  }
}

/** PUT a file (path) or buffer to a signed URL, with retries. Returns bytes sent. */
export async function upload(url, body, type) {
  for (let attempt = 0; ; attempt++) {
    try {
      const isPath = typeof body === "string";
      const size = isPath ? statSync(body).size : body.length;
      const r = await fetch(url, { method: "PUT", body: isPath ? Readable.toWeb(createReadStream(body)) : body, duplex: "half", headers: { "content-length": String(size), "content-type": type ?? (isPath ? typeFor(body) : "application/octet-stream") } });
      if (!r.ok) throw new Error(`upload ${r.status} ${(await r.text()).slice(0, 120)}`);
      return size;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}
