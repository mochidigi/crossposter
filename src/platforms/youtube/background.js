import { registerPlatformContentScript } from "../../shared/content-scripts.js";
import { registerDownloadResolver } from "../../shared/downloaders.js";
import { registerSourceNetwork } from "../../shared/draft.js";
import { registerPageVideoHintResolver } from "../../shared/source-video.js";
import { readYoutubePlayerData, resolveYoutube, youtubeVideoInfo } from "./player.js";

registerPlatformContentScript({
  platformId: "youtube",
  id: "crossposter-youtube",
  file: "platforms/youtube/content.js",
  matches: ["https://www.youtube.com/*", "https://m.youtube.com/*", "https://youtube.com/*"],
  sourceOnly: true,
  activeTabOnly: true,
  hosts: host => host === "youtube.com" || host.endsWith(".youtube.com")
});

registerSourceNetwork({
  id: "youtube",
  label: "YouTube",
  matches: host => host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be"
});

registerPageVideoHintResolver("youtube", async ({ ext, tab, frameId }) => {
  if (!ext.scripting?.executeScript || !Number.isInteger(tab?.id)) return null;
  const target = { tabId: tab.id, ...(Number.isInteger(frameId) ? { frameIds: [frameId] } : {}) };
  const [execution] = await ext.scripting.executeScript({ target, world: "MAIN", func: readYoutubePlayerData });
  return youtubeVideoInfo(execution?.result);
});

registerDownloadResolver("youtube", info => resolveYoutube(info));
