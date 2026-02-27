const fs = require("fs");
const { chromium } = require("playwright");

async function launchContext({ headless, storagePath }) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext(
    fs.existsSync(storagePath) ? { storageState: storagePath } : {}
  );
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function saveStorage(ctx, storagePath) {
  await ctx.storageState({ path: storagePath });
}

async function closeAll({ ctx, browser }) {
  try { await ctx.close(); } catch {}
  try { await browser.close(); } catch {}
}

module.exports = { launchContext, saveStorage, closeAll };