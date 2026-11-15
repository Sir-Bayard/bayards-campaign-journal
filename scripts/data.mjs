import { esc, tipAttr } from "./kit/safe-text.mjs";
import { gmTabs } from "./kit/gm-tabs.mjs";
import { FOLDER_KEYS, L, MOD, store } from "./constants.mjs";
import { freshFor, kindFor, notice, partyEdits, readersOf, stripTags } from "./helpers.mjs";

/** Bayard's Campaign Journal: the journal's folders and entries, dates, Markdown and HTML, seen marks and notices. */

/* ------------------------------------------------------------------ */
/* Folders                                                              */
/* ------------------------------------------------------------------ */

const flagsOf = (doc) => doc?.flags?.[MOD] ?? {};
const roleOf = (folder) => flagsOf(folder).role ?? null;

function findFolder(role, userId = null) {
  return game.folders.find((f) => f.type === "JournalEntry" && roleOf(f) === role && (role !== "player" || flagsOf(f).user === userId)) ?? null;
}

/** The journal area a folder belongs to ({ area, user }), looking up through its parents; null outside the journal. */
function areaOf(folder) {
  for (let f = folder, n = 0; f && n < 20; f = f.folder, n++) {
    const role = roleOf(f);
    if (role === "party" || role === "handouts") return { area: role, user: null };
    if (role === "player") return { area: "player", user: flagsOf(f).user ?? null };
    if (role === "root" || role === "players") return null;
  }
  return null;
}


/** One GM in two browser tabs: only the lead tab of the active GM does the GM's work (the kit's election). */
const tabs = gmTabs(MOD);

let ensuring = null;
let ensureAgain = false;
/** Make the journal's folders, and one for each player, if they're missing. Only the active GM's lead tab does
 * this; a call while it runs asks for one more pass, so nothing in between is missed. */
async function ensureFolders() {
  if (!game.user.isGM || !(await tabs.leadNow())) return;
  if (ensuring) {
    ensureAgain = true;
    return ensuring;
  }
  ensuring = (async () => {
    do {
      ensureAgain = false;
      await ensurePass();
    } while (ensureAgain);
  })().catch((err) => console.error(`${MOD} | couldn't make the journal folders`, err)).finally(() => {
    ensuring = null;
  });
  return ensuring;
}
async function ensurePass() {
  const make = (name, role, parent, extra = {}) => Folder.create({ name, type: "JournalEntry", folder: parent?.id ?? null, sorting: "m", flags: { [MOD]: { role, ...extra } } });
  const root = findFolder("root") ?? await make(L(FOLDER_KEYS.root), "root", null);
  for (const role of ["party", "handouts", "players"]) if (!findFolder(role)) await make(L(FOLDER_KEYS[role]), role, root);
  const players = findFolder("players");
  for (const u of game.users) {
    if (u.isGM) continue;
    const f = findFolder("player", u.id);
    if (!f) await make(u.name, "player", players, { user: u.id });
    else if (f.name !== u.name) await f.update({ name: u.name });
  }
}

/* ------------------------------------------------------------------ */
/* Entries                                                              */
/* ------------------------------------------------------------------ */

/** What the journal knows about an entry, or null when it isn't in the journal's folders. */
function describe(entry) {
  const where = areaOf(entry.folder);
  if (!where) return null;
  const f = flagsOf(entry);
  const kind = kindFor(where.area, f.kind);
  const { readers: found, all } = readersOf(entry.ownership, game.users.contents);
  const readers = found.sort((a, b) => who(a).name.localeCompare(who(b).name));
  return { entry, id: entry.id, name: entry.name, kind, area: where.area, user: where.user, pinned: !!f.pinned, pinOrder: Number.isFinite(f.pinOrder) ? f.pinOrder : null, sharedBy: f.sharedBy ?? null, sharedFrom: f.sharedFrom ?? null, author: f.author ?? f.sharedBy ?? null, editable: partyEdits(entry.ownership), subtitle: f.subtitle ?? "", session: f.session ?? null, date: f.date ?? null, played: f.played ?? null, attended: Array.isArray(f.attended) ? f.attended : [], readers, all, sort: entry.sort ?? 0, created: entry._stats?.createdTime ?? 0 };
}

/** What the journal knows (see describe) of every entry in its folders this user can read. */
function readable() {
  const out = [];
  for (const entry of game.journal) {
    if (!entry.testUserPermission(game.user, "OBSERVER")) continue;
    const d = describe(entry);
    if (d) out.push(d);
  }
  return out;
}

/** A title as it files: a leading "A", "An" or "The" (and opening quotes or brackets) left out. */
function titleKey(name) {
  return String(name ?? "").trim().replace(/^[\s"'\u201c\u2018([]+/, "").replace(/^(the|an|a)\s+/i, "");
}
/** By title, library-style: articles ignored, case ignored, numbers in order (Session 2 before Session 10). */
const byName = (a, b) => titleKey(a.name).localeCompare(titleKey(b.name), undefined, { numeric: true, sensitivity: "base" }) || String(a.name).localeCompare(String(b.name));
/** Newest first (by when the entry was made), then by name. */
const byNewest = (a, b) => ((b.created ?? 0) - (a.created ?? 0)) || a.name.localeCompare(b.name);

/** Pinned entries in the GM's order; any without a place yet after them, by name. */
function comparePinned(a, b) {
  const pa = Number.isFinite(a.pinOrder) ? a.pinOrder : null;
  const pb = Number.isFinite(b.pinOrder) ? b.pinOrder : null;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  return byName(a, b);
}

/** Move one id in a list to before (or after) another; the list unchanged when either is missing. */
function moveId(ids, id, target, after = false) {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return [...ids];
  const out = ids.filter((x) => x !== id);
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, id);
  return out;
}

/** Names as a list: "Vance", "Vance and Mira", "Vance, Mira and Kestrel". */
function listOf(names) {
  if (names.length <= 1) return names.join("");
  return L("ListTwo", { a: names.slice(0, -1).join(L("ListSeparator")), b: names.at(-1) });
}

/** A user's short name (their character's, if they have one), initial and color. */
function who(user) {
  const name = user?.character?.name ?? user?.name ?? "?";
  return { name, initial: name.trim().charAt(0).toUpperCase() || "?", color: user?.color?.css ?? String(user?.color ?? "#888") };
}

/** Who can see an entry: "All", "GM" or a dot per reader, each with a plain-text tooltip; screen readers get the
 * same as one sentence instead of the initials. */
function dots(d) {
  const sr = (text) => `<span class="bcj-sr">${esc(text)}</span>`;
  if (d.all && d.editable) return `<span class="bcj-all" aria-hidden="true"${tipAttr(L("AllPlayersCanSeeAndEdit"))}>${esc(L("AllShort"))} <i class="fa-solid fa-pen"></i></span>${sr(L("AllPlayersCanSeeAndEdit"))}`;
  if (d.all) return `<span class="bcj-all" aria-hidden="true"${tipAttr(L("AllPlayersCanSeeThis"))}>${esc(L("AllShort"))}</span>${sr(L("AllPlayersCanSeeThis"))}`;
  if (!d.readers.length) return `<span class="bcj-all bcj-gmonly" aria-hidden="true"${tipAttr(L("OnlyGMsCanSeeThis"))}>${esc(L("GMShort"))}</span>${sr(L("OnlyGMsCanSeeThis"))}`;
  return d.readers.map((u) => {
    const w = who(u);
    return `<span class="bcj-dot" aria-hidden="true" style="--c:${esc(w.color)}" ${tipAttr(L("CanSeeThis", { names: w.name }))}>${esc(w.initial)}</span>`;
  }).join("") + sr(L("CanSeeThis", { names: listOf(d.readers.map((u) => who(u).name)) }));
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
function months() {
  const vals = game.time?.calendar?.months?.values ?? [];
  // Foundry's own calendar names its months with translation keys; calendar modules usually give plain names.
  const L = (key) => (key ? String(game.i18n?.localize?.(String(key)) ?? key) : "");
  return vals.map((m) => {
    const name = L(m.name);
    return { name, short: String(L(m.abbreviation) || name).split(",")[0].trim(), days: m.days };
  });
}
/** Today's in-game date as { y, m, d }, the year as the calendar shows it, months and days from 1. */
function today() {
  const c = game.time.components ?? {};
  const y0 = num(game.time.calendar?.years?.yearZero, 0);
  return { y: num(c.year) + y0, m: num(c.month) + 1, d: num(c.dayOfMonth) + 1 };
}
function fmtDate(x) {
  if (!x || !Number.isFinite(x.y)) return "";
  const mo = months()[x.m - 1];
  return `${x.d} ${mo?.short ?? L("MonthN", { n: x.m })} ${x.y}`;
}
function monthIndex(name) {
  const n = String(name).trim().toLowerCase();
  if (!n) return -1;
  const list = months();
  let i = list.findIndex((m) => m.short.toLowerCase() === n || m.name.toLowerCase() === n);
  if (i < 0 && n.length >= 3) i = list.findIndex((m) => m.short.toLowerCase().startsWith(n) || m.name.toLowerCase().startsWith(n));
  if (i < 0 && /^\d+$/.test(n)) i = Number(n) - 1;
  return i;
}
/** "15 March", "15 March 1200", "March 15" or "1200-03-15", month names from the world's calendar. Null for blank,
 * undefined if unreadable. */
function parseDate(str, defYear = today().y) {
  const s = String(str ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  let y, mi, d;
  let m = s.match(/^(-?\d{1,5})-(\d{1,2})-(\d{1,2})$/);
  if (m) [y, mi, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([^\d,]+?)(?:,?\s+(-?\d{1,5}))?$/i))) [d, mi, y] = [Number(m[1]), monthIndex(m[2]), m[3] ? Number(m[3]) : defYear];
  else if ((m = s.match(/^([^\d,]+?)\s+(\d{1,2})(?:,?\s+(-?\d{1,5}))?$/i))) [mi, d, y] = [monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : defYear];
  else return undefined;
  const list = months();
  if (mi < 0 || (list.length && mi >= list.length)) return undefined;
  const days = list[mi]?.days;
  if (d < 1 || (days && d > days)) return undefined;
  return { y, m: mi + 1, d };
}
/** Today's real date the way recaps write it: "Sat 8 Nov". */
function realDate(dt = new Date()) {
  const wd = dt.toLocaleDateString("en-US", { weekday: "short" });
  const mo = dt.toLocaleDateString("en-US", { month: "short" });
  return `${wd} ${dt.getDate()} ${mo}`;
}

const converter = () => new showdown.Converter({ tables: true, strikethrough: true, simplifiedAutoLink: true, noHeaderId: true, openLinksInNewWindow: true });
const md2html = (md) => (md ? converter().makeHtml(md) : "");
const html2md = (html) => (html ? converter().makeMarkdown(html).replace(/<!-- -->\n?/g, "").trim() : "");

/** A recap's page from the parsed file: the short version in its box, then the rest. */
function recapHTML(r) {
  return `${r.short ? `<blockquote class="bcj-short">${md2html(r.short)}</blockquote>` : ""}${md2html(r.body)}`;
}

/** A text page's HTML without Foundry's GM secret blocks (section.secret) the GM hasn't revealed, unless they may be
 * kept: the page's owners see them in the reading pane, but they never go into downloads, search or "Previously on…"
 * for others. */
function visibleHTML(page, keepSecrets = page.isOwner) {
  const html = page.text?.content ?? "";
  if (keepSecrets || !/secret/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("section.secret:not(.revealed)")) el.remove();
  return doc.body.innerHTML;
}

/** HTML with any secret blocks left in it opened up into their contents, since Markdown would keep the tags. */
function openSections(html) {
  if (!/<section/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("section")) el.replaceWith(...el.childNodes);
  return doc.body.innerHTML;
}

/** A text page's HTML with each GM secret block labeled, for the GM's copy of an export. */
function markedSecretsHTML(page) {
  const html = page.text?.content ?? "";
  if (!/secret/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("section.secret")) {
    const quote = doc.createElement("blockquote");
    const label = doc.createElement("p");
    label.innerHTML = `<strong>${esc(L(el.classList.contains("revealed") ? "GMSecretRevealed" : "GMSecret"))}</strong>`;
    quote.append(label, ...el.childNodes);
    el.replaceWith(quote);
  }
  return doc.body.innerHTML;
}

/** The short version of a recap as HTML: its short box, else its first quote, else its first paragraph. Never from
 * a secret block the GM hasn't revealed, so the GM's popup shows what the players see. */
function shortOf(entry) {
  const page = entry.pages.contents.find((p) => p.type === "text");
  if (!page) return "";
  const doc = new DOMParser().parseFromString(visibleHTML(page, false), "text/html");
  const el = doc.querySelector("blockquote.bcj-short") ?? doc.querySelector("blockquote") ?? doc.querySelector("p");
  return el ? (el.tagName === "BLOCKQUOTE" ? el.innerHTML : el.outerHTML) : "";
}

/** The starting text of a new recap or letter handout, in the user's language. */
const TEMPLATES = {
  get recap() {
    return `<blockquote class="bcj-short"><p>${esc(L("TemplateRecapShort"))}</p></blockquote><h2>${esc(L("TemplateFull"))}</h2><p></p><h2>${esc(L("TemplateNPCs"))}</h2><p></p><h2>${esc(L("TemplatePlaces"))}</h2><p></p><h2>${esc(L("TemplateLoot"))}</h2><p></p>`;
  },
  get letter() {
    return `<p><em>${esc(L("TemplateLetterTo"))}</em></p><p>${esc(L("TemplateLetterText"))}</p><p style="text-align: right"><em>${esc(L("TemplateLetterFrom"))}</em></p>`;
  },
};

/** The line under an entry's name in the list. */
/** A date on the real calendar, short: "Nov 14", with the year when it isn't this year. */
function shortDate(t) {
  const dt = new Date(t);
  const opts = dt.getFullYear() === new Date().getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
  return dt.toLocaleDateString(game.i18n?.lang || undefined, opts);
}
/** When an entry was written, or last changed if that was later. */
function whenLine(d) {
  const made = d.entry._stats?.createdTime ?? 0;
  const changed = stampOf(d.entry);
  return changed - made > 60000 ? L("ChangedOn", { date: shortDate(changed) }) : L("WrittenOn", { date: shortDate(made || changed) });
}
/** The line under an entry in the list: a recap's session and date; otherwise who wrote it, if a player did, and
 * when it was written or changed (the group's heading already says what kind it is). */
function subline(d, tab = null) {
  if (d.kind === "recap") return [d.session ? L("SessionN", { n: d.session }) : L("Recap"), fmtDate(d.date)].filter(Boolean).join(" · ");
  const when = whenLine(d);
  // The GM's Players tab mixes a player's journal with their handouts.
  if (d.kind === "handout") return tab === "players" ? L("HandoutWhen", { when }) : when;
  if (d.kind === "journal") return game.users.get(d.user) ? when : L("FormerJournalWhen", { when });
  if (d.sharedBy) return L("SharedByWhen", { name: who(game.users.get(d.sharedBy)).name, when });
  if (d.author) return L("ByWhen", { name: who(game.users.get(d.author)).name, when });
  return when;
}
/** The subfolder of Party an entry sits in (at any depth below it), or null for one directly in Party. */
function partySubfolder(entry) {
  const party = findFolder("party");
  let f = entry?.folder;
  if (!party || !f || f.id === party.id) return null;
  while (f?.folder && f.folder.id !== party.id) f = f.folder;
  return f?.folder?.id === party.id ? f : null;
}

/** The line under an entry's title in the reading pane. */
function metaline(d) {
  if (d.kind === "recap") {
    if (d.subtitle) return d.subtitle;
    const played = d.played ? L("PlayedOn", { date: d.played }) : "";
    return [d.session ? L("SessionN", { n: d.session }) : L("SessionRecap"), fmtDate(d.date), played].filter(Boolean).join(" · ");
  }
  if (d.kind === "handout") {
    const to = d.all ? L("Everyone") : listOf(d.readers.map((u) => who(u).name)) || L("NoOneYet");
    return L("HandoutFor", { to });
  }
  if (d.kind === "journal") {
    const u = game.users.get(d.user);
    return u ? L("PlayersJournalPrivate", { name: who(u).name }) : L("AFormerPlayerSJournalPrivate");
  }
  const by = d.sharedBy ? L("SharedBy", { name: who(game.users.get(d.sharedBy)).name }) : d.author ? L("WrittenBy", { name: who(game.users.get(d.author)).name }) : d.pinned ? L("PinnedPage") : L("PartyPage");
  return d.editable ? L("PartyCanEditIt", { by }) : by;
}

/* Seen marks: entry id to the change time this user last saw, kept in the user's own flags (as one JSON string, so a
 * pruned entry really goes) so they follow the user to any browser. Before 0.3.0 they were kept in the browser; those
 * are copied once. */
let seenCache;
let seenWritten = null;
let seenTimer = null;
/** This user's seen map, or null before their first load. */
function seenMap() {
  if (seenCache !== undefined) return seenCache;
  const raw = game.user?.getFlag(MOD, "seen");
  let map = null;
  if (typeof raw === "string") {
    try {
      map = JSON.parse(raw);
    } catch {
      map = null;
    }
  }
  if (!map || typeof map !== "object") map = store.get("seen", null);
  seenCache = map && typeof map === "object" ? map : null;
  return seenCache;
}
function saveSeen(map) {
  seenCache = map;
  updateCount();
  // Written a moment later, so reading several entries in a row makes one change to the user.
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => {
    seenWritten = JSON.stringify(seenCache ?? {});
    game.user.setFlag(MOD, "seen", seenWritten).catch((err) => console.warn(`${MOD} | couldn't save what you've read`, err));
  }, 1000);
}
/** The user's seen marks changed in another browser: read them again. Returns true when it was someone else's write. */
function seenChanged(raw) {
  if (raw === seenWritten) return false;
  seenCache = undefined;
  return true;
}
/** When an entry's content last changed (the server's clock): its pages, or the entry's making. Changes to the
 * entry itself (pins, order, who has it, recap details) don't count, so they don't mark it Updated. */
function stampOf(entry) {
  return Math.max(entry._stats?.createdTime ?? 0, ...entry.pages.contents.map((p) => Math.max(p._stats?.modifiedTime ?? 0, p._stats?.createdTime ?? 0)));
}
/** Who made an entry's latest content change: whoever last changed the most recently modified page. */
function lastBy(entry) {
  let best = null;
  for (const p of entry.pages.contents) if (!best || (p._stats?.modifiedTime ?? 0) > (best.modifiedTime ?? 0)) best = p._stats;
  return best?.lastModifiedBy ?? null;
}
/** Whether something is new to this user, never for their own changes: for a player, anything but their own journal;
 * for a GM, what players write (their journals, and party entries a player wrote or shared). */
function freshness(d) {
  if (game.user.isGM ? !(d.area === "player" || (d.area === "party" && (d.author || d.sharedBy))) : d.area === "player" && d.user === game.user.id) return "";
  return freshFor({ seen: (seenMap() ?? {})[d.id], stamp: stampOf(d.entry), lastBy: lastBy(d.entry), me: game.user.id, author: d.author });
}
function markSeen(entry) {
  const map = { ...(seenMap() ?? {}) };
  const stamp = stampOf(entry);
  if (map[entry.id] === stamp) return;
  map[entry.id] = stamp;
  saveSeen(map);
}
/** On a user's first load, everything already there counts as seen, so the list doesn't open full of markers.
 * Later loads drop entries that no longer exist. */
function seedSeen() {
  const had = seenMap();
  if (had) {
    const kept = Object.fromEntries(Object.entries(had).filter(([id]) => game.journal.has(id)));
    const fromBrowser = typeof game.user.getFlag(MOD, "seen") !== "string";
    // Before 0.3.0 the GM had no New marks, so the GM's marks from then cover only what they opened: everything else
    // already there counts as seen, or the GM's first load would mark nearly every player's entry New.
    if (fromBrowser && game.user.isGM) for (const d of readable()) if (!(d.id in kept)) kept[d.id] = stampOf(d.entry);
    // Marks copied from this browser (before 0.3.0) are saved to the user at once, so they follow them from now on.
    if (fromBrowser || Object.keys(kept).length !== Object.keys(had).length) saveSeen(kept);
    return;
  }
  const map = {};
  for (const d of readable()) map[d.id] = stampOf(d.entry);
  saveSeen(map);
}

/** How many entries are New or Updated for this user. */
function unseenCount() {
  return readable().filter((d) => freshness(d)).length;
}
/** Show that count on the Journal tab's button. */
function updateCount() {
  const n = unseenCount();
  for (const btn of document.querySelectorAll(".bcj-open")) {
    const c = btn.querySelector(".bcj-open-count");
    if (c) {
      c.textContent = String(n);
      c.hidden = !n;
    }
    btn.setAttribute("aria-label", n ? L("ButtonCount", { n }) : L("OpenButton"));
  }
}

/** Entries this player has already had a notice for. */
const noticed = new Set();
/** A short notice when something new reaches this player: a recap, a handout, a page or a shared entry. */
function noticeNew(entry) {
  if (game.user.isGM || noticed.has(entry.id) || !entry.testUserPermission(game.user, "OBSERVER")) return;
  const d = describe(entry);
  if (!d || freshness(d) !== "new") return;
  noticed.add(entry.id);
  const what = d.kind === "recap" ? L("NewRecap") : d.kind === "handout" ? L("AHandoutForYou") : d.sharedBy ? L("SharedBy", { name: who(game.users.get(d.sharedBy)).name }) : d.author ? L("NewFrom", { name: who(game.users.get(d.author)).name }) : L("NewInThePartyJournal");
  notice("info", L("NoticeNew", { what, name: entry.name }));
}

/** What an entry's reading pane shows depends on: its pages' content, and which pages (and secrets) this user may
 * read. Two draws with the same key show the same body. */
function bodyKey(entry) {
  const pages = entry.pages.contents.map((p) => `${p.id}:${p._stats?.modifiedTime ?? 0}:${p.testUserPermission(game.user, "OBSERVER") ? (p.isOwner ? 2 : 1) : 0}`);
  return `${entry.id}|${pages.join(",")}`;
}
const bodyCache = new Map();
/** The readable pages of an entry, as HTML (kept for the last few entries, until their content or access changes). */
async function contentHTML(entry) {
  const key = bodyKey(entry);
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  const html = await buildContent(entry);
  bodyCache.set(key, html);
  while (bodyCache.size > 20) bodyCache.delete(bodyCache.keys().next().value);
  return html;
}
async function buildContent(entry) {
  const TE = foundry.applications.ux.TextEditor.implementation;
  const pages = entry.pages.contents.filter((p) => p.testUserPermission(game.user, "OBSERVER")).sort((a, b) => a.sort - b.sort);
  const parts = [];
  for (const p of pages) {
    const heading = pages.length > 1 && p.title?.show !== false ? `<h1 class="bcj-pagename">${esc(p.name)}</h1>` : "";
    if (p.type === "text") {
      const html = await TE.enrichHTML(p.text?.content ?? "", { secrets: p.isOwner, relativeTo: p });
      // Foundry draws a Hide button on a revealed secret even for readers who can't edit the page (CJ33).
      parts.push(`${heading}<div class="bcj-pagebody${p.isOwner ? "" : " bcj-readonly"}">${html}</div>`);
    } else if (p.type === "image" && p.src) {
      parts.push(`${heading}<figure class="bcj-figure"><img src="${esc(p.src)}" alt="${esc(p.image?.caption || p.name)}">${p.image?.caption ? `<figcaption>${esc(p.image.caption)}</figcaption>` : ""}</figure>`);
    } else if (p.type === "video" && p.src) {
      parts.push(`${heading}<video class="bcj-figure" src="${esc(p.src)}" controls></video>`);
    } else {
      parts.push(`${heading}<p class="bcj-hint">${esc(L("OtherPageType", { type: p.type }))} <button type="button" class="bcj-linkbtn" data-action="bcjOpenPage" data-page="${esc(p.id)}">${esc(L("OpenIt"))}</button></p>`);
    }
  }
  return parts.join("") || `<p class="bcj-hint">${esc(L("NothingToReadYet"))}</p>`;
}

/** Plain text of an entry's readable pages, for search (secrets left out for players), kept until it changes. */
const textCache = new Map();
function textOf(entry) {
  // Keyed like the reading pane's body: the text changes with what the user may read (pages, secrets), not only edits.
  const stamp = bodyKey(entry);
  const hit = textCache.get(entry.id);
  if (hit && hit.stamp === stamp) return hit.text;
  const text = entry.pages.contents.filter((p) => p.type === "text" && p.testUserPermission(game.user, "OBSERVER")).map((p) => stripTags(visibleHTML(p))).join(" ");
  textCache.set(entry.id, { stamp, text });
  return text;
}


export { flagsOf, roleOf, findFolder, areaOf, tabs, ensuring, ensureAgain, ensureFolders, ensurePass, describe, readable, titleKey, byName, byNewest, comparePinned, moveId, listOf, who, dots, num, months, today, fmtDate, monthIndex, parseDate, realDate, converter, md2html, html2md, recapHTML, visibleHTML, openSections, markedSecretsHTML, shortOf, TEMPLATES, shortDate, whenLine, subline, partySubfolder, metaline, seenCache, seenWritten, seenTimer, seenMap, saveSeen, seenChanged, stampOf, lastBy, freshness, markSeen, seedSeen, unseenCount, updateCount, noticed, noticeNew, bodyKey, bodyCache, contentHTML, buildContent, textCache, textOf };
