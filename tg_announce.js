// Автопостинг анонсов новых статей TehnoRex в Telegram-канал @tehnorexby.
// Работает на GitHub Actions (публичный репозиторий, токен — в секретах).
//
// Режимы:
//   node tg_announce.js run        — отправить анонсы только для НОВЫХ статей (нет в логе) [режим воркфлоу]
//   node tg_announce.js baseline   — записать ВСЕ текущие статьи sitemap как уже анонсированные (без отправки)
//   node tg_announce.js probe <slug> — показать, что будет извлечено из страницы (без отправки)
//   node tg_announce.js test <slug>  — принудительно отправить анонс одной статьи
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
const SM = "https://tehnorex.by/seo/sitemap_journal_1.xml";
const LOG_FILE = path.join(process.cwd(), "telegram_posted.json");
const SITE = "https://tehnorex.by";

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

function metaContent(html, prop) {
  const i = html.indexOf(prop);
  if (i < 0) return null;
  const win = html.slice(i, i + 400);
  const m = win.match(/content\s*=\s*["']([^"']+)["']/i);
  return m ? decodeHtml(m[1]) : null;
}

// ---------- разбор sitemap ----------
async function fetchJournalSitemap() {
  const xml = await fetchText(SM);
  if (!xml) throw new Error("sitemap недоступен: " + SM);
  const out = [];
  const re = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g;
  let m;
  while ((m = re.exec(xml))) {
    const loc = m[1].trim();
    const mm = loc.match(/\/zhurnal\/([^\/?#]+)/);
    if (!mm) continue;
    out.push({ slug: mm[1], url: loc, lastmod: m[2] || "" });
  }
  const seen = new Set();
  return out.filter(e => !seen.has(e.slug) && seen.add(e.slug));
}

// ---------- извлечение данных статьи ----------
async function fetchArticle(slug) {
  const url = SITE + "/zhurnal/" + slug;
  const html = await fetchText(url);
  if (!html) return null;
  const ogTitle = metaContent(html, "og:title");
  const ogDesc = metaContent(html, "og:description");
  const ogImage = metaContent(html, "og:image");
  const hm = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title = hm ? stripTags(hm[1]) : ogTitle;
  if (!title) title = slug.replace(/-/g, " ");
  let desc = ogDesc && ogDesc.length > 20 ? ogDesc : null;
  if (!desc) {
    const tail = html.indexOf("Читайте также");
    const body = html.slice(html.indexOf("<h1"), tail > -1 ? tail : html.length);
    const pm = body.match(/<p[^>]*>([\s\S]*?)<\/p>/g) || [];
    for (const p of pm) {
      const t = stripTags(p);
      if (t.length > 60) { desc = t; break; }
    }
  }
  return { slug, url, title, desc: desc ? desc.slice(0, 400) : "", image: ogImage || null };
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

// ---------- режимы ----------
const mode = process.argv[2];
const arg2 = process.argv[3];

(async () => {
  const entries = await fetchJournalSitemap();
  console.log("Sitemap: статей найдено —", entries.length);

  if (mode === "baseline") {
    const log = readLog();
    let n = 0;
    for (const e of entries) {
      if (!log[e.slug]) { log[e.slug] = { url: e.url, lastmod: e.lastmod, sent_at: null, baseline: true }; n++; }
    }
    writeLog(log);
    console.log("Baseline записан: помечено —", n, "статей. Всего в логе:", Object.keys(log).length);
    return;
  }

  if (mode === "probe") {
    if (!arg2) { console.log("укажите slug"); return; }
    const a = await fetchArticle(arg2);
    if (!a) { console.log("не удалось загрузить страницу"); return; }
    console.log("title:", a.title);
    console.log("desc :", a.desc ? a.desc.slice(0, 200) : "(нет)");
    console.log("image:", a.image);
    console.log("\n--- caption ---\n" + captionOf(a));
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
  const fresh = entries
    .filter(e => !log[e.slug])
    .sort((a, b) => (a.lastmod < b.lastmod ? -1 : a.lastmod > b.lastmod ? 1 : 0));
  console.log("Новых статей (нет в логе):", fresh.length);
  if (fresh.length === 0) { console.log("Анонсировать нечего."); return; }
  for (const e of fresh) {
    const a = await fetchArticle(e.slug);
    if (!a) { console.log("SKIP (страница не загрузилась):", e.slug); continue; }
    try {
      const res = await sendAnnounce(a);
      log[a.slug] = { url: a.url, lastmod: e.lastmod, title: a.title, sent_at: new Date().toISOString(), message_id: res && res.message_id };
      writeLog(log);
      console.log("OK:", a.slug, "->", res && res.message_id);
    } catch (err) {
      console.log("FAIL:", a.slug, "-", err.message);
    }
    await wait(400);
  }
  console.log("Готово. Всего в логе:", Object.keys(log).length);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
