// Packages the built extensions into store-ready zips: runs the standard
// build, then writes dist/crossposter-<target>-v<version>.zip with the
// manifest at the archive root, as the Chrome Web Store and AMO expect.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

await import("./build.mjs");

for (const target of ["chrome", "firefox"]) {
  const dir = path.join("dist", target);
  const { version } = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const zipName = `crossposter-${target}-v${version}.zip`;
  await rm(path.join("dist", zipName), { force: true });
  // -X keeps platform extra fields out of the archive so packages are reproducible.
  await run("zip", ["-qrX", path.join("..", zipName), "."], { cwd: dir });
  console.log(`Packaged dist/${zipName}`);
}
