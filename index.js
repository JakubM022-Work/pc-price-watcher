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

async function acceptCookiesIfPresent(page) {
  // Ceneo potrafi mieć różne bannery, więc robimy "best effort"
  const candidates = [
    "text=Zaakceptuj wszystkie",
    "text=Akceptuj wszystkie",
    "text=ZAAKCEPTUJ WSZYSTKIE",
    "text=Akceptuj",
    "text=Zgadzam się",
    "button:has-text('Akceptuj')",
    "button:has-text('Zaakceptuj')",
    "#onetrust-accept-btn-handler"
  ];

  for (const sel of candidates) {
    try {
      const el = await page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(600);
        break;
      }
    } catch {}
  }
}

async function getPriceFromCeneo(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  await acceptCookiesIfPresent(page);
  await page.waitForTimeout(600);

  // Dokładnie jak w Twoim HTML:
  // .product-offer-summary__price-box ... .value + .penny
  const valueLoc = page.locator(".product-offer-summary__price-box .price .value").first();
  const pennyLoc = page.locator(".product-offer-summary__price-box .price .penny").first();

  const hasValue = await valueLoc.count();
  const hasPenny = await pennyLoc.count();

  if (hasValue) {
    const value = (await valueLoc.innerText()).trim(); // np. "2 013"
    const penny = hasPenny ? (await pennyLoc.innerText()).trim() : ",00"; // np. ",99"

    // penny może być ",99" albo "99" — ujednolicamy do ",99"
    const pennyNorm = penny.startsWith(",") ? penny : `,${penny.replace(/\D/g, "").padStart(2, "0")}`;

    const textPrice = `${value}${pennyNorm} zł`;
    const price = parsePriceToGrosze(textPrice);
    if (price != null) {
      return { priceGrosze: price, raw: textPrice, method: "ceneo:summaryBox" };
    }
  }

  // Fallback: jakby layout się zmienił, spróbuj regexem z HTML
  const html = await page.content();
  const m = html.match(/(\d{1,3}(?:\s\d{3})*),(\d{2})\s*zł/i);
  if (m) {
    const zl = m[1].replace(/\s+/g, "");
    const gr = m[2];
    const price = parsePriceToGrosze(`${zl},${gr} zł`);
    if (price != null) return { priceGrosze: price, raw: m[0], method: "ceneo:regex" };
  }

  return null;
}

async function runOnce() {
  const cfg = readJson(CONFIG_PATH);
  const state = fs.existsSync(STATE_PATH) ? readJson(STATE_PATH) : {};

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const results = [];
  const changes = [];

  for (const item of cfg.items) {
    if (!item?.url) continue;

    try {
      const res = await getPriceFromCeneo(page, item.url);
      if (!res) {
        results.push({ item, ok: false, error: "Nie udało się znaleźć ceny na Ceneo" });
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

  writeJson(STATE_PATH, state);

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