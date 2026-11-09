/**
 * Bayard's Campaign Journal
 * A journal window over ordinary journal entries: the party journal (session recaps and standing
 * entries), handouts given to players, and each player's private journal. Everything stays a normal
 * Foundry journal entry in a "Campaign Journal" folder, so nothing is lost without the module.
 */

const MOD = "bayards-campaign-journal";
const VIEW_KEY = `${MOD}.view`;
/** Ownership levels (CONST.DOCUMENT_OWNERSHIP_LEVELS), written out so the helpers run without Foundry. */
const LEVEL = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
const FOLDER_NAMES = { root: "Campaign Journal", party: "Party", handouts: "Handouts", players: "Players" };
/** The kinds of entry, and the kind an entry gets in each area when it has none of its own. */
const KINDS = ["recap", "page", "handout", "journal"];
const AREA_KIND = { party: "page", handouts: "handout", player: "journal" };

/* ------------------------------------------------------------------ */
/* Helpers (no Foundry needed)                                         */
/* ------------------------------------------------------------------ */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stripTags = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** An entry's kind from its area and its own flag: a recap only in the party journal, otherwise the area's kind. */
function kindFor(area, flagKind) {
  if (!area) return null;
  if (area === "party") return flagKind === "recap" ? "recap" : "page";
  return AREA_KIND[area];
}

/** A user's ownership level on a document: their own level, else the default (inherit means the default). */
function levelFor(ownership, userId) {
  const own = ownership ?? {};
  const mine = own[userId];
  if (mine !== undefined && mine !== LEVEL.INHERIT) return mine;
  return own.default ?? LEVEL.NONE;
}

/** The players (non-GM users) who can read a document with this ownership, and whether it's shared with every
 * player (by its default level, so players who join later see it too), not just the ones who happen to be here. */
function readersOf(ownership, users) {
  const players = users.filter((u) => !u.isGM);
  const readers = players.filter((u) => levelFor(ownership, u.id) >= LEVEL.OBSERVER);
  return { readers, all: (ownership?.default ?? LEVEL.NONE) >= LEVEL.OBSERVER };
}

/** Sort recaps newest first by session number, then by the folder's manual order. */
function compareRecaps(a, b) {
  const sa = Number(a.session) || 0, sb = Number(b.session) || 0;
  if (sa !== sb) return sb - sa;
  return (a.sort ?? 0) - (b.sort ?? 0);
}

/** Whether an entry matches a search: every word of the query in its title or its text. */
function matches(query, title, text) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${title ?? ""} ${text ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Read a recap laid out the session-recap way: "# Session N: Title", an italic line, a "## Short" section, then
 * the rest. Returns { session, title, subtitle, short, body }, with short and body still Markdown. */
function parseRecap(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && !lines[i].trim()) i++;
  };
  skipBlank();
  let session = null, title = "", subtitle = "";
  const h1 = lines[i]?.match(/^#\s+(.+?)\s*#*\s*$/);
  if (h1) {
    i++;
    const name = h1[1].trim();
    const m = name.match(/^Session\s+(\d+)\s*(?:[:.]|-)\s*(.*)$/i) ?? name.match(/^Session\s+(\d+)$/i);
    if (m) {
      session = Number(m[1]);
      title = (m[2] ?? "").trim();
    } else title = name;
    skipBlank();
  }
  const it = lines[i]?.trim().match(/^([*_])(?!\1)(.+)\1$/);
  if (it) {
    subtitle = it[2].trim();
    i++;
  }
  const rest = lines.slice(i);
  let short = "", body = rest;
  const at = rest.findIndex((l) => /^##\s+short\s*#*\s*$/i.test(l.trim()));
  if (at >= 0) {
    let end = at + 1;
    while (end < rest.length && !/^#{1,2}\s/.test(rest[end])) end++;
    short = rest.slice(at + 1, end).join("\n").trim();
    body = [...rest.slice(0, at), ...rest.slice(end)];
  }
  return { session, title, subtitle, short, body: body.join("\n").trim() };
}

/** The parts of a recap's italic line: who was away ("Edric absent", "Mira and Edric away"), the real date
 * ("Sat 15 Nov"), and the other parts (the place, the in-game date), split on middle dots or bars. */
function splitDetails(line) {
  const out = { absent: [], played: "", rest: [] };
  for (const raw of String(line ?? "").split(/\s*[·•|]\s*/)) {
    const part = raw.trim();
    if (!part) continue;
    const away = part.match(/^(.*?)\s+(?:absent|away|missing|not there)$/i) ?? part.match(/^(?:absent|away|missing)\s*:?\s+(.*)$/i);
    if (away) out.absent.push(...away[1].split(/\s*(?:,|&|\band\b)\s*/i).map((n) => n.trim()).filter(Boolean));
    else if (!out.played && /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(?:\d{1,2}\s+[a-z]{3,}|[a-z]{3,}\.?\s+\d{1,2})/i.test(part)) out.played = part;
    else out.rest.push(part);
  }
  return out;
}

/** An entry name for a recap: "Session 3: The Lantern", or whichever part there is. */
function recapName(session, title) {
  const t = String(title ?? "").trim();
  if (session && t) return `Session ${session}: ${t}`;
  return t || (session ? `Session ${session}` : "Session recap");
}

/** The ownership for giving a document to everyone, or to some players. Owners keep their level, and players who
 * shouldn't have it are set to None, since a level of their own outranks the default. */
function ownershipFor(current, everyone, readerIds, playerIds) {
  const own = { ...(current ?? {}) };
  own.default = everyone ? Math.max(LEVEL.OBSERVER, own.default ?? LEVEL.NONE) : LEVEL.NONE;
  for (const id of playerIds) {
    if (own[id] === LEVEL.OWNER) continue;
    if (everyone) {
      if (own[id] !== undefined && own[id] < LEVEL.OBSERVER) own[id] = LEVEL.OBSERVER;
    } else own[id] = readerIds.includes(id) ? LEVEL.OBSERVER : LEVEL.NONE;
  }
  return own;
}

/** Markdown with every heading moved down by some levels (at most to level 6), leaving code blocks alone. */
function shiftHeadings(md, by) {
  if (!by) return md;
  let fence = false;
  return String(md).split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return line;
    return line.replace(/^(#{1,6})(\s)/, (m, h, sp) => `${"#".repeat(Math.min(6, h.length + by))}${sp}`);
  }).join("\n");
}

/** Whether a player has seen an entry as it is: "new" (never opened), "updated" (changed since) or "". */
function freshnessOf(seen, stamp) {
  if (seen === undefined || seen === null) return "new";
  return (Number(stamp) || 0) > Number(seen) ? "updated" : "";
}

/** Freshness for one player: nothing for their own latest change, and their own party entry is never "new". */
function freshFor({ seen, stamp, lastBy, me, author }) {
  if (lastBy && lastBy === me) return "";
  if (author && author === me && (seen === undefined || seen === null)) return "";
  return freshnessOf(seen, stamp);
}

/** Ownership for a party entry the party can, or can't, edit; its author always keeps Owner. */
function editOwnership(on, authorId = null) {
  const out = { default: on ? LEVEL.OWNER : LEVEL.OBSERVER };
  if (authorId) out[authorId] = LEVEL.OWNER;
  return out;
}

/** Whether every player can edit an entry (default ownership Owner). */
const partyEdits = (ownership) => (ownership?.default ?? LEVEL.NONE) >= LEVEL.OWNER;

/** A file name from an entry name. */
const slug = (name) => String(name ?? "entry").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "entry";

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

const isPrimaryGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/** Make the journal's folders, and one for each player, if they're missing. Only the active GM does this. */
let ensuring = null;
async function ensureFolders() {
  if (!isPrimaryGM()) return;
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const make = (name, role, parent, extra = {}) => Folder.create({ name, type: "JournalEntry", folder: parent?.id ?? null, sorting: "m", flags: { [MOD]: { role, ...extra } } });
    const root = findFolder("root") ?? await make(FOLDER_NAMES.root, "root", null);
    for (const role of ["party", "handouts", "players"]) if (!findFolder(role)) await make(FOLDER_NAMES[role], role, root);
    const players = findFolder("players");
    for (const u of game.users) {
      if (u.isGM) continue;
      const f = findFolder("player", u.id);
      if (!f) await make(u.name, "player", players, { user: u.id });
      else if (f.name !== u.name) await f.update({ name: u.name });
    }
  })().catch((err) => console.error(`${MOD} | couldn't make the journal folders`, err)).finally(() => {
    ensuring = null;
  });
  return ensuring;
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
  return { entry, id: entry.id, name: entry.name, kind, area: where.area, user: where.user, pinned: !!f.pinned, pinOrder: Number.isFinite(f.pinOrder) ? f.pinOrder : null, sharedBy: f.sharedBy ?? null, sharedFrom: f.sharedFrom ?? null, author: f.author ?? f.sharedBy ?? null, editable: partyEdits(entry.ownership), subtitle: f.subtitle ?? "", session: f.session ?? null, date: f.date ?? null, played: f.played ?? null, attended: Array.isArray(f.attended) ? f.attended : [], readers, all, sort: entry.sort ?? 0 };
}

/** Every journal entry this user can read. */
function readable() {
  const out = [];
  for (const entry of game.journal) {
    if (!entry.testUserPermission(game.user, "OBSERVER")) continue;
    const d = describe(entry);
    if (d) out.push(d);
  }
  return out;
}

const byName = (a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name);

/** Pinned entries in the GM's order; any without a place yet (pinned before ordering existed) after them, by name. */
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
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A short name and initial for a user: their character's name if they have one. */
function who(user) {
  const name = user?.character?.name ?? user?.name ?? "?";
  return { name, initial: name.trim().charAt(0).toUpperCase() || "?", color: user?.color?.css ?? String(user?.color ?? "#888") };
}

function dots(d) {
  if (d.all && d.editable) return `<span class="bcj-all" data-tooltip="All players can see and edit this">All <i class="fa-solid fa-pen"></i></span>`;
  if (d.all) return `<span class="bcj-all" data-tooltip="All players can see this">All</span>`;
  if (!d.readers.length) return `<span class="bcj-all bcj-gmonly" data-tooltip="Only GMs can see this">GM</span>`;
  return d.readers.map((u) => {
    const w = who(u);
    return `<span class="bcj-dot" style="--c:${esc(w.color)}" data-tooltip="${esc(w.name)} can see this">${esc(w.initial)}</span>`;
  }).join("");
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
function months() {
  const vals = game.time?.calendar?.months?.values ?? [];
  return vals.map((m) => ({ name: m.name, short: String(m.abbreviation || m.name).split(",")[0].trim(), days: m.days }));
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
  return `${x.d} ${mo?.short ?? `Month ${x.m}`} ${x.y}`;
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
/** "15 Vind", "15 Vind 1534", "Vind 15" or "1534-12-15". Null for blank, undefined if unreadable. */
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

/** The short version of a recap as HTML: its short box, else its first quote, else its first paragraph. */
function shortOf(entry) {
  const page = entry.pages.contents.find((p) => p.type === "text");
  if (!page) return "";
  const doc = new DOMParser().parseFromString(page.text?.content ?? "", "text/html");
  const el = doc.querySelector("blockquote.bcj-short") ?? doc.querySelector("blockquote") ?? doc.querySelector("p");
  return el ? (el.tagName === "BLOCKQUOTE" ? el.innerHTML : el.outerHTML) : "";
}

const TEMPLATES = {
  recap: `<blockquote class="bcj-short"><p>The whole session in a paragraph.</p></blockquote><h2>Full</h2><p></p><h2>NPCs Met</h2><p></p><h2>Places Visited</h2><p></p><h2>Loot and Treasure</h2><p></p>`,
  letter: `<p><em>To whoever reads this,</em></p><p>The letter's text.</p><p style="text-align: right"><em>The writer</em></p>`,
};

/** The line under an entry's name in the list. */
function subline(d) {
  if (d.kind === "recap") return [d.session ? `Session ${d.session}` : "Recap", fmtDate(d.date)].filter(Boolean).join(" · ");
  if (d.kind === "handout") return "Handout";
  if (d.kind === "journal") {
    const u = game.users.get(d.user);
    return u?.id === game.user.id ? "Private" : `${who(u).name}'s journal`;
  }
  if (d.sharedBy) return `Shared by ${who(game.users.get(d.sharedBy)).name}`;
  if (d.author) return `By ${who(game.users.get(d.author)).name}`;
  return d.pinned ? "Pinned" : "Page";
}

/** The line under an entry's title in the reading pane. */
function metaline(d) {
  if (d.kind === "recap") {
    if (d.subtitle) return d.subtitle;
    const played = d.played ? `played ${d.played}` : "";
    return [d.session ? `Session ${d.session}` : "Session recap", fmtDate(d.date), played].filter(Boolean).join(" · ");
  }
  if (d.kind === "handout") {
    const to = d.all ? "everyone" : listOf(d.readers.map((u) => who(u).name)) || "no one yet";
    return `Handout · for ${to}`;
  }
  if (d.kind === "journal") {
    const u = game.users.get(d.user);
    return `${who(u).name}'s journal · private`;
  }
  const by = d.sharedBy ? `Shared by ${who(game.users.get(d.sharedBy)).name}` : d.author ? `Written by ${who(game.users.get(d.author)).name}` : d.pinned ? "Pinned page" : "Party page";
  return d.editable ? `${by} · the party can edit it` : by;
}

const SEEN_KEY = `${MOD}.seen`;
let seenCache;
/** This player's map of entry id to the change time they last saw, or null before the first load. */
function seenMap() {
  if (seenCache === undefined) {
    try {
      seenCache = JSON.parse(localStorage.getItem(SEEN_KEY));
    } catch {
      seenCache = null;
    }
  }
  return seenCache;
}
function saveSeen(map) {
  seenCache = map;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    /* no storage: markers last until the page reloads */
  }
}
/** When an entry or any of its pages last changed (the server's clock). */
function stampOf(entry) {
  return Math.max(entry._stats?.modifiedTime ?? 0, entry._stats?.createdTime ?? 0, ...entry.pages.contents.map((p) => p._stats?.modifiedTime ?? 0));
}
/** Who made an entry's latest change: the entry or whichever page changed last. */
function lastBy(entry) {
  let best = entry._stats;
  for (const p of entry.pages.contents) if ((p._stats?.modifiedTime ?? 0) > (best?.modifiedTime ?? 0)) best = p._stats;
  return best?.lastModifiedBy ?? null;
}
/** Whether something is new to this player: never for a GM or their own journal; not for their own changes. */
function freshness(d) {
  if (game.user.isGM || (d.area === "player" && d.user === game.user.id)) return "";
  return freshFor({ seen: (seenMap() ?? {})[d.id], stamp: stampOf(d.entry), lastBy: lastBy(d.entry), me: game.user.id, author: d.author });
}
function markSeen(entry) {
  const map = { ...(seenMap() ?? {}) };
  const stamp = stampOf(entry);
  if (map[entry.id] === stamp) return;
  map[entry.id] = stamp;
  saveSeen(map);
}
/** On a player's first load, everything already there counts as seen, so the list doesn't open full of markers. */
function seedSeen() {
  if (game.user.isGM || seenMap()) return;
  const map = {};
  for (const d of readable()) map[d.id] = stampOf(d.entry);
  saveSeen(map);
}

/** A short notice when something new reaches this player: a recap, a handout, a page or a shared entry. */
const noticed = new Set();
function noticeNew(entry) {
  if (game.user.isGM || noticed.has(entry.id) || !entry.testUserPermission(game.user, "OBSERVER")) return;
  const d = describe(entry);
  if (!d || freshness(d) !== "new") return;
  noticed.add(entry.id);
  const what = d.kind === "recap" ? "New recap" : d.kind === "handout" ? "A handout for you" : d.sharedBy ? `Shared by ${who(game.users.get(d.sharedBy)).name}` : d.author ? `New from ${who(game.users.get(d.author)).name}` : "New in the party journal";
  ui.notifications.info(`Campaign Journal: ${what}: ${entry.name}`);
}

/** The readable pages of an entry, as HTML. */
async function contentHTML(entry) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  const pages = entry.pages.contents.filter((p) => p.testUserPermission(game.user, "OBSERVER")).sort((a, b) => a.sort - b.sort);
  const parts = [];
  for (const p of pages) {
    const heading = pages.length > 1 && p.title?.show !== false ? `<h1 class="bcj-pagename">${esc(p.name)}</h1>` : "";
    if (p.type === "text") {
      const html = await TE.enrichHTML(p.text?.content ?? "", { secrets: p.isOwner, relativeTo: p });
      parts.push(`${heading}${html}`);
    } else if (p.type === "image" && p.src) {
      parts.push(`${heading}<figure class="bcj-figure"><img src="${esc(p.src)}" alt="${esc(p.image?.caption || p.name)}">${p.image?.caption ? `<figcaption>${esc(p.image.caption)}</figcaption>` : ""}</figure>`);
    } else if (p.type === "video" && p.src) {
      parts.push(`${heading}<video class="bcj-figure" src="${esc(p.src)}" controls></video>`);
    } else {
      parts.push(`${heading}<p class="bcj-hint">This page (${esc(p.type)}) opens in Foundry's own viewer. <a data-action="bcjOpenPage" data-page="${esc(p.id)}">Open it</a></p>`);
    }
  }
  return parts.join("") || `<p class="bcj-hint">This entry has nothing to read yet.</p>`;
}

/** Plain text of an entry's readable pages, for search. */
function textOf(entry) {
  return entry.pages.contents.filter((p) => p.type === "text" && p.testUserPermission(game.user, "OBSERVER")).map((p) => stripTags(p.text?.content)).join(" ");
}

/* ------------------------------------------------------------------ */
/* The window                                                           */
/* ------------------------------------------------------------------ */

const openApps = new Set();
let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const app of openApps) if (app.rendered) app.render();
  }, 100);
}

function loadView() {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveView(v) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ tab: v.tab, entry: v.entry }));
  } catch {
    /* no storage: the view resets on reload */
  }
}

const SIZE_KEY = `${MOD}.size`;
/** The window's last size and place in this browser, kept inside the screen. */
function loadSize() {
  let v;
  try {
    v = JSON.parse(localStorage.getItem(SIZE_KEY));
  } catch {
    return {};
  }
  if (!v || typeof v !== "object") return {};
  // A size saved while the window was collapsed is no size at all.
  if (!(v.width >= 400 && v.height >= 250)) return {};
  const out = {};
  const W = window.innerWidth, H = window.innerHeight;
  if (Number.isFinite(v.width)) out.width = Math.max(400, Math.min(v.width, W));
  if (Number.isFinite(v.height)) out.height = Math.max(250, Math.min(v.height, H));
  if (Number.isFinite(v.left)) out.left = Math.max(0, Math.min(v.left, W - (out.width ?? 400)));
  if (Number.isFinite(v.top)) out.top = Math.max(0, Math.min(v.top, H - (out.height ?? 250)));
  return out;
}
let sizeTimer = null;
function saveSize(pos) {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify({ width: pos.width, height: pos.height, left: pos.left, top: pos.top }));
    } catch {
      /* no storage: the window opens at its default size */
    }
  }, 300);
}

class JournalApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: MOD,
    classes: ["bcj"],
    tag: "div",
    window: { title: "Campaign Journal", icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 1120, height: 760 },
    actions: {
      bcjTab: JournalApp.#onTab,
      bcjEntry: JournalApp.#onEntry,
      bcjEdit: JournalApp.#onEdit,
      bcjOpenPage: JournalApp.#onOpenPage,
      bcjToc: JournalApp.#onToc,
      bcjFolders: JournalApp.#onFolders,
      bcjNewRecap: JournalApp.#onNewRecap,
      bcjNewHandout: JournalApp.#onNewHandout,
      bcjNewPage: JournalApp.#onNewPage,
      bcjDetails: JournalApp.#onDetails,
      bcjPin: JournalApp.#onPin,
      bcjGive: JournalApp.#onGive,
      bcjShow: JournalApp.#onShow,
      bcjPrevious: JournalApp.#onPrevious,
      bcjMarkdown: JournalApp.#onMarkdown,
      bcjExport: JournalApp.#onExport,
      bcjNewEntry: JournalApp.#onNewEntry,
      bcjNewParty: JournalApp.#onNewParty,
      bcjEditing: JournalApp.#onEditing,
      bcjShare: JournalApp.#onShare,
      bcjDelete: JournalApp.#onDelete,
    },
  };

  constructor(options = {}) {
    super(foundry.utils.mergeObject({ position: loadSize() }, options));
    const saved = loadView();
    this.view = { tab: saved.tab ?? "party", entry: saved.entry ?? null, query: "" };
    this.texts = new Map();
  }

  get isGM() {
    return game.user.isGM;
  }

  /** The tabs this user has: Party, then My Journal for players, or Handouts and Players for GMs. */
  tabs() {
    return this.isGM
      ? [["party", "Party", "fa-solid fa-users"], ["handouts", "Handouts", "fa-solid fa-envelope-open-text"], ["players", "Players", "fa-solid fa-user-group"]]
      : [["party", "Party", "fa-solid fa-users"], ["mine", "My Journal", "fa-solid fa-feather"]];
  }

  /** A tab's groups (the current tab unless named): [heading, entries, empty text]. */
  groups(all, tab = this.view.tab) {
    if (tab === "party") {
      // Anything on this tab can be pinned to the top: pages, recaps, shared copies, handouts for everyone.
      const party = all.filter((d) => d.area === "party");
      const handouts = all.filter((d) => d.kind === "handout" && d.all);
      return [
        ["Pinned", [...party, ...handouts].filter((d) => d.pinned).sort(comparePinned), null],
        ["Recaps", party.filter((d) => d.kind === "recap" && !d.pinned).sort(compareRecaps), "No recaps yet."],
        ["Pages", party.filter((d) => d.kind !== "recap" && !d.pinned).sort(byName), null],
        ["Handouts for everyone", handouts.filter((d) => !d.pinned).sort(byName), null],
      ];
    }
    if (tab === "mine") {
      return [
        ["My entries", all.filter((d) => d.area === "player" && d.user === game.user.id).sort(byName), "Nothing written yet."],
        ["Handouts for me", all.filter((d) => d.kind === "handout" && !d.all).sort(byName), null],
      ];
    }
    if (tab === "handouts") {
      const h = all.filter((d) => d.kind === "handout");
      return [
        ["For everyone", h.filter((d) => d.all).sort(byName), null],
        ["For some players", h.filter((d) => !d.all && d.readers.length).sort(byName), null],
        ["Not given yet", h.filter((d) => !d.readers.length).sort(byName), null],
      ];
    }
    // GM: one group per player, with their journal and the handouts only some players have.
    return game.users.filter((u) => !u.isGM).sort((a, b) => a.name.localeCompare(b.name)).map((u) => [
      who(u).name === u.name ? u.name : `${u.name} (${who(u).name})`,
      [...all.filter((d) => d.area === "player" && d.user === u.id).sort(byName), ...all.filter((d) => d.kind === "handout" && !d.all && d.readers.some((r) => r.id === u.id)).sort(byName)],
      "Nothing yet.",
    ]);
  }

  async _renderHTML() {
    const tabs = this.tabs();
    if (!tabs.some(([k]) => k === this.view.tab)) this.view.tab = "party";
    const all = readable();
    const groups = this.groups(all).filter(([, list, empty]) => list.length || empty);
    const shown = groups.flatMap(([, list]) => list);
    if (!shown.some((d) => d.id === this.view.entry)) this.view.entry = shown[0]?.id ?? null;
    saveView(this.view);
    this.texts = new Map(shown.map((d) => [d.id, textOf(d.entry)]));
    const current = shown.find((d) => d.id === this.view.entry) ?? null;
    if (current && !this.isGM) markSeen(current.entry);

    const mark = (d) => {
      const f = freshness(d);
      return f ? `<b class="bcj-new bcj-${f}">${f === "new" ? "New" : "Updated"}</b>` : "";
    };
    const unseenIn = (k) => !this.isGM && this.groups(all, k).some(([, items]) => items.some((d) => freshness(d)));
    const rail = tabs.map(([k, label, icon]) => `<a class="bcj-tab ${k === this.view.tab ? "active" : ""}" data-action="bcjTab" data-tab="${k}"><i class="${icon}"></i><span>${label}</span>${unseenIn(k) ? `<i class="bcj-dotnew" data-tooltip="Something new"></i>` : ""}</a>`).join("");
    const list = groups.map(([heading, items, empty]) => `<div class="bcj-group" data-group="${esc(heading)}"><div class="bcj-gh">${esc(heading)}</div>${items.length ? items.map((d) => `<a class="bcj-item ${d.id === this.view.entry ? "active" : ""}" data-action="bcjEntry" data-entry="${esc(d.id)}">
        <span class="bcj-it">${esc(d.name)}</span><span class="bcj-is">${mark(d)}${esc(subline(d))}</span><span class="bcj-iw">${dots(d)}</span></a>`).join("") : `<p class="bcj-none">${esc(empty)}</p>`}</div>`).join("");
    const noFolders = this.isGM && !findFolder("root");
    const listBody = shown.length || groups.length ? list : "";

    return `<div class="bcj-shell">
      <nav class="bcj-rail">${rail}<div class="bcj-railfoot"><a data-action="bcjExport" data-tooltip="Download this tab's entries as one Markdown file"><i class="fa-solid fa-file-export"></i><span>Export</span></a>${this.isGM ? `<a data-action="bcjFolders" data-tooltip="Show the journal's folders in the Journal tab"><i class="fa-solid fa-folder-tree"></i><span>Folders</span></a>` : ""}</div></nav>
      <section class="bcj-list">
        <div class="bcj-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" name="bcj-q" placeholder="Search the journal" value="${esc(this.view.query)}"></div>
        ${this.isGM ? `<div class="bcj-actions"><button type="button" data-action="bcjNewRecap" data-tooltip="New session recap"><i class="fa-solid fa-plus"></i> Recap</button><button type="button" data-action="bcjNewHandout" data-tooltip="New handout"><i class="fa-solid fa-plus"></i> Handout</button><button type="button" data-action="bcjNewPage" data-tooltip="New page in the party journal, such as Lines and Veils or house rules"><i class="fa-solid fa-plus"></i> Page</button></div>` : this.view.tab === "mine" ? `<div class="bcj-actions"><button type="button" data-action="bcjNewEntry"><i class="fa-solid fa-feather"></i> New entry</button></div>` : this.view.tab === "party" ? `<div class="bcj-actions"><button type="button" data-action="bcjNewParty" data-tooltip="An entry everyone can read, signed with your name"><i class="fa-solid fa-feather"></i> New party entry</button></div>` : ""}
        <div class="bcj-scroll">${noFolders ? `<p class="bcj-none">The journal's folders are being made.</p>` : listBody}<p class="bcj-none bcj-nomatch" hidden>Nothing matches.</p></div>
      </section>
      <section class="bcj-read">${current ? await this.#page(current) : this.#empty()}</section>
    </div>`;
  }

  #empty() {
    const tip = this.isGM
      ? `Entries in the <strong>Campaign Journal</strong> folder show here: <strong>Party</strong> for the party journal, <strong>Handouts</strong> for handouts (who can see each one is its own permission), and each player's folder under <strong>Players</strong> for their journal.`
      : `Nothing here yet.`;
    return `<article class="bcj-page bcj-blank"><p class="bcj-hint">${tip}</p></article>`;
  }

  async #page(d) {
    const entry = d.entry;
    const body = await contentHTML(entry);
    const att = d.kind === "recap" && d.attended.length
      ? `<div class="bcj-att"><span class="bcj-k">At the table</span>${d.attended.map((id) => game.users.get(id)).filter(Boolean).map((u) => {
        const w = who(u);
        return `<span class="bcj-dot" style="--c:${esc(w.color)}" data-tooltip="${esc(w.name)}">${esc(w.initial)}</span>`;
      }).join("")}</div>`
      : "";
    const B = (action, icon, label, tip = "") => `<button type="button" data-action="${action}"${tip ? ` data-tooltip="${esc(tip)}"` : ""}><i class="${icon}"></i> ${label}</button>`;
    const gm = this.isGM;
    const mine = !gm && d.area === "player" && d.user === game.user.id && entry.isOwner;
    const copy = mine ? sharedCopyOf(entry.id, game.user.id) : null;
    const tools = [
      gm && d.kind === "recap" ? B("bcjPrevious", "fa-solid fa-clock-rotate-left", "Previously on…", "Show the short version on every player's screen") : "",
      gm && d.kind === "recap" ? B("bcjDetails", "fa-solid fa-sliders", "Details", "Session, dates and who was at the table") : "",
      gm && d.kind === "handout" ? B("bcjGive", "fa-solid fa-user-plus", "Give to…") : "",
      gm && (d.area === "party" || (d.kind === "handout" && d.all)) ? B("bcjPin", d.pinned ? "fa-solid fa-thumbtack-slash" : "fa-solid fa-thumbtack", d.pinned ? "Unpin" : "Pin", d.pinned ? "Put it back in its place in the party journal" : "Keep it at the top of the party journal") : "",
      gm ? B("bcjShow", "fa-solid fa-eye", "Show to players", "Open it on the screens of the players who can read it") : "",
      mine ? B("bcjShare", "fa-solid fa-share-from-square", copy ? "Update the shared copy" : "Share a copy to the Party Journal", copy ? `Replace "${copy.name}" in the party journal with this version` : "Everyone will be able to read the copy; you can still edit it") : "",
      B("bcjMarkdown", "fa-solid fa-file-arrow-down", "Markdown", "Download this entry as a Markdown file"),
      d.area === "party" && d.all && (gm || (d.author === game.user.id && entry.isOwner)) ? B("bcjEditing", d.editable ? "fa-solid fa-lock" : "fa-solid fa-user-pen", d.editable ? "Stop party editing" : "Let the party edit", d.editable ? "Only the author and the GM can edit it again" : "Every player can edit it and add to it") : "",
      !gm && entry.isOwner && (mine || (d.area === "party" && d.author === game.user.id)) ? B("bcjDelete", "fa-solid fa-trash", "Delete") : "",
      entry.isOwner ? `<button type="button" class="bcj-edit" data-action="bcjEdit"><i class="fa-solid fa-pen"></i> Edit</button>` : "",
    ].join("");
    const sharedNote = mine && copy ? `<p class="bcj-shared"><i class="fa-solid fa-share-from-square"></i> A copy is in the party journal as "${esc(copy.name)}".</p>` : "";
    const text = d.kind === "handout" ? `<div class="bcj-letter">${body}</div>` : body;
    return `<article class="bcj-page bcj-kind-${d.kind}" data-entry="${esc(d.id)}">
      <header class="bcj-ph"><div><h1>${esc(d.name)}</h1><div class="bcj-meta">${esc(metaline(d))}</div>${att}</div>
        <div class="bcj-seen"><span class="bcj-k">Who can see</span>${dots(d)}</div></header>
      ${tools ? `<div class="bcj-tools">${tools}</div>` : ""}${sharedNote}
      <div class="bcj-flow"><nav class="bcj-toc" hidden></nav><div class="bcj-text">${text}</div></div>
    </article>`;
  }

  _replaceHTML(result, content) {
    const scroll = content.querySelector(".bcj-read")?.scrollTop ?? 0;
    const listScroll = content.querySelector(".bcj-scroll")?.scrollTop ?? 0;
    const sameEntry = content.querySelector(".bcj-page")?.dataset.entry === this.view.entry;
    content.innerHTML = result;
    if (sameEntry) content.querySelector(".bcj-read").scrollTop = scroll;
    const ls = content.querySelector(".bcj-scroll");
    if (ls) ls.scrollTop = listScroll;
  }

  _onFirstRender() {
    openApps.add(this);
  }

  _onClose() {
    openApps.delete(this);
  }

  /* Foundry restores a minimized window to its measured size on screen, which is smaller than its real size when
   * the interface is scaled; keep the real size from before and put it back. */
  #beforeMin = null;
  #restoring = false;
  async minimize() {
    if (!this.minimized && this.rendered) this.#beforeMin = { width: this.position.width, height: this.position.height };
    return super.minimize();
  }
  async maximize() {
    if (!this.minimized) return super.maximize();
    const was = this.#beforeMin;
    this.#restoring = true;
    try {
      await super.maximize();
    } finally {
      this.#restoring = false;
    }
    if (was) this.setPosition(was);
  }

  /** Remember the size and place the user gives the window (not while it's minimized or being restored). */
  _onPosition(position) {
    super._onPosition?.(position);
    if (!this.rendered || this.minimized || this.#restoring) return;
    if (![position.width, position.height, position.left, position.top].every(Number.isFinite)) return;
    if (position.width < 400 || position.height < 250) return;
    saveSize(position);
  }

  _onRender() {
    const el = this.element;
    // The table of contents, from the page's headings.
    const heads = [...el.querySelectorAll(".bcj-text h1, .bcj-text h2, .bcj-text h3")];
    const toc = el.querySelector(".bcj-toc");
    if (toc && heads.length > 1) {
      heads.forEach((h, i) => (h.dataset.bcjHead = String(i)));
      toc.innerHTML = `<div class="bcj-k">On this page</div>${heads.map((h, i) => `<a data-action="bcjToc" data-head="${i}" class="bcj-toc-${h.tagName.toLowerCase()}">${esc(h.textContent.trim())}</a>`).join("")}`;
      toc.hidden = false;
    }
    this.#dragPins();
    const input = el.querySelector('input[name="bcj-q"]');
    input?.addEventListener("input", () => {
      this.view.query = input.value;
      this.#filter();
    });
    this.#filter();
  }

  /** The GM drags pinned entries up and down; the order is saved on the entries for everyone. */
  #dragPins() {
    if (!this.isGM) return;
    const group = this.element.querySelector('.bcj-group[data-group="Pinned"]');
    const items = group ? [...group.querySelectorAll(".bcj-item")] : [];
    if (items.length < 2) return;
    const clear = () => items.forEach((a) => a.classList.remove("bcj-drop-before", "bcj-drop-after", "bcj-dragging"));
    let dragged = null;
    for (const a of items) {
      a.draggable = true;
      a.addEventListener("dragstart", (ev) => {
        if (this.view.query) return ev.preventDefault();
        dragged = a.dataset.entry;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", dragged);
        a.classList.add("bcj-dragging");
      });
      a.addEventListener("dragover", (ev) => {
        if (!dragged || a.dataset.entry === dragged) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const r = a.getBoundingClientRect();
        const after = ev.clientY > r.top + r.height / 2;
        items.forEach((b) => b !== a && b.classList.remove("bcj-drop-before", "bcj-drop-after"));
        a.classList.toggle("bcj-drop-after", after);
        a.classList.toggle("bcj-drop-before", !after);
      });
      a.addEventListener("dragleave", () => a.classList.remove("bcj-drop-before", "bcj-drop-after"));
      a.addEventListener("drop", (ev) => {
        if (!dragged) return;
        ev.preventDefault();
        const after = a.classList.contains("bcj-drop-after");
        const ids = moveId(items.map((b) => b.dataset.entry), dragged, a.dataset.entry, after);
        dragged = null;
        clear();
        JournalEntry.updateDocuments(ids.map((id, i) => ({ _id: id, [`flags.${MOD}.pinOrder`]: i })))
          .catch((err) => ui.notifications.warn(`Campaign Journal: couldn't save the order (${err.message}).`));
      });
      a.addEventListener("dragend", () => {
        dragged = null;
        clear();
      });
    }
  }

  /** Hide list entries that don't match the search, and groups left empty. */
  #filter() {
    const el = this.element;
    const q = this.view.query;
    let any = false;
    for (const g of el.querySelectorAll(".bcj-group")) {
      let shown = 0;
      for (const a of g.querySelectorAll(".bcj-item")) {
        const ok = matches(q, a.querySelector(".bcj-it")?.textContent, this.texts.get(a.dataset.entry));
        a.hidden = !ok;
        if (ok) shown++;
      }
      const hasItems = !!g.querySelector(".bcj-item");
      g.hidden = !!q && hasItems && !shown || !!q && !hasItems;
      if (shown) any = true;
    }
    const none = el.querySelector(".bcj-nomatch");
    if (none) none.hidden = !q || any;
  }

  static #onTab(event, target) {
    this.view.tab = target.dataset.tab;
    this.view.entry = null;
    this.render();
  }

  static #onEntry(event, target) {
    this.view.entry = target.dataset.entry;
    this.render();
  }

  static #onEdit() {
    const entry = game.journal.get(this.view.entry);
    if (!entry?.isOwner) return;
    const pages = entry.pages.contents;
    if (pages.length === 1 && pages[0].type === "text") pages[0].sheet.render(true);
    else entry.sheet.render(true);
  }

  static #onOpenPage(event, target) {
    const entry = game.journal.get(this.view.entry);
    const page = entry?.pages.get(target.dataset.page);
    if (page) entry.sheet.render(true, { pageId: page.id });
  }

  static #onToc(event, target) {
    const h = this.element.querySelector(`[data-bcj-head="${target.dataset.head}"]`);
    h?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  static #onFolders() {
    ui.sidebar?.changeTab?.("journal", "primary");
    const root = findFolder("root");
    if (root) game.folders.get(root.id)?.expand?.();
  }

  static async #onNewRecap() {
    if (!this.isGM) return;
    const party = findFolder("party");
    if (!party) return ui.notifications.warn("Campaign Journal: the Party folder isn't there yet.");
    const sessions = readable().filter((d) => d.kind === "recap").map((d) => Number(d.session) || 0);
    const data = await recapDialog({ session: (sessions.length ? Math.max(...sessions) : 0) + 1, date: today(), played: realDate(), attended: players().map((u) => u.id), share: true }, { create: true });
    if (!data) return;
    const r = parseRecap(data.md);
    const session = data.session ?? r.session;
    const name = recapName(session, data.title || r.title);
    const html = data.md.trim() ? recapHTML(r) : TEMPLATES.recap;
    const entry = await JournalEntry.create({
      name, folder: party.id, ownership: { default: data.share ? LEVEL.OBSERVER : LEVEL.NONE },
      flags: { [MOD]: { kind: "recap", session, date: data.date, played: data.played, attended: data.attended, subtitle: data.subtitle || r.subtitle } },
      pages: [{ name, type: "text", text: { content: html, format: 1 } }],
    });
    if (!entry) return;
    this.view.tab = "party";
    this.view.entry = entry.id;
    this.render();
    if (!data.md.trim()) entry.pages.contents[0]?.sheet.render(true);
  }

  static async #onDetails() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const f = flagsOf(entry);
    const data = await recapDialog({ session: f.session, title: entry.name.replace(/^Session\s+\d+\s*:\s*/i, ""), date: f.date, played: f.played, attended: f.attended ?? [], subtitle: f.subtitle ?? "" }, { create: false });
    if (!data) return;
    const name = recapName(data.session, data.title);
    const update = { flags: { [MOD]: { session: data.session, date: data.date, played: data.played, attended: data.attended, subtitle: data.subtitle } } };
    if (name !== entry.name) update.name = name;
    await entry.update(update);
    const page = entry.pages.contents.length === 1 ? entry.pages.contents[0] : null;
    if (page && update.name && page.name !== name) await page.update({ name });
  }

  static async #onNewPage() {
    if (!this.isGM) return;
    const party = findFolder("party");
    if (!party) return ui.notifications.warn("Campaign Journal: the Party folder isn't there yet.");
    const data = await DialogV2().wait({
      window: { title: "New page", icon: "fa-solid fa-file-lines" },
      classes: ["bcj-dialog"],
      position: { width: 420 },
      content: `<div class="bcj-form"><label>Title <input type="text" name="name" placeholder="House rules" autofocus></label>
        <label class="bcj-check"><input type="checkbox" name="pinned"> Pin it to the top of the party journal</label>
        <label class="bcj-check"><input type="checkbox" name="share" checked> Players can read it now</label>
        <label class="bcj-check"><input type="checkbox" name="edit"> The party can edit it too</label></div>`,
      buttons: [
        { action: "ok", label: "Make it", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
          const e = button.form.elements;
          return { name: e.name.value.trim(), pinned: e.pinned.checked, share: e.share.checked || e.edit.checked, edit: e.edit.checked };
        } },
        { action: "cancel", label: "Cancel" },
      ],
      rejectClose: false,
    });
    if (!data || typeof data !== "object" || !data.name) return;
    const entry = await JournalEntry.create({
      name: data.name, folder: party.id, ownership: data.share ? editOwnership(data.edit) : { default: LEVEL.NONE },
      flags: { [MOD]: { pinned: data.pinned } },
      pages: [{ name: data.name, type: "text", text: { content: "", format: 1 } }],
    });
    if (!entry) return;
    this.view.tab = "party";
    this.view.entry = entry.id;
    this.render();
    entry.pages.contents[0]?.sheet.render(true);
  }

  static async #onNewHandout() {
    if (!this.isGM) return;
    const folder = findFolder("handouts");
    if (!folder) return ui.notifications.warn("Campaign Journal: the Handouts folder isn't there yet.");
    const data = await giveDialog({ title: "New handout", name: "", everyone: false, readers: [], letter: true });
    if (!data?.name) return;
    const entry = await JournalEntry.create({
      name: data.name, folder: folder.id, ownership: ownershipFor({ default: LEVEL.NONE }, data.everyone, data.readers, players().map((u) => u.id)),
      pages: [{ name: data.name, type: "text", text: { content: data.letter ? TEMPLATES.letter : "", format: 1 } }],
    });
    if (!entry) return;
    this.view.tab = "handouts";
    this.view.entry = entry.id;
    this.render();
    entry.pages.contents[0]?.sheet.render(true);
  }

  static async #onGive() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const { readers, all } = readersOf(entry.ownership, game.users.contents);
    const data = await giveDialog({ title: `Give "${entry.name}"`, everyone: all, readers: readers.map((u) => u.id) });
    if (!data) return;
    await entry.update({ ownership: ownershipFor(entry.ownership, data.everyone, data.readers, players().map((u) => u.id)) });
  }

  static async #onPin() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    if (flagsOf(entry).pinned) return entry.update({ [`flags.${MOD}.pinned`]: false, [`flags.${MOD}.-=pinOrder`]: null });
    const last = Math.max(-1, ...readable().filter((d) => d.pinned && Number.isFinite(d.pinOrder)).map((d) => d.pinOrder));
    await entry.update({ [`flags.${MOD}.pinned`]: true, [`flags.${MOD}.pinOrder`]: last + 1 });
  }

  static #onShow() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const to = readersOf(entry.ownership, game.users.contents).readers.filter((u) => u.active);
    if (!to.length) return ui.notifications.warn(`No player who can read "${entry.name}" is logged in.`);
    game.socket.emit(SOCKET, { type: "show", entry: entry.id, users: to.map((u) => u.id) });
    ui.notifications.info(`Shown to ${to.map((u) => who(u).name).join(", ")}.`);
  }

  static #onPrevious() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    if (!shortOf(entry)) return ui.notifications.warn(`"${entry.name}" has no short version to show.`);
    const to = readersOf(entry.ownership, game.users.contents).readers.filter((u) => u.active);
    if (to.length) game.socket.emit(SOCKET, { type: "previously", entry: entry.id, users: to.map((u) => u.id) });
    else ui.notifications.info(`No player who can read "${entry.name}" is logged in, so only you see it.`);
    PreviouslyApp.show(entry);
  }

  static #onMarkdown() {
    const entry = game.journal.get(this.view.entry);
    const d = entry && describe(entry);
    if (!d) return;
    foundry.utils.saveDataToFile(entryMarkdown(d), "text/markdown", `${slug(entry.name)}.md`);
  }

  static #onExport() {
    const seen = new Set();
    const list = this.groups(readable()).flatMap(([, items]) => items).filter((d) => !seen.has(d.id) && seen.add(d.id));
    if (!list.length) return ui.notifications.warn("Nothing on this tab to export.");
    const label = this.tabs().find(([k]) => k === this.view.tab)?.[1] ?? "Journal";
    const md = `# Campaign Journal: ${label}\n\n${list.map((d) => entryMarkdown(d, 2)).join("\n\n---\n\n")}\n`;
    foundry.utils.saveDataToFile(md, "text/markdown", `campaign-journal-${slug(label)}.md`);
  }

  static async #onNewEntry() {
    if (this.isGM) return;
    const name = await DialogV2().prompt({
      window: { title: "New journal entry", icon: "fa-solid fa-feather" },
      classes: ["bcj-dialog"],
      content: `<div class="bcj-form"><label>Title <input type="text" name="name" placeholder="What the guard didn't say" autofocus></label><p class="bcj-dim">Only you and the GM can read it.</p></div>`,
      ok: { label: "Make it", icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.name.value.trim() },
      rejectClose: false,
    });
    if (typeof name !== "string" || !name) return;
    askGM({ type: "create", name: name.slice(0, 120) });
  }

  static async #onNewParty() {
    if (this.isGM) return;
    const data = await DialogV2().wait({
      window: { title: "New party entry", icon: "fa-solid fa-feather" },
      classes: ["bcj-dialog"],
      position: { width: 420 },
      content: `<div class="bcj-form"><label>Title <input type="text" name="name" placeholder="Rumors from the market" autofocus></label>
        <label class="bcj-check"><input type="checkbox" name="edit"> Let the rest of the party edit it too</label>
        <p class="bcj-dim">Everyone can read it, signed with your name. You can change who edits it later.</p></div>`,
      buttons: [
        { action: "ok", label: "Make it", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
          const e = button.form.elements;
          return { name: e.name.value.trim(), edit: e.edit.checked };
        } },
        { action: "cancel", label: "Cancel" },
      ],
      rejectClose: false,
    });
    if (!data || typeof data !== "object" || !data.name) return;
    askGM({ type: "party", name: data.name.slice(0, 120), edit: !!data.edit });
  }

  static async #onEditing() {
    const entry = game.journal.get(this.view.entry);
    const d = entry && describe(entry);
    if (!d || d.area !== "party" || !d.all) return;
    const on = !d.editable;
    if (this.isGM) return entry.update({ ownership: editOwnership(on, d.author) });
    if (d.author !== game.user.id || !entry.isOwner) return;
    askGM({ type: "edit", entry: entry.id, on });
  }

  static async #onShare() {
    const entry = game.journal.get(this.view.entry);
    if (!entry?.isOwner || this.isGM) return;
    const copy = sharedCopyOf(entry.id, game.user.id);
    const ok = await DialogV2().confirm({
      window: { title: copy ? "Update the shared copy" : "Share a copy" },
      classes: ["bcj-dialog"],
      content: copy
        ? `<p>You shared this before. Replace the copy in the party journal, <strong>${esc(copy.name)}</strong>, with this version? What it says now will be overwritten${partyEdits(copy.ownership) ? ", including anything the rest of the party added to it" : ""}.</p>`
        : `<p>Put a copy of <strong>${esc(entry.name)}</strong> in the party journal, signed with your name? Everyone will be able to read it. You can still edit the copy, and your own entry stays private.</p>`,
      rejectClose: false,
    });
    if (ok) askGM({ type: "share", entry: entry.id });
  }

  static async #onDelete() {
    const entry = game.journal.get(this.view.entry);
    if (!entry?.isOwner || this.isGM) return;
    const ok = await DialogV2().confirm({ window: { title: "Delete" }, classes: ["bcj-dialog"], content: `<p>Delete <strong>${esc(entry.name)}</strong>? This can't be undone.</p>`, rejectClose: false });
    if (!ok) return;
    try {
      await entry.delete();
    } catch (err) {
      ui.notifications.warn(`Campaign Journal: couldn't delete "${entry.name}" (${err.message}).`);
    }
  }

  /** Open the window, on an entry if one is given. */
  static open(entryId = null) {
    const app = [...openApps][0] ?? new JournalApp();
    if (entryId) {
      const d = describe(game.journal.get(entryId) ?? {});
      if (d) {
        app.view.entry = entryId;
        app.view.tab = d.area === "party" || (d.kind === "handout" && d.all) ? "party" : game.user.isGM ? (d.kind === "handout" ? "handouts" : "players") : "mine";
      }
    }
    // Restore a minimized window before drawing it: a draw that ends while it's still collapsed would take the
    // title bar's height as its size.
    if (app.minimized) app.maximize().then(() => app.render({ force: true }));
    else app.render({ force: true });
    return app;
  }
}

const players = () => game.users.filter((u) => !u.isGM).sort((a, b) => a.name.localeCompare(b.name));
const DialogV2 = () => foundry.applications.api.DialogV2;

/** One entry as Markdown: its title (at the given heading level), its line, then its readable text pages. */
function entryMarkdown(d, level = 1) {
  const entry = d.entry;
  const hashes = "#".repeat(level);
  const pages = entry.pages.contents.filter((p) => p.type === "text" && p.testUserPermission(game.user, "OBSERVER")).sort((a, b) => a.sort - b.sort);
  const parts = [`${hashes} ${entry.name}`, `*${metaline(d)}*`];
  for (const p of pages) {
    if (pages.length > 1) parts.push(`${hashes}# ${p.name}`);
    // The page's own headings go below the entry's title (and its page names, if it has several).
    const shift = level - 1 + (pages.length > 1 ? 1 : 0);
    parts.push(shiftHeadings(html2md(p.text?.content ?? ""), shift));
  }
  return parts.filter(Boolean).join("\n\n");
}

const checkboxes = (name, list, checked) => list.map((u) => `<label class="bcj-check"><input type="checkbox" name="${name}" value="${esc(u.id)}" ${checked.includes(u.id) ? "checked" : ""}> ${esc(who(u).name)}${who(u).name !== u.name ? ` <span class="bcj-dim">(${esc(u.name)})</span>` : ""}</label>`).join("");

/** The New recap and recap details form. Resolves to the values, or null if canceled. */
async function recapDialog(v, { create }) {
  const form = `<div class="bcj-form">
    <div class="bcj-row"><label>Session <input type="number" name="session" min="0" value="${esc(v.session ?? "")}"></label><label class="bcj-grow">Title <input type="text" name="title" value="${esc(v.title ?? "")}" placeholder="${create ? "Taken from the file if left blank" : ""}"></label></div>
    <div class="bcj-row"><label>In-game date <input type="text" name="date" value="${esc(fmtDate(v.date))}" placeholder="14 Aten 1534"></label><label>Played <input type="text" name="played" value="${esc(v.played ?? "")}" placeholder="Sat 8 Nov"></label></div>
    <label>Line under the title <input type="text" name="subtitle" value="${esc(v.subtitle ?? "")}" placeholder="${create ? "Taken from the file if left blank; otherwise the session, dates and who played" : "Session, dates and who played if left blank"}"></label>
    <fieldset><legend>At the table</legend>${checkboxes("attended", players(), v.attended ?? []) || `<p class="bcj-dim">No players yet.</p>`}</fieldset>
    ${create ? `<label>Recap (Markdown) <textarea name="md" rows="9" placeholder="Paste the recap here, or import the file. Leave it empty for a blank recap to write in."></textarea></label>
    <div class="bcj-row"><label class="bcj-file"><i class="fa-solid fa-file-import"></i> Import a file <input type="file" name="file" accept=".md,.markdown,.txt,text/markdown,text/plain"></label><label class="bcj-check"><input type="checkbox" name="share" ${v.share ? "checked" : ""}> Players can read it now</label></div>` : ""}
  </div>`;
  return DialogV2().wait({
    window: { title: create ? "New recap" : "Recap details", icon: "fa-solid fa-book-open" },
    classes: ["bcj-dialog"],
    position: { width: 560 },
    content: form,
    render: (event, dialog) => {
      const el = dialog.element ?? event?.target?.element;
      if (!el) return;
      const area = el.querySelector('textarea[name="md"]');
      /** Fill the form from a recap's heading and italic line: session, title, dates, and who was away. */
      const fill = (text) => {
        const r = parseRecap(text);
        const f = (n) => el.querySelector(`[name="${n}"]`);
        if (r.session) f("session").value = r.session;
        if (r.title && !f("title").value) f("title").value = r.title;
        if (!r.subtitle) return;
        const d = splitDetails(r.subtitle);
        const date = d.rest.map((p) => parseDate(p)).find((x) => x);
        if (date) f("date").value = fmtDate(date);
        if (d.played) f("played").value = d.played;
        if (d.absent.length) {
          const away = d.absent.map((n) => n.toLowerCase());
          for (const box of el.querySelectorAll('input[name="attended"]')) {
            const u = game.users.get(box.value);
            const names = [who(u).name, u?.name].filter(Boolean).map((n) => n.toLowerCase());
            box.checked = !away.some((a) => names.some((n) => n === a || n.split(/\s+/)[0] === a || a.split(/\s+/)[0] === n.split(/\s+/)[0]));
          }
        }
      };
      const file = el.querySelector('input[name="file"]');
      file?.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (!f) return;
        const text = await f.text();
        area.value = text;
        fill(text);
      });
      area?.addEventListener("paste", () => setTimeout(() => fill(area.value), 0));
    },
    buttons: [
      { action: "ok", label: create ? "Make the recap" : "Save", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        const date = parseDate(e.date.value);
        if (date === undefined) {
          ui.notifications.warn(`Campaign Journal: "${e.date.value}" isn't a date the calendar knows; it was left out.`);
        }
        return {
          session: e.session.value === "" ? null : Number(e.session.value),
          title: e.title.value.trim(),
          date: date || null,
          played: e.played.value.trim(),
          subtitle: e.subtitle.value.trim(),
          attended: [...button.form.querySelectorAll('input[name="attended"]:checked')].map((x) => x.value),
          md: e.md?.value ?? "",
          share: !!e.share?.checked,
        };
      } },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  }).then((r) => (r && typeof r === "object" ? r : null));
}

/** Who gets a handout (and, for a new one, its name and starting layout). Resolves to the values, or null. */
async function giveDialog(v) {
  const isNew = v.name !== undefined;
  const form = `<div class="bcj-form">
    ${isNew ? `<label>Name <input type="text" name="name" value="${esc(v.name)}" placeholder="A letter from Maud Holloway" autofocus></label>` : ""}
    <fieldset><legend>Who gets it</legend><label class="bcj-check"><input type="checkbox" name="everyone" ${v.everyone ? "checked" : ""}> <strong>Everyone</strong> <span class="bcj-dim">(players who join later too)</span></label>${checkboxes("reader", players(), v.readers)}</fieldset>
    ${isNew ? `<label class="bcj-check"><input type="checkbox" name="letter" ${v.letter ? "checked" : ""}> Start from the letter layout</label>` : ""}
  </div>`;
  return DialogV2().wait({
    window: { title: v.title, icon: "fa-solid fa-envelope-open-text" },
    classes: ["bcj-dialog"],
    position: { width: 420 },
    content: form,
    buttons: [
      { action: "ok", label: isNew ? "Make it" : "Save", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        return { name: e.name?.value.trim(), everyone: !!e.everyone.checked, readers: [...button.form.querySelectorAll('input[name="reader"]:checked')].map((x) => x.value), letter: !!e.letter?.checked };
      } },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  }).then((r) => (r && typeof r === "object" ? r : null));
}

/** "Previously on…": a recap's short version, on every player's screen. */
class PreviouslyApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MOD}-previously`,
    classes: ["bcj", "bcj-prev"],
    window: { title: "Previously on…", icon: "fa-solid fa-clock-rotate-left" },
    position: { width: 520, height: "auto" },
    actions: { bcjReadAll: PreviouslyApp.#onReadAll },
  };

  constructor(entry) {
    super();
    this.entryId = entry.id;
  }

  async _renderHTML() {
    const entry = game.journal.get(this.entryId);
    if (!entry) return `<p class="bcj-hint">That recap is gone.</p>`;
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const html = await TE.enrichHTML(shortOf(entry), { relativeTo: entry });
    return `<article class="bcj-page"><h1>${esc(entry.name)}</h1><div class="bcj-text">${html}</div>
      <div class="bcj-tools"><button type="button" data-action="bcjReadAll"><i class="fa-solid fa-book-open"></i> Read the whole recap</button></div></article>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  static #onReadAll() {
    JournalApp.open(this.entryId);
    this.close();
  }

  static show(entry) {
    foundry.applications.instances.get(`${MOD}-previously`)?.close({ animate: false });
    new PreviouslyApp(entry).render({ force: true });
  }
}

const SOCKET = `module.${MOD}`;

/** The copy of a player's entry they shared to the party journal, if there is one. */
function sharedCopyOf(sourceId, userId) {
  return game.journal.find((e) => {
    const f = flagsOf(e);
    return f.sharedFrom === sourceId && f.sharedBy === userId && areaOf(e.folder)?.area === "party";
  }) ?? null;
}

/** A player asks the GM's client to do something they may not have the rights for. */
function askGM(msg) {
  if (!game.users.activeGM) {
    ui.notifications.warn("Campaign Journal: a GM needs to be logged in for that.");
    return false;
  }
  game.socket.emit(SOCKET, msg);
  return true;
}

/** The active GM's client acts on a player's request: a new entry in their folder, or a shared copy. */
async function onRequest(msg, sender) {
  const reply = (extra) => game.socket.emit(SOCKET, { users: [sender.id], ...extra });
  try {
    if (msg.type === "create") {
      await ensureFolders();
      const folder = findFolder("player", sender.id);
      const name = String(msg.name ?? "").trim().slice(0, 120) || "Untitled";
      if (!folder) return reply({ type: "fail", text: "Campaign Journal: your journal folder isn't there yet. Ask the GM." });
      const entry = await JournalEntry.create({ name, folder: folder.id, ownership: { default: LEVEL.NONE, [sender.id]: LEVEL.OWNER }, pages: [{ name, type: "text", text: { content: "", format: 1 } }] });
      if (entry) reply({ type: "done", what: "create", entry: entry.id });
    } else if (msg.type === "party") {
      const party = findFolder("party");
      if (!party) return reply({ type: "fail", text: "Campaign Journal: the party journal isn't there yet. Ask the GM." });
      const name = String(msg.name ?? "").trim().slice(0, 120) || "Untitled";
      const entry = await JournalEntry.create({ name, folder: party.id, ownership: editOwnership(!!msg.edit, sender.id), flags: { [MOD]: { author: sender.id } }, pages: [{ name, type: "text", text: { content: "", format: 1 } }] });
      if (entry) reply({ type: "done", what: "create", entry: entry.id });
    } else if (msg.type === "edit") {
      const entry = game.journal.get(msg.entry);
      const d = entry && describe(entry);
      if (!d || d.area !== "party" || !d.all || d.author !== sender.id || !entry.testUserPermission(sender, "OWNER")) return reply({ type: "fail", text: "Campaign Journal: only the player who wrote it, or the GM, can change who edits it." });
      await entry.update({ ownership: editOwnership(!!msg.on, sender.id) });
      reply({ type: "done", what: "edit", entry: entry.id, on: !!msg.on });
    } else if (msg.type === "share") {
      const source = game.journal.get(msg.entry);
      const d = source && describe(source);
      if (!d || d.area !== "player" || d.user !== sender.id || !source.testUserPermission(sender, "OWNER")) return reply({ type: "fail", text: "Campaign Journal: only an entry in your own journal can be shared." });
      const party = findFolder("party");
      if (!party) return reply({ type: "fail", text: "Campaign Journal: the party journal isn't there yet. Ask the GM." });
      const pages = source.pages.contents.sort((a, b) => a.sort - b.sort).map((page) => {
        const data = page.toObject();
        delete data._id;
        data.ownership = { default: LEVEL.INHERIT };
        return data;
      });
      let copy = sharedCopyOf(source.id, sender.id);
      if (copy) {
        await copy.update({ name: source.name });
        await copy.deleteEmbeddedDocuments("JournalEntryPage", copy.pages.map((pg) => pg.id));
        await copy.createEmbeddedDocuments("JournalEntryPage", pages);
      } else {
        copy = await JournalEntry.create({ name: source.name, folder: party.id, ownership: { default: LEVEL.OBSERVER, [sender.id]: LEVEL.OWNER }, flags: { [MOD]: { sharedFrom: source.id, sharedBy: sender.id } }, pages });
      }
      if (copy) reply({ type: "done", what: "share", entry: copy.id });
    }
  } catch (err) {
    console.error(`${MOD} | a player's request failed`, err);
    reply({ type: "fail", text: `Campaign Journal: that didn't work (${err.message}).` });
  }
}

/** Socket messages. The active GM's client takes players' requests; a player's client takes a GM's messages
 * (open an entry, show a recap's short version, the answer to a request). Foundry gives the sender's id. */
function onSocket(msg, senderId) {
  if (!msg?.type) return;
  const sender = game.users.get(senderId);
  if (game.user.isGM) {
    if (isPrimaryGM() && sender && !sender.isGM && ["create", "party", "edit", "share"].includes(msg.type)) onRequest(msg, sender);
    return;
  }
  if (!sender?.isGM) return;
  if (Array.isArray(msg.users) && !msg.users.includes(game.user.id)) return;
  if (msg.type === "fail") return ui.notifications.warn(String(msg.text ?? "Campaign Journal: that didn't work."));
  const act = () => {
    const entry = game.journal.get(msg.entry);
    if (!entry?.testUserPermission(game.user, "OBSERVER")) return false;
    if (msg.type === "show") JournalApp.open(entry.id);
    else if (msg.type === "previously") PreviouslyApp.show(entry);
    else if (msg.type === "done" && msg.what === "create") {
      JournalApp.open(entry.id);
      entry.pages.contents[0]?.sheet.render(true);
    } else if (msg.type === "done" && msg.what === "edit") {
      ui.notifications.info(msg.on ? `Campaign Journal: the party can edit "${entry.name}" now.` : `Campaign Journal: only you and the GM can edit "${entry.name}" now.`);
    } else if (msg.type === "done" && msg.what === "share") {
      noticed.add(entry.id);
      markSeen(entry);
      ui.notifications.info(`Campaign Journal: "${entry.name}" is in the party journal.`);
    }
    return true;
  };
  // A new entry can arrive a moment after the message about it.
  if (!act()) setTimeout(act, 400);
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

function registerKeys() {
  try {
    game.keybindings.register(MOD, "open", {
      name: "Open the Campaign Journal",
      hint: "Opens the journal window, or brings it to the front.",
      editable: [{ key: "KeyJ", modifiers: [] }],
      onDown: () => {
        JournalApp.open();
        return true;
      },
    });
  } catch (err) {
    console.warn(`${MOD} | the hotkey couldn't be registered`, err);
  }
}

/** A button at the top of the Journal tab, and the journal's folder kept out of players' view there. */
function addDirectoryButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  if (!game.user.isGM && !game.settings.get(MOD, "showFolder")) {
    const folder = findFolder("root");
    // A class, not an inline style: Foundry's search filter sets each row's display when the directory redraws.
    if (folder) for (const li of root.querySelectorAll(`[data-folder-id="${folder.id}"]`)) (li.closest("li") ?? li).classList.add("bcj-hidden");
  }
  if (root.querySelector(".bcj-open")) return;
  const bar = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  if (!bar) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bcj-open";
  btn.innerHTML = `<i class="fa-solid fa-book-open"></i> Campaign Journal`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    JournalApp.open();
  });
  bar.append(btn);
}

function start() {
  game.modules.get(MOD).api = { open: (entryId) => JournalApp.open(entryId), refresh };
  game.socket.on(SOCKET, onSocket);
  seedSeen();
  ensureFolders();
  const dir = ui.journal ?? ui.sidebar?.tabs?.journal;
  if (dir?.element) addDirectoryButton(dir, dir.element);
}

function registerSettings() {
  game.settings.register(MOD, "showFolder", {
    name: "Players see the journal's folder",
    hint: "Show the Campaign Journal folder in players' Journal tab. Off keeps their tab clean: they read everything in the journal window.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => ui.journal?.render(),
  });
}

Hooks.once("init", () => {
  registerSettings();
  registerKeys();
});
Hooks.once("ready", start);
Hooks.on("renderJournalDirectory", addDirectoryButton);
// A calendar module may set the calendar up after ready; draw dates again once it has.
Hooks.on("calendaria.ready", () => refresh());
Hooks.on("calendaria.calendarSwitched", () => refresh());
for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry", "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage", "createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, refresh);
Hooks.on("createJournalEntry", (entry) => noticeNew(entry));
Hooks.on("updateJournalEntry", (entry, change) => {
  if ("ownership" in change || "folder" in change) noticeNew(entry);
});
// A folder that appears later (the first GM login) is hidden from players too.
Hooks.on("createFolder", () => {
  if (!game.user.isGM) ui.journal?.render();
});
Hooks.on("createUser", () => {
  ensureFolders();
  refresh();
});
Hooks.on("updateUser", (user, change) => {
  if ("name" in change) ensureFolders();
  if ("name" in change || "color" in change || "character" in change) refresh();
});

// Loaded after ready (a test injection): run the start-up now.
if (globalThis.game?.ready) {
  try {
    registerSettings();
  } catch {
    /* already registered */
  }
  registerKeys();
  start();
}

export { kindFor, levelFor, readersOf, compareRecaps, matches, stripTags, esc, KINDS, parseRecap, recapName, ownershipFor, slug, splitDetails, shiftHeadings, freshnessOf, freshFor, editOwnership, partyEdits, comparePinned, moveId };
