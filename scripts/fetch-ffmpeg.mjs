// Fetches the ffmpeg.wasm assets used for the HLS -> MP4 fallback into
// src/vendor/ffmpeg/ (gitignored). The standard build runs this automatically
// when the assets are missing; `npm run fetch-ffmpeg` remains available for an
// explicit refresh of the pinned packages.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const OUT = "src/vendor/ffmpeg";
const TMP = "src/vendor/.ffmpeg-tmp";
const PKGS = [
  // Keep the core pinned to the wrapper's own CORE_VERSION (see
  // @ffmpeg/ffmpeg dist/esm/const.js) — newer cores exist on npm but the
  // wrapper is only tested against its paired core, so bump both together.
  { name: "@ffmpeg/ffmpeg", version: "0.12.10", dist: "dist/esm", dest: "ffmpeg" },
  // ESM core: the vendored ffmpeg worker runs as a module worker and loads the
  // core via `import()`, which needs the ESM build's `export default`, not UMD.
  // Only the core itself is taken — 0.12.6's dist/esm also ships a copy of the
  // wrapper JS (classes.js, worker.js, …) that nothing loads, and its worker.js
  // trips AMO's dynamic-import lint. That looks like a packaging accident: when
  // bumping the version, check whether dist/esm still contains the stray
  // wrapper files — if upstream fixed it, this `files` allowlist can go.
  { name: "@ffmpeg/core", version: "0.12.6", dist: "dist/esm", dest: "core", files: ["ffmpeg-core.js", "ffmpeg-core.wasm"] }
];

async function runNpm(args) {
  // npm exposes its CLI path to lifecycle scripts. Running that JavaScript
  // entry point through Node avoids Windows' inability to exec npm.cmd
  // directly, while retaining a fallback for direct `node` invocation.
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], { cwd: process.cwd() });
  }
  if (process.platform === "win32") {
    return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], { cwd: process.cwd() });
  }
  return run("npm", args, { cwd: process.cwd() });
}

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const pkg of PKGS) {
  const { stdout } = await runNpm(["pack", `${pkg.name}@${pkg.version}`, "--pack-destination", TMP]);
  const tarball = stdout.trim().split("\n").pop();
  await run("tar", ["-xzf", path.join(TMP, tarball), "-C", TMP]);
  if (pkg.files) {
    await mkdir(path.join(OUT, pkg.dest), { recursive: true });
    for (const file of pkg.files) await cp(path.join(TMP, "package", pkg.dist, file), path.join(OUT, pkg.dest, file));
  } else {
    await cp(path.join(TMP, "package", pkg.dist), path.join(OUT, pkg.dest), { recursive: true });
  }
}

// AMO's linter flags dynamic `import()` arguments (UNSAFE_VAR_ASSIGNMENT). The
// extension always loads the core from the vendored location (shared/hls.js
// passes exactly that coreURL), so hardwire the specifier the wrapper's worker
// would otherwise receive at runtime. When bumping the wrapper version, check
// whether upstream made the import lint-safe — if `addons-linter` no longer
// flags the unpatched worker.js, drop this patch.
const workerPath = path.join(OUT, "ffmpeg", "worker.js");
const workerSource = await readFile(workerPath, "utf8");
const patched = workerSource.replace(/await import\(([\s\S]*?)_coreURL\)/, 'await import("../core/ffmpeg-core.js")');
if (patched === workerSource) throw new Error("ffmpeg/worker.js: static-import patch no longer applies; re-check the wrapper source");
await writeFile(workerPath, patched);

await rm(TMP, { recursive: true, force: true });
console.log(`Fetched ffmpeg assets into ${OUT}/:`, (await readdir(OUT)).join(", "));
