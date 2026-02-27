const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig() {
  const root = path.join(__dirname, "..");
  const configPath = path.join(root, process.env.CONFIG_PATH || "config.json");
  const statePath = path.join(root, process.env.STATE_PATH || "state.json");
  const storagePath = path.join(root, process.env.STORAGE_STATE_PATH || "storageState.json");

  const cfgFile = readJson(configPath);

  return {
    pollMinutes: envInt("POLL_MINUTES", 30),
    notifyOnEveryCheck: envBool("NOTIFY_ON_EVERY_CHECK", true),
    notifyOnChange: envBool("NOTIFY_ON_CHANGE", true),
    headlessDefault: envBool("HEADLESS_DEFAULT", true),

    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",

    configPath,
    statePath,
    storagePath,

    items: Array.isArray(cfgFile.items) ? cfgFile.items : []
  };
}

module.exports = { loadConfig };