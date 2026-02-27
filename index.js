const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { chromium } = require("playwright");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function parsePriceToGrosze(text) {
  if (!text) return null;

  let t = text.toLowerCase().replace("zł", "").replace("pln", "").trim();
  const m = t.match(/(\d[\d\s.,]*)/);
  if (!m) return null;

  let num = m[1].replace(/\s+/g, "");

  // PL: 2399,00
  if (num.includes(",") && !num.includes(".")) {
    const [zl, gr = "00"] = num.split(",");
    const zlDigits = zl.replace(/\D/g, "");
    const grDigits = gr.replace(/\D/g, "").slice(0, 2).padEnd(2, "0");
    if (!zlDigits) return null;
    return Number(zlDigits) * 100 + Number(grDigits);
  }

  // EN: 2399.00
  if (num.includes(".") && !num.includes(",")) {
    const [zl, gr = "00"] = num.split(".");
    const zlDigits = zl.replace(/\D/g, "");
    const grDigits = gr.replace(/\D/g, "").slice(0, 2).padEnd(2, "0");
    if (!zlDigits) return null;
    return Number(zlDigits) * 100 + Number(grDigits);
  }

  // mixed: 2.399,00 -> 2399.00
  num = num.replace(/\./g, "").replace(",", ".");
  if (num.includes(".")) {
    const [zl, gr = "00"] = num.split(".");
    const zlDigits = zl.replace(/\D/g, "");
    const grDigits = gr.replace(/\D/g, "").slice(0, 2).padEnd(2, "0");
    if (!zlDigits) return null;
    return Number(zlDigits) * 100 + Number(grDigits);
  }

  // integer
  const zlDigits = num.replace(/\D/g, "");
  if (!zlDigits) return null;
  return Number(zlDigits) * 100;
}

function formatPLN(grosze) {
  const zl = Math.floor(grosze / 100);
  const gr = grosze % 100;
  return `${zl.toLocaleString("pl-PL")},${String(gr).padStart(2, "0")} zł`;
}

async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return;
  await axios.post(webhookUrl, { content }, { timeout: 15000 });
}

async function acceptCookies(page, strategy) {
  // Media Expert - OneTrust
  if (strategy === "mediaexpert") {
    try {
      await page.waitForSelector("#onetrust-accept-btn-handler", { timeout: 4000 });
      await page.click("#onetrust-accept-btn-handler");
      await page.waitForTimeout(800);
      return;
    } catch {}
  }

  // x-kom – przycisk "W porządku"
  if (strategy === "xkom") {
    try {
      await page.waitForSelector('button[data-name="AcceptPermissionButton"]', { timeout: 4000 });
      await page.click('button[data-name="AcceptPermissionButton"]');
      await page.waitForTimeout(800);
      return;
    } catch {}
  }

  // Fallbacki (gdyby coś się zmieniło)
  try { await page.click('text=ZAAKCEPTUJ WSZYSTKIE', { timeout: 1500 }); } catch {}
  try { await page.click('text=W porządku', { timeout: 1500 }); } catch {}
  try { await page.click('text=Akceptuj', { timeout: 1500 }); } catch {}
  await page.waitForTimeout(300);
}

function saveDebugFiles(itemName, html, screenshotBuffer) {
  const safe = itemName.replace(/[^a-z0-9]+/gi, "_").slice(0, 70);
  fs.writeFileSync(`debug_${safe}.html`, html, "utf8");
  if (screenshotBuffer) fs.writeFileSync(`debug_${safe}.png`, screenshotBuffer);
}

function extractPriceFromHtmlByStrategy(html, item) {
  if (!html) return null;

  // x-kom: często w HTML występuje "Cena: 539,00 zł"
  if (item.strategy === "xkom") {
    const m = html.match(/Cena:\s*([0-9\s]+,\d{2})\s*zł/i);
    if (!m) return null;
    const price = parsePriceToGrosze(m[1] + " zł");
    return price != null ? { price, raw: m[0], selectorUsed: "html-regex:xkom" } : null;
  }

  // Media Expert: różne formaty, czasem "2 242 01 zł" albo "2 899,00 zł"
  if (item.strategy === "mediaexpert") {
    const anchor = item.anchorText || "";
    let idx = anchor ? html.indexOf(anchor) : -1;
    if (idx === -1) idx = 0;

    const chunk = html.slice(idx, idx + 12000);

    const m =
      chunk.match(/(\d{1,3}(?:\s\d{3})*)\s+(\d{2})\s*zł/i) ||    // "2 242 01 zł"
      chunk.match(/(\d{1,3}(?:\s\d{3})*),(\d{2})\s*zł/i);        // "2 899,00 zł"

    if (!m) return null;

    const zl = m[1].replace(/\s+/g, "");
    const gr = (m[2] || "00").padStart(2, "0");
    const price = parsePriceToGrosze(`${zl},${gr} zł`);
    return price != null ? { price, raw: m[0], selectorUsed: "html-regex:mediaexpert" } : null;
  }

  return null;
}

async function getPrice(page, item) {
  await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

  await acceptCookies(page, item.strategy);
  await page.waitForTimeout(800);

  const html = await page.content();

  // 1) spróbuj strategii sklepu (najstabilniej)
  const byStrategy = extractPriceFromHtmlByStrategy(html, item);
  if (byStrategy) return byStrategy;

  // 2) fallback: jeżeli w config dodasz selector, nadal zadziała
  if (item.selector) {
    const selectors = item.selector.split(",").map(s => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (!el) continue;
      const raw = (await el.innerText()).trim();
      const price = parsePriceToGrosze(raw);
      if (price != null) return { price, raw, selectorUsed: sel };
    }
  }

  // 3) debug — zapisz html i screenshot, żeby zobaczyć co Playwright widzi
  const shot = await page.screenshot({ fullPage: true }).catch(() => null);
  saveDebugFiles(item.name, html, shot);
  return null;
}

async function runOnce() {
  const cfg = readJson(CONFIG_PATH);
  const state = fs.existsSync(STATE_PATH) ? readJson(STATE_PATH) : {};

  const browser = await chromium.launch({ headless: true }); // jak chcesz widzieć okno -> false
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const results = [];
  const changes = [];

  for (const item of cfg.items) {
    if (!item.url) continue;

    try {
      const res = await getPrice(page, item);
      if (!res) {
        results.push({ item, ok: false, error: "Nie znaleziono ceny (strategia/selektor nie pasuje)" });
        continue;
      }

      const key = item.url;
      const prev = state[key]?.lastPriceGrosze ?? null;

      state[key] = {
        name: item.name,
        lastPriceGrosze: res.price,
        lastSeen: new Date().toISOString(),
        selectorUsed: res.selectorUsed,
        raw: res.raw
      };

      results.push({ item, ok: true, priceGrosze: res.price, prevGrosze: prev });

      if (prev != null && prev !== res.price) {
        changes.push({ name: item.name, url: item.url, from: prev, to: res.price });
      }
    } catch (e) {
      results.push({ item, ok: false, error: String(e) });
    }
  }

  writeJson(STATE_PATH, state);

  // powiadomienia o zmianach
  if (cfg.notifyOnChange && changes.length > 0) {
    const lines = changes.map(c => {
      const dir = c.to < c.from ? "⬇️" : "⬆️";
      return `${dir} **${c.name}**: ${formatPLN(c.from)} → ${formatPLN(c.to)}\n${c.url}`;
    });
    await sendDiscord(cfg.discordWebhookUrl, `💸 **Zmiana cen (${changes.length})**\n\n${lines.join("\n\n")}`);
  }

  // raport po każdym sprawdzeniu (testowo)
  if (cfg.notifyOnEveryCheck) {
    const now = new Date().toLocaleString("pl-PL");
    const lines = results.map(r => {
      if (!r.ok) return `⚠️ **${r.item.name}**: ${r.error}\n${r.item.url}`;
      return `✅ **${r.item.name}**: ${formatPLN(r.priceGrosze)}\n${r.item.url}`;
    });
    await sendDiscord(cfg.discordWebhookUrl, `📦 **Raport cen – ${now}**\n\n${lines.join("\n\n")}`);
  }

  await ctx.close();
  await browser.close();
}

async function main() {
  const cfg = readJson(CONFIG_PATH);
  const pollMs = (cfg.pollMinutes ?? 30) * 60 * 1000;

  await runOnce();
  setInterval(() => runOnce().catch(err => console.error("runOnce error:", err)), pollMs);
}

main().catch(console.error);