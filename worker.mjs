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
 *   { server, token, nodeodm, workDir, workerId, odmPython?, odmPath?, mode? ("cloud" | "office"), blender? }
 * With Blender on this computer (config "blender", FUSION_BLENDER, or found under D:/FUSION/Blender) it also takes
 * FUSION 3D Studio jobs: a Blender presentation pass over an existing model (../fusion-desktop/engine/blender).
 * Shared engine code: ../fusion-desktop/engine (same packaging/upload FUSION Desktop uses).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageOutputs, publishOutputs, rasterStats, unzip } from "../fusion-desktop/engine/outputs.mjs";
import { apiClient, download, pool, sleep, walk } from "../fusion-desktop/engine/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = process.env.FUSION_WORKER_CONFIG || path.join(here, "config.json");
const cfg = { server: "https://atomicxr.com", nodeodm: "http://127.0.0.1:3001", workDir: path.join(here, "jobs"), workerId: `worker-${process.env.COMPUTERNAME || os.hostname() || "pc"}`, pollSeconds: 30, mode: "office", ...(existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {}) };
const ENV = { token: "FUSION_WORKER_TOKEN", server: "FUSION_SERVER", nodeodm: "FUSION_NODEODM", workDir: "FUSION_WORK_DIR", workerId: "FUSION_WORKER_ID", mode: "FUSION_WORKER_MODE", odmPython: "FUSION_ODM_PYTHON", odmPath: "FUSION_ODM_PATH", maxPhotos: "FUSION_MAX_PHOTOS", maxGB: "FUSION_MAX_GB", blender: "FUSION_BLENDER", only: "FUSION_ONLY" };
for (const [k, e] of Object.entries(ENV)) if (process.env[e]) cfg[k] = process.env[e];
if (!cfg.token) throw new Error("No worker token (config.json token or FUSION_WORKER_TOKEN)");

// Some shells set this; it stops .bat files from calling their neighbours (ODM's run.bat → winrun.bat), and NodeODM
// / ODM helpers started from here would inherit it.
delete process.env.NoDefaultCurrentDirectoryInExePath;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Blender for FUSION 3D Studio: configured path, or the newest portable install under D:/FUSION/Blender. */
function findBlender() {
  if (cfg.blender) return existsSync(cfg.blender) ? cfg.blender : null;
  if (cfg.mode === "cloud") return null;
  for (const root of ["D:/FUSION/Blender", "C:/FUSION/Blender"]) {
    try {
      const dirs = readdirSync(root).filter((d) => /^blender-/i.test(d)).sort().reverse();
      for (const d of dirs) {
        const exe = path.join(root, d, process.platform === "win32" ? "blender.exe" : "blender");
        if (existsSync(exe)) return exe;
      }
    } catch {}
  }
  return null;
}
const BLENDER = findBlender();
/** Gyroflow for FUSION Video Studio jobs (office PC only; never the cloud container). */
function findGyroflowExe() {
  if (cfg.mode === "cloud") return null;
  if (cfg.gyroflow) return existsSync(cfg.gyroflow) ? cfg.gyroflow : null;
  for (const root of ["D:/FUSION/Gyroflow", "C:/FUSION/Gyroflow"]) {
    try {
      for (const d of readdirSync(root).filter((x) => /^v\d/.test(x)).sort().reverse()) {
        const exe = path.join(root, d, "Gyroflow.exe");
        if (existsSync(exe)) return exe;
      }
    } catch {}
  }
  return null;
}
const GYROFLOW = findGyroflowExe();
const COMPARE_SCRIPT = path.join(here, "../fusion-desktop/engine/video/compare.py");
const STUDIO_SCRIPT = path.join(here, "../fusion-desktop/engine/blender/fusion_studio.py");
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
  // Peak disk in use on the work filesystem (cloud containers have 10 GiB): measured, so limits come from data.
  const diskUsed = () => { try { const st = statfsSync(cfg.workDir); return (st.blocks - st.bfree) * st.bsize; } catch { return 0; } };
  const baseDisk = diskUsed();
  let peakDisk = baseDisk;
  const memTimer = setInterval(() => { peakUsed = Math.max(peakUsed, os.totalmem() - os.freemem()); peakDisk = Math.max(peakDisk, diskUsed()); }, 5000);
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
      // In the cloud container disk is small (10 GiB): let ODM delete heavy intermediate files as it goes.
      const opts = { ...(job.options || {}), ...(cfg.mode === "cloud" ? { "optimize-disk-space": true } : {}) };
      const options = Object.entries(opts).map(([k, value]) => ({ name: k, value }));
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
      // The engine has its own copy now.
      if (cfg.mode === "cloud") await rm(imgDir, { recursive: true, force: true }).catch(() => {});
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
    // Cloud: free the engine's working folder (the biggest) before unpacking, and the zip after.
    if (cfg.mode === "cloud") await odm("/task/remove", { method: "POST", body: form({ uuid }) }).catch((e) => log("task remove failed:", e.message));
    const outDir = path.join(dir, "out");
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await unzip(zip, outDir, log);
    if (cfg.mode === "cloud") await rm(zip, { force: true }).catch(() => {});

    const stats = (f, preview) => rasterStats(f, { python: cfg.odmPython, odmPath: cfg.odmPath, workDir: cfg.workDir, log, preview });
    const { layers, files } = await packageOutputs(outDir, expectBounds, stats, { cloudPreview: true, odmPath: cfg.odmPath, log });
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
        peakDiskGB: +((peakDisk - baseDisk) / 1024 ** 3).toFixed(2),
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

// ── FUSION Video Studio job (Gyroflow) ─────────────────────────────────────────
async function processVideo(job, sources) {
  const g = await import("../fusion-desktop/engine/video/gyroflow.mjs");
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const { execFile } = await import("node:child_process");
  const dir = path.join(cfg.workDir, job.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const o = job.options || {};
  let canceled = false;
  const progress = async (p, stage, extra = {}) => {
    const r = await api({ action: "progress", jobId: job.id, progress: p, stage, ...extra }).catch(() => ({}));
    if (r.canceled) canceled = true;
    return !canceled;
  };
  const sha = (f) => new Promise((res, rej) => { const h = createHash("sha256"); createReadStream(f).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej); });
  // compare.py may sit inside FUSION Desktop's app archive: Python needs a real file.
  const compare = path.join(dir, "compare.py");
  await writeFile(compare, readFileSync(COMPARE_SCRIPT));
  const py = cfg.odmPython;
  const runPy = (args) => new Promise((res) => {
    const bat = /\.bat$/i.test(py ?? "");
    execFile(bat ? "cmd.exe" : py, bat ? ["/d", "/c", py, compare, ...args] : [compare, ...args], { timeout: 1_800_000, maxBuffer: 8 << 20, env: { ...process.env, ODM_PATH: cfg.odmPath ?? process.env.ODM_PATH ?? "" }, windowsHide: true }, (e, out) => res(e ? null : out));
  });
  const files = [];
  const results = [];
  let n = 0;
  for (const src of sources) {
    n++;
    const base = Math.round(((n - 1) / sources.length) * 90);
    const local = path.join(dir, `${src.fileId}${path.extname(src.name) || ".mp4"}`);
    await progress(base + 2, `Downloading original ${n}/${sources.length} (${src.name})`);
    try {
      await download(src.url, local, src.bytes || undefined, src.headers);
      const motion = await g.inspectMotion(local, { gyroflow: GYROFLOW, workDir: dir });
      if (!motion.hasMotion && !o.allowOptical) {
        results.push({ fileId: src.fileId, status: "skipped", reason: "No gyro data in the file: left as shot (optical-only stabilization wasn't requested).", motion });
        continue;
      }
      await progress(base + 10, `Stabilizing ${n}/${sources.length} (${motion.hasMotion ? `gyro: ${motion.source ?? "detected"}` : "optical, experimental"})`);
      const outDir = path.join(dir, "out", src.fileId);
      const outFile = path.join(outDir, "stabilized.mp4");
      const r = await g.stabilize(local, outFile, { gyroflow: GYROFLOW, preset: o.preset, motion, allowOptical: Boolean(o.allowOptical), onProgress: (p) => void progress(base + 10 + Math.round((p / 100) * (70 / sources.length)), `Stabilizing ${n}/${sources.length}: ${Math.round(p)}%`) });
      await progress(base + 80 / sources.length, `Measuring before/after ${n}/${sources.length}`);
      const out = await runPy([local, outFile, outDir]);
      const metrics = out ? JSON.parse(String(out).trim().split("\n").pop()) : null;
      const rel = (f) => `video/${src.fileId}/${f}`;
      files.push([rel("stabilized.mp4"), outFile]);
      if (existsSync(path.join(outDir, "compare.jpg"))) files.push([rel("compare.jpg"), path.join(outDir, "compare.jpg")]);
      if (existsSync(path.join(outDir, "thumb.jpg"))) files.push([rel("thumb.jpg"), path.join(outDir, "thumb.jpg")]);
      results.push({ fileId: src.fileId, status: "ok", motion, mode: r.mode, preset: r.preset, gyroflow: r.gyroflowVersion, seconds: r.seconds, metrics, out: rel("stabilized.mp4"), compare: existsSync(path.join(outDir, "compare.jpg")) ? rel("compare.jpg") : null, thumb: existsSync(path.join(outDir, "thumb.jpg")) ? rel("thumb.jpg") : null, bytes: statSync(outFile).size, sha256: await sha(outFile) });
    } catch (e) {
      results.push({ fileId: src.fileId, status: "failed", reason: String(e.message).slice(0, 300) });
    } finally {
      await rm(local, { force: true }).catch(() => {});
    }
    if (canceled) return { canceled: true };
  }
  if (!files.length) {
    await api({ action: "finish", jobId: job.id, ok: true, layers: [], usage: {}, video: { results } });
  } else {
    await publishOutputs({ api, jobId: job.id, layers: [], files, extra: { video: { results } }, log, onProgress: (sent, total) => progress(92 + Math.round((sent / total) * 6), `Uploading ${sent}/${total}`), usage: { files: sources.length, ok: results.filter((r) => r.status === "ok").length, runner: cfg.mode, workerId: cfg.workerId } });
  }
  log(`video job ${job.id}: ${results.map((r) => r.status).join(", ")}`);
  if (!cfg.keepJobFiles) await rm(dir, { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

// ── FUSION 3D Studio job (Blender) ─────────────────────────────────────────────
async function processStudio(job, source) {
  const dir = path.join(cfg.workDir, job.id);
  const out = path.join(dir, "out");
  await rm(dir, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const started = Date.now();
  let canceled = false;
  const progress = async (p, stage, extra = {}) => {
    const r = await api({ action: "progress", jobId: job.id, progress: p, stage, ...extra }).catch(() => ({}));
    if (r.canceled) canceled = true;
    return !canceled;
  };
  const input = path.join(dir, "source.glb");
  await progress(3, `Downloading the 3D model (${source.title ?? "model"})`);
  await download(source.url, input, source.bytes || undefined);
  // The script may sit inside FUSION Desktop's app archive: Blender needs a real file, so copy it next to the job.
  const script = path.join(dir, "fusion_studio.py");
  await writeFile(script, readFileSync(STUDIO_SCRIPT));
  const o = job.options || {};
  const jobFile = path.join(dir, "job.json");
  await writeFile(jobFile, JSON.stringify({ ...o, input, outDir: out }, null, 1));
  const frames = Math.round((o.video?.seconds || 12) * (o.video?.fps || 30));
  const lines = [];
  const code = await new Promise((resolve) => {
    const p = spawn(BLENDER, ["-b", "--factory-startup", "-P", script, "--", jobFile], { cwd: dir, windowsHide: true });
    let buf = "";
    let last = 0;
    const onData = (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line.startsWith("[fusion-studio]")) lines.push(line);
        const now = Date.now();
        if (now - last < 10_000) continue;
        const fra = /^Fra:(\d+)/.exec(line);
        const step = /^\[fusion-studio\] (\w+)/.exec(line);
        const stage = fra ? `Rendering video frame ${fra[1]}/${frames}` : step ? `3D Studio: ${step[1]}` : null;
        if (!stage) continue;
        last = now;
        progress(fra ? 30 + Math.round((Number(fra[1]) / frames) * 55) : 15, stage, { log: lines.slice(-30).join("\n") }).then((go) => {
          if (!go) p.kill();
        });
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", (e) => {
      lines.push(`Blender failed to start: ${e.message}`);
      resolve(-1);
    });
    p.on("close", resolve);
  });
  if (canceled) return { canceled: true };
  if (code !== 0) throw Object.assign(new Error(`Blender failed (exit ${code}): ${lines.slice(-4).join(" | ") || "no output"}`), { retryable: false });
  const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
  const has = (n) => existsSync(path.join(out, n));
  const files = [];
  const add = (rel, name) => {
    if (has(name)) files.push([rel, path.join(out, name)]);
  };
  const stills = readdirSync(out).filter((n) => /^still_\d+\.jpg$/.test(n)).sort();
  add("model/model_web.glb", "model_web.glb");
  add("model/preview.jpg", stills[0] ?? "plan.jpg");
  add("video/flythrough.mp4", "flythrough.mp4");
  stills.forEach((n) => add(`video/${n}`, n));
  add("video/plan.jpg", "plan.jpg");
  add("video/report.json", "report.json");
  const size = (rel) => {
    const f = files.find(([r]) => r === rel);
    return f ? statSync(f[1]).size : null;
  };
  const clean = report.steps?.find((x) => x.step === "clean") ?? {};
  const studio = {
    facesIn: report.facesIn,
    facesOut: report.facesOut,
    fragmentsRemoved: clean.fragments_removed ?? null,
    fragmentFacesRemoved: clean.fragment_faces_removed ?? null,
    blender: report.blender,
    seconds: report.seconds,
    camera: report.camera,
    planView: report.planView ?? null,
    offsetBlender: report.offsetBlender,
    sourceLayerId: o.sourceLayerId,
    target: o.target ?? null,
    radius: o.radius ?? null,
    label: o.label ?? null,
  };
  studio.coverage = report.coverage ?? null;
  const what = o.label || (o.target ? "selected building" : "whole site");
  const layers = [];
  const mode = o.mode || "present";
  let extra = {};
  if (mode === "inspect") {
    // Evidence about the SOURCE model (coverage + plan + two looks): attached to it, no new outputs.
    files.length = 0;
    add("inspect/plan.jpg", "plan.jpg");
    stills.forEach((n) => add(`inspect/${n}`, n));
    extra = { studio: { mode, sourceLayerId: o.sourceLayerId, coverage: report.coverage ?? null, facesIn: report.facesIn, blender: report.blender, plan: "inspect/plan.jpg", stills: stills.map((n) => `inspect/${n}`) } };
  } else if (mode === "views") {
    files.length = 0;
    const views = report.views ?? [];
    for (const v of views) add(v.file, v.file);
    add("video/tour.mp4", "tour.mp4");
    add("video/still_1.jpg", "still_1.jpg");
    if (size("video/tour.mp4"))
      layers.push({ kind: "FLYTHROUGH", title: `Tour flythrough (${o.label || "saved views"})`, file: "video/tour.mp4", fileBytes: size("video/tour.mp4"), meta: { studio: { ...studio, mode, tourId: o.tourId ?? null }, tourId: o.tourId ?? null, preview: "video/still_1.jpg", seconds: report.tourVideo?.seconds, width: o.video?.width ?? 1920, height: o.video?.height ?? 1080, stills: [] } });
    extra = { studio: { mode, sourceLayerId: o.sourceLayerId, views } };
  }
  if (mode === "present" && size("model/model_web.glb")) layers.push({ kind: "MODEL_3D", title: `3D Studio model (${what}, web/TV)`, file: "model/model_web.glb", fileBytes: size("model/model_web.glb"), meta: { studio, preview: "model/preview.jpg", format: "glb" } });
  if (mode === "present" && size("video/flythrough.mp4"))
    layers.push({
      kind: "FLYTHROUGH",
      title: `${o.video?.path === "flyin" ? "Fly-in" : "Orbit"} video (${what})`,
      file: "video/flythrough.mp4",
      fileBytes: size("video/flythrough.mp4"),
      meta: { studio, preview: `video/${stills[0] ?? "plan.jpg"}`, seconds: o.video?.seconds, fps: o.video?.fps, width: o.video?.width, height: o.video?.height, stills: stills.map((n) => `video/${n}`) },
      downloads: [
        ...stills.map((n, i) => ({ file: `video/${n}`, name: `still-${i + 1}.jpg`, bytes: size(`video/${n}`), format: "jpg" })),
        ...(size("video/plan.jpg") ? [{ file: "video/plan.jpg", name: "plan-view.jpg", bytes: size("video/plan.jpg"), format: "jpg" }] : []),
      ],
    });
  if (!layers.length && mode === "present") throw Object.assign(new Error("Blender finished but produced no model or video."), { retryable: false });
  if (!files.length) throw Object.assign(new Error("Blender finished but produced nothing to upload."), { retryable: false });
  await publishOutputs({
    api,
    jobId: job.id,
    layers,
    files,
    extra,
    log,
    onProgress: (sent, total) => progress(88 + Math.round((sent / total) * 10), `Uploading results ${sent}/${total}`),
    usage: { seconds: Math.round((Date.now() - started) / 1000), blender: report.blender, renderSeconds: report.seconds, outputFiles: files.length, runner: cfg.mode, workerId: cfg.workerId },
  });
  log(`studio job ${job.id}: done, ${layers.length} layers`);
  if (!cfg.keepJobFiles) await rm(dir, { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

async function main() {
  log(`FUSION worker ${cfg.workerId} (${cfg.mode}) → ${cfg.server}, NodeODM ${cfg.nodeodm}`);
  const info = await odm("/info").catch((e) => ({ error: e.message }));
  log("NodeODM:", JSON.stringify(info));
  log(BLENDER ? `Blender: ${BLENDER} (3D Studio jobs enabled)` : "Blender: not installed (3D Studio jobs go to another computer)");
  log(GYROFLOW ? `Gyroflow: ${GYROFLOW} (Video Studio jobs enabled)` : "Gyroflow: not installed (Video Studio jobs go to another computer)");
  for (;;) {
    let claim;
    try {
      // Optional capacity (the Bunny container sets it; the office PC takes any size).
      claim = await api({ action: "claim", engine: `NodeODM ${info.version ?? "?"} / ODM ${info.engineVersion ?? "?"}`, maxPhotos: Number(cfg.maxPhotos) || undefined, maxGB: Number(cfg.maxGB) || undefined, caps: [...(BLENDER ? ["blender"] : []), ...(GYROFLOW ? ["gyroflow"] : [])], only: cfg.only || undefined });
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
      const r = claim.job.type === "STUDIO" ? await processStudio(claim.job, claim.source) : claim.job.type === "VIDEO" ? await processVideo(claim.job, claim.sources ?? []) : await processJob(claim.job, claim.images, claim.expectBounds ?? null);
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
