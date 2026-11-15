import { esc } from "./kit/safe-text.mjs";
import { JournalApp, openApps, questApi, questList, refresh } from "./app.mjs";
import { L, MOD, SOCKET, TRACKERS } from "./constants.mjs";
import { areaOf, describe, ensureFolders, findFolder, noticeNew, roleOf, seedSeen, seenChanged, tabs, unseenCount, updateCount } from "./data.mjs";
import { notice } from "./helpers.mjs";
import { onSocket } from "./requests.mjs";

/**
 * Bayard's Campaign Journal: the entry point. Registers the setting and the hotkey, starts up at ready, and keeps the
 * window in step with the world through Foundry's hooks. The window is app.mjs; what it knows of entries is data.mjs.
 */

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

function registerKeys() {
  game.keybindings.register(MOD, "open", {
    name: "BCJ.KeyOpenName",
    hint: "BCJ.KeyOpenHint",
    editable: [{ key: "KeyJ", modifiers: [] }],
    onDown: () => {
      JournalApp.open();
      return true;
    },
  });
}

/** A button at the top of the Journal tab, and the journal's folder kept out of players' view there. */
function addDirectoryButton(app, html) {
  const root = html;
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
  btn.innerHTML = `<i class="fa-solid fa-book-open" aria-hidden="true"></i> ${esc(L("OpenButton"))} <span class="bcj-open-count" hidden></span>`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    JournalApp.open();
  });
  bar.append(btn);
  updateCount();
}

function start() {
  game.modules.get(MOD).api = { open: (entryId) => JournalApp.open(entryId), refresh };
  game.socket.on(SOCKET, onSocket);
  seedSeen();
  // What arrived while this player was away: one notice (the button in the Journal tab keeps the count).
  const waiting = game.user.isGM ? 0 : unseenCount();
  if (waiting) notice("info", waiting === 1 ? L("WaitingOne") : L("WaitingMany", { n: waiting }));
  tabs.start();
  // The lead GM tab makes any missing folders (leadNow waits out the election's first moments).
  if (game.user.isGM) ensureFolders();
  const dir = ui.journal;
  if (dir?.element) addDirectoryButton(dir, dir.element);
}

function registerSettings() {
  game.settings.register(MOD, "showFolder", {
    name: "BCJ.SettingShowFolderName",
    hint: "BCJ.SettingShowFolderHint",
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

/* Redraw only for changes to the journal's own entries and folders, and only for entries this user can read (every
 * entry reaches every client, so a player's private note would otherwise redraw everyone's window), except when who
 * can read it or where it is changed. */
const inJournal = (entry) => !!(entry && areaOf(entry.folder));
const canRead = (entry) => game.user.isGM || !!entry?.testUserPermission(game.user, "OBSERVER");
Hooks.on("createJournalEntry", (entry) => {
  if (inJournal(entry) && canRead(entry)) refresh();
  noticeNew(entry);
});
Hooks.on("deleteJournalEntry", (entry) => inJournal(entry) && canRead(entry) && refresh());
Hooks.on("updateJournalEntry", (entry, change) => {
  const moved = "ownership" in change || "folder" in change;
  if (moved ? inJournal(entry) || "folder" in change : inJournal(entry) && canRead(entry)) refresh();
  if (moved) noticeNew(entry);
});
for (const hook of ["createJournalEntryPage", "deleteJournalEntryPage"]) Hooks.on(hook, (page) => inJournal(page.parent) && canRead(page.parent) && refresh());
Hooks.on("updateJournalEntryPage", (page, change, options, userId) => {
  const entry = page.parent;
  if (inJournal(entry) && (canRead(entry) || "ownership" in change)) refresh();
  // Foundry's page editor renames the page, but the journal lists entries: a one-page entry in the journal takes
  // the page's new title (done by whoever renamed it, so players can rename entries they can't see in the sidebar).
  if (userId !== game.user.id || !("name" in change)) return;
  if (!entry || entry.pages.size !== 1 || !entry.isOwner || !describe(entry) || entry.name === page.name) return;
  entry.update({ name: page.name }).catch((err) => console.warn(`${MOD} | couldn't rename the entry`, err));
});
Hooks.on("createFolder", (folder) => {
  if (folder.type !== "JournalEntry") return;
  refresh();
  // A folder that appears later (the first GM login) is hidden from players too.
  if (!game.user.isGM) ui.journal?.render();
});
Hooks.on("updateFolder", (folder) => folder.type === "JournalEntry" && refresh());
Hooks.on("deleteFolder", (folder) => {
  if (folder.type !== "JournalEntry") return;
  refresh();
  if (roleOf(folder)) ensureFolders();
});
// Trackers' quests changed (or this user's New/Updated marks): redraw, for the Quests tab and its dot.
Hooks.on(`${TRACKERS}.changed`, () => {
  for (const app of openApps) {
    if (!app.rendered) continue;
    if (app.view.tab === "quests") app.render();
    else if (!game.user.isGM && questList().some((q) => q.mark && (q.id !== app.view.quest || app.held === `q:${q.id}`)) !== !!app.questDot) app.render();
  }
});
// A quest link clicked in this window opens the quest on the Quests tab instead of in Trackers.
Hooks.on(`${TRACKERS}.questLink`, (id, link) => {
  const app = [...openApps].find((a) => a.rendered && a.element?.contains(link));
  if (!app || !questApi()) return;
  app.showQuest(id);
  return false;
});
Hooks.on("createUser", () => {
  ensureFolders();
  refresh();
});
Hooks.on("updateUser", (user, change) => {
  // This user's seen marks, changed in another of their browsers.
  if (user.isSelf && change.flags?.[MOD] && "seen" in change.flags[MOD] && seenChanged(change.flags[MOD].seen)) refresh();
  if ("name" in change) ensureFolders();
  if ("name" in change || "color" in change || "character" in change) refresh();
});
