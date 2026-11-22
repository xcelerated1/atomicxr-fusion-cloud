/**
 * OpenDroneMap results → FUSION layers, and the verified upload to atomicxr.com.
 * Packages ODM outputs for upload (tiles + GeoTIFF + GLB + LAZ + report). Packaging only: says nothing about output quality.
 */
import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pool, upload, walk } from "./util.mjs";

const run = promisify(execFile);

// ── tiles → bounds ───────────────────────────────────────────────────────────
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

export async function tileInfo(dir, expect) {
  const zs = (await readdir(dir).catch(() => [])).filter((z) => /^\d+$/.test(z)).map(Number).sort((a, b) => a - b);
  if (!zs.length) return null;
  const z = zs[zs.length - 1];
  const xs = (await readdir(path.join(dir, String(z)))).filter((x) => /^\d+$/.test(x)).map(Number);
  const ys = [];
  for (const x of xs) for (const y of await readdir(path.join(dir, String(z), String(x)))) if (/^\d+\.png$/.test(y)) ys.push(Number(y.replace(".png", "")));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs) + 1, Math.min(...ys), Math.max(...ys) + 1];
  const xyz = [tile2lon(x0, z), tile2lat(y1, z), tile2lon(x1, z), tile2lat(y0, z)];
  const flip = (y) => 2 ** z - y;
  const tms = [tile2lon(x0, z), tile2lat(flip(y0), z), tile2lon(x1, z), tile2lat(flip(y1), z)];
  // gdal2tiles writes TMS unless told otherwise: decide by which box contains the photos.
  const inside = (b) => expect && expect[0] >= b[0] - 0.01 && expect[2] <= b[2] + 0.01 && expect[1] >= b[1] - 0.01 && expect[3] <= b[3] + 0.01;
  const scheme = existsSync(path.join(dir, "tilemapresource.xml")) && !inside(xyz) ? "tms" : inside(tms) && !inside(xyz) ? "tms" : "xyz";
  return { minZoom: zs[0], maxZoom: z, bounds: scheme === "tms" ? tms : xyz, scheme };
}

/** Unzip with Windows' own tar (bsdtar reads zip), falling back to PowerShell. Never Git Bash's GNU tar: it reads "D:" as a host. */
export async function unzip(zip, outDir, log = console.log) {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  try {
    await run(tar, ["-xf", zip, "-C", outDir], { timeout: 3_600_000, maxBuffer: 1 << 24 });
  } catch (e) {
    if (process.platform !== "win32") throw e;
    log("tar failed, using Expand-Archive:", e.message.split("\n")[0]);
    await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`], { timeout: 7_200_000, maxBuffer: 1 << 24 });
  }
}

/**
 * Elevation/raster statistics with GDAL from ODM's own Python — only measured values go to the viewer.
 * python: a .bat that sets up ODM's environment (NodeODM's helpers/odm_python.bat, or FUSION Desktop's copy).
 */
export async function rasterStats(file, { python, odmPath, workDir, log = console.log, preview = null }) {
  if (!python || !existsSync(python) || !existsSync(file)) return null;
  // validShare = share of pixels that have data (GDAL mask band, read downsampled to ≤1024 px wide).
  // With a preview ({ out, kind: "ortho" | "dem" }) it also writes an image for visual review and measures:
  //   ortho → sharpness = variance of the Laplacian over pixels with data (higher = crisper; relative, not calibrated)
  //   dem   → hillshade PNG (spikes, pits and holes show plainly) + spikeShare = share of cells more than
  //           max(2 m, 5 × MAD) from their 3×3 neighbourhood median.
  const code = [
    "import sys,json",
    "from osgeo import gdal",
    "ds=gdal.Open(sys.argv[1]);b=ds.GetRasterBand(1);mn,mx,mean,sd=b.ComputeStatistics(False);gt=ds.GetGeoTransform()",
    "W=min(1024,ds.RasterXSize);H=max(1,int(ds.RasterYSize*W/ds.RasterXSize))",
    "m=b.GetMaskBand().ReadRaster(0,0,ds.RasterXSize,ds.RasterYSize,W,H);v=sum(1 for c in m if c)/max(1,len(m))",
    "res={'min':mn,'max':mx,'mean':mean,'resolution':abs(gt[1]),'width':ds.RasterXSize,'height':ds.RasterYSize,'validShare':round(v,3)}",
    "if len(sys.argv)>3:",
    "  import numpy as np",
    "  out,kind=sys.argv[2],sys.argv[3]",
    "  PW=min(1600,ds.RasterXSize);PH=max(1,int(ds.RasterYSize*PW/ds.RasterXSize))",
    "  if kind=='ortho':",
    "    gdal.Translate(out,ds,format='JPEG',width=PW,height=PH,bandList=[1,2,3],creationOptions=['QUALITY=85'])",
    "    g=ds.GetRasterBand(2).ReadAsArray(buf_xsize=PW,buf_ysize=PH).astype('float32')",
    "    mk=ds.GetRasterBand(1).GetMaskBand().ReadAsArray(buf_xsize=PW,buf_ysize=PH)[1:-1,1:-1]>0",
    "    lap=4*g[1:-1,1:-1]-g[:-2,1:-1]-g[2:,1:-1]-g[1:-1,:-2]-g[1:-1,2:]",
    "    res['sharpness']=round(float(np.var(lap[mk])),1) if mk.any() else None",
    "  else:",
    "    small=gdal.Translate('/vsimem/dem.tif',ds,width=PW,height=PH,resampleAlg='average')",
    "    hs=gdal.DEMProcessing('/vsimem/hs.tif',small,'hillshade',computeEdges=True)",
    "    gdal.Translate(out,hs,format='PNG')",
    "    sb=small.GetRasterBand(1);z=sb.ReadAsArray().astype('float64');ok=sb.GetMaskBand().ReadAsArray()>0",
    "    zf=np.where(ok,z,np.nan);pad=np.pad(zf,1,mode='edge')",
    "    stack=np.stack([pad[i:i+zf.shape[0],j:j+zf.shape[1]] for i in range(3) for j in range(3)])",
    "    med=np.nanmedian(stack,axis=0);d=np.abs(zf-med);dv=d[ok & ~np.isnan(d)]",
    "    if dv.size:",
    "      mad=float(np.median(dv));thr=max(2.0,5*mad);res['spikeShare']=round(float((dv>thr).mean()),4);res['spikeThresholdM']=round(thr,2)",
    "print(json.dumps(res))",
  ].join("\n");
  const script = path.join(workDir, "raster_stats.py");
  await mkdir(workDir, { recursive: true });
  await writeFile(script, code);
  try {
    const bat = /\.bat$/i.test(python);
    const args = preview ? [file, preview.out, preview.kind] : [file];
    const { stdout } = await run(bat ? "cmd.exe" : python, bat ? ["/d", "/c", python, script, ...args] : [script, ...args], {
      timeout: 300_000,
      maxBuffer: 1 << 20,
      env: { ...process.env, ODM_PATH: odmPath ?? process.env.ODM_PATH ?? "" },
    });
    return JSON.parse(stdout.trim().split("\n").pop());
  } catch (e) {
    log("stats failed", file, e.message);
    return null;
  }
}

/**
 * Package an ODM project folder (or NodeODM's unzipped all.zip, same layout) into FUSION layers.
 * Returns { layers, files: [[rel, abs, kind, part]] } where part is "tiles" or "file".
 */
/** OpenDroneMap's own reconstruction statistics (odm_report/stats.json), reduced to what quality checks use. */
export function processingStats(outDir) {
  const file = path.join(outDir, "odm_report", "stats.json");
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const r = j.reconstruction_statistics ?? {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const gps = j.gps_errors ?? {};
    const gcp = j.gcp_errors ?? {};
    return {
      shotsTotal: num(r.initial_shots_count),
      shotsReconstructed: num(r.reconstructed_shots_count),
      pointsReconstructed: num(r.reconstructed_points_count),
      components: num(r.components),
      gpsErrorM: num(gps.average_error),
      reprojectionErrorPx: num(r.reprojection_error_pixels),
      gcpUsed: Boolean(gcp && Object.keys(gcp).length && num(gcp.average_error) != null),
    };
  } catch {
    return null;
  }
}

export async function packageOutputs(outDir, expectBounds, stats) {
  const processing = processingStats(outDir);
  const layers = [];
  const files = [];
  const add = (rel, abs, kind, part) => { files.push([rel, abs, kind, part]); return rel; };
  const has = (p) => existsSync(path.join(outDir, p));
  if (!has("odm_orthophoto") && !has("odm_texturing") && !has("odm_georeferencing") && !has("odm_dem")) {
    // NodeODM reports success even when ODM never ran; report what ODM printed instead of finishing with nothing.
    const out = [path.join(outDir, "task_output.txt"), path.join(outDir, "log.json")].find((p) => existsSync(p));
    const tail = out ? readFileSync(out, "utf8").trim().split("\n").slice(-8).join(" | ") : "no output";
    throw Object.assign(new Error(`The mapping engine produced no results: ${tail.slice(0, 1500)}`), { retryable: false });
  }
  const size = (p) => statSync(path.join(outDir, p)).size;
  const tiles = async (kind, folder, extra) => {
    const t = has(folder) ? await tileInfo(path.join(outDir, folder), expectBounds) : null;
    for (const f of t ? await walk(path.join(outDir, folder)) : []) if (f.endsWith(".png")) add(`${kind.toLowerCase()}/tiles/${path.relative(path.join(outDir, folder), f).split(path.sep).join("/")}`, f, kind, "tiles");
    return t ? { tiles: `${kind.toLowerCase()}/tiles`, minZoom: t.minZoom, maxZoom: t.maxZoom, bounds: t.bounds, scheme: t.scheme, ...extra } : extra;
  };

  // Preview images for visual review (written next to the outputs, uploaded with the layer).
  const pvDir = path.join(outDir, "fusion_previews");
  const preview = (kind, rel) => {
    const out = path.join(pvDir, rel.replace(/\//g, "_"));
    return { out, rel, kind };
  };
  const attachPreview = (pv, st, layerKind) => (st && existsSync(pv.out) ? add(pv.rel, pv.out, layerKind, "preview") : null);
  if (existsSync(outDir)) { try { mkdirSync(pvDir, { recursive: true }); } catch {} }

  if (has("odm_orthophoto/odm_orthophoto.tif")) {
    const t = await tiles("ORTHOMOSAIC", "orthophoto_tiles", {});
    const pv = preview("ortho", "orthomosaic/preview.jpg");
    const st = await stats(path.join(outDir, "odm_orthophoto/odm_orthophoto.tif"), pv);
    const pvRel = attachPreview(pv, st, "ORTHOMOSAIC");
    layers.push({ kind: "ORTHOMOSAIC", title: "2D Map (orthomosaic)", ...t, file: add("orthomosaic/orthophoto.tif", path.join(outDir, "odm_orthophoto/odm_orthophoto.tif"), "ORTHOMOSAIC", "file"), fileBytes: size("odm_orthophoto/odm_orthophoto.tif"), meta: { scheme: t.scheme ?? "xyz", resolutionM: st?.resolution ?? null, pixels: st ? [st.width, st.height] : null, validShare: st?.validShare ?? null, sharpness: st?.sharpness ?? null, preview: pvRel, processing } });
  }
  for (const [kind, name, surface] of [["DSM", "dsm", "surface"], ["DTM", "dtm", "terrain"]]) {
    if (!has(`odm_dem/${name}.tif`)) continue;
    const pv = preview("dem", `${kind.toLowerCase()}/preview.png`);
    const st = await stats(path.join(outDir, `odm_dem/${name}.tif`), pv);
    const pvRel = attachPreview(pv, st, kind);
    const t = await tiles(kind, `${name}_tiles`, {});
    layers.push({
      kind,
      title: kind === "DSM" ? "Elevation (surface)" : "Elevation (bare ground)",
      ...t,
      file: add(`${kind.toLowerCase()}/${name}.tif`, path.join(outDir, `odm_dem/${name}.tif`), kind, "file"),
      fileBytes: size(`odm_dem/${name}.tif`),
      meta: { scheme: t.scheme ?? "xyz", surface, unit: "m", min: st?.min ?? null, max: st?.max ?? null, resolutionM: st?.resolution ?? null, validShare: st?.validShare ?? null, spikeShare: st?.spikeShare ?? null, spikeThresholdM: st?.spikeThresholdM ?? null, preview: pvRel, processing, datum: "GPS ellipsoid/EGM heights as recorded by the drone (not a surveyed datum)" },
    });
  }
  const glb = ["odm_texturing/odm_textured_model_geo.glb", "odm_texturing_25d/odm_textured_model_geo.glb"].find(has);
  if (glb) layers.push({ kind: "MODEL_3D", title: "3D Model", file: add("model3d/model.glb", path.join(outDir, glb), "MODEL_3D", "file"), fileBytes: size(glb), meta: { format: "glb", source: glb.includes("25d") ? "2.5D" : "full 3D", processing } });
  if (has("odm_georeferencing/odm_georeferenced_model.laz")) layers.push({ kind: "POINT_CLOUD", title: "Point cloud", file: add("pointcloud/points.laz", path.join(outDir, "odm_georeferencing/odm_georeferenced_model.laz"), "POINT_CLOUD", "file"), fileBytes: size("odm_georeferencing/odm_georeferenced_model.laz"), meta: { format: "laz", processing } });
  if (has("odm_report/report.pdf")) layers.push({ kind: "REPORT", title: "Processing report (OpenDroneMap)", file: add("report/odm-report.pdf", path.join(outDir, "odm_report/report.pdf"), "REPORT", "file"), fileBytes: size("odm_report/report.pdf"), meta: {} });
  if (!layers.length) throw Object.assign(new Error("The mapping engine finished but produced no usable outputs."), { retryable: false });
  return { layers, files };
}

/**
 * Leave out parts the user chose to keep local (skip = Set of "KIND:part", e.g. "POINT_CLOUD:file").
 * A layer with nothing left to show is dropped.
 */
export function selectOutputs({ layers, files }, skip = new Set()) {
  const keptFiles = files.filter(([, , kind, part]) => !skip.has(`${kind}:${part}`));
  const keptLayers = [];
  for (const l of layers) {
    const x = { ...l };
    if (skip.has(`${l.kind}:tiles`)) for (const k of ["tiles", "minZoom", "maxZoom", "scheme"]) delete x[k];
    if (skip.has(`${l.kind}:file`)) { delete x.file; delete x.fileBytes; }
    if (x.tiles || x.file) keptLayers.push(x);
  }
  return { layers: keptLayers, files: keptFiles };
}

/**
 * Upload outputs with signed URLs, then "finish" with the full upload list: atomicxr.com checks every file is
 * in storage with the right size before it attaches the layers. Missing files are re-sent (up to 2 rounds).
 */
export async function publishOutputs({ api, jobId, layers, files, usage, onProgress = async () => {}, log = console.log }) {
  let sent = 0;
  const total = files.length;
  const sendAll = async (list) => {
    for (let i = 0; i < list.length; i += 800) {
      const batch = list.slice(i, i + 800);
      const { urls } = await api({ action: "presign", jobId, files: batch.map(([rel]) => rel) });
      await pool(batch, 8, async ([rel, abs]) => {
        await upload(urls[rel], abs);
        sent++;
        if (sent % 50 === 0 || sent === total) await onProgress(Math.min(sent, total), total);
      });
    }
  };
  await sendAll(files);
  const { where } = await api({ action: "presign", jobId, files: [] });
  const uploaded = files.map(([rel, abs]) => ({ rel, bytes: statSync(abs).size }));
  for (let round = 0; ; round++) {
    const r = await api({ action: "finish", jobId, ok: true, where, layers, usage, uploaded });
    if (r.status !== 409) return { where, verified: uploaded.length };
    if (round >= 2) throw new Error(`Storage check: ${r.count ?? r.missing?.length} file(s) still missing after re-sending.`);
    log(`storage check: re-sending ${r.missing.length} file(s)`);
    const miss = new Set(r.missing);
    await sendAll(files.filter(([rel]) => miss.has(rel)));
  }
}
