// Fetches the ffmpeg.wasm assets used for the HLS -> MP4 fallback into
// src/vendor/ffmpeg/ (gitignored). The standard build runs this automatically
// when the assets are missing; `npm run fetch-ffmpeg` remains available for an
// explicit refresh of the pinned packages.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const OUT = "src/vendor/ffmpeg";
const TMP = "src/vendor/.ffmpeg-tmp";
const PKGS = [
  { name: "@ffmpeg/ffmpeg", version: "0.12.10", dist: "dist/esm", dest: "ffmpeg" },
  // ESM core: the vendored ffmpeg worker runs as a module worker and loads the
  // core via `import()`, which needs the ESM build's `export default`, not UMD.
  { name: "@ffmpeg/core", version: "0.12.6", dist: "dist/esm", dest: "core" }
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
  await cp(path.join(TMP, "package", pkg.dist), path.join(OUT, pkg.dest), { recursive: true });
}

await rm(TMP, { recursive: true, force: true });
console.log(`Fetched ffmpeg assets into ${OUT}/:`, (await readdir(OUT)).join(", "));
