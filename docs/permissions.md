# Permission audit

Every permission in the manifests, why it is needed, and where it is used.
Audited 2026-08-29 against the current code; all requested permissions are in
active use. This doubles as the justification text for store review.

## Permissions

| Permission | Used by | Why |
| --- | --- | --- |
| `contextMenus` | `background.js` (`contextMenus.create`/`onClicked`) | The extension's entry point: the right-click **Crosspost** menu item. |
| `storage` | throughout (`storage.local`, `storage.session`) | Drafts, preferences, crosspost session state, and handoff data — all kept locally. |
| `unlimitedStorage` | media store (`shared/media-store.js`, IndexedDB) | Captured images and especially videos are held in the browser while composing; a single video can exceed the default quota. |
| `tabs` | `background.js` (`tabs.query`, create/update/remove; reads `tab.url` to match supported platforms) | Opening each network's composer tab, keeping platform adapters and composer tabs in sync with the networks enabled in Settings, and tracking composer tab lifecycle. Reading tab URLs requires the `tabs` permission. |
| `tabGroups` | `background.js` (`tabs.group`, `tabGroups.update`) | Groups the composer tabs opened by one crosspost and labels the group so the user can review them together. |
| `activeTab` | context-menu invocation | Grants temporary access to the page the user explicitly invokes Crossposter on, including recovery when an unpacked-extension reload invalidates an older page context. |
| `scripting` | `background.js` (`scripting.registerContentScripts`, `unregisterContentScripts`, `executeScript`) | Registers adapters only for platforms enabled in Settings, removes disabled adapters from future page loads, and refreshes enabled integrations in already-open tabs. Only the extension's own files are injected. |
| `downloads` | `compose.js` (`downloads.download`) | The **Download video** feature saves the resolved media file via the browser's downloader. |
| `clipboardWrite` | `tray.js` (async clipboard text and image writes) | The sidebar's explicit "copy text" / "copy image" buttons, used for manual handoff into a composer. |
| `notifications` | `background.js` (LinkedIn publish notifications) | Notifies the user when their LinkedIn post is detected as published so the crosspost session can continue. |
| `sidePanel` (Chrome) / `sidebar_action` (Firefox) | `background.js`, `tray.html` | The browser-owned handoff sidebar that holds text/media for dragging into a site's own composer. |
| `webRequest` | `background.js:56-70` (non-blocking listeners filtered to LinkedIn's publish endpoint) | Detects that the user's own LinkedIn post request completed, to advance the crosspost session. Observational only — nothing is modified or blocked. |

## Host permissions

Host permissions fall into three groups:

- **Media CDNs** (`*.twimg.com`, `*.licdn.com`, `*.cdninstagram.com`,
  `*.fbcdn.net`, `*.video.upscrolled.com`, `video.bsky.app`): fetching the
  original image/video files of a captured post so they can be re-uploaded as
  genuine files into the destination composer.
- **Public post APIs** (`cdn.syndication.twimg.com`, `public.api.bsky.app`):
  resolving a post's direct video renditions without any third-party service.
- **Platform origins** (`upscrolled.com`, `x.com`, `twitter.com`, `linkedin.com`,
  `bsky.app`, `instagram.com`, `threads.com`, `facebook.com`): platform-specific
  capture and native-composer automation. Content scripts are registered dynamically
  only for platforms enabled in Settings; disabling a platform unregisters its scripts
  without changing the extension's installed permission set.

## Review conclusions

- Nothing requested is unused; removing any entry breaks a shipped feature.
- The broadest grants (`tabs`, `webRequest`, `unlimitedStorage`) are each tied
  to one concrete feature listed above, and none are used to observe general
  browsing.
- When a platform adapter is removed, its host permissions must be removed in
  the same change; `npm run check` verifies adapters and manifests stay in
  sync.
