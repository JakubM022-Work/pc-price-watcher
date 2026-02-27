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

  if (num.includes(",") && !num.includes(".")) {
    const [zl, gr = "00"] = num.split(",");
    const zlDigits = zl.replace(/\D/g, "");
    const grDigits = gr.replace(/\D/g, "").slice(0, 2).padEnd(2, "0");
    if (!zlDigits) return null;
    return Number(zlDigits) * 100 + Number(grDigits);
  }

  if (num.includes(".") && !num.includes(",")) {
    const [zl, gr = "00"] = num.split(".");
    const zlDigits = zl.replace(/\D/g, "");
    const grDigits = gr.replace(/\D/g, "").slice(0, 2).padEnd(2, "0");
    if (!zlDigits) return null;
    return Number(zlDigits) * 100 + Number(grDigits);
  }

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
  const title = (await page.title().catch(() => "")).toLowerCase();
  const html = await page.content().catch(() => "");
  return (
    title.includes("security verification") ||
    title.includes("just a moment") ||
    html.toLowerCase().includes("verify you are human") ||
    html.toLowerCase().includes("cf-turnstile") ||
    html.toLowerCase().includes("challenge-platform") ||
    html.toLowerCase().includes("cloudflare")
  );
}

async function getCeneoPrice(page, item) {
  await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  // jeśli wpadło w Cloudflare – czekamy na użytkownika
  if (await isHumanCheckPage(page)) {
    console.log(`\n[HUMAN CHECK] ${item.name}`);
    console.log("W przeglądarce kliknij: 'Potwierdź, że jesteś człowiekiem' / 'Przejdź dalej'.");
    console.log("Gdy zobaczysz normalną stronę produktu na Ceneo, wróć do terminala.\n");
    await waitForEnter("Wciśnij Enter, gdy przejdziesz weryfikację... ");
    await page.waitForTimeout(1000);
  }

  await acceptCookiesIfPresent(page);

  // Poczekaj chwilę na dociągnięcie elementów
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}

  // Szukamy ceny w kilku możliwych miejscach (Ceneo ma różne layouty)
  const selectors = [
    ".product-offer-summary__price-box .price .value",
    ".product-offer-summary__price-box .value",
    ".price-format .value",
    ".product-offer-summary__price-box .price .penny",
    ".price-format .penny"
  ];

  // Najlepszy wariant: value + penny
  const valueLoc = page.locator(".product-offer-summary__price-box .price .value, .product-offer-summary__price-box .value, .price-format .value").first();
  const pennyLoc = page.locator(".product-offer-summary__price-box .price .penny, .product-offer-summary__price-box .penny, .price-format .penny").first();

  if (await valueLoc.count()) {
    const value = (await valueLoc.innerText()).trim();      // np. "2 013"
    const penny = (await pennyLoc.count()) ? (await pennyLoc.innerText()).trim() : ",00"; // ",99"
    const pennyNorm = penny.startsWith(",") ? penny : `,${penny.replace(/\D/g, "").padStart(2, "0")}`;

    const textPrice = `${value}${pennyNorm} zł`;
    const price = parsePriceToGrosze(textPrice);
    if (price != null) return { priceGrosze: price, raw: textPrice, method: "ceneo:dom:value+penny" };
  }

  // Fallback: regex z HTML
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

async function runOnce() {
  const cfg = readJson(CONFIG_PATH);
  const state = fs.existsSync(STATE_PATH) ? readJson(STATE_PATH) : {};

  const browser = await chromium.launch({ headless: false }); // HUMAN-IN-THE-LOOP
  const ctx = await browser.newContext(
    fs.existsSync(STORAGE_PATH) ? { storageState: STORAGE_PATH } : {}
  );
  const page = await ctx.newPage();

  const results = [];
  const changes = [];

  for (const item of cfg.items) {
    if (!item?.url) continue;

    try {
      const res = await getCeneoPrice(page, item);
      if (!res) {
        results.push({ item, ok: false, error: "Nie udało się znaleźć ceny (po weryfikacji nadal brak)" });
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

  // zapis sesji (żeby captcha wyskakiwała rzadziej)
  await ctx.storageState({ path: STORAGE_PATH });

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

  // UWAGA: przy human-in-the-loop 30 min to spam i częstsze captcha.
  // Ale zostawiam jak chcesz — tylko pamiętaj, że może wołać Cię do kompa.
  setInterval(() => runOnce().catch(err => console.error("runOnce error:", err)), pollMs);
}

main().catch(console.error);