import { esc, labelAttr } from "./kit/safe-text.mjs";
import { questApi } from "./app.mjs";
import { L } from "./constants.mjs";
import { fmtDate, html2md, markedSecretsHTML, metaline, openSections, parseDate, today, visibleHTML, who } from "./data.mjs";
import { notice, parseRecap, resolveLinks, shiftHeadings, splitDetails } from "./helpers.mjs";

/** Bayard's Campaign Journal: the dialogs (new recap, handout, export) and Markdown export. */

const players = () => game.users.filter((u) => !u.isGM).sort((a, b) => a.name.localeCompare(b.name));
const DialogV2 = () => foundry.applications.api.DialogV2;

/** A dialog's render hook that keeps it open when "Make it" (or Enter) is used with something missing: a title, or a
 * picture when the dialog makes a picture handout. The box is marked, a line says why, and the line goes once
 * something is typed or chosen. Cancel and the close button still close. */
const needsTitle = (event, dialog) => {
  const el = dialog?.element ?? event?.target?.element;
  if (!el) return;
  const picture = () => !!el.querySelector('input[name="layout"][value="picture"]')?.checked;
  const rules = [
    [el.querySelector('input[name="name"]'), () => true, L("GiveItATitleToMake")],
    [el.querySelector('input[name="src"]'), picture, L("ChooseAPictureToMakeIt")],
  ].filter(([input]) => input);
  if (!rules.length) return;
  const clear = (input) => {
    input.classList.remove("bcj-invalid");
    input.removeAttribute("aria-invalid");
    if (input.getAttribute("aria-describedby")) el.querySelector(`#${input.getAttribute("aria-describedby")}`)?.remove();
    input.removeAttribute("aria-describedby");
  };
  for (const [input] of rules) input.addEventListener("input", () => clear(input));
  for (const radio of el.querySelectorAll('input[name="layout"]')) radio.addEventListener("change", () => rules.forEach(([input]) => clear(input)));
  const stop = (ev, button) => {
    if (button?.dataset.action !== "ok") return;
    const missing = rules.find(([input, applies]) => applies() && !input.value.trim());
    if (!missing) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const [input, , message] = missing;
    input.classList.add("bcj-invalid");
    input.setAttribute("aria-invalid", "true");
    if (!input.getAttribute("aria-describedby")) {
      const line = document.createElement("p");
      line.className = "bcj-error";
      line.id = `bcj-error-${foundry.utils.randomID(6)}`;
      line.textContent = message;
      input.setAttribute("aria-describedby", line.id);
      (input.closest(".bcj-row") ?? input.closest("label"))?.after(line);
    }
    input.focus();
  };
  // On the dialog itself, in the capture phase, so these run before its own button and submit handlers.
  el.addEventListener("click", (ev) => stop(ev, ev.target.closest?.("button")), true);
  el.addEventListener("submit", (ev) => stop(ev, ev.submitter), true);
};

/** The New handout dialog's picture: Browse opens Foundry's file picker; choosing a picture picks the picture layout. */
const pictureBrowse = (event, dialog) => {
  const el = dialog?.element ?? event?.target?.element;
  const input = el?.querySelector('input[name="src"]');
  const browse = el?.querySelector("[data-bcj-browse]");
  if (!input || !browse) return;
  const choose = () => {
    const radio = el.querySelector('input[name="layout"][value="picture"]');
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  input.addEventListener("input", () => input.value.trim() && choose());
  browse.addEventListener("click", () => {
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type: "image",
      current: input.value,
      callback: (path) => {
        input.value = path;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
    }).render({ force: true });
  });
};

/** The name a content link points to, for a Markdown file (a document in this world or a compendium, or a quest). */
function linkName(type, target) {
  if (type === "UUID") {
    try {
      return fromUuidSync(target, { strict: false })?.name ?? null;
    } catch {
      return null;
    }
  }
  if (type === "Quest") return questApi()?.quests().find((q) => q.id === target)?.name ?? null;
  return null;
}

/** Whether any player can read an entry, or a page of it (a page's own level, else the entry's). */
const forPlayers = (d) => d.all || d.readers.length > 0;
const defaultLevel = (page) => {
  const own = page.ownership?.default ?? -1;
  return own === -1 ? page.parent?.ownership?.default ?? 0 : own;
};
function pageForPlayers(page) {
  return defaultLevel(page) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER || players().some((u) => page.testUserPermission(u, "OBSERVER"));
}
/** Whether every player, now and later, can read an entry, or a page of it. */
const forEveryone = (d) => d.all && players().every((u) => d.entry.testUserPermission(u, "OBSERVER"));
const pageForEveryone = (page) => defaultLevel(page) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER && players().every((u) => page.testUserPermission(u, "OBSERVER"));

/** The GM's choice of export, for one entry or a whole tab: "pub" (the players' copy: an entry as its readers see it,
 * or a tab's entries every player can read; hidden secrets left out) or "gm" (everything, secret blocks labeled), or
 * null if canceled. Players always get their own copy, so they aren't asked. */
async function askCopy(scope = "entry") {
  if (!game.user.isGM) return "own";
  const pub = scope === "tab" ? L("WhatEveryPlayerCanRead") : L("WhatItsReadersSee");
  const pick = await DialogV2().wait({
    window: { title: L("ExportAsMarkdown"), icon: "fa-solid fa-file-export" },
    classes: ["bcj-dialog"],
    content: `<div class="bcj-form"><label class="bcj-check"><input type="radio" name="copy" value="pub" checked> ${esc(L("CopyPlayers", { what: pub }))}</label>
      <label class="bcj-check"><input type="radio" name="copy" value="gm"> ${esc(L("CopyGM"))}</label></div>`,
    buttons: [
      { action: "export", label: L("Export"), icon: "fa-solid fa-file-export", default: true, callback: (ev, button) => button.form.elements.copy.value },
      { action: "cancel", label: L("Cancel") },
    ],
    rejectClose: false,
  });
  return pick === "pub" || pick === "gm" ? pick : null;
}

/** One entry as Markdown: its title (at the given heading level), its line, then its pages for this copy (text, and
 * pictures, videos and PDFs as links to their files)
 * ("own": what this user can read; "pub": what any player can read; "table": what every player can read; "gm":
 * everything, secrets labeled). Hidden secrets are left out of all but "gm" (and "own" for a page's owner). */
function entryMarkdown(d, level = 1, copy = "own") {
  const entry = d.entry;
  const hashes = "#".repeat(level);
  const pages = entry.pages.contents.filter((p) => ["text", "image", "video", "pdf"].includes(p.type) && p.testUserPermission(game.user, "OBSERVER") && (copy !== "pub" || pageForPlayers(p)) && (copy !== "table" || pageForEveryone(p))).sort((a, b) => a.sort - b.sort);
  const parts = [`${hashes} ${entry.name}`, `*${metaline(d)}*`];
  for (const p of pages) {
    if (pages.length > 1) parts.push(`${hashes}# ${p.name}`);
    if (p.type !== "text") {
      if (!p.src) continue;
      const label = (p.image?.caption || p.name || "").replace(/[[\]]/g, "");
      parts.push(p.type === "image" ? `![${label}](<${p.src}>)` : `[${label || p.src}](<${p.src}>)`);
      continue;
    }
    // The page's own headings go below the entry's title (and its page names, if it has several).
    const shift = level - 1 + (pages.length > 1 ? 1 : 0);
    const html = copy === "gm" ? markedSecretsHTML(p) : openSections(visibleHTML(p, copy === "own" ? undefined : false));
    parts.push(shiftHeadings(resolveLinks(html2md(html), linkName), shift));
  }
  return parts.filter(Boolean).join("\n\n");
}

const checkboxes = (name, list, checked) => list.map((u) => `<label class="bcj-check"><input type="checkbox" name="${name}" value="${esc(u.id)}" ${checked.includes(u.id) ? "checked" : ""}> ${esc(who(u).name)}${who(u).name !== u.name ? ` <span class="bcj-dim">(${esc(u.name)})</span>` : ""}</label>`).join("");

/** The New recap and recap details form. Resolves to the values, or null if canceled. */
async function recapDialog(v, { create }) {
  const form = `<div class="bcj-form">
    <div class="bcj-row"><label>${esc(L("FieldSession"))} <input type="number" name="session" min="0" value="${esc(v.session ?? "")}"></label><label class="bcj-grow">${esc(L("FieldTitle"))} <input type="text" name="title" value="${esc(v.title ?? "")}" placeholder="${create ? esc(L("TakenFromTheFileIfLeft")) : ""}"></label></div>
    <div class="bcj-row"><label>${esc(L("FieldGameDate"))} <input type="text" name="date" value="${esc(fmtDate(v.date))}" placeholder="${esc(fmtDate(today()))}"></label><label>${esc(L("FieldPlayed"))} <input type="text" name="played" value="${esc(v.played ?? "")}" placeholder="${esc(L("PlayedExample"))}"></label></div>
    <label>${esc(L("FieldSubtitle"))} <input type="text" name="subtitle" value="${esc(v.subtitle ?? "")}" placeholder="${esc(create ? L("TakenFromTheFileIfLeft2") : L("SessionDatesAndWhoPlayedIf"))}"></label>
    <fieldset><legend>${esc(L("AtTheTable"))}</legend>${checkboxes("attended", players(), v.attended ?? []) || `<p class="bcj-dim">${esc(L("NoPlayersYet"))}</p>`}</fieldset>
    ${create ? `<label>${esc(L("FieldRecapMarkdown"))} <textarea name="md" rows="9" placeholder="${esc(L("RecapPastePlaceholder"))}"></textarea></label>
    <div class="bcj-row"><label class="bcj-file"><i class="fa-solid fa-file-import" aria-hidden="true"></i> ${esc(L("ImportAFile"))} <input type="file" name="file" accept=".md,.markdown,.txt,text/markdown,text/plain"></label><label class="bcj-check"><input type="checkbox" name="share" ${v.share ? "checked" : ""}> ${esc(L("PlayersCanReadItNow"))}</label></div>` : ""}
  </div>`;
  return DialogV2().wait({
    window: { title: create ? L("NewRecap") : L("RecapDetails"), icon: "fa-solid fa-book-open" },
    classes: ["bcj-dialog"],
    position: { width: 560 },
    content: form,
    render: (event, dialog) => {
      const el = dialog.element;
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
      { action: "ok", label: create ? L("MakeTheRecap") : L("Save"), icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        const typed = e.date.value.trim();
        let date = parseDate(typed);
        // An untouched field keeps the stored date, even if the calendar can't read its own text back.
        if (!create && v.date && typed === fmtDate(v.date)) date = v.date;
        else if (date === undefined) {
          notice("warn", L("DateNotKnown", { typed, what: create || !v.date ? L("ItWasLeftOut") : L("TheDateWasKeptAsIt") }));
          date = create ? null : v.date ?? null;
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
      { action: "cancel", label: L("Cancel") },
    ],
    rejectClose: false,
  }).then((r) => (r && typeof r === "object" ? r : null));
}

/** Who gets a handout (and, for a new one, its name and starting layout). Resolves to the values, or null. */
async function giveDialog(v) {
  const isNew = v.name !== undefined;
  const form = `<div class="bcj-form">
    ${isNew ? `<label>${esc(L("FieldName"))} <input type="text" name="name" value="${esc(v.name)}" placeholder="${esc(L("HandoutNameExample"))}" autofocus></label>` : ""}
    <fieldset><legend>${esc(L("WhoGetsIt"))}</legend><label class="bcj-check"><input type="checkbox" name="everyone" ${v.everyone ? "checked" : ""}> <strong>${esc(L("EveryoneBold"))}</strong> <span class="bcj-dim">${esc(L("PlayersWhoJoinLater"))}</span></label>${checkboxes("reader", players(), v.readers)}</fieldset>
    ${isNew ? `<fieldset><legend>${esc(L("StartWith"))}</legend>
      <label class="bcj-check"><input type="radio" name="layout" value="letter" checked> ${esc(L("LayoutLetter"))}</label>
      <label class="bcj-check"><input type="radio" name="layout" value="blank"> ${esc(L("LayoutBlank"))}</label>
      <label class="bcj-check"><input type="radio" name="layout" value="picture"> ${esc(L("LayoutPicture"))}</label>
      <div class="bcj-row bcj-pic"><label class="bcj-grow">${esc(L("FieldPicture"))} <input type="text" name="src" placeholder="${esc(L("PicturePlaceholder"))}"></label><button type="button" class="bcj-browse" data-bcj-browse${labelAttr(L("BrowseForAPicture"))}><i class="fa-solid fa-file-image" aria-hidden="true"></i></button></div>
    </fieldset>` : ""}
  </div>`;
  return DialogV2().wait({
    window: { title: v.title, icon: "fa-solid fa-envelope-open-text" },
    classes: ["bcj-dialog"],
    position: { width: 420 },
    content: form,
    render: isNew ? (event, dialog) => {
      needsTitle(event, dialog);
      pictureBrowse(event, dialog);
    } : undefined,
    buttons: [
      { action: "ok", label: isNew ? L("MakeIt") : L("Save"), icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        return { name: e.name?.value.trim(), everyone: !!e.everyone.checked, readers: [...button.form.querySelectorAll('input[name="reader"]:checked')].map((x) => x.value), layout: e.layout?.value ?? null, src: e.src?.value.trim() ?? "" };
      } },
      { action: "cancel", label: L("Cancel") },
    ],
    rejectClose: false,
  }).then((r) => (r && typeof r === "object" ? r : null));
}


export { players, DialogV2, needsTitle, pictureBrowse, linkName, forPlayers, defaultLevel, pageForPlayers, forEveryone, pageForEveryone, askCopy, entryMarkdown, checkboxes, recapDialog, giveDialog };
