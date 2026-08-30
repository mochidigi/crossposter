# Fabric.js runtime

This directory contains the browser ESM bundle from Fabric.js **7.4.0**
(`package/dist/index.mjs`, unminified and byte-identical to the published npm
build), distributed under the MIT license in `LICENSE`. It is vendored so the
MV3 extension can run the image editor entirely from extension-owned files
without remote code or a runtime network dependency, and shipped unminified so
the code in the repository and in the store packages is human-readable and
reviewable.

Source: <https://www.npmjs.com/package/fabric/v/7.4.0>
