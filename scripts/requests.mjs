import { JournalApp, PreviouslyApp } from "./app.mjs";
import { L, LEVEL, MOD, SOCKET } from "./constants.mjs";
import { areaOf, describe, ensureFolders, findFolder, flagsOf, markSeen, noticed, tabs } from "./data.mjs";
import { editOwnership, notice } from "./helpers.mjs";

/** Bayard's Campaign Journal: players' requests answered by the GM's client, and the module's socket. */

/** The copy of a player's entry they shared to the party journal, if there is one. */
function sharedCopyOf(sourceId, userId) {
  return game.journal.find((e) => {
    const f = flagsOf(e);
    return f.sharedFrom === sourceId && f.sharedBy === userId && areaOf(e.folder)?.area === "party";
  }) ?? null;
}

/** Requests waiting for the GM's answer: request id to the timer that gives up after 10 s. */
const pending = new Map();
/** A player asks the GM's client to do something they may not have the rights for. False if no GM is logged in. */
function askGM(msg, offline = L("CampaignJournalAGMNeedsTo2")) {
  if (!game.users.activeGM) {
    notice("warn", offline);
    return false;
  }
  const rid = foundry.utils.randomID(12);
  pending.set(rid, setTimeout(() => {
    pending.delete(rid);
    notice("warn", L("CampaignJournalTheGMSClient"));
  }, 10000));
  game.socket.emit(SOCKET, { ...msg, rid });
  return true;
}
/** A GM's answer came: stop waiting for it. */
function answered(rid) {
  if (!rid || !pending.has(rid)) return;
  clearTimeout(pending.get(rid));
  pending.delete(rid);
}

/** A journal action for a player that can't be done (the user is told why). */
class Refused extends Error {}

/** A new entry in a player's own journal. */
async function makeEntry(user, name) {
  const folder = findFolder("player", user.id);
  if (!folder) throw new Refused(L("YourJournalFolderIsnTThere"));
  name = String(name ?? "").trim().slice(0, 120) || L("Untitled");
  return JournalEntry.create({ name, folder: folder.id, ownership: { default: LEVEL.NONE, [user.id]: LEVEL.OWNER }, pages: [{ name, type: "text", text: { content: "", format: 1 } }] });
}

/** A new party entry signed by a player, which the party may or may not edit. */
async function makePartyEntry(user, name, edit) {
  const party = findFolder("party");
  if (!party) throw new Refused(L("ThePartyJournalIsnTThere"));
  name = String(name ?? "").trim().slice(0, 120) || L("Untitled");
  return JournalEntry.create({ name, folder: party.id, ownership: editOwnership(!!edit, user.id), flags: { [MOD]: { author: user.id } }, pages: [{ name, type: "text", text: { content: "", format: 1 } }] });
}

/** A copy of a player's entry in the party journal, or the earlier copy brought up to date. */
async function shareCopy(user, sourceId) {
  const source = game.journal.get(sourceId);
  const d = source && describe(source);
  if (!d || d.area !== "player" || d.user !== user.id || !source.testUserPermission(user, "OWNER")) throw new Refused(L("OnlyAnEntryInYourOwn"));
  const party = findFolder("party");
  if (!party) throw new Refused(L("ThePartyJournalIsnTThere"));
  // Only the pages the player may read go into the copy (a GM note page hidden from them stays out).
  const pages = source.pages.contents.filter((page) => page.testUserPermission(user, "OBSERVER")).sort((a, b) => a.sort - b.sort).map((page) => {
    const data = page.toObject();
    delete data._id;
    data.ownership = { default: LEVEL.INHERIT };
    return data;
  });
  let copy = sharedCopyOf(source.id, user.id);
  if (copy && !copy.testUserPermission(user, "OWNER")) throw new Refused(L("TheSharedCopyIsnTYours"));
  if (copy) {
    // The new pages go in before the old ones go, so a failure never leaves the copy empty.
    const old = copy.pages.map((pg) => pg.id);
    await copy.update({ name: source.name });
    await copy.createEmbeddedDocuments("JournalEntryPage", pages);
    if (old.length) await copy.deleteEmbeddedDocuments("JournalEntryPage", old);
  } else {
    copy = await JournalEntry.create({ name: source.name, folder: party.id, ownership: { default: LEVEL.OBSERVER, [user.id]: LEVEL.OWNER }, flags: { [MOD]: { sharedFrom: source.id, sharedBy: user.id } }, pages });
  }
  return copy;
}

/** What a player sees once a new entry or a shared copy exists. */
function afterDone(what, entry) {
  if (what === "create") {
    JournalApp.open(entry.id);
    entry.pages.contents[0]?.sheet.render({ force: true });
  } else if (what === "share") {
    noticed.add(entry.id);
    markSeen(entry);
    notice("info", L("InThePartyJournal", { name: entry.name }));
  }
}

/** A player's new entry, party entry or shared copy: made on their own client when Foundry lets them create
 * journal entries (so it works with no GM logged in), otherwise by the GM's client. */
async function playerDo(msg) {
  if (game.user.can("JOURNAL_CREATE")) {
    try {
      const entry = msg.type === "create" ? await makeEntry(game.user, msg.name)
        : msg.type === "party" ? await makePartyEntry(game.user, msg.name, msg.edit)
          : await shareCopy(game.user, msg.entry);
      if (entry) afterDone(msg.type === "share" ? "share" : "create", entry);
      return;
    } catch (err) {
      if (err instanceof Refused || !game.users.activeGM) return notice("warn", err instanceof Refused ? L("Notice", { text: err.message }) : L("DidntWork", { error: err.message }));
      console.warn(`${MOD} | couldn't do that here; asking the GM`, err);
    }
  }
  askGM(msg);
}

/** The active GM's client acts on a player's request: a new entry, a party entry, who can edit, or a shared copy. */
async function onRequest(msg, sender) {
  if (!(await tabs.leadNow())) return;
  const reply = (extra) => game.socket.emit(SOCKET, { users: [sender.id], rid: typeof msg.rid === "string" ? msg.rid : null, ...extra });
  try {
    if (msg.type === "create") {
      await ensureFolders();
      const entry = await makeEntry(sender, msg.name);
      if (entry) reply({ type: "done", what: "create", entry: entry.id });
    } else if (msg.type === "party") {
      const entry = await makePartyEntry(sender, msg.name, msg.edit);
      if (entry) reply({ type: "done", what: "create", entry: entry.id });
    } else if (msg.type === "edit") {
      const entry = game.journal.get(msg.entry);
      const d = entry && describe(entry);
      // Any editor can rewrite the author flag, so the sender must also hold Owner in their own right.
      if (!d || d.area !== "party" || !d.all || d.author !== sender.id || entry.ownership?.[sender.id] !== LEVEL.OWNER) return reply({ type: "fail", text: L("CampaignJournalOnlyThePlayerWho") });
      await entry.update({ ownership: editOwnership(!!msg.on, sender.id) });
      reply({ type: "done", what: "edit", entry: entry.id, on: !!msg.on });
    } else if (msg.type === "share") {
      const copy = await shareCopy(sender, msg.entry);
      if (copy) reply({ type: "done", what: "share", entry: copy.id });
    }
  } catch (err) {
    if (err instanceof Refused) return reply({ type: "fail", text: L("Notice", { text: err.message }) });
    console.error(`${MOD} | a player's request failed`, err);
    reply({ type: "fail", text: L("DidntWork", { error: err.message }) });
  }
}

/** Socket messages. The active GM's client takes players' requests; a player's client takes a GM's messages
 * (open an entry, show a recap's short version, the answer to a request). Foundry gives the sender's id. */
function onSocket(msg, senderId) {
  if (tabs.handle(msg, senderId)) return;
  if (!msg?.type) return;
  const sender = game.users.get(senderId);
  if (game.user.isGM) {
    if (sender && !sender.isGM && ["create", "party", "edit", "share"].includes(msg.type)) onRequest(msg, sender);
    return;
  }
  if (!sender?.isGM) return;
  if (Array.isArray(msg.users) && !msg.users.includes(game.user.id)) return;
  if (msg.type === "done" || msg.type === "fail") answered(msg.rid);
  if (msg.type === "fail") return notice("warn", String(msg.text ?? L("CampaignJournalThatDidnTWork")));
  const act = () => {
    const entry = game.journal.get(msg.entry);
    if (!entry?.testUserPermission(game.user, "OBSERVER")) return false;
    if (msg.type === "show") JournalApp.open(entry.id);
    else if (msg.type === "previously") PreviouslyApp.show(entry);
    else if (msg.type === "done" && (msg.what === "create" || msg.what === "share")) afterDone(msg.what, entry);
    else if (msg.type === "done" && msg.what === "edit") {
      notice("info", msg.on ? L("PartyCanEditNow", { name: entry.name }) : L("OnlyYouAndGMNow", { name: entry.name }));
    }
    return true;
  };
  // A new entry can arrive a moment after the message about it.
  if (!act()) setTimeout(act, 400);
}


export { sharedCopyOf, pending, askGM, answered, Refused, makeEntry, makePartyEntry, shareCopy, afterDone, playerDo, onRequest, onSocket };
