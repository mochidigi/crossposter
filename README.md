# Crossposter — source releases

This repository contains the complete source of the
[Crossposter](https://crossposter.mochi.is) browser extension, published once
per release. Each commit corresponds to one released version (tagged
`v<version>`), so you can diff any two releases to see exactly what changed in
the code that runs in your browser.

Crossposter captures a post and prepares it in the native composers of
Upscrolled, LinkedIn, X, Bluesky, Instagram, Threads, and Facebook.

## Why this repo exists

Crossposter is distributed outside the public store listings (unlisted), so
there is no store page to inspect. This repo is the audit trail: the exact
source for every signed build, plus the scripts to reproduce those builds
byte-for-byte.

Day-to-day development happens in a separate private repository; this mirror
receives a snapshot at every release, committed by CI.

## Reproducing a release

```sh
npm run package
```

This fetches the pinned ffmpeg.wasm runtime into `src/vendor/ffmpeg/`, builds
`dist/chrome` and `dist/firefox`, and writes
`dist/crossposter-<target>-v<version>.zip`. The zips are created with
platform extra fields stripped (`zip -X`), so the archives are reproducible:
they should match the packages submitted to the stores for the same tag.

## What each browser loads

- Chrome: `src/` with `manifest.chrome.json` as `manifest.json`
- Firefox: `src/` with `manifest.firefox.json` as `manifest.json`

See [docs/permissions.md](docs/permissions.md) for what every requested
permission is used for.

## License

[MIT](LICENSE)
