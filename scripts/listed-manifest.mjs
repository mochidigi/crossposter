// Rewrites dist/firefox/manifest.json to the LISTED sibling version: the tag
// version X.Y.Z with a ".1" suffix. The release workflow signs X.Y.Z on the
// unlisted channel and X.Y.Z.1 on the listed channel (see CLAUDE.md), and
// `npm run build-for-amo` runs this after the build so AMO's automated
// source-to-package comparison sees the same manifest as the listed upload.
import { readFile, writeFile } from "node:fs/promises";

const manifestPath = "dist/firefox/manifest.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version.split(".").length !== 3) {
  throw new Error(`${manifestPath}: expected an X.Y.Z version, got ${manifest.version}`);
}
manifest.version = `${manifest.version}.1`;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Set ${manifestPath} version to ${manifest.version} (listed sibling).`);
