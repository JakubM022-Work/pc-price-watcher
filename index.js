const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { chromium } = require("playwright");
const readline = require("readline");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const STORAGE_PATH = path.join(__dirname, "storageState.json");

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
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
  const candidates = [
    "#onetrust-accept-btn-handler",
    "text=Zaakceptuj wszystkie",
    "text=Akceptuj wszystkie",
    "text=ZAAKCEPTUJ WSZYSTKIE",
    "text=Akceptuj",
    "text=Zgadzam się",
    "button:has-text('Akceptuj')",
    "button:has-text('Zaakceptuj')"
  ];

  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 1200 });
        await page.waitForTimeout(600);
        break;
      }
    } catch {}
  }
}

async function isHumanCheckPage(page) {
  const url = page.url().toLowerCase();

  // twarde sygnały challange
  if (url.includes("/captcha/add")) return true;
  if (url.includes("challenges.cloudflare.com")) return true;

  // elementy typowe dla Turnstile
  try {
    const hasTurnstile = await page.locator("div.cf-turnstile").count();
    if (hasTurnstile > 0) return true;
  } catch {}

  try {
    const hasChallengeIframe = await page.locator('iframe[src*="challenges.cloudflare.com"]').count();
    if (hasChallengeIframe > 0) return true;
  } catch {}

  const title = (await page.title().catch(() => "")).toLowerCase();
  if (title.includes("just a moment")) return true;
  if (title.includes("security verification")) return true;

  return false;
}

async function extractCeneoPrice(page) {
  const valueLoc = page.locator(
    ".product-offer-summary__price-box .price .value, .product-offer-summary__price-box .value, .price-format .value"
  ).first();

  const pennyLoc = page.locator(
    ".product-offer-summary__price-box .price .penny, .product-offer-summary__price-box .penny, .price-format .penny"
  ).first();

  if (await valueLoc.count()) {
    const value = (await valueLoc.innerText()).trim();
    const penny = (await pennyLoc.count()) ? (await pennyLoc.innerText()).trim() : ",00";
    const pennyNorm = penny.startsWith(",") ? penny : `,${penny.replace(/\D/g, "").padStart(2, "0")}`;

    const textPrice = `${value}${pennyNorm} zł`;
    const price = parsePriceToGrosze(textPrice);
    if (price != null) return { priceGrosze: price, raw: textPrice, method: "ceneo:dom:value+penny" };
  }

  // fallback: regex
  const html = await page.content();
  const m =
    html.match(/(\d{1,3}(?:\s\d{3})*),(\d{2})\s*zł/i) ||
    html.match(/(\d{1,3}(?:\s\d{3})*)\s+(\d{2})\s*zł/i);

  if (m) {
    const zl = m[1].replace(/\s+/g, "");
    const gr = m[2];
    const price = parsePriceToGrosze(`${zl},${gr} zł`);
    if (price != null) return { priceGrosze: price, raw: m[0], method: "ceneo:regex" };
  }

  return null;
}

/**
 * brakowało Ci tej funkcji – to jest “silnik” headless/headful
 */
async function getCeneoPriceWithMode(url, headless) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext(
    fs.existsSync(STORAGE_PATH) ? { storageState: STORAGE_PATH } : {}
  );
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);

    const humanCheck = await isHumanCheckPage(page);
    if (humanCheck) {
      return { needsHuman: true, result: null, ctx, browser, page };
    }

    await acceptCookiesIfPresent(page);
    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}

    const result = await extractCeneoPrice(page);
    return { needsHuman: false, result, ctx, browser, page };
  } catch (e) {
    return { needsHuman: false, result: null, error: e, ctx, browser, page };
  }
}

/**
 * Jedyna poprawna wersja – bez duplikatów.
 * Loguje HUMAN CHECK dopiero gdy headful też ma challenge.
 */
async function getCeneoPriceSmart(url, itemName) {
  // 1) headless
  const attempt = await getCeneoPriceWithMode(url, true);

  if (!attempt.needsHuman) {
    await attempt.ctx.storageState({ path: STORAGE_PATH });
    await attempt.ctx.close();
    await attempt.browser.close();
    return attempt.result;
  }

  // headless challenge → przełączamy na headful
  await attempt.ctx.close();
  await attempt.browser.close();

  const headful = await getCeneoPriceWithMode(url, false);

  if (headful.needsHuman) {
    console.log(`\n[HUMAN CHECK] ${itemName}`);
    console.log("W oknie przeglądarki kliknij weryfikację Cloudflare i wejdź na stronę produktu.");
    console.log("Gdy strona produktu się załaduje, wróć do terminala.\n");

    await waitForEnter("Wciśnij Enter, gdy przejdziesz weryfikację i zobaczysz stronę produktu... ");
    await headful.page.waitForTimeout(800);

    await acceptCookiesIfPresent(headful.page);
    try { await headful.page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  }

  const finalResult = await extractCeneoPrice(headful.page);

  await headful.ctx.storageState({ path: STORAGE_PATH });
  await headful.ctx.close();
  await headful.browser.close();

  return finalResult;
}

async function runOnce() {
  const cfg = readJson(CONFIG_PATH);
  const state = fs.existsSync(STATE_PATH) ? readJson(STATE_PATH) : {};

  const results = [];
  const changes = [];

  for (const item of cfg.items) {
    if (!item?.url) continue;

    try {
      const res = await getCeneoPriceSmart(item.url, item.name);

      if (!res) {
        results.push({ item, ok: false, error: "Nie udało się znaleźć ceny (headless + fallback okno)" });
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
}

async function main() {
  const cfg = readJson(CONFIG_PATH);
  const pollMs = (cfg.pollMinutes ?? 30) * 60 * 1000;

  await runOnce();
  setInterval(() => runOnce().catch(err => console.error("runOnce error:", err)), pollMs);
}

main().catch(console.error);