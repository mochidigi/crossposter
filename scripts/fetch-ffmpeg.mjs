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
  { name: "@ffmpeg/ffmpeg", version: "0.12.15", dist: "dist/esm", dest: "ffmpeg" },
  // ESM core: the vendored ffmpeg worker runs as a module worker and loads the
  // core via `import()`, which needs the ESM build's `export default`, not UMD.
  // The `files` allowlist guards against 0.12.6's packaging accident (its
  // dist/esm also shipped a stray copy of the wrapper JS whose worker.js
  // tripped AMO's dynamic-import lint). 0.12.9 ships only these two files,
  // but the allowlist stays as insurance against a regression.
  { name: "@ffmpeg/core", version: "0.12.9", dist: "dist/esm", dest: "core", files: ["ffmpeg-core.js", "ffmpeg-core.wasm"] }
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

// Two patches to the wrapper, applied at vendoring time. When bumping the
// wrapper version, re-check whether upstream still needs them (run
// addons-linter and grep the vendored files for "unpkg").
//
// 1. const.js: upstream exports CORE_URL as a CDN default
//    (`https://unpkg.com/@ffmpeg/core@…`). The extension never uses it
//    (shared/hls.js always passes the bundled core), but the Chrome Web Store
//    rejects MV3 items containing it as "remotely-hosted code" (rejection
//    2026-09-12, ref "Blue Argon"). Point it at the bundled core instead so no
//    remote URL remains anywhere in the package.
const constPath = path.join(OUT, "ffmpeg", "const.js");
const constSource = await readFile(constPath, "utf8");
const constPatched = constSource.replace(
  /export const CORE_URL = `https:\/\/unpkg\.com\/[^`]*`;/,
  'export const CORE_URL = new URL("../core/ffmpeg-core.js", import.meta.url).href;'
);
if (constPatched === constSource) throw new Error("ffmpeg/const.js: CORE_URL patch no longer applies; re-check the wrapper source");
if (/https?:\/\//.test(constPatched)) throw new Error("ffmpeg/const.js: a remote URL survived the patch");
await writeFile(constPath, constPatched);

// 2. worker.js: upstream's load() first tries `importScripts(_coreURL)`
//    (classic-worker path) and on failure rewrites the CDN URL from /umd/ to
//    /esm/ and does `await import(_coreURL)`. AMO's linter flags the dynamic
//    import argument, and both branches read like remote code loading. The
//    extension always runs the module-worker path with the bundled core, so
//    replace the whole try/catch with one static import of it.
const workerPath = path.join(OUT, "ffmpeg", "worker.js");
const workerSource = await readFile(workerPath, "utf8");
const patched = workerSource.replace(
  /    try \{\n        if \(!_coreURL\)\n            _coreURL = CORE_URL;\n[\s\S]*?importScripts\(_coreURL\);\n    \}\n    catch \{\n[\s\S]*?self\.createFFmpegCore = \(await import\([\s\S]*?_coreURL\)\)\.default;\n        if \(!self\.createFFmpegCore\) \{\n            throw ERROR_IMPORT_FAILURE;\n        \}\n    \}\n/,
  '    if (!_coreURL)\n        _coreURL = CORE_URL;\n    // Module worker: always the bundled core (static specifier; see fetch-ffmpeg.mjs).\n    self.createFFmpegCore = (await import("../core/ffmpeg-core.js")).default;\n    if (!self.createFFmpegCore) {\n        throw ERROR_IMPORT_FAILURE;\n    }\n'
);
if (patched === workerSource) throw new Error("ffmpeg/worker.js: static-import patch no longer applies; re-check the wrapper source");
if (/importScripts|import\(_coreURL\)/.test(patched)) throw new Error("ffmpeg/worker.js: dynamic core loading survived the patch");
await writeFile(workerPath, patched);

// Drop the wrapper's TypeScript declaration files: nothing loads them, and
// their doc comments still quote the unpkg.com default URLs, which a store
// reviewer's text scan would flag.
for (const file of await readdir(path.join(OUT, "ffmpeg"))) {
  if (/\.d\.m?ts$/.test(file)) await rm(path.join(OUT, "ffmpeg", file));
}

await rm(TMP, { recursive: true, force: true });
console.log(`Fetched ffmpeg assets into ${OUT}/:`, (await readdir(OUT)).join(", "));
