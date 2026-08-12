const path = require("node:path");

// This is the single project-level Puppeteer supply policy. Runtime executable
// selection remains owned by scripts/lib/qa-browser-runtime.mjs.
module.exports = {
  skipDownload: true,
  chrome: { skipDownload: true },
  "chrome-headless-shell": { skipDownload: true },
  firefox: { skipDownload: true },
  cacheDirectory: path.join(
    __dirname,
    ".content-workspace",
    "qa-browser-runtime",
    "puppeteer-cache",
  ),
};
