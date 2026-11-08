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
  const { readers, all } = readersOf(entry.ownership, game.users.contents);
  return { entry, id: entry.id, name: entry.name, kind, area: where.area, user: where.user, pinned: !!f.pinned, session: f.session ?? null, date: f.date ?? null, played: f.played ?? null, attended: Array.isArray(f.attended) ? f.attended : [], readers, all, sort: entry.sort ?? 0 };
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

/** A short name and initial for a user: their character's name if they have one. */
function who(user) {
  const name = user?.character?.name ?? user?.name ?? "?";
  return { name, initial: name.trim().charAt(0).toUpperCase() || "?", color: user?.color?.css ?? String(user?.color ?? "#888") };
}

function dots(d) {
  if (d.all) return `<span class="bcj-all" data-tooltip="All players can see this">All</span>`;
  if (!d.readers.length) return `<span class="bcj-all bcj-gmonly" data-tooltip="Only GMs can see this">GM</span>`;
  return d.readers.map((u) => {
    const w = who(u);
    return `<span class="bcj-dot" style="--c:${esc(w.color)}" data-tooltip="${esc(w.name)} can see this">${esc(w.initial)}</span>`;
  }).join("");
}

function fmtDate(x) {
  if (!x || !Number.isFinite(x.y)) return "";
  const months = game.time?.calendar?.months?.values ?? [];
  const m = months[x.m - 1];
  const name = m ? String(m.abbreviation || m.name).split(",")[0].trim() : `Month ${x.m}`;
  return `${x.d} ${name} ${x.y}`;
}

/** The line under an entry's name in the list. */
function subline(d) {
  if (d.kind === "recap") return [d.session ? `Session ${d.session}` : "Recap", fmtDate(d.date)].filter(Boolean).join(" · ");
  if (d.kind === "handout") return "Handout";
  if (d.kind === "journal") {
    const u = game.users.get(d.user);
    return u?.id === game.user.id ? "Private" : `${who(u).name}'s journal`;
  }
  return d.pinned ? "Pinned" : "Page";
}

/** The line under an entry's title in the reading pane. */
function metaline(d) {
  if (d.kind === "recap") {
    const played = d.played ? `played ${d.played}` : "";
    return [d.session ? `Session ${d.session}` : "Session recap", fmtDate(d.date), played].filter(Boolean).join(" · ");
  }
  if (d.kind === "handout") {
    const to = d.all ? "everyone" : d.readers.map((u) => who(u).name).join(" and ") || "no one yet";
    return `Handout · for ${to}`;
  }
  if (d.kind === "journal") {
    const u = game.users.get(d.user);
    return `${who(u).name}'s journal · private`;
  }
  return d.pinned ? "Pinned page" : "Party page";
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
    },
  };

  constructor(options = {}) {
    super(options);
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

  /** The current tab's groups: [heading, entries, empty text]. */
  groups(all) {
    const tab = this.view.tab;
    if (tab === "party") {
      const party = all.filter((d) => d.area === "party");
      return [
        ["Pinned", party.filter((d) => d.pinned && d.kind !== "recap").sort(byName), null],
        ["Recaps", party.filter((d) => d.kind === "recap").sort(compareRecaps), "No recaps yet."],
        ["Pages", party.filter((d) => !d.pinned && d.kind !== "recap").sort(byName), null],
        ["Handouts for everyone", all.filter((d) => d.kind === "handout" && d.all).sort(byName), null],
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

    const rail = tabs.map(([k, label, icon]) => `<a class="bcj-tab ${k === this.view.tab ? "active" : ""}" data-action="bcjTab" data-tab="${k}"><i class="${icon}"></i><span>${label}</span></a>`).join("");
    const list = groups.map(([heading, items, empty]) => `<div class="bcj-group"><div class="bcj-gh">${esc(heading)}</div>${items.length ? items.map((d) => `<a class="bcj-item ${d.id === this.view.entry ? "active" : ""}" data-action="bcjEntry" data-entry="${esc(d.id)}">
        <span class="bcj-it">${esc(d.name)}</span><span class="bcj-is">${esc(subline(d))}</span><span class="bcj-iw">${dots(d)}</span></a>`).join("") : `<p class="bcj-none">${esc(empty)}</p>`}</div>`).join("");
    const noFolders = this.isGM && !findFolder("root");
    const listBody = shown.length || groups.length ? list : "";

    return `<div class="bcj-shell">
      <nav class="bcj-rail">${rail}${this.isGM ? `<div class="bcj-railfoot"><a data-action="bcjFolders" data-tooltip="Show the journal's folders in the Journal tab"><i class="fa-solid fa-folder-tree"></i><span>Folders</span></a></div>` : ""}</nav>
      <section class="bcj-list">
        <div class="bcj-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" name="bcj-q" placeholder="Search the journal" value="${esc(this.view.query)}"></div>
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
    const canEdit = entry.isOwner;
    const tools = canEdit ? `<button type="button" class="bcj-edit" data-action="bcjEdit"><i class="fa-solid fa-pen"></i> Edit</button>` : "";
    const text = d.kind === "handout" ? `<div class="bcj-letter">${body}</div>` : body;
    return `<article class="bcj-page bcj-kind-${d.kind}" data-entry="${esc(d.id)}">
      <header class="bcj-ph"><div><h1>${esc(d.name)}</h1><div class="bcj-meta">${esc(metaline(d))}</div>${att}</div>
        <div class="bcj-seen"><span class="bcj-k">Who can see</span>${dots(d)}</div></header>
      ${tools ? `<div class="bcj-tools">${tools}</div>` : ""}
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
    const input = el.querySelector('input[name="bcj-q"]');
    input?.addEventListener("input", () => {
      this.view.query = input.value;
      this.#filter();
    });
    this.#filter();
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
    app.render({ force: true });
    if (app.minimized) app.maximize();
    return app;
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

function registerKeys() {
  try {
    game.keybindings.register(MOD, "open", {
      name: "Open the Campaign Journal",
      hint: "Opens the journal window, or brings it to the front.",
      editable: [{ key: "KeyJ", modifiers: ["Alt"] }],
      onDown: () => {
        JournalApp.open();
        return true;
      },
    });
  } catch (err) {
    console.warn(`${MOD} | the hotkey couldn't be registered`, err);
  }
}

/** A button at the top of the Journal tab. */
function addDirectoryButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".bcj-open")) return;
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
  ensureFolders();
  const dir = ui.journal ?? ui.sidebar?.tabs?.journal;
  if (dir?.element) addDirectoryButton(dir, dir.element);
}

Hooks.once("init", registerKeys);
Hooks.once("ready", start);
Hooks.on("renderJournalDirectory", addDirectoryButton);
for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry", "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage", "createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, refresh);
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
  registerKeys();
  start();
}

export { kindFor, levelFor, readersOf, compareRecaps, matches, stripTags, esc, KINDS };
