# Changelog

## 0.3.1

- **Keys stay with the journal while you work in it.** Once you've clicked in the window, or opened it with J or the button, Space doesn't pause the game, the arrows and letters don't move the map, and Tab moves through the window instead of jumping between tokens. In 0.3.0 that only held after reaching the window with Tab, so with the mouse (and PF2e, which takes focus off a clicked button) Foundry still got every key. Click the map to give the keys back; Escape still closes the window.
- **Tab goes round the window** instead of dropping out to the map after the last button, so the tabs on the left are reached too, and the arrow keys move between those tabs (Enter or Space opens one).

## 0.3.0

- **Keyboard.** The whole window works from the keyboard: tabs, the list, folds, sort toggles and every button take focus, Enter and Space work them, focus stays put when the window redraws, and the window's keys no longer reach Foundry's own (Space doesn't pause the game). Pinned entries move with **Move up** and **Move down** as well as by dragging; a quest's link can be copied with **Copy link**.
- **What arrived while you were away.** The Campaign Journal button in the Journal tab shows how many entries are new or updated for you, and a player logging in gets one notice when something is waiting. New and Updated marks now follow you to any browser.
- **Marks for the GM.** New and Updated show the GM what players have written: their journals, and party entries a player wrote or shared.
- **Write here.** A one-page entry can be written in the journal window itself; Done saves, and so does moving to another entry, making a new one or closing the window. If a save fails, the text is kept, and Write here brings it back.
- **Picture handouts.** New handout starts from a letter, a blank page or a picture.
- **Search shows where it matched**: a line under each entry whose text matched, and the words marked on the page.
- **Previous session and Next session** under a recap's title.
- **Groups for Party subfolders.** A folder inside Party (an arc, say) shows as a group of its own in the party journal.
- **A tidier toolbar.** Previously on…, Show to players and Edit stay in the row; Details, Give to…, Pin, Hide, Let the party edit and Markdown are under **More**; Delete sits apart. Delete now says whose journal an entry is in.
- The line under each entry says when it was written or last changed, instead of repeating its group's name. The sort toggle shows the order the list is in (Newest or A-Z) with a swap icon. Empty lists say how to start.
- Links in a Markdown export come out as their names, and pictures as pictures.
- The window no longer redraws for entries you can't read, and a redraw keeps the page you're reading as it is (a playing video, a selection) when it hasn't changed. Search reads entries' text only when you search.
- Foundry's Hide button no longer shows on a revealed secret block for players who can't edit the page.
- Every word the module shows is in `lang/en.json`, ready for translation.
- The window's size and place are now kept per world and user. One GM in two browser tabs is handled more reliably (a tab that closes hands over at once).
- For macro writers: `api.open()` now returns a promise of the window.

## 0.2.1

- Titles and names that players write show as plain text in notifications and tooltips, instead of as formatting or images.
- An entry that changes while the journal window is minimized now shows Updated when you bring the window back, until you pick an entry. Before, it was quietly marked as read.
- Opening the journal twice in quick succession (the J key, the Journal tab button, or a GM's Show to players) no longer opens two windows.
- Secret blocks the GM has revealed now show in players' search, Markdown, Export and "Previously on…", as they do on the page.
- The GM's Markdown and Export ask each time for the players' copy or the GM copy (everything, with each secret block marked). A tab's players' copy holds only what every player can read, so it's safe to share with the table; an entry's holds what its readers see. Both leave hidden secrets out. Export on the GM's Players tab gives the GM copy without asking, since players' journals are private.
- New page, New handout, New entry and New party entry no longer close and make nothing when the title is left empty: the dialog stays open and asks for a title.
- "Previously on…" opens once when clicked on two recaps in quick succession.
- The Quests tab shows only when the installed PF2e Campaign Trackers has everything the tab uses.

## 0.2.0

- A Quests tab, when PF2e Campaign Trackers is installed: the quests the party knows, by status (Active, Leads, Completed, Failed), with each one's category, progress, New and Updated marks, and party-quest and focus icons. Click one to read it in the journal as the players see it; Open in Trackers ticks objectives, adds notes or edits it. The GM sees quests players can't yet, marked. Without Trackers (or when players can't open it) there's no Quests tab.
- Quest links: Trackers' `@Quest[id]` links in journal text open the quest on the Quests tab. Drag a quest from the list into a journal page to make one.
- Restoring the window from minimized brings it back at its full size; on Foundry 14.370 it came back as a thin strip.
- Verified on Foundry 14.370.

## 0.1.1

- A GM with a tab in the background no longer has two tabs answering players' requests at once, which could make a player's entry twice. Background tabs check in less often, so a GM tab is now remembered longer and answers the others when they check in.

## 0.1.0

First release.

- The journal window: Party, My Journal (players), Handouts and Players (GMs) tabs, a reading pane styled as a paper page, who-can-see markers, a table of contents from each page's headings, and search across titles and text.
- A Campaign Journal folder with Party, Handouts and a folder for each player, made on the GM's first login and kept up as players join.
- Handouts show on parchment.
- A Campaign Journal button on the Journal tab, and the J key.
- The window remembers the size and place you last gave it, in each browser. Any group in the list (Recaps, Pages, Handouts...) folds to its heading, and stays folded.
- New recap: session number, in-game date, the real date, who was at the table and the recap itself, pasted or imported as Markdown. A recap laid out as "# Session N: Title", an italic line and a "Short" section fills the form in: the italic line's in-game date, real date and anyone marked absent. The short version goes in its own box at the top. Left empty, a recap starts from a template to write in.
- Recap details: change a recap's session, dates, line under the title and who was there.
- New handout, starting from a letter layout, and Give to… for everyone or chosen players (everyone means players who join later too).
- Show to players opens an entry on the screens of the players who can read it. "Previously on…" shows a recap's short version on the screens of the players who can read it, with a button to read the rest.
- New page, for party pages such as house rules, optionally pinned. Pin anything on the Party tab to the top: pages, recaps, shared copies and handouts for everyone. The GM drags pinned entries into the order everyone sees; a new pin goes to the bottom.
- Markdown: download an entry, or the whole tab with Export. The GM's secret blocks stay out of players' downloads, search and "Previously on…".
- Players write their own entries (New entry, then Foundry's editor); only they and the GM can read them. Their journal and their handouts list newest first, each with its own A-Z toggle; on the GM's Players tab one toggle sorts every player's list. A-Z files titles library-style (a leading A, An or The ignored, numbers in order).
- When players may create journal entries (Foundry's permission), their new entries, party entries and shared copies are made on their own client, so they can write with no GM logged in. Otherwise a GM's client makes them.
- Renaming a one-page entry's page in Foundry's editor renames the entry too.
- Share a copy to the Party Journal: a copy signed "Shared by" the player, which everyone can read and the player can still edit. Sharing the same entry again asks first, then replaces the earlier copy in place.
- New party entry: players write straight into the party journal, signed with their name.
- Let the party edit: the GM, or the player who wrote or shared an entry, lets every player edit it and add to it, and can stop it again. Updating a shared copy warns first when others may have added to it.
- Players can delete their own entries, their shared copies and their party entries; the GM can delete anything from the window, and hide a party entry from players or let them read it.
- A short notice when something new reaches a player (a recap, a handout given to them, a shared or party entry), and New or Updated markers in their list until they open it, with a dot on the tab. Edits show as Updated without a notice, and never for a player's own changes.
- The Campaign Journal folder is hidden from players' Journal tab, so they read everything in the window; a setting shows it again.
- "Previously on…" pops up on the GM's screen too, even when no player is logged in, so you see what they see.
