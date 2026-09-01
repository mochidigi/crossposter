import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// HLS downloads need the vendored ffmpeg.wasm runtime. Keep normal builds fast
// by reusing an existing copy, but make a clean checkout self-contained by
// fetching the pinned assets before packaging when they are absent.
const requiredFfmpegAssets = [
  "src/vendor/ffmpeg/ffmpeg/index.js",
  "src/vendor/ffmpeg/ffmpeg/worker.js",
  "src/vendor/ffmpeg/core/ffmpeg-core.js",
  "src/vendor/ffmpeg/core/ffmpeg-core.wasm"
];

async function hasFfmpegAssets() {
  try {
    await Promise.all(requiredFfmpegAssets.map(file => access(file)));
    return true;
  } catch {
    return false;
  }
}

if (!await hasFfmpegAssets()) {
  console.log("FFmpeg assets are missing; fetching the pinned runtime before packaging…");
  await import("./fetch-ffmpeg.mjs");
}

await rm("dist", { recursive: true, force: true });
for (const target of ["chrome", "firefox"]) {
  const out = path.join("dist", target);
  const chromeOnlyExclusions = [
    path.resolve("src", "background.firefox.js"),
    path.resolve("src", "platforms", "youtube")
  ];
  await mkdir(out, { recursive: true });
  await cp("src", out, {
    recursive: true,
    filter: source => {
      const resolved = path.resolve(source);
      if (source.includes("manifest.chrome.json") || source.includes("manifest.firefox.json")) return false;
      if (target === "chrome" && chromeOnlyExclusions.some(excluded => resolved === excluded || resolved.startsWith(`${excluded}${path.sep}`))) return false;
      return true;
    }
  });
  await writeFile(path.join(out, "manifest.json"), await readFile(`src/manifest.${target}.json`));
}
console.log("Built Chrome and Firefox extensions in dist/.");
