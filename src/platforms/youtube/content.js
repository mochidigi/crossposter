(() => {
  const core = globalThis.CrossposterContent;
  if (!core) return;

  core.register({
    id: "youtube",
    matches: host => host === "youtube.com" || host.endsWith(".youtube.com"),
    postSelectors: ["ytd-watch-flexy"],
    captureText: ({ post }) => youtubeTitle(post),
    captureMedia: ({ post }) => {
      const videoId = youtubeVideoId();
      if (!videoId || !post.querySelector?.("video")) return [];
      const poster = youtubePoster(videoId);
      return [{ kind: "video", url: youtubeWatchUrl(videoId), poster }];
    },
    sourceUrl: () => {
      const videoId = youtubeVideoId();
      return videoId ? youtubeWatchUrl(videoId) : location.href;
    },
    sourceAuthor: ({ post }) => youtubeAuthor(post),
    videoInfo: () => ({ source: "youtube", videoId: youtubeVideoId(), src: "" })
  });

  function youtubeVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    } catch {}
    return "";
  }

  function youtubeWatchUrl(videoId) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  function youtubeTitle(post) {
    const selectors = ["h1 yt-formatted-string", "h1", "meta[itemprop='name']"];
    for (const selector of selectors) {
      const element = post.querySelector?.(selector) || document.querySelector?.(selector);
      const value = element?.content || element?.textContent || "";
      if (value.trim()) return value.replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function youtubeAuthor(post) {
    const selectors = [
      "ytd-video-owner-renderer ytd-channel-name a",
      "#owner ytd-channel-name a",
      "link[itemprop='name']"
    ];
    for (const selector of selectors) {
      const element = post.querySelector?.(selector) || document.querySelector?.(selector);
      const value = element?.content || element?.textContent || "";
      if (value.trim()) return value.replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function youtubePoster(videoId) {
    const element = document.querySelector?.("meta[property='og:image'], link[itemprop='thumbnailUrl']");
    return element?.content || element?.href || `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
  }
})();
