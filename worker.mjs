#!/usr/bin/env node
/**
 * ATOMICXR FUSION Cloud processing worker (also runs on an office PC as a fallback).
 *
 * Runs next to a NodeODM node (OpenDroneMap's processing API). It only makes OUTBOUND requests: atomicxr.com
 * hands it FUSION Cloud jobs (small projects whose photos were uploaded online) and short-lived signed URLs,
 * so the machine needs no open ports and no storage credentials. Large projects use FUSION Desktop instead.
 *
 *   loop: claim job → download mapping photos → NodeODM task (init/upload/commit) → poll progress
 *         → download all.zip → package layers → signed uploads → finish (atomicxr.com verifies every file)
 *
 * Config: config.json next to this file (or FUSION_WORKER_CONFIG / env):
 *   { server, token, nodeodm, workDir, workerId, odmPython?, odmPath?, mode? ("cloud" | "office") }
 * Shared engine code: ../fusion-desktop/engine (same packaging/upload FUSION Desktop uses).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageOutputs, publishOutputs, rasterStats, unzip } from "../fusion-desktop/engine/outputs.mjs";
import { apiClient, download, pool, sleep, walk } from "../fusion-desktop/engine/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = process.env.FUSION_WORKER_CONFIG || path.join(here, "config.json");
const cfg = { server: "https://atomicxr.com", nodeodm: "http://127.0.0.1:3001", workDir: path.join(here, "jobs"), workerId: `worker-${process.env.COMPUTERNAME || os.hostname() || "pc"}`, pollSeconds: 30, mode: "office", ...(existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {}) };
const ENV = { token: "FUSION_WORKER_TOKEN", server: "FUSION_SERVER", nodeodm: "FUSION_NODEODM", workDir: "FUSION_WORK_DIR", workerId: "FUSION_WORKER_ID", mode: "FUSION_WORKER_MODE", odmPython: "FUSION_ODM_PYTHON", odmPath: "FUSION_ODM_PATH" };
for (const [k, e] of Object.entries(ENV)) if (process.env[e]) cfg[k] = process.env[e];
if (!cfg.token) throw new Error("No worker token (config.json token or FUSION_WORKER_TOKEN)");

// Some shells set this; it stops .bat files from calling their neighbours (ODM's run.bat → winrun.bat), and NodeODM
// / ODM helpers started from here would inherit it.
delete process.env.NoDefaultCurrentDirectoryInExePath;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const api = apiClient(cfg);

// Inside FUSION Desktop the worker runs as a utility process: tell the app when a job is running (so it can warn
// before quitting or a Windows shutdown), and hand a running job back to the queue when the app asks us to stop.
const parent = process.parentPort ?? null;
let current = null;
const tellParent = (m) => { try { parent?.postMessage(m); } catch {} };
parent?.on("message", async (e) => {
  if (e?.data?.type !== "stop") return;
  if (current) {
    log(`job ${current.id}: stopping (FUSION Desktop closing); it goes back in the queue`);
    await api({ action: "finish", jobId: current.id, ok: false, retryable: true, error: "Interrupted: FUSION Desktop was closed or the PC shut down. It runs again automatically the next time FUSION Desktop starts." }).catch(() => {});
  }
  tellParent({ type: "stopped" });
  process.exit(0);
});

/** NodeODM's POST endpoints read multipart form fields (URL-encoded bodies are silently ignored). */
function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

async function odm(pathname, init = {}) {
  const r = await fetch(`${cfg.nodeodm}${pathname}`, init);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok || j.error) throw new Error(`NodeODM ${pathname}: ${j.error ?? r.status}`);
  return j;
}

async function dirBytes(dir) {
  let t = 0;
  for (const f of await walk(dir)) try { t += statSync(f).size; } catch {}
  return t;
}

// ── one job ──────────────────────────────────────────────────────────────────
async function processJob(job, images, expectBounds) {
  const dir = path.join(cfg.workDir, job.id);
  const imgDir = path.join(dir, "images");
  await mkdir(imgDir, { recursive: true });
  const started = Date.now();
  let canceled = false;
  // Peak memory in use on this machine while the job runs (to size FUSION Cloud limits from real numbers).
  const baseUsed = os.totalmem() - os.freemem();
  let peakUsed = baseUsed;
  const memTimer = setInterval(() => { peakUsed = Math.max(peakUsed, os.totalmem() - os.freemem()); }, 5000);
  const progress = async (p, stage, extra = {}) => {
    const r = await api({ action: "progress", jobId: job.id, progress: p, stage, ...extra }).catch(() => ({}));
    if (r.canceled) canceled = true;
    return !canceled;
  };
  try {
    log(`job ${job.id}: ${images.length} photos, preset ${job.preset}`);
    // Crash recovery: if the mapping engine already has this job's task (running or finished), attach to it
    // instead of starting hours of processing again.
    const name = `atomicxr-${job.id}`;
    const taskFile = path.join(dir, "nodeodm-task.txt");
    let uuid = null;
    if (existsSync(taskFile)) {
      const saved = readFileSync(taskFile, "utf8").trim();
      const i = await odm(`/task/${saved}/info`).catch(() => null);
      if (i && [10, 20, 40].includes(i.status?.code) && i.imagesCount === images.length) uuid = saved;
    }
    if (uuid) {
      log(`job ${job.id}: reusing mapping-engine task ${uuid}`);
      await progress(13, "Resuming in the mapping engine", { log: `NodeODM task ${uuid} (resumed)` });
    } else {
      let done = 0;
      await pool(images, 4, async (im) => {
        await download(im.url, path.join(imgDir, im.name), im.bytes);
        if (++done % 10 === 0 || done === images.length) await progress(Math.round((done / images.length) * 12), `Downloading photos ${done}/${images.length}`);
      });
      if (canceled) return { canceled: true };

      // NodeODM task: options are ODM's own names.
      const options = Object.entries(job.options || {}).map(([k, value]) => ({ name: k, value }));
      const init = await odm("/task/new/init", { method: "POST", body: form({ name, options: JSON.stringify(options), skipPostProcessing: "false" }) });
      uuid = init.uuid;
      await writeFile(taskFile, uuid);
      await progress(13, "Sending photos to the mapping engine", { log: `NodeODM task ${uuid}` });
      const names = (await readdir(imgDir)).filter((n) => !n.endsWith(".part"));
      for (let i = 0; i < names.length; i += 20) {
        const fd = new FormData();
        for (const n of names.slice(i, i + 20)) fd.append("images", new Blob([readFileSync(path.join(imgDir, n))]), n);
        await odm(`/task/new/upload/${uuid}`, { method: "POST", body: fd });
      }
      await odm(`/task/new/commit/${uuid}`, { method: "POST" });
    }

    let info;
    for (;;) {
      await sleep(15_000);
      info = await odm(`/task/${uuid}/info`);
      const code = info.status?.code;
      const out = await odm(`/task/${uuid}/output?line=-40`).catch(() => []);
      await progress(15 + Math.round((info.progress || 0) * 0.7), code === 10 ? "Queued in the mapping engine" : `Processing (${Math.round(info.progress || 0)}%)`, { log: Array.isArray(out) ? out.join("\n") : "" });
      if (canceled) {
        await odm("/task/cancel", { method: "POST", body: form({ uuid }) }).catch(() => {});
        return { canceled: true };
      }
      if (code === 40) break;
      if (code === 30 || code === 50) {
        const tail = await odm(`/task/${uuid}/output?line=-25`).catch(() => []);
        throw Object.assign(new Error(`Mapping engine failed: ${info.status?.errorMessage || (Array.isArray(tail) ? tail.slice(-6).join(" | ") : "unknown")}`), { retryable: false });
      }
    }

    await progress(86, "Downloading results");
    const zip = path.join(dir, "all.zip");
    await rm(zip, { force: true }); // never reuse results from an earlier attempt
    await download(`${cfg.nodeodm}/task/${uuid}/download/all.zip`, zip);
    const outDir = path.join(dir, "out");
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await unzip(zip, outDir, log);

    const stats = (f) => rasterStats(f, { python: cfg.odmPython, odmPath: cfg.odmPath, workDir: cfg.workDir, log });
    const { layers, files } = await packageOutputs(outDir, expectBounds, stats);
    const workBytes = await dirBytes(dir);
    await publishOutputs({
      api,
      jobId: job.id,
      layers,
      files,
      log,
      onProgress: (sent, total) => progress(88 + Math.round((sent / total) * 10), `Uploading results ${sent}/${total}`),
      usage: {
        seconds: Math.round((Date.now() - started) / 1000),
        photos: images.length,
        photoBytes: images.reduce((t, im) => t + (im.bytes || 0), 0),
        outputFiles: files.length,
        odmVersion: info?.odmVersion ?? null,
        processingTimeMs: info?.processingTime ?? null,
        runner: cfg.mode,
        workerId: cfg.workerId,
        peakMemGB: +((peakUsed - baseUsed) / 1024 ** 3).toFixed(2),
        workDirGB: +(workBytes / 1024 ** 3).toFixed(2),
        cpus: os.cpus().length,
      },
    });
    log(`job ${job.id}: done, ${layers.length} layers, ${files.length} files (verified by atomicxr.com)`);
    if (!cfg.keepJobFiles) await rm(dir, { recursive: true, force: true }).catch(() => {});
    await odm("/task/remove", { method: "POST", body: form({ uuid }) }).catch(() => {});
    await rm(taskFile, { force: true });
    return { ok: true };
  } finally {
    clearInterval(memTimer);
  }
}

async function main() {
  log(`FUSION worker ${cfg.workerId} (${cfg.mode}) → ${cfg.server}, NodeODM ${cfg.nodeodm}`);
  const info = await odm("/info").catch((e) => ({ error: e.message }));
  log("NodeODM:", JSON.stringify(info));
  for (;;) {
    let claim;
    try {
      claim = await api({ action: "claim", engine: `NodeODM ${info.version ?? "?"} / ODM ${info.engineVersion ?? "?"}` });
    } catch (e) {
      log("claim failed:", e.message);
      await sleep(cfg.pollSeconds * 1000);
      continue;
    }
    if (!claim.job) {
      if (process.argv.includes("--once")) return;
      await sleep(cfg.pollSeconds * 1000);
      continue;
    }
    current = claim.job;
    tellParent({ type: "busy", jobId: claim.job.id, captureId: claim.job.captureId ?? null, at: Date.now() });
    try {
      const r = await processJob(claim.job, claim.images, claim.expectBounds ?? null);
      if (r.canceled) log(`job ${claim.job.id}: canceled`);
    } catch (e) {
      log(`job ${claim.job.id} failed:`, e.message);
      await api({ action: "finish", jobId: claim.job.id, ok: false, error: e.message, retryable: e.retryable !== false }).catch(() => {});
    }
    current = null;
    tellParent({ type: "idle", at: Date.now() });
    if (process.argv.includes("--once")) return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
