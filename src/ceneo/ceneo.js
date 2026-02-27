const readline = require("readline");
const selectors = require("./selectors");

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => { rl.close(); resolve(); });
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

async function acceptCookiesIfPresent(page) {
  for (const sel of selectors.cookieButtons) {
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
  if (url.includes("/captcha/add")) return true;
  if (url.includes("challenges.cloudflare.com")) return true;

  try {
    const hasTurnstile = await page.locator("div.cf-turnstile").count();
    if (hasTurnstile > 0) return true;
  } catch {}

  try {
    const hasIframe = await page.locator('iframe[src*="challenges.cloudflare.com"]').count();
    if (hasIframe > 0) return true;
  } catch {}

  const title = (await page.title().catch(() => "")).toLowerCase();
  if (title.includes("just a moment")) return true;
  if (title.includes("security verification")) return true;

  return false;
}

async function extractCeneoPrice(page) {
  const valueLoc = page.locator(selectors.priceValue).first();
  const pennyLoc = page.locator(selectors.pricePenny).first();

  if (await valueLoc.count()) {
    const value = (await valueLoc.innerText()).trim();
    const penny = (await pennyLoc.count()) ? (await pennyLoc.innerText()).trim() : ",00";
    const pennyNorm = penny.startsWith(",") ? penny : `,${penny.replace(/\D/g, "").padStart(2, "0")}`;

    const textPrice = `${value}${pennyNorm} zł`;
    const price = parsePriceToGrosze(textPrice);
    if (price != null) return { priceGrosze: price, raw: textPrice, method: "ceneo:dom:value+penny" };
  }

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

async function tryGetOgImage(page) {
  // daj stronie chwilę na dociągnięcie head/meta
  try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch {}

  const makeAbs = (u) => {
    if (!u) return null;
    if (u.startsWith("//")) return "https:" + u;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    if (u.startsWith("/")) return "https://www.ceneo.pl" + u;
    return u;
  };

  // 1) og:image
  try {
    const loc = page.locator('meta[property="og:image"]').first();
    if (await loc.count()) {
      const u = makeAbs(await loc.getAttribute("content"));
      if (u && u.startsWith("http")) return u;
    }
  } catch {}

  // 2) image_src
  try {
    const loc = page.locator('link[rel="image_src"]').first();
    if (await loc.count()) {
      const u = makeAbs(await loc.getAttribute("href"));
      if (u && u.startsWith("http")) return u;
    }
  } catch {}

  // 3) pierwszy sensowny img
  try {
    const u = await page.evaluate(() => {
      const imgs = Array.from(document.images || []);
      const best = imgs
        .map(img => img.currentSrc || img.src || "")
        .filter(u => u.startsWith("http"))
        .find(u => /(\.jpg|\.jpeg|\.png|\.webp)/i.test(u));
      return best || null;
    });
    return makeAbs(u);
  } catch {}

  return null;
}

async function fetchPriceSmart({ item, headlessAttempt, launchContext, saveStorage, closeAll, storagePath }) {
  // HEADLESS attempt
  let s1 = await launchContext({ headless: headlessAttempt, storagePath });
  try {
    await s1.page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await s1.page.waitForTimeout(1200);

    const challenge = await isHumanCheckPage(s1.page);
    if (!challenge) {
      await acceptCookiesIfPresent(s1.page);
      try { await s1.page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}

      const res = await extractCeneoPrice(s1.page);
      if (res) res.imageUrl = await tryGetOgImage(s1.page);
      await saveStorage(s1.ctx, storagePath);
      return res;
    }
  } finally {
    await closeAll(s1);
  }

  // HEADFUL fallback (okno) — tylko jeśli headless się odbił
  const s2 = await launchContext({ headless: false, storagePath });
  try {
    await s2.page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await s2.page.waitForTimeout(1200);

    if (await isHumanCheckPage(s2.page)) {
      console.log(`\n[HUMAN CHECK] ${item.name}`);
      console.log("Kliknij weryfikację w oknie przeglądarki i przejdź na stronę produktu.");
      await waitForEnter("Gdy gotowe, wciśnij Enter... ");
    }

    await acceptCookiesIfPresent(s2.page);
    try { await s2.page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}

    const res = await extractCeneoPrice(s2.page);
    if (res) res.imageUrl = await tryGetOgImage(s2.page);
    await saveStorage(s2.ctx, storagePath);
    return res;
  } finally {
    await closeAll(s2);
  }
}

module.exports = {
  fetchPriceSmart,
  formatPLN,
  tryGetOgImage
};