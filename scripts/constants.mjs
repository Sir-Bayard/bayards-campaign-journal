import { storage } from "./kit/storage.mjs";

/**
 * Bayard's Campaign Journal
 * A journal window over ordinary journal entries: the party journal (session recaps and standing
 * entries), handouts given to players, and each player's private journal. Everything stays a normal
 * Foundry journal entry in a "Campaign Journal" folder, so nothing is lost without the module.
 */

const MOD = "bayards-campaign-journal";
const SOCKET = `module.${MOD}`;
/** Display text from lang/<language>.json: L("Key") or L("Key", { name }) with {name} in the text (values aren't
 * escaped: escape what goes into HTML). Before Foundry's translations are loaded it gives the key back. */
const L = (key, data) => {
  const i18n = globalThis.game?.i18n;
  const k = `BCJ.${key}`;
  if (!i18n?.translations || !Object.keys(i18n.translations).length) return k;
  return data ? i18n.format(k, data) : i18n.localize(k);
};
/** PF2e Campaign Trackers, whose quests show on a Quests tab when it's installed and on (never needed). */
const TRACKERS = "pf2e-campaign-trackers";
/** Browser storage, per world and user (one browser can hold several worlds and users). */
const store = storage(MOD);
/** Ownership levels (CONST.DOCUMENT_OWNERSHIP_LEVELS), written out so the helpers run without Foundry. */
const LEVEL = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
/** The journal's folders, named in the language of the GM who makes them (they're found by flag, not by name). */
const FOLDER_KEYS = { root: "FolderRoot", party: "FolderParty", handouts: "FolderHandouts", players: "FolderPlayers" };
/** The kinds of entry, and the kind an entry gets in each area when it has none of its own. */
const KINDS = ["recap", "page", "handout", "journal"];
const AREA_KIND = { party: "page", handouts: "handout", player: "journal" };


export { MOD, SOCKET, L, TRACKERS, store, LEVEL, FOLDER_KEYS, KINDS, AREA_KIND };
