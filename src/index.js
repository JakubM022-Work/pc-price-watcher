require("dotenv").config();

const { loadConfig } = require("./config");
const { readState, writeState } = require("./state");
const { sendDiscord } = require("./discord");
const { launchContext, saveStorage, closeAll } = require("./browser");
const { fetchPriceSmart, formatPLN } = require("./ceneo/ceneo");

async function runOnce(cfg) {
  const state = readState(cfg.statePath);

  const results = [];
  const changes = [];

  for (const item of cfg.items) {
    if (!item?.url) continue;

    try {
      const res = await fetchPriceSmart({
        item,
        headlessAttempt: cfg.headlessDefault,
        launchContext,
        saveStorage,
        closeAll,
        storagePath: cfg.storagePath
      });

      if (!res) {
        results.push({ item, ok: false, error: "Nie udało się znaleźć ceny" });
        continue;
      }

      const key = item.url;
      const prev = state[key]?.lastPriceGrosze ?? null;

      state[key] = {
        name: item.name,
        lastPriceGrosze: res.priceGrosze,
        lastSeen: new Date().toISOString(),
        method: res.method,
        raw: res.raw
      };

      results.push({ item, ok: true, priceGrosze: res.priceGrosze, prevGrosze: prev });

      if (prev != null && prev !== res.priceGrosze) {
        changes.push({ name: item.name, url: item.url, from: prev, to: res.priceGrosze });
      }
    } catch (e) {
      results.push({ item, ok: false, error: String(e) });
    }
  }

  writeState(cfg.statePath, state);

  if (cfg.notifyOnChange && changes.length > 0) {
    const lines = changes.map(c => {
      const dir = c.to < c.from ? "⬇️" : "⬆️";
      return `${dir} **${c.name}**: ${formatPLN(c.from)} → ${formatPLN(c.to)}\n${c.url}`;
    });
    await sendDiscord(cfg.discordWebhookUrl, `💸 **Zmiana cen (${changes.length})**\n\n${lines.join("\n\n")}`);
  }

  if (cfg.notifyOnEveryCheck) {
    const now = new Date().toLocaleString("pl-PL");
    const lines = results.map(r => {
      if (!r.ok) return `⚠️ **${r.item.name}**: ${r.error}\n${r.item.url}`;
      return `✅ **${r.item.name}**: ${formatPLN(r.priceGrosze)}\n${r.item.url}`;
    });
    await sendDiscord(cfg.discordWebhookUrl, `📦 **Raport cen – ${now}**\n\n${lines.join("\n\n")}`);
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.discordWebhookUrl) {
    console.error("Brak DISCORD_WEBHOOK_URL w .env");
  }

  await runOnce(cfg);

  const pollMs = (cfg.pollMinutes ?? 30) * 60 * 1000;
  setInterval(() => runOnce(cfg).catch(err => console.error("runOnce error:", err)), pollMs);
}

main().catch(console.error);