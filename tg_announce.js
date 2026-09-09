// Автопостинг анонсов новых статей TehnoRex в Telegram-канал @tehnorexby.
// Источник: ЖИВАЯ лента журнала https://tehnorex.by/zhurnal (sitemap обновляется с задержкой,
// поэтому он не используется — статьи могут быть опубликованы, но отсутствовать в sitemap).
//
// Режимы:
//   node tg_announce.js run        — отправить анонсы только для НОВЫХ статей (нет в логе) [режим воркфлоу]
//   node tg_announce.js baseline   — записать ВСЕ текущие статьи ленты как уже анонсированные (без отправки)
//   node tg_announce.js probe      — показать первые 5 статей ленты, как их увидит скрипт (без отправки)
//   node tg_announce.js test <slug>  — принудительно отправить анонс одной статьи (данные со страницы)
//
// Требования: переменная окружения TELEGRAM_BOT_TOKEN (секрет репозитория).
"use strict";
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("ОШИБКА: не задана переменная окружения TELEGRAM_BOT_TOKEN (добавьте её в секреты репозитория).");
  process.exit(1);
}
const API = "https://api.telegram.org/bot" + TOKEN;

const CHAT = -1002446772680;               // id канала @tehnorexby (TehnoRex.by)
const SITE = "https://tehnorex.by";
const FEED_PAGES = 2;                      // сколько страниц ленты просматривать (на случай пачки статей)
const LOG_FILE = path.join(process.cwd(), "telegram_posted.json");

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- утилиты ----------
function decodeHtml(s) {
  return s
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function stripTags(s) { return decodeHtml(s.replace(/<[^>]*>/g, " ")); }

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return {}; } // { slug: {url, title, sent_at} }
}
function writeLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1), "utf8");
}

async function tg(method, body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) return j.result;
    if (j.error_code === 429) {
      const ms = (j.parameters && j.parameters.retry_after ? j.parameters.retry_after : 2 + i) * 1000;
      await wait(ms);
      continue;
    }
    const err = new Error("tg " + method + ": " + (j.description || JSON.stringify(j)));
    err.tg = j;
    throw err;
  }
  throw new Error("tg " + method + ": rate limit exceeded");
}

async function fetchText(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (TehnoRexBot)" } });
      if (r.ok) return await r.text();
    } catch {}
    await wait(1500 * (i + 1));
  }
  return null;
}

// ---------- разбор карточки статьи из ленты ----------
function parseCard(block) {
  const slugM = block.match(/href="\/zhurnal\/([a-z0-9-]+)"/);
  if (!slugM) return null;
  const slug = slugM[1];
  const titleM = block.match(/<h2[^>]*>\s*<a[^>]*href="\/zhurnal\/[^"]*"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
  const title = titleM ? stripTags(titleM[1]) : slug.replace(/-/g, " ");
  const imgM = block.match(/src="(\/uploads\/originals\/[^"]+)"/);
  const dateM = block.match(/<time[^>]*>([^<]+)<\/time>/i);
  // описание: первый <p> после заголовка
  let desc = "";
  const h2i = block.search(/<h2/i);
  const afterH2 = h2i >= 0 ? block.slice(h2i) : block;
  const pM = afterH2.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (pM) desc = stripTags(pM[1]);
  return {
    slug,
    url: SITE + "/zhurnal/" + slug,
    title,
    desc: desc.slice(0, 400),
    image: imgM ? SITE + imgM[1] : null,
    date: dateM ? dateM[1].trim() : ""
  };
}

async function fetchJournalFeed() {
  const out = [];
  const seen = new Set();
  for (let p = 1; p <= FEED_PAGES; p++) {
    const url = p === 1 ? SITE + "/zhurnal" : SITE + "/zhurnal?page=" + p;
    const html = await fetchText(url);
    if (!html) { console.log("WARN: лента не загрузилась:", url); continue; }
    const parts = html.split('<article class="tr-journal-card');
    for (let i = 1; i < parts.length; i++) {
      const a = parseCard(parts[i]);
      if (a && !seen.has(a.slug)) { seen.add(a.slug); out.push(a); }
    }
  }
  return out; // порядок: новые сначала (страница 1 -> страница 2)
}

// ---------- отправка ----------
function captionOf(a) {
  let c = "\u{1F195} " + a.title + "\n\n";
  if (a.desc) c += a.desc + "\n\n";
  c += "\u27A1\uFE0F " + a.url + "\n\n#tehnorex";
  if (c.length > 1024) c = c.slice(0, 1020) + "\u2026";
  return c;
}

async function sendAnnounce(a) {
  const cap = captionOf(a);
  if (a.image) {
    try {
      return await tg("sendPhoto", { chat_id: CHAT, photo: a.image, caption: cap, disable_web_page_preview: true });
    } catch (e) {
      console.log("  (фото не прошло:", e.message, ") — отправляю текстом");
    }
  }
  const r = await tg("sendMessage", { chat_id: CHAT, text: cap, disable_web_page_preview: false });
  return r;
}

// данные одной статьи со страницы (для режима test)
async function fetchArticle(slug) {
  const html = await fetchText(SITE + "/zhurnal/" + slug);
  if (!html) return null;
  const h1m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const imgM =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    html.match(/src="(\/uploads\/originals\/[^"]+)"/);
  let desc = "";
  const tail = html.indexOf("Читайте также");
  const bd = html.slice(html.indexOf("<h1"), tail > -1 ? tail : html.length);
  const pM = bd.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (pM) desc = stripTags(pM[1]);
  const img = imgM ? imgM[1] : null;
  return {
    slug,
    url: SITE + "/zhurnal/" + slug,
    title: h1m ? stripTags(h1m[1]) : slug.replace(/-/g, " "),
    desc: desc.slice(0, 400),
    image: img ? (img.startsWith("http") ? img : SITE + img) : null,
    date: ""
  };
}

// ---------- режимы ----------
const mode = process.argv[2];
const arg2 = process.argv[3];

(async () => {
  const feed = await fetchJournalFeed();
  console.log("Лента: статей найдено (страницы 1.." + FEED_PAGES + ") —", feed.length);

  if (mode === "baseline") {
    const log = readLog();
    let n = 0;
    for (const e of feed) {
      if (!log[e.slug]) { log[e.slug] = { url: e.url, title: e.title, sent_at: null, baseline: true }; n++; }
    }
    writeLog(log);
    console.log("Baseline записан: помечено —", n, "статей. Всего в логе:", Object.keys(log).length);
    return;
  }

  if (mode === "probe") {
    for (const e of feed.slice(0, 5)) {
      console.log("\nslug:", e.slug);
      console.log("date:", e.date, "| title:", e.title);
      console.log("desc:", e.desc ? e.desc.slice(0, 120) : "(нет)");
      console.log("image:", e.image);
    }
    return;
  }

  if (mode === "test") {
    if (!arg2) { console.log("укажите slug"); return; }
    const a = await fetchArticle(arg2);
    if (!a) { console.log("не удалось загрузить страницу"); return; }
    const res = await sendAnnounce(a);
    console.log("Отправлено. message_id:", res.message_id, "| чат:", res.chat && res.chat.title ? res.chat.title : CHAT);
    const log = readLog();
    log[a.slug] = { url: a.url, title: a.title, sent_at: new Date().toISOString(), message_id: res.message_id };
    writeLog(log);
    return;
  }

  // режим "run" (используется GitHub Actions)
  const log = readLog();
  const fresh = feed.filter(e => !log[e.slug]);
  console.log("Новых статей (нет в логе):", fresh.length);
  if (fresh.length === 0) { console.log("Анонсировать нечего."); return; }
  for (const a of fresh) {
    try {
      const res = await sendAnnounce(a);
      log[a.slug] = { url: a.url, title: a.title, date: a.date, sent_at: new Date().toISOString(), message_id: res && res.message_id };
      writeLog(log);
      console.log("OK:", a.slug, "->", res && res.message_id);
    } catch (err) {
      console.log("FAIL:", a.slug, "-", err.message);
    }
    await wait(400);
  }
  console.log("Готово. Всего в логе:", Object.keys(log).length);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
