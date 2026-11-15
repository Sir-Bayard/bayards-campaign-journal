import { esc } from "./kit/safe-text.mjs";
import { AREA_KIND, L, LEVEL } from "./constants.mjs";

/** Bayard's Campaign Journal: helpers that need no Foundry (parsing recaps, sorting, ownership sums, search). */

/* ------------------------------------------------------------------ */
/* Helpers (no Foundry needed)                                         */
/* ------------------------------------------------------------------ */

/** A notification as plain text: Foundry keeps markup in a message, and names in these come from players. */
const notice = (type, text) => ui.notifications[type](esc(text));
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

/**
 * The players (non-GM users) who can read a document, and whether its default level shares it with every player,
 * including ones who join later.
 */
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

/**
 * Foundry's content links in text (`@UUID[target]{label}`, `@Quest[id]`, `@Check[...]`) written as words for a
 * Markdown file: a link with a label becomes its label; one without becomes what `lookup(type, target)` names it,
 * or stays as it was when lookup has no name for it.
 */
function resolveLinks(text, lookup = () => null) {
  return String(text ?? "").replace(/@([A-Za-z]+)\[([^\]]*)\](?:\{([^}]*)\})?/g, (all, type, target, label) => {
    if (label !== undefined && label.trim()) return label;
    const name = lookup(type, target);
    return name ? String(name) : all;
  });
}

/** The words of a search, lowercased. */
const queryWords = (query) => String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/**
 * A short piece of an entry's text around the first word of the search found in it, as HTML with each word marked
 * (`<mark class="bcj-hit">`), or "" when none is found. `span` is about how many characters show either side.
 */
function snippetHTML(text, query, span = 60) {
  const words = queryWords(query);
  const plain = String(text ?? "");
  const low = plain.toLowerCase();
  const at = Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return "";
  let from = Math.max(0, at - span), to = Math.min(plain.length, at + span);
  // Start and end on a word boundary where one is near.
  if (from > 0) from = plain.indexOf(" ", from) + 1 || from;
  if (to < plain.length) to = plain.lastIndexOf(" ", to) > at ? plain.lastIndexOf(" ", to) : to;
  const piece = plain.slice(from, to);
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let out = "", last = 0;
  for (const m of piece.matchAll(re)) {
    out += esc(piece.slice(last, m.index)) + `<mark class="bcj-hit">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  out += esc(piece.slice(last));
  return `${from > 0 ? "…" : ""}${out}${to < plain.length ? "…" : ""}`;
}

/**
 * Read a Markdown recap: "# Session N: Title", an italic line, a "## Short" section, then the rest (each part
 * optional). Returns { session, title, subtitle, short, body }, with short and body still Markdown.
 */
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

/** A recap's own title, without the "Session N: " that recapName puts in front (in the module's language). */
function titleOfRecap(name) {
  const template = L("SessionTitle", { n: "\u0001", title: "\u0002" });
  if (!template.includes("\u0001") || !template.includes("\u0002")) return name;
  const pattern = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*").replace("\u0001", "\\d+").replace("\u0002", "([\\s\\S]*)");
  return new RegExp(`^${pattern}$`, "i").exec(name)?.[1] ?? name;
}

/** An entry name for a recap: "Session 3: The Lantern", or whichever part there is. */
function recapName(session, title) {
  const t = String(title ?? "").trim();
  if (session && t) return L("SessionTitle", { n: session, title: t });
  return t || (session ? L("SessionN", { n: session }) : L("SessionRecap"));
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


export { notice, stripTags, kindFor, levelFor, readersOf, compareRecaps, matches, resolveLinks, queryWords, snippetHTML, parseRecap, splitDetails, titleOfRecap, recapName, ownershipFor, shiftHeadings, freshnessOf, freshFor, editOwnership, partyEdits, slug };
