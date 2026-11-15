import { esc, tipAttr } from "./kit/safe-text.mjs";
import { keyboardWindow } from "./kit/keyboard.mjs";
import { singleWindow } from "./kit/single-window.mjs";
import { rememberWindow } from "./kit/window-memory.mjs";
import { L, LEVEL, MOD, SOCKET, TRACKERS, store } from "./constants.mjs";
import { TEMPLATES, bodyKey, byName, byNewest, comparePinned, contentHTML, describe, dots, findFolder, flagsOf, freshness, listOf, markSeen, metaline, moveId, partySubfolder, readable, realDate, recapHTML, shortOf, subline, textOf, today, updateCount, who } from "./data.mjs";
import { DialogV2, askCopy, entryMarkdown, forEveryone, forPlayers, giveDialog, needsTitle, players, recapDialog } from "./dialogs.mjs";
import { compareRecaps, editOwnership, matches, notice, ownershipFor, parseRecap, partyEdits, queryWords, readersOf, recapName, slug, snippetHTML, titleOfRecap } from "./helpers.mjs";
import { askGM, playerDo, sharedCopyOf } from "./requests.mjs";

/** Bayard's Campaign Journal: the journal window and the "Previously on…" popup. */

/* ------------------------------------------------------------------ */
/* The window                                                           */
/* ------------------------------------------------------------------ */

const openApps = new Set();
let refreshTimer = null;
/** Trackers' API when it can draw quests for this user, else null. */
function questApi() {
  const m = game.modules.get(TRACKERS);
  const api = m?.active ? m.api : null;
  if (!["quests", "questHTML", "openQuest", "markQuestSeen"].every((k) => typeof api?.[k] === "function")) return null;
  if (game.user.isGM) return api;
  try {
    return game.settings.get(TRACKERS, "playerAccess") ? api : null;
  } catch {
    return api;
  }
}
/** Group headings are also identities (fold keys, the Pinned group's drag order), so they stay in English in the
 * code and are translated only where they're shown; a player's or a subfolder's name shows as it is. */
const GROUP_KEYS = { Pinned: "GroupPinned", Recaps: "GroupRecaps", Pages: "GroupPages", "Handouts for everyone": "GroupHandoutsForEveryone", "My entries": "GroupMyEntries", "Handouts for me": "GroupHandoutsForMe", "For everyone": "GroupForEveryone", "For some players": "GroupForSomePlayers", "Not given yet": "GroupNotGivenYet", "Former players": "GroupFormerPlayers", Active: "GroupActive", Leads: "GroupLeads", Completed: "GroupCompleted", Failed: "GroupFailed", Players: "GroupPlayers" };
/** A group's heading as shown. Party subfolders and players are named by id ("folder:<id>", "user:<id>"), so a
 * subfolder or player can't be taken for one of the module's own groups, and renaming one keeps its fold. */
const groupLabel = (heading) => {
  if (GROUP_KEYS[heading]) return L(GROUP_KEYS[heading]);
  const [kind, id] = heading.split(":");
  if (kind === "folder") return game.folders.get(id)?.name ?? "";
  if (kind === "user") {
    const u = game.users.get(id);
    return !u ? "" : who(u).name === u.name ? u.name : `${u.name} (${who(u).name})`;
  }
  return heading;
};
const QUEST_GROUPS = [["active", "Active"], ["lead", "Leads"], ["completed", "Completed"], ["failed", "Failed"]];
/** The quests this user can see, from Trackers. */
function questList() {
  try {
    return questApi()?.quests() ?? [];
  } catch (err) {
    console.warn(`${MOD} | couldn't read quests from Campaign Trackers`, err);
    return [];
  }
}
/** The words of a quest as players see it, for search. */
function questText(api, id) {
  const html = api?.questHTML(id);
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const n of div.querySelectorAll(".pct-hint, .pct-sub, .pct-k")) n.remove();
  return div.textContent.replace(/\s+/g, " ");
}

function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const app of openApps) if (app.rendered) app.render();
    updateCount();
  }, 100);
}

function loadView() {
  const v = store.get("view", {});
  return v && typeof v === "object" ? v : {};
}
function saveView(v) {
  store.set("view", { tab: v.tab, entry: v.entry, quest: v.quest, sorts: v.sorts, folded: v.folded });
}

/** A one-page text entry the user owns can be written in the window (F9). */
const canWriteHere = (entry) => !!entry?.isOwner && entry.pages.size === 1 && entry.pages.contents[0].type === "text";

/** Put the new markup (newRoot) into the page (oldRoot) around one node that stays where it is: `keep` takes the
 * place of `stand` (its counterpart in the new markup), and its ancestors stay too, taking the new ones' attributes.
 * False, changing nothing, if the two don't sit at the same depth. */
function keepInPlace(keep, stand, oldRoot, newRoot) {
  const path = (node, root) => {
    const nodes = [];
    for (let n = node; n && n !== root; n = n.parentNode) nodes.unshift(n);
    return nodes[0]?.parentNode === root ? nodes : null;
  };
  const olds = path(keep, oldRoot), news = path(stand, newRoot);
  if (!olds || !news || olds.length !== news.length) return false;
  let oldParent = oldRoot, newParent = newRoot;
  olds.forEach((o, i) => {
    const n = news[i];
    const kids = [...newParent.childNodes];
    const at = kids.indexOf(n);
    for (const c of [...oldParent.childNodes]) if (c !== o) c.remove();
    for (const c of kids.slice(0, at)) oldParent.insertBefore(c, o);
    for (const c of kids.slice(at + 1)) oldParent.append(c);
    if (i < olds.length - 1) {
      for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
      for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    }
    oldParent = o;
    newParent = n;
  });
  return true;
}

/** The window: size and place kept per world and user and a whole restore from minimized (the kit's window memory;
 * the size kept before 0.3.0 is read once), focus kept across redraws and the window's keys kept from Foundry's
 * keybindings (the kit's keyboard pattern). */
class JournalApp extends keyboardWindow(rememberWindow(foundry.applications.api.ApplicationV2, { module: MOD, name: "main", from: `${MOD}.size` }), { module: MOD, scope: ".bcj, .bcj-dialog", ownKeys: true }) {
  static DEFAULT_OPTIONS = {
    id: MOD,
    classes: ["bcj"],
    tag: "div",
    window: { title: "BCJ.Title", icon: "fa-solid fa-book-open", resizable: true },
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
      bcjSort: JournalApp.#onSort,
      bcjFold: JournalApp.#onFold,
      bcjReaders: JournalApp.#onReaders,
      bcjNewParty: JournalApp.#onNewParty,
      bcjEditing: JournalApp.#onEditing,
      bcjShare: JournalApp.#onShare,
      bcjDelete: JournalApp.#onDelete,
      bcjQuest: JournalApp.#onQuest,
      bcjQuestOpen: JournalApp.#onQuestOpen,
      bcjCopyQuest: JournalApp.#onCopyQuest,
      bcjMove: JournalApp.#onMove,
      bcjStep: JournalApp.#onStep,
      bcjWrite: JournalApp.#onWrite,
      bcjWriteDone: JournalApp.#onWriteDone,
    },
  };

  constructor(options = {}) {
    super(options);
    const saved = loadView();
    this.view = { tab: saved.tab ?? "party", entry: saved.entry ?? null, quest: saved.quest ?? null, query: "", sorts: saved.sorts && typeof saved.sorts === "object" ? { ...saved.sorts } : {}, folded: saved.folded && typeof saved.folded === "object" ? { ...saved.folded } : {} };
    this.texts = new Map();
    /** The entry being written in the window (F9), or null. */
    this.writing = null;
    /** What was last read from the editor ({ id, html }), kept until it's saved, so a failed save loses nothing. */
    this.draft = null;
  }

  get isGM() {
    return game.user.isGM;
  }

  /** Tabs: Party, then My Journal (players) or Handouts and Players (GMs), then Quests if Trackers offers them. */
  tabs() {
    const tabs = this.isGM
      ? [["party", L("Party"), "fa-solid fa-users"], ["handouts", L("Handouts"), "fa-solid fa-envelope-open-text"], ["players", L("Players"), "fa-solid fa-user-group"]]
      : [["party", L("Party"), "fa-solid fa-users"], ["mine", L("MyJournal"), "fa-solid fa-feather"]];
    // Quests, when PF2e Campaign Trackers is installed and players may open it.
    if (questApi()) tabs.push(["quests", L("Quests"), "fa-solid fa-scroll"]);
    return tabs;
  }

  /** A tab's groups (the current tab unless named): [heading, entries, empty text, the key of its sort toggle]. */
  groups(all, tab = this.view.tab) {
    // The Quests tab lists Trackers' quests, not journal entries.
    if (tab === "quests") return [];
    // Newest / A-Z choices: one each for My entries and Handouts for me, one shared by the Players tab's groups.
    const orderFor = (key) => (this.view.sorts[key] === "az" ? byName : byNewest);
    if (tab === "party") {
      // Anything on this tab can be pinned to the top: pages, recaps, shared copies, handouts for everyone.
      const party = all.filter((d) => d.area === "party");
      const handouts = all.filter((d) => d.kind === "handout" && d.all);
      // A subfolder of Party (an arc, say) is a group of its own: its recaps by session, then its other entries.
      const subs = new Map();
      for (const d of party) {
        const f = partySubfolder(d.entry);
        if (f && !d.pinned) subs.set(f, [...(subs.get(f) ?? []), d]);
      }
      const top = party.filter((d) => !partySubfolder(d.entry));
      const arcs = [...subs].sort(([a], [b]) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name)).map(([f, items]) => [
        `folder:${f.id}`,
        [...items.filter((d) => d.kind === "recap").sort(compareRecaps), ...items.filter((d) => d.kind !== "recap").sort(byName)],
        null,
      ]);
      return [
        ["Pinned", [...party, ...handouts].filter((d) => d.pinned).sort(comparePinned), null],
        ["Recaps", top.filter((d) => d.kind === "recap" && !d.pinned).sort(compareRecaps), subs.size ? null : L("NoRecapsYet")],
        ...arcs,
        ["Pages", top.filter((d) => d.kind !== "recap" && !d.pinned).sort(byName), null],
        ["Handouts for everyone", handouts.filter((d) => !d.pinned).sort(byName), null],
      ];
    }
    if (tab === "mine") {
      return [
        ["My entries", all.filter((d) => d.area === "player" && d.user === game.user.id).sort(orderFor("mine")), L("NothingWrittenYetUseNewEntry"), "mine"],
        ["Handouts for me", all.filter((d) => d.kind === "handout" && !d.all).sort(orderFor("myHandouts")), null, "myHandouts"],
      ];
    }
    if (tab === "handouts") {
      const h = all.filter((d) => d.kind === "handout");
      return [
        ["For everyone", h.filter((d) => d.all).sort(byName), h.length ? null : L("NoHandoutsYet")],
        ["For some players", h.filter((d) => !d.all && d.readers.length).sort(byName), null],
        ["Not given yet", h.filter((d) => !d.readers.length).sort(byName), null],
      ];
    }
    // GM: one group per player, with their journal and the handouts only some players have; then the journals of
    // players who are gone (their user deleted), so nothing is lost from view.
    const current = game.users.filter((u) => !u.isGM).sort((a, b) => a.name.localeCompare(b.name));
    const groups = current.map((u) => [
      `user:${u.id}`,
      [...all.filter((d) => d.area === "player" && d.user === u.id), ...all.filter((d) => d.kind === "handout" && !d.all && d.readers.some((r) => r.id === u.id))].sort(orderFor("players")),
      L("NothingYet"),
      null,
    ]);
    const former = all.filter((d) => d.area === "player" && !current.some((u) => u.id === d.user));
    if (former.length) groups.push(["Former players", former.sort(orderFor("players")), null, null]);
    if (!groups.length) groups.push(["Players", [], L("NoPlayersYet"), null]);
    return groups;
  }

  async _renderHTML() {
    const tabs = this.tabs();
    if (!tabs.some(([k]) => k === this.view.tab)) this.view.tab = "party";
    const all = readable();
    const groups = this.groups(all).filter(([, list, empty]) => list.length || empty);
    const shown = groups.flatMap(([, list]) => list);
    const qtab = this.view.tab === "quests";
    // On the Quests tab the Party (or other) entry being read is kept for coming back.
    if (!qtab && !shown.some((d) => d.id === this.view.entry)) this.view.entry = shown[0]?.id ?? null;
    saveView(this.view);
    // An entry's words for search are read the first time someone searches (see #filter).
    this.texts = new Map();
    const current = shown.find((d) => d.id === this.view.entry) ?? null;
    // Writing in an entry that this draw won't show (another entry opened, a tab change, the entry gone): save it now,
    // while the editor is still on the page.
    // (Not again after a failed save: that waits for Done, another pick or closing, and the editor keeps the text.)
    if (this.writing && !this.draft?.failed && (qtab || current?.id !== this.writing || !canWriteHere(current.entry))) this.finishWriting();
    if (current && this.#inFront(`e:${current.id}`)) markSeen(current.entry);
    const qapi = qtab ? questApi() : null;
    const quests = qtab ? questList() : [];
    if (qtab && !quests.some((q) => q.id === this.view.quest)) {
      this.view.quest = (quests.find((q) => q.status === "active" && q.revealed) ?? quests.find((q) => q.revealed) ?? quests[0])?.id ?? null;
      saveView(this.view);
    }
    const showMark = (q) => this.#showMark(q);
    // Trackers' quests, read once a draw: for the Quests tab, or for its dot on the other tabs (players only).
    const qall = qtab ? quests : this.isGM ? [] : questList();
    // The Quests dot, kept so a Trackers change redraws a window off the Quests tab only when the dot would change.
    this.questDot = !this.isGM && qall.some(showMark);
    const quest = qtab ? quests.find((q) => q.id === this.view.quest) ?? null : null;
    if (quest && quest.mark && !this.isGM && this.#inFront(`q:${quest.id}`)) qapi.markQuestSeen(quest.id);

    const mark = (d) => {
      const f = freshness(d);
      return f ? `<b class="bcj-new bcj-${f}">${f === "new" ? L("New") : L("Updated")}</b>` : "";
    };
    const unseenIn = (k) => (k === "quests" ? !this.isGM && qall.some(showMark) : this.groups(all, k).some(([, items]) => items.some((d) => freshness(d))));
    const rail = `<div class="bcj-tabs" role="tablist" aria-label="${esc(L("JournalSections"))}">${tabs.map(([k, label, icon]) => {
      const sel = k === this.view.tab;
      const dot = unseenIn(k) ? `<i class="bcj-dotnew" aria-hidden="true"></i><span class="bcj-sr">${esc(L("SomethingNew"))}</span>` : "";
      return `<button type="button" role="tab" class="bcj-tab ${sel ? "active" : ""}" aria-selected="${sel}" aria-controls="bcj-panel" data-action="bcjTab" data-tab="${k}"${sel ? " data-focus-home" : ""}><i class="${icon}" aria-hidden="true"></i><span id="bcj-tabname-${k}">${label}</span>${dot}</button>`;
    }).join("")}</div>`;
    // The toggle shows the order the list is in now; clicking swaps it.
    const sorter = (key) => {
      const az = this.view.sorts[key] === "az";
      const next = az ? L("SortNewestFirst") : L("SortAToZ");
      return `<button type="button" class="bcj-sort" data-action="bcjSort" data-sort="${key}" aria-label="${az ? L("SortedAToZ") : L("NewestFirst")}. ${next}"${tipAttr(next)}><i class="fa-solid ${az ? "fa-arrow-down-a-z" : "fa-clock"}" aria-hidden="true"></i> ${az ? L("AZ") : L("Newest")} <i class="fa-solid fa-arrows-up-down" aria-hidden="true"></i></button>`;
    };
    // Any group folds to its heading (a long run of recaps, say); the choice is kept per tab and heading.
    const foldKey = (heading) => `${this.view.tab}:${heading}`;
    const row = (d, heading) => {
      const active = d.id === this.view.entry;
      const attrs = `class="bcj-item ${active ? "active" : ""}" data-action="bcjEntry" data-entry="${esc(d.id)}"${active ? ` aria-current="true"` : ""}`;
      const inner = `<span class="bcj-it">${esc(d.name)}</span><span class="bcj-is">${mark(d)}${esc(subline(d, this.view.tab))}</span><span class="bcj-iw">${dots(d)}</span>`;
      // The GM drags pinned entries into order (Move up and Move down in More do the same from the keyboard); a
      // dragged row stays a role=button element, since Firefox drags real buttons badly.
      return this.isGM && heading === "Pinned" ? `<div role="button" tabindex="0" ${attrs}>${inner}</div>` : `<button type="button" ${attrs}>${inner}</button>`;
    };
    const list = groups.map(([heading, items, empty, sortKey], gi) => {
      const folded = !!this.view.folded[foldKey(heading)];
      const gid = `bcj-g-${gi}`;
      return `<div class="bcj-group ${folded ? "bcj-folded" : ""}" data-group="${esc(heading)}"><div class="bcj-gh"><button type="button" class="bcj-fold" data-action="bcjFold" data-fold="${esc(foldKey(heading))}" aria-expanded="${!folded}" aria-controls="${gid}"${tipAttr(folded ? L("ShowThisGroup") : L("FoldThisGroup"))}><i class="fa-solid ${folded ? "fa-chevron-right" : "fa-chevron-down"}" aria-hidden="true"></i> ${esc(groupLabel(heading))}${folded && items.length ? ` <span class="bcj-count">${items.length}</span>` : ""}</button>${sortKey ? sorter(sortKey) : ""}</div><div class="bcj-gitems" id="${gid}">${items.length ? items.map((d) => row(d, heading)).join("") : `<p class="bcj-none">${esc(empty)}</p>`}</div></div>`;
    }).join("");
    const noFolders = this.isGM && !findFolder("root");
    // On the Players tab one toggle sorts every player's group, so it sits once, above them.
    const bar = this.isGM && this.view.tab === "players" && groups.length ? `<div class="bcj-gh bcj-listbar"><span>${esc(L("EveryPlayersList"))}</span>${sorter("players")}</div>` : "";
    const listBody = qtab ? this.#questList(quests) : shown.length || groups.length ? bar + list : "";
    const B = (action, icon, label, tip = "") => `<button type="button" data-action="${action}"${tip ? tipAttr(tip) : ""}><i class="${icon}" aria-hidden="true"></i> ${label}</button>`;
    const actions = qtab ? ""
      : this.isGM ? `<div class="bcj-actions">${B("bcjNewRecap", "fa-solid fa-plus", L("Recap"), L("NewSessionRecap"))}${B("bcjNewHandout", "fa-solid fa-plus", L("Handout"), L("NewHandout"))}${B("bcjNewPage", "fa-solid fa-plus", L("Page"), L("NewPageInThePartyJournal"))}</div>`
      : this.view.tab === "mine" ? `<div class="bcj-actions">${B("bcjNewEntry", "fa-solid fa-feather", L("NewEntry"), L("APrivateEntryOnlyYouAnd"))}</div>`
      : this.view.tab === "party" ? `<div class="bcj-actions">${B("bcjNewParty", "fa-solid fa-feather", L("NewPartyEntry"), L("AnEntryEveryoneCanReadSigned"))}</div>` : "";
    const foot = `${qtab ? "" : B("bcjExport", "fa-solid fa-file-export", `<span>${L("Export")}</span>`, L("DownloadThisTabSEntriesAs"))}${this.isGM ? B("bcjFolders", "fa-solid fa-folder-tree", `<span>${L("Folders")}</span>`, L("ShowTheJournalSFoldersIn")) : ""}`;

    return `<div class="bcj-shell">
      <nav class="bcj-rail" aria-label="${esc(L("Title"))}">${rail}<div class="bcj-railfoot">${foot}</div></nav>
      <section class="bcj-list" id="bcj-panel" role="tabpanel" aria-labelledby="bcj-tabname-${this.view.tab}">
        <div class="bcj-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" name="bcj-q" placeholder="${esc(L("SearchTheJournal"))}" aria-label="${esc(L("SearchTheJournal"))}" value="${esc(this.view.query)}"></div>
        ${actions}
        <div class="bcj-scroll" data-keep-scroll="list" data-focus-pane="list" tabindex="-1">${noFolders ? `<p class="bcj-none">${esc(L("FoldersBeingMade"))}</p>` : listBody}<p class="bcj-none bcj-nomatch" hidden>${esc(L("NothingMatches"))}</p></div>
      </section>
      <section class="bcj-read" data-keep-scroll="read" data-focus-pane="read" data-focus-start tabindex="-1" aria-label="${esc(L("Reading"))}">${qtab ? this.#questPage(quest, qapi) : current ? await this.#page(current) : this.#empty()}</section>
    </div>`;
  }

  /** The Quests tab's list: by status, with each quest's category and progress, marks and icons. */
  #questList(quests) {
    if (!quests.length) return `<p class="bcj-none">${this.isGM ? L("NoQuestsYetMakeThemIn") : L("NoQuestsYet")}</p>`;
    const foldKey = (heading) => `quests:${heading}`;
    return QUEST_GROUPS.map(([status, heading]) => {
      const items = quests.filter((q) => (QUEST_GROUPS.some(([k]) => k === q.status) ? q.status : "active") === status);
      if (!items.length) return "";
      const folded = !!this.view.folded[foldKey(heading)];
      const rows = items.map((q) => {
        const sub = [q.category, q.total ? `${q.done}/${q.total}` : ""].filter(Boolean).join(" · ");
        const icons = `${q.party ? `<i class="fa-solid fa-users" role="img" aria-label="${esc(L("APartyQuest"))}" data-tooltip-text="${esc(L("APartyQuest"))}"></i>` : ""}${q.focus ? `<i class="fa-solid fa-star" role="img" aria-label="${esc(L("ThePartysFocus"))}" data-tooltip-text="${esc(L("ThePartysFocus"))}"></i>` : ""}`;
        const mark = this.#showMark(q) ? `<b class="bcj-new bcj-${q.mark}">${q.mark === "new" ? L("New") : L("Updated")}</b>` : "";
        return `<div role="button" tabindex="0" class="bcj-item bcj-qitem bcj-qs-${esc(q.status)} ${q.revealed ? "" : "bcj-qhidden"} ${q.id === this.view.quest ? "active" : ""}" data-action="bcjQuest" data-quest="${esc(q.id)}" data-entry="quest:${esc(q.id)}"${q.id === this.view.quest ? ` aria-current="true"` : ""} draggable="true">
          <span class="bcj-it">${q.revealed ? "" : `<i class="fa-solid fa-eye-slash" aria-hidden="true"></i><span class="bcj-sr">${esc(L("HiddenPrefix"))} </span> `}${esc(q.name)}</span><span class="bcj-is">${mark}${esc(sub)}</span><span class="bcj-iw">${icons}</span></div>`;
      }).join("");
      return `<div class="bcj-group ${folded ? "bcj-folded" : ""}" data-group="${esc(heading)}"><div class="bcj-gh"><button type="button" class="bcj-fold" data-action="bcjFold" data-fold="${esc(foldKey(heading))}" aria-expanded="${!folded}" aria-controls="bcj-q-${status}"${tipAttr(folded ? L("ShowThisGroup") : L("FoldThisGroup"))}><i class="fa-solid ${folded ? "fa-chevron-right" : "fa-chevron-down"}" aria-hidden="true"></i> ${esc(groupLabel(heading))}${folded ? ` <span class="bcj-count">${items.length}</span>` : ""}</button></div><div class="bcj-gitems" id="bcj-q-${status}">${rows}</div></div>`;
    }).join("");
  }

  /** A quest in the reading pane, drawn by Trackers as the players see it. */
  #questPage(q, api) {
    if (!q) return `<article class="bcj-page bcj-blank"><p class="bcj-hint">${this.isGM ? L("QuestsMadeInCampaignTrackersShow") : L("NoQuestsYet")}</p></article>`;
    const done = q.shownDone ?? q.done, total = q.shownTotal ?? q.total;
    const meta = [q.statusLabel, q.category, total ? L("ObjectivesDone", { done, total }) : ""].filter(Boolean).join(" · ");
    const body = q.revealed ? api?.questHTML(q.id) : null;
    const note = this.isGM
      ? `<p class="bcj-hint">${q.revealed ? L("AsThePlayersSeeItOpen") : L("PlayersCanTSeeThisQuest")}</p>`
      : "";
    return `<article class="bcj-page bcj-quest" data-quest="${esc(q.id)}">
      <header class="bcj-ph"><div><h1>${esc(q.name)}</h1><div class="bcj-meta">${esc(meta)}</div></div></header>
      <div class="bcj-tools"><button type="button" data-action="bcjQuestOpen"${tipAttr(L("OpenItInCampaignTrackers"))}><i class="fa-solid fa-scroll" aria-hidden="true"></i> ${esc(L("OpenInTrackers"))}</button><button type="button" data-action="bcjCopyQuest"${tipAttr(L("CopyALinkToThisQuest"))}><i class="fa-solid fa-link" aria-hidden="true"></i> ${esc(L("CopyLink"))}</button></div>
      ${note}<div class="bcj-text bcj-qtext">${body ?? (this.isGM ? "" : `<p class="bcj-hint">${esc(L("QuestNotOpen"))}</p>`)}</div>
    </article>`;
  }

  #empty() {
    const tip = this.isGM
      ? L("EmptyGM")
      : this.view.tab === "mine" ? L("NothingHereYetUseStrongNew")
      : L("NothingInThePartyJournalYet");
    return `<article class="bcj-page bcj-blank"><p class="bcj-hint">${tip}</p></article>`;
  }

  async #page(d) {
    const entry = d.entry;
    const body = await contentHTML(entry);
    const att = d.kind === "recap" && d.attended.length
      ? `<div class="bcj-att"><span class="bcj-k">${esc(L("AtTheTable"))}</span>${d.attended.map((id) => game.users.get(id)).filter(Boolean).map((u) => {
        const w = who(u);
        return `<span class="bcj-dot" aria-hidden="true" style="--c:${esc(w.color)}" data-tooltip-text="${esc(w.name)}">${esc(w.initial)}</span>`;
      }).join("")}<span class="bcj-sr">${esc(L("AtTheTableNames", { names: listOf(d.attended.map((id) => game.users.get(id)).filter(Boolean).map((u) => who(u).name)) }))}</span></div>`
      : "";
    const B = (action, icon, label, tip = "", extra = "") => `<button type="button" data-action="${action}"${extra}${tip ? tipAttr(tip) : ""}><i class="${icon}" aria-hidden="true"></i> ${label}</button>`;
    const gm = this.isGM;
    const mine = !gm && d.area === "player" && d.user === game.user.id && entry.isOwner;
    const copy = mine ? sharedCopyOf(entry.id, game.user.id) : null;
    const pinnable = gm && (d.area === "party" || (d.kind === "handout" && d.all));
    // Short notes are written in the window itself: an entry with one text page the user can edit.
    const writable = canWriteHere(entry);
    const writing = writable && this.writing === entry.id;
    const pins = pinnable && d.pinned ? readable().filter((x) => x.pinned).sort(comparePinned).map((x) => x.id) : [];
    const at = pins.indexOf(d.id);
    // In the row: what's used at the table. Under More: the rest. Delete stands apart at the end.
    const row = [
      gm && d.kind === "recap" ? B("bcjPrevious", "fa-solid fa-clock-rotate-left", L("PreviouslyOn"), L("ShowTheShortVersionToThe")) : "",
      gm ? B("bcjShow", "fa-solid fa-eye", L("ShowToPlayers"), L("OpenItOnTheScreensOf")) : "",
      mine ? B("bcjShare", "fa-solid fa-share-from-square", copy ? L("UpdateTheSharedCopy") : L("ShareACopyToTheParty"), copy ? L("ReplaceSharedCopy", { name: copy.name }) : L("EveryoneWillBeAbleToRead")) : "",
      writable && !writing ? B("bcjWrite", "fa-solid fa-feather-pointed", L("WriteHere"), L("WriteInThisEntryWithoutLeaving")) : "",
      writing ? B("bcjWriteDone", "fa-solid fa-check", L("Done"), L("SaveWhatYouWroteAndGo")) : "",
      entry.isOwner && !writing ? `<button type="button" class="bcj-edit" data-action="bcjEdit"><i class="fa-solid fa-pen" aria-hidden="true"></i> ${esc(L("Edit"))}</button>` : "",
    ].join("");
    const more = [
      gm && d.kind === "recap" ? B("bcjDetails", "fa-solid fa-sliders", L("Details"), L("SessionDatesAndWhoWasAt")) : "",
      gm && d.kind === "handout" ? B("bcjGive", "fa-solid fa-user-plus", L("GiveTo"), L("ChooseWhoGetsThisHandout")) : "",
      pinnable ? B("bcjPin", d.pinned ? "fa-solid fa-thumbtack-slash" : "fa-solid fa-thumbtack", d.pinned ? L("Unpin") : L("Pin"), d.pinned ? L("PutItBackInItsPlace") : L("KeepItAtTheTopOf")) : "",
      at > 0 ? B("bcjMove", "fa-solid fa-arrow-up", L("MoveUp"), L("MoveItUpAmongThePinned"), ` data-step="-1"`) : "",
      at >= 0 && at < pins.length - 1 ? B("bcjMove", "fa-solid fa-arrow-down", L("MoveDown"), L("MoveItDownAmongThePinned"), ` data-step="1"`) : "",
      gm && d.area === "party" ? B("bcjReaders", d.all ? "fa-solid fa-eye-slash" : "fa-solid fa-users", d.all ? L("HideFromPlayers") : L("LetPlayersReadIt"), d.all ? L("OnlyGMsWillSeeItAnyone") : L("EveryPlayerCanReadItPlayers")) : "",
      d.area === "party" && d.all && (gm || (d.author === game.user.id && entry.isOwner)) ? B("bcjEditing", d.editable ? "fa-solid fa-lock" : "fa-solid fa-user-pen", d.editable ? L("StopPartyEditing") : L("LetThePartyEdit"), d.editable ? L("OnlyTheAuthorAndTheGM") : L("EveryPlayerCanEditItAnd")) : "",
      B("bcjMarkdown", "fa-solid fa-file-arrow-down", L("Markdown"), L("DownloadThisEntryAsAMarkdown")),
    ].join("");
    const del = gm || (entry.isOwner && (mine || (d.area === "party" && d.author === game.user.id))) ? `<button type="button" class="bcj-delete" data-action="bcjDelete"><i class="fa-solid fa-trash" aria-hidden="true"></i> ${esc(L("Delete"))}</button>` : "";
    const menu = more ? `<details class="bcj-more" data-focus-key="more"><summary><i class="fa-solid fa-ellipsis" aria-hidden="true"></i> ${esc(L("More"))}</summary><div class="bcj-menu">${more}</div></details>` : "";
    const tools = row + menu + del;
    const sharedNote = mine && copy ? `<p class="bcj-shared"><i class="fa-solid fa-share-from-square" aria-hidden="true"></i> ${esc(L("CopyIsInPartyJournal", { name: copy.name }))}</p>` : "";
    const text = d.kind === "handout" ? `<div class="bcj-letter">${body}</div>` : body;
    return `<article class="bcj-page bcj-kind-${d.kind}" data-entry="${esc(d.id)}">
      <header class="bcj-ph"><div><h1>${esc(d.name)}</h1><div class="bcj-meta">${esc(metaline(d))}</div>${att}${this.#steps(d)}</div>
        <div class="bcj-seen"><span class="bcj-k">${esc(L("WhoCanSee"))}</span>${dots(d)}</div></header>
      ${tools ? `<div class="bcj-tools">${tools}</div>` : ""}${sharedNote}
      <div class="bcj-flow">${writing ? `<div class="bcj-text bcj-writing" data-write="${esc(entry.id)}"></div>` : `<nav class="bcj-toc" hidden></nav><div class="bcj-text" data-body="${esc(bodyKey(entry))}">${text}</div>`}</div>
    </article>`;
  }

  /** Put Foundry's editor into the reading pane of the entry being written (once; it's kept through redraws). */
  #writer() {
    const box = this.element.querySelector(".bcj-writing[data-write]");
    if (!box || box.querySelector("prose-mirror")) return;
    const page = game.journal.get(box.dataset.write)?.pages.contents[0];
    if (!page) return;
    // A draft from a failed save: this window's, or one kept in this browser when the window closed.
    const kept = store.get("draft", null);
    const draft = this.draft?.id === page.parent.id ? this.draft : kept?.id === page.parent.id ? kept : null;
    if (draft && draft !== this.draft) this.draft = { id: draft.id, html: draft.html };
    const value = draft ? draft.html : page.text?.content ?? "";
    const editor = foundry.applications.elements.HTMLProseMirrorElement.create({ name: "content", value, toggled: false, documentUUID: page.uuid });
    editor.setAttribute("aria-label", L("WriteIn", { name: page.parent.name }));
    // The editor's own Save (in its menu) saves to the page too.
    editor.addEventListener("change", () => this.#saveWriting(page, editor.value ?? "").catch(() => {}));
    box.append(editor);
    editor.focus?.();
  }

  /** Save what's in the editor to its page, if it changed. */
  async #saveWriting(page, html) {
    if (html === (page.text?.content ?? "")) return;
    try {
      await page.update({ "text.content": html });
    } catch (err) {
      notice("warn", L("CouldntSaveWriting", { error: err.message }));
      throw err;
    }
  }

  /** Stop writing, saving first; false (still writing, with the text kept for the editor) if the save failed. The
   * editor is read before anything is awaited, so a redraw straight after a call doesn't lose the text. */
  async finishWriting() {
    const id = this.writing;
    if (!id) return true;
    const editor = this.element?.querySelector(".bcj-writing[data-write] prose-mirror");
    if (editor && editor.closest("[data-write]").dataset.write === id) this.draft = { id, html: editor.value ?? "" };
    const page = game.journal.get(id)?.pages.contents[0];
    if (page && this.draft?.id === id) {
      try {
        await this.#saveWriting(page, this.draft.html);
      } catch {
        this.draft.failed = true;
        return false;
      }
    }
    if (this.draft?.id === id) this.draft = null;
    if (store.get("draft", null)?.id === id) store.set("draft", null);
    if (this.writing === id) this.writing = null;
    return true;
  }

  static #onWrite() {
    this.writing = this.view.entry;
    this.render();
  }

  static async #onWriteDone() {
    if (await this.finishWriting()) this.render();
  }

  /** Save what's being written before the window closes. If that fails, the text is kept in this browser and Write
   * here on that entry brings it back (the window still closes: one window at a time depends on it). */
  async close(options) {
    if (!(await this.finishWriting()) && this.draft) {
      store.set("draft", { id: this.draft.id, html: this.draft.html });
      notice("warn", L("DraftKept", { name: game.journal.get(this.draft.id)?.name ?? "" }));
    }
    return super.close(options);
  }

  /** Previous and Next under a recap's title: the sessions either side of it that this user can read. */
  #steps(d) {
    if (d.kind !== "recap") return "";
    // compareRecaps puts the newest session first.
    const recaps = readable().filter((x) => x.kind === "recap" && x.area === "party").sort(compareRecaps);
    const i = recaps.findIndex((x) => x.id === d.id);
    const older = recaps[i + 1], newer = recaps[i - 1];
    if (!older && !newer) return "";
    const step = (x, icon, word, after) => `<button type="button" class="bcj-stepbtn" data-action="bcjStep" data-entry="${esc(x.id)}" aria-label="${word}: ${esc(x.name)}"${tipAttr(`${word}: ${x.name}`)}>${after ? "" : `<i class="fa-solid ${icon}" aria-hidden="true"></i> `}${word}${after ? ` <i class="fa-solid ${icon}" aria-hidden="true"></i>` : ""}</button>`;
    return `<nav class="bcj-steps" aria-label="${esc(L("Sessions"))}">${older ? step(older, "fa-chevron-left", L("PreviousSession"), false) : "<span></span>"}${newer ? step(newer, "fa-chevron-right", L("NextSession"), true) : ""}</nav>`;
  }

  _replaceHTML(result, content) {
    const scroll = content.querySelector(".bcj-read")?.scrollTop ?? 0;
    const listScroll = content.querySelector(".bcj-scroll")?.scrollTop ?? 0;
    const page = content.querySelector(".bcj-page");
    const sameEntry = this.view.tab === "quests" ? !!page?.dataset.quest && page.dataset.quest === this.view.quest : page?.dataset.entry === this.view.entry;
    // Someone typing in the search box keeps their place when a change elsewhere redraws the window.
    const typing = document.activeElement?.name === "bcj-q" && content.contains(document.activeElement) ? document.activeElement : null;
    const caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    // The editor being written in, or else the body on screen, stays in the page through the redraw if the new draw
    // brings the same one: the new markup is put in around it, so it's never taken out (Foundry rebuilds an editor
    // that leaves the page, and a selection or a playing video would be lost).
    const oldWrite = content.querySelector(".bcj-writing[data-write]");
    const oldBody = content.querySelector(".bcj-text[data-body]");
    const fresh = document.createElement("template");
    fresh.innerHTML = result;
    const newWrite = fresh.content.querySelector(".bcj-writing[data-write]");
    const newBody = fresh.content.querySelector(".bcj-text[data-body]");
    const kept =
      (oldWrite && newWrite && oldWrite.dataset.write === newWrite.dataset.write && keepInPlace(oldWrite, newWrite, content, fresh.content)) ||
      (oldBody && newBody && oldBody.dataset.body === newBody.dataset.body && oldBody.className === newBody.className && keepInPlace(oldBody, newBody, content, fresh.content));
    if (!kept) content.replaceChildren(fresh.content);
    if (typing) {
      const input = content.querySelector('input[name="bcj-q"]');
      input?.focus();
      if (caret) input?.setSelectionRange(...caret);
    }
    if (sameEntry) content.querySelector(".bcj-read").scrollTop = scroll;
    const ls = content.querySelector(".bcj-scroll");
    if (ls) ls.scrollTop = listScroll;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    openApps.add(this);
  }

  _onClose(options) {
    super._onClose?.(options);
    openApps.delete(this);
  }

  /** Minimized, kept here because Foundry's own `minimized` reads false while the window redraws. */
  #collapsed = false;
  /** An entry was just opened by name while the window was minimized: the restore holds nothing. */
  #picking = false;
  #restoring = null;
  minimize() {
    if (this.rendered) this.#collapsed = true;
    return super.minimize();
  }
  /** Restore (the kit's window memory does the work): what changed while minimized is held before the window counts
   * as in front again, so no draw marks it seen in between. */
  maximize() {
    if (!this.#collapsed) return super.maximize();
    if (this.#restoring) return this.#restoring;
    this.#restoring = (async () => {
      const held = this.#picking ? ((this.held = null), false) : this.#holdIfChanged();
      this.#picking = false;
      try {
        await super.maximize();
      } finally {
        this.#collapsed = this.minimized;
      }
      // Redraw so a held quest shows its mark (the quest on show isn't marked in a draw made before the hold).
      if (held && this.held?.startsWith("q:") && this.rendered && !this.minimized) this.render();
    })().finally(() => (this.#restoring = null));
    return this.#restoring;
  }

  /** Show an entry opened by name (a GM's Show to players, a link, a new entry): it counts as the player's pick. */
  pick(entryId) {
    const d = entryId ? describe(game.journal.get(entryId) ?? {}) : null;
    if (!d) return;
    // What's being written in another entry is saved first (it reads the editor before anything is redrawn).
    if (this.writing && this.writing !== entryId) this.finishWriting();
    this.view.entry = entryId;
    this.held = null;
    this.#picking = this.#collapsed;
    this.view.tab = d.area === "party" || (d.kind === "handout" && d.all) ? "party" : game.user.isGM ? (d.kind === "handout" ? "handouts" : "players") : "mine";
  }

  _onRender() {
    const el = this.element;
    // The table of contents, from the page's headings.
    const heads = [...el.querySelectorAll(":is(.bcj-text[data-body], .bcj-qtext) :is(h1, h2, h3)")];
    const toc = el.querySelector(".bcj-toc");
    if (toc && heads.length > 1) {
      heads.forEach((h, i) => (h.dataset.bcjHead = String(i)));
      toc.innerHTML = `<div class="bcj-k" id="bcj-toc-k">${esc(L("OnThisPage"))}</div>${heads.map((h, i) => `<button type="button" data-action="bcjToc" data-head="${i}" class="bcj-tocitem bcj-toc-${h.tagName.toLowerCase()}">${esc(h.textContent.trim())}</button>`).join("")}`;
      toc.hidden = false;
    }
    this.#dragPins();
    this.#questEvents();
    this.#writer();
    // The More menu closes once something in it is chosen, on Escape (which then doesn't close the window), and when
    // focus leaves it.
    const more = el.querySelector(".bcj-more");
    if (more) {
      more.querySelector(".bcj-menu")?.addEventListener("click", (ev) => {
        if (!ev.target.closest("button")) return;
        // Focus goes back to More (and the redraw puts it there again), not to the page.
        more.querySelector("summary")?.focus();
        more.open = false;
      });
      more.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape" || !more.open) return;
        ev.stopPropagation();
        more.open = false;
        more.querySelector("summary")?.focus();
      });
      more.addEventListener("focusout", (ev) => {
        if (!more.contains(ev.relatedTarget)) more.open = false;
      });
    }
    const input = el.querySelector('input[name="bcj-q"]');
    input?.addEventListener("input", () => {
      this.view.query = input.value;
      this.#filter();
    });
    this.#filter();
  }

  /** On the Quests tab: drag a quest into a journal page as a link; links in the quest go to that quest or sheet. */
  #questEvents() {
    if (this.view.tab !== "quests") return;
    for (const a of this.element.querySelectorAll(".bcj-qitem")) {
      a.addEventListener("dragstart", (ev) => ev.dataTransfer.setData("text/plain", `@Quest[${a.dataset.quest}]`));
    }
    this.element.querySelector(".bcj-qtext")?.addEventListener("click", async (ev) => {
      const go = ev.target.closest("[data-pct-action]");
      if (!go) return;
      ev.preventDefault();
      if (go.dataset.pctAction === "pctQuestGo" && go.dataset.qid) {
        this.view.quest = go.dataset.qid;
        this.held = null;
        this.render();
      } else if (go.dataset.pctAction === "pctOpenActor" && go.dataset.uuid) {
        const actor = await fromUuid(go.dataset.uuid);
        if (!actor) notice("info", L("ThatSNoLongerInThe"));
        else if (actor.testUserPermission(game.user, "LIMITED")) actor.sheet.render({ force: true });
        else notice("info", L("YouCanTOpenThatYet"));
      }
    });
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
          .catch((err) => notice("warn", L("CouldntSaveOrder", { error: err.message })));
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
        const key = a.dataset.entry;
        // A quest's words are read from Trackers the first time someone searches.
        if (q && key && !this.texts.has(key)) {
          if (key.startsWith("quest:")) this.texts.set(key, questText(questApi(), key.slice(6)));
          else if (game.journal.get(key)) this.texts.set(key, textOf(game.journal.get(key)));
        }
        const title = a.querySelector(".bcj-it")?.textContent;
        const ok = matches(q, title, this.texts.get(key));
        a.hidden = !ok;
        if (ok) shown++;
        // Where the text matched, when the title alone doesn't: a line under the entry.
        a.querySelector(".bcj-snip")?.remove();
        if (ok && q && !matches(q, title, "")) {
          const snip = snippetHTML(this.texts.get(key), q);
          if (snip) a.insertAdjacentHTML("beforeend", `<span class="bcj-snip">${snip}</span>`);
        }
      }
      const hasItems = !!g.querySelector(".bcj-item");
      g.hidden = !!q && hasItems && !shown || !!q && !hasItems;
      if (shown) any = true;
    }
    const none = el.querySelector(".bcj-nomatch");
    if (none) none.hidden = !q || any;
    // While searching, matches show even in folded groups.
    el.querySelector(".bcj-scroll")?.classList.toggle("bcj-searching", !!q);
    this.#highlight(q);
  }

  /** Mark the search's words in the reading pane (and clear the last marks; the pane can be kept across redraws). */
  #highlight(q) {
    const body = this.element?.querySelector(".bcj-read :is(.bcj-text[data-body], .bcj-qtext)");
    if (!body) return;
    for (const m of body.querySelectorAll("mark.bcj-hit")) {
      const parent = m.parentNode;
      m.replaceWith(...m.childNodes);
      parent.normalize();
    }
    const words = queryWords(q);
    if (!words.length) return;
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("script, style, mark, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let count = 0;
    for (const node of nodes) {
      if (count > 300) break;
      const text = node.nodeValue;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(re)) {
        frag.append(text.slice(last, m.index));
        const mark = document.createElement("mark");
        mark.className = "bcj-hit";
        mark.textContent = m[0];
        frag.append(mark);
        last = m.index + m[0].length;
        count++;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  static async #onQuest(event, target) {
    if (!(await this.finishWriting())) return;
    this.view.quest = target.dataset.quest;
    this.held = null;
    this.render();
  }

  static #onQuestOpen() {
    const api = questApi();
    if (api && this.view.quest) api.openQuest(this.view.quest);
  }

  /** Show a quest on the Quests tab (from a quest link in the window). */
  showQuest(id) {
    this.view.tab = "quests";
    this.view.quest = id;
    this.view.query = "";
    this.held = null;
    this.render();
  }

  /** Copy a quest's link (the same text a drag from the list writes), for pasting into a journal page. */
  static async #onCopyQuest() {
    const id = this.view.quest;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(`@Quest[${id}]`);
      notice("info", L("CampaignJournalTheQuestSLink"));
    } catch {
      notice("warn", L("CouldntCopyLink", { id }));
    }
  }

  /** Move a pinned entry up or down among the pins (the keyboard way to drag it). */
  static async #onMove(event, target) {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const ids = readable().filter((x) => x.pinned).sort(comparePinned).map((x) => x.id);
    const i = ids.indexOf(entry.id);
    const step = Number(target.dataset.step);
    const other = ids[i + step];
    if (i < 0 || !other) return;
    const order = moveId(ids, entry.id, other, step > 0);
    await JournalEntry.updateDocuments(order.map((id, n) => ({ _id: id, [`flags.${MOD}.pinOrder`]: n }))).catch((err) => notice("warn", L("CouldntSaveOrder", { error: err.message })));
    this.announceText?.(L(step > 0 ? "MovedDown" : "MovedUp", { name: entry.name }));
  }

  /** Previous or Next session from a recap. */
  static async #onStep(event, target) {
    if (!(await this.finishWriting())) return;
    if (!target.dataset.entry) return;
    this.view.entry = target.dataset.entry;
    this.held = null;
    this.render();
  }

  static async #onTab(event, target) {
    if (!(await this.finishWriting())) return;
    this.view.tab = target.dataset.tab;
    this.view.entry = null;
    this.held = null;
    this.render();
  }

  static async #onEntry(event, target) {
    if (!(await this.finishWriting())) return;
    this.view.entry = target.dataset.entry;
    this.held = null;
    this.render();
  }

  /** What a player picks counts as seen, and so does what a draw shows in an open window, except while minimized
   * and, after a restore, what changed while it was minimized: that keeps its mark until the player picks something. */
  held = null;
  /** A quest's mark shows unless it's the one on show, and the one on show keeps it while held after a restore. */
  #showMark(q) {
    return !!q.mark && (q.id !== this.view.quest || this.held === `q:${q.id}`);
  }
  #inFront(key) {
    return !this.#collapsed && this.held !== key;
  }
  /** On a restore: hold the entry or quest on show if it changed while the window was minimized. True if held. */
  #holdIfChanged() {
    if (this.view.tab === "quests") {
      if (this.isGM) return false;
      const q = this.view.quest && questApi() ? questList().find((x) => x.id === this.view.quest) : null;
      if (!q?.mark) return false;
      this.held = `q:${q.id}`;
      return true;
    }
    const entry = this.view.entry && game.journal.get(this.view.entry);
    const d = entry && describe(entry);
    if (!d || !entry.testUserPermission(game.user, "OBSERVER") || !freshness(d)) return false;
    this.held = `e:${d.id}`;
    return true;
  }

  static #onEdit() {
    const entry = game.journal.get(this.view.entry);
    if (!entry?.isOwner) return;
    const pages = entry.pages.contents;
    if (pages.length === 1 && pages[0].type === "text") pages[0].sheet.render({ force: true });
    else entry.sheet.render({ force: true });
  }

  static #onOpenPage(event, target) {
    const entry = game.journal.get(this.view.entry);
    const page = entry?.pages.get(target.dataset.page);
    if (page) entry.sheet.render({ force: true, pageId: page.id });
  }

  static #onToc(event, target) {
    const h = this.element.querySelector(`[data-bcj-head="${target.dataset.head}"]`);
    h?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  static #onFolders() {
    ui.sidebar?.changeTab?.("journal", "primary");
    // Foundry 14 keeps open folders in game.folders._expanded, by folder uuid.
    for (const role of ["root", "party", "handouts", "players"]) {
      const f = findFolder(role);
      if (f && game.folders._expanded) game.folders._expanded[f.uuid] = true;
    }
    ui.journal?.render();
  }

  static async #onNewRecap() {
    if (!this.isGM) return;
    if (!(await this.finishWriting())) return;
    const party = findFolder("party");
    if (!party) return notice("warn", L("CampaignJournalThePartyFolderIsn"));
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
    if (!data.md.trim()) entry.pages.contents[0]?.sheet.render({ force: true });
  }

  static async #onDetails() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const f = flagsOf(entry);
    const data = await recapDialog({ session: f.session, title: titleOfRecap(entry.name), date: f.date, played: f.played, attended: f.attended ?? [], subtitle: f.subtitle ?? "" }, { create: false });
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
    if (!(await this.finishWriting())) return;
    const party = findFolder("party");
    if (!party) return notice("warn", L("CampaignJournalThePartyFolderIsn"));
    const data = await DialogV2().wait({
      window: { title: L("NewPage"), icon: "fa-solid fa-file-lines" },
      classes: ["bcj-dialog"],
      position: { width: 420 },
      render: needsTitle,
      content: `<div class="bcj-form"><label>${esc(L("FieldTitle"))} <input type="text" name="name" placeholder="${esc(L("PagePlaceholder"))}" autofocus></label>
        <label class="bcj-check"><input type="checkbox" name="pinned"> ${esc(L("PinItToTop"))}</label>
        <label class="bcj-check"><input type="checkbox" name="share" checked> ${esc(L("PlayersCanReadItNow"))}</label>
        <label class="bcj-check"><input type="checkbox" name="edit"> ${esc(L("PartyCanEditToo"))}</label></div>`,
      buttons: [
        { action: "ok", label: L("MakeIt"), icon: "fa-solid fa-check", default: true, callback: (event, button) => {
          const e = button.form.elements;
          return { name: e.name.value.trim(), pinned: e.pinned.checked, share: e.share.checked || e.edit.checked, edit: e.edit.checked };
        } },
        { action: "cancel", label: L("Cancel") },
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
    entry.pages.contents[0]?.sheet.render({ force: true });
  }

  static async #onNewHandout() {
    if (!this.isGM) return;
    if (!(await this.finishWriting())) return;
    const folder = findFolder("handouts");
    if (!folder) return notice("warn", L("CampaignJournalTheHandoutsFolderIsn"));
    const data = await giveDialog({ title: L("NewHandout"), name: "", everyone: false, readers: [] });
    if (!data?.name) return;
    const picture = data.layout === "picture" && data.src;
    const page = picture ? { name: data.name, type: "image", src: data.src, image: { caption: "" } } : { name: data.name, type: "text", text: { content: data.layout === "letter" ? TEMPLATES.letter : "", format: 1 } };
    const entry = await JournalEntry.create({
      name: data.name, folder: folder.id, ownership: ownershipFor({ default: LEVEL.NONE }, data.everyone, data.readers, players().map((u) => u.id)),
      pages: [page],
    });
    if (!entry) return;
    this.view.tab = "handouts";
    this.view.entry = entry.id;
    this.held = null;
    this.render();
    // A letter or a blank page opens for writing; a picture is ready as it is.
    if (!picture) entry.pages.contents[0]?.sheet.render({ force: true });
  }

  static async #onGive() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const { readers, all } = readersOf(entry.ownership, game.users.contents);
    const data = await giveDialog({ title: L("GiveTitle", { name: entry.name }), everyone: all, readers: readers.map((u) => u.id) });
    if (!data) return;
    await entry.update({ ownership: ownershipFor(entry.ownership, data.everyone, data.readers, players().map((u) => u.id)) });
  }

  static async #onPin() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    if (flagsOf(entry).pinned) return entry.update({ [`flags.${MOD}.pinned`]: false, [`flags.${MOD}.pinOrder`]: new foundry.data.operators.ForcedDeletion() });
    const last = Math.max(-1, ...readable().filter((d) => d.pinned && Number.isFinite(d.pinOrder)).map((d) => d.pinOrder));
    await entry.update({ [`flags.${MOD}.pinned`]: true, [`flags.${MOD}.pinOrder`]: last + 1 });
  }

  static #onShow() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    const to = readersOf(entry.ownership, game.users.contents).readers.filter((u) => u.active);
    if (!to.length) return notice("warn", L("NoReaderLoggedIn", { name: entry.name }));
    game.socket.emit(SOCKET, { type: "show", entry: entry.id, users: to.map((u) => u.id) });
    notice("info", L("ShownTo", { names: listOf(to.map((u) => who(u).name)) }));
  }

  static #onPrevious() {
    const entry = game.journal.get(this.view.entry);
    if (!this.isGM || !entry) return;
    if (!shortOf(entry)) return notice("warn", L("NoShortVersion", { name: entry.name }));
    const to = readersOf(entry.ownership, game.users.contents).readers.filter((u) => u.active);
    if (to.length) game.socket.emit(SOCKET, { type: "previously", entry: entry.id, users: to.map((u) => u.id) });
    else notice("info", L("NoReaderOnlyYou", { name: entry.name }));
    PreviouslyApp.show(entry);
  }

  static async #onMarkdown() {
    const entry = game.journal.get(this.view.entry);
    const d = entry && describe(entry);
    if (!d) return;
    const copy = await askCopy("entry");
    if (!copy) return;
    if (copy === "pub" && !forPlayers(d)) return notice("warn", L("NoPlayerCanReadThisEntry"));
    foundry.utils.saveDataToFile(entryMarkdown(d, 1, copy), "text/markdown", `${slug(entry.name)}${copy === "gm" ? "-gm" : ""}.md`);
  }

  static async #onExport() {
    const seen = new Set();
    const all = this.groups(readable()).flatMap(([, items]) => items).filter((d) => !seen.has(d.id) && seen.add(d.id));
    if (!all.length) return notice("warn", L("NothingOnThisTabToExport"));
    // A tab's players' copy is for sharing with the table, so it holds only what every player can read; players'
    // own journals are private, so the GM's Players tab exports the GM copy without asking.
    const picked = this.isGM && this.view.tab === "players" ? "gm" : await askCopy("tab");
    if (!picked) return;
    const copy = picked === "pub" ? "table" : picked;
    const list = copy === "table" ? all.filter(forEveryone) : all;
    if (!list.length) return notice("warn", L("NothingOnThisTabIsShared"));
    const label = this.tabs().find(([k]) => k === this.view.tab)?.[1] ?? L("Title");
    const md = `# ${L(copy === "gm" ? "ExportHeadingGM" : "ExportHeading", { tab: label })}\n\n${list.map((d) => entryMarkdown(d, 2, copy)).join("\n\n---\n\n")}\n`;
    foundry.utils.saveDataToFile(md, "text/markdown", `campaign-journal-${slug(label)}${copy === "gm" ? "-gm" : ""}.md`);
  }

  static async #onNewEntry() {
    if (this.isGM) return;
    if (!(await this.finishWriting())) return;
    const name = await DialogV2().prompt({
      window: { title: L("NewJournalEntry"), icon: "fa-solid fa-feather" },
      classes: ["bcj-dialog"],
      render: needsTitle,
      content: `<div class="bcj-form"><label>${esc(L("FieldTitle"))} <input type="text" name="name" placeholder="${esc(L("EntryPlaceholder"))}" autofocus></label><p class="bcj-dim">${esc(L("OnlyYouAndGMRead"))}</p></div>`,
      ok: { label: L("MakeIt"), icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.name.value.trim() },
      rejectClose: false,
    });
    if (typeof name !== "string" || !name) return;
    playerDo({ type: "create", name: name.slice(0, 120) });
  }

  static async #onNewParty() {
    if (this.isGM) return;
    if (!(await this.finishWriting())) return;
    const data = await DialogV2().wait({
      window: { title: L("NewPartyEntry"), icon: "fa-solid fa-feather" },
      classes: ["bcj-dialog"],
      position: { width: 420 },
      render: needsTitle,
      content: `<div class="bcj-form"><label>${esc(L("FieldTitle"))} <input type="text" name="name" placeholder="${esc(L("PartyEntryPlaceholder"))}" autofocus></label>
        <label class="bcj-check"><input type="checkbox" name="edit"> ${esc(L("LetTheRestEdit"))}</label>
        <p class="bcj-dim">${esc(L("PartyEntryNote"))}</p></div>`,
      buttons: [
        { action: "ok", label: L("MakeIt"), icon: "fa-solid fa-check", default: true, callback: (event, button) => {
          const e = button.form.elements;
          return { name: e.name.value.trim(), edit: e.edit.checked };
        } },
        { action: "cancel", label: L("Cancel") },
      ],
      rejectClose: false,
    });
    if (!data || typeof data !== "object" || !data.name) return;
    playerDo({ type: "party", name: data.name.slice(0, 120), edit: !!data.edit });
  }

  static async #onEditing() {
    const entry = game.journal.get(this.view.entry);
    const d = entry && describe(entry);
    if (!d || d.area !== "party" || !d.all) return;
    const on = !d.editable;
    if (this.isGM) return entry.update({ ownership: editOwnership(on, d.author) });
    if (d.author !== game.user.id || !entry.isOwner) return;
    askGM({ type: "edit", entry: entry.id, on }, L("CampaignJournalAGMNeedsTo"));
  }

  static async #onReaders() {
    const entry = game.journal.get(this.view.entry);
    const d = entry && describe(entry);
    if (!this.isGM || !d || d.area !== "party") return;
    await entry.update({ ownership: { default: d.all ? LEVEL.NONE : LEVEL.OBSERVER } });
  }

  static #onFold(event, target) {
    const key = target.dataset.fold;
    if (!key) return;
    if (this.view.folded[key]) delete this.view.folded[key];
    else this.view.folded[key] = true;
    this.render();
  }

  static #onSort(event, target) {
    const key = target.dataset.sort;
    if (!["mine", "myHandouts", "players"].includes(key)) return;
    this.view.sorts[key] = this.view.sorts[key] === "az" ? "newest" : "az";
    this.render();
  }

  static async #onShare() {
    const entry = game.journal.get(this.view.entry);
    if (!entry?.isOwner || this.isGM) return;
    const copy = sharedCopyOf(entry.id, game.user.id);
    const ok = await DialogV2().confirm({
      window: { title: copy ? L("UpdateTheSharedCopy") : L("ShareACopy") },
      classes: ["bcj-dialog"],
      content: copy
        ? `<p>${L("ShareAgainText", { name: esc(copy.name), more: partyEdits(copy.ownership) ? esc(L("IncludingAnythingTheRestOfThe")) : "" })}</p>`
        : `<p>${L("ShareText", { name: esc(entry.name) })}</p>`,
      rejectClose: false,
    });
    if (ok) playerDo({ type: "share", entry: entry.id });
  }

  static async #onDelete() {
    const entry = game.journal.get(this.view.entry);
    if (!entry?.isOwner) return;
    const d = describe(entry);
    const owner = d?.area === "player" ? game.users.get(d.user) : null;
    const where = d?.area === "player" ? (owner?.id === game.user.id ? L("YourJournal") : L("PlayersJournal", { name: owner ? who(owner).name : L("AFormerPlayer") }))
      : d?.area === "handouts" ? L("TheHandouts") : L("ThePartyJournal");
    const ok = await DialogV2().confirm({ window: { title: L("Delete") }, classes: ["bcj-dialog"], content: `<p>${L("DeleteText", { name: esc(entry.name), where: esc(where) })}</p>`, rejectClose: false });
    if (!ok) return;
    try {
      await entry.delete();
    } catch (err) {
      notice("warn", L("CouldntDelete", { name: entry.name, error: err.message }));
    }
  }

  /** Open the window, on an entry if one is given. Resolves to the window. */
  static open(entryId = null) {
    return journalWindow.open(entryId);
  }
}

/** The one journal window: open() makes it or draws it again, and waits out a close in progress. */
const journalWindow = singleWindow((entryId) => {
  const app = new JournalApp();
  app.pick(entryId);
  return app;
}, { reuse: (app, entryId) => app.pick(entryId) });

/** "Previously on…": a recap's short version, on the screens of the players who can read it (and the GM's). */
class PreviouslyApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MOD}-previously`,
    classes: ["bcj", "bcj-prev"],
    window: { title: "BCJ.PreviouslyOn", icon: "fa-solid fa-clock-rotate-left" },
    position: { width: 520, height: "auto" },
    actions: { bcjReadAll: PreviouslyApp.#onReadAll },
  };

  constructor(entry) {
    super();
    this.entryId = entry.id;
  }

  async _renderHTML() {
    const entry = game.journal.get(this.entryId);
    if (!entry) return `<p class="bcj-hint">${esc(L("RecapGone"))}</p>`;
    const TE = foundry.applications.ux.TextEditor.implementation;
    const html = await TE.enrichHTML(shortOf(entry), { relativeTo: entry });
    return `<article class="bcj-page"><h1>${esc(entry.name)}</h1><div class="bcj-text">${html}</div>
      <div class="bcj-tools"><button type="button" data-action="bcjReadAll"><i class="fa-solid fa-book-open" aria-hidden="true"></i> ${esc(L("ReadTheWholeRecap"))}</button></div></article>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  static #onReadAll() {
    JournalApp.open(this.entryId);
    this.close();
  }

  /** One popup at a time: each show waits for the one before it, closes the old window, then opens its own. */
  static #queue = Promise.resolve();
  static show(entry) {
    PreviouslyApp.#queue = PreviouslyApp.#queue.then(async () => {
      await foundry.applications.instances.get(`${MOD}-previously`)?.close({ animate: false });
      await new PreviouslyApp(entry).render({ force: true });
    }).catch((err) => console.error(err));
    return PreviouslyApp.#queue;
  }
}


export { openApps, refreshTimer, questApi, GROUP_KEYS, groupLabel, QUEST_GROUPS, questList, questText, refresh, loadView, saveView, canWriteHere, keepInPlace, JournalApp, journalWindow, PreviouslyApp };
