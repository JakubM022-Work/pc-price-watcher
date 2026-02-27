const axios = require("axios");

async function sendDiscord(webhookUrl, payload) {
  if (!webhookUrl) return;
  await axios.post(webhookUrl, payload, { timeout: 15000 });
}

function pln(grosze) {
  const zl = Math.floor(grosze / 100);
  const gr = String(grosze % 100).padStart(2, "0");
  return `${zl.toLocaleString("pl-PL")},${gr} zł`;
}

function deltaPLN(from, to) {
  const diff = to - from;
  const abs = Math.abs(diff);
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
  return `${sign}${pln(abs)}`;
}

function domainTag(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "";
  }
}

/**
 * Buduje super estetyczny raport:
 * - 1 embed "header/summary"
 * - każdy produkt jako osobny embed z miniaturką
 * - jeśli jest za dużo produktów -> nadwyżkę dokleja do summary jako lista
 *
 * results: [{ ok, item:{name,url}, priceGrosze?, prevGrosze?, error?, imageUrl? }]
 */
function buildFancyReport({ results, title = "Raport cen", accentColor = 0x3498db }) {
  const nowIso = new Date().toISOString();

  const ok = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);

  const up = ok.filter(r => r.prevGrosze != null && r.priceGrosze > r.prevGrosze).length;
  const down = ok.filter(r => r.prevGrosze != null && r.priceGrosze < r.prevGrosze).length;
  const same = ok.filter(r => r.prevGrosze != null && r.priceGrosze === r.prevGrosze).length;
  const newOnes = ok.filter(r => r.prevGrosze == null).length;

  const summaryLines = [
    `✅ OK: **${ok.length}**`,
    bad.length ? `⚠️ Błędy: **${bad.length}**` : null,
    (up || down || same || newOnes) ? `📈 Zmiany: ⬆️ **${up}**  ⬇️ **${down}**  ➖ **${same}**  🆕 **${newOnes}**` : null
  ].filter(Boolean);

  const embeds = [];

  // 1) HEADER/SUMMARY EMBED
  const header = {
    title: `📦 ${title}`,
    color: accentColor,
    timestamp: nowIso,
    description: summaryLines.join("\n"),
    footer: { text: "PC Price Watcher • Ceneo" }
  };

  // Jeśli mamy błędy, pokaż je w jednym polu w headerze (czytelniej)
  if (bad.length) {
    header.fields = [
      {
        name: "Problemy",
        value: bad.slice(0, 6).map(r => `• **${r.item.name}** — ${String(r.error).slice(0, 120)}`).join("\n"),
        inline: false
      }
    ];
    if (bad.length > 6) {
      header.fields.push({
        name: "…",
        value: `+${bad.length - 6} kolejnych błędów (sprawdź logi)`,
        inline: false
      });
    }
  }

  embeds.push(header);

  // 2) KAFELKI PRODUKTÓW
  // Discord limit: max 10 embedów. Header już 1, więc zostaje 9.
  const maxProductEmbeds = 9;
  const shown = ok.slice(0, maxProductEmbeds);
  const overflow = ok.slice(maxProductEmbeds);

  for (const r of shown) {
    const url = r.item.url;
    const tag = domainTag(url);
    const hasPrev = r.prevGrosze != null;

    const isUp = hasPrev && r.priceGrosze > r.prevGrosze;
    const isDown = hasPrev && r.priceGrosze < r.prevGrosze;

    // kolor per kafelek
    const color = isDown ? 0x2ecc71 : isUp ? 0xe74c3c : 0x95a5a6; // green/red/gray

    const changeLine = !hasPrev
      ? "🆕 Pierwszy odczyt"
      : isDown
        ? `⬇️ Spadek: **${deltaPLN(r.prevGrosze, r.priceGrosze)}**`
        : isUp
          ? `⬆️ Wzrost: **${deltaPLN(r.prevGrosze, r.priceGrosze)}**`
          : "➖ Bez zmian";

    embeds.push({
      title: r.item.name,
      url,
      color,
      timestamp: nowIso,
      description: [
        `**${pln(r.priceGrosze)}**`,
        changeLine,
        tag ? `🏷️ Źródło: \`${tag}\`` : null
      ].filter(Boolean).join("\n"),
      thumbnail: r.imageUrl ? { url: r.imageUrl } : undefined
    });
  }

  // 3) NADWYŻKA PRODUKTÓW (jak jest >9), dopinamy listę do headera jako pole
  if (overflow.length) {
    const extra = overflow
      .slice(0, 20)
      .map(r => `• **${r.item.name}** — ${pln(r.priceGrosze)} (${r.item.url})`)
      .join("\n");

    if (!header.fields) header.fields = [];
    header.fields.push({
      name: `Pozostałe (${overflow.length})`,
      value: extra.length ? extra : "—",
      inline: false
    });
  }

  return { embeds };
}

/**
 * Oddzielny alert tylko gdy są zmiany (ładnie i agresywnie czytelnie)
 * changes: [{ name, url, from, to }]
 */
function buildChangeAlert({ changes }) {
  const nowIso = new Date().toISOString();

  const lines = changes.map(c => {
    const isDown = c.to < c.from;
    const arrow = isDown ? "⬇️" : "⬆️";
    const diff = deltaPLN(c.from, c.to);
    return `${arrow} **${c.name}**\n${pln(c.from)} → **${pln(c.to)}**  (${diff})\n${c.url}`;
  });

  const anyUp = changes.some(c => c.to > c.from);
  const anyDown = changes.some(c => c.to < c.from);

  // kolor: jeśli są spadki -> zielony, jeśli tylko wzrosty -> czerwony, miks -> pomarańcz
  const color =
    anyDown && anyUp ? 0xf39c12 :
    anyDown ? 0x2ecc71 :
    0xe74c3c;

  return {
    embeds: [
      {
        title: `💸 Wykryto zmianę cen (${changes.length})`,
        color,
        timestamp: nowIso,
        description: lines.join("\n\n"),
        footer: { text: "Alert cenowy" }
      }
    ]
  };
}

module.exports = { sendDiscord, buildFancyReport, buildChangeAlert };