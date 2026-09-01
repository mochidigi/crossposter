// Firefox-only source integrations register before the shared background
// module starts synchronizing content scripts and handling context-menu clicks.
import "./platforms/youtube/background.js";
import "./background.js";
