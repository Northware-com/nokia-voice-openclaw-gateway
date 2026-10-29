# Klaus chat terminal (KaiOS)

Voice and text chat client for the EcoRay / Klaus backend on the Nokia 6300 4G (240x320, KaiOS 2.5 / Gecko 48). Press OK to talk, OK again to pause, the green Call key to send, or press the left softkey to type; the bridge turns the turn into a Klaus run and the reply appears as a chat bubble and is read aloud.

## Screen

```
+------------------------------+
|2/3 Shopping list            ●|  top bar: chat n/m, title, connection dot
|                              |
|            [what's on it?]   |  your turns: right, green
| [Milk, eggs and coffee.]     |  Klaus: left, dark
|            [add bread]       |  typed text echoed while pending
| [thinking ··· 0:12]          |  animated pending bubble
|                              |
| Request cancelled.           |  notice, up to two lines, coloured by kind
|[OK: talk · Left: type       ]|  composer, or the state banner below
| Type        TALK        Menu |  softkeys follow the state
+------------------------------+
```

The connection dot is green when connected, amber when the gateway is down, red for auth/network errors and grey when no bridge is configured; a problem also adds a word next to the dot (`offline`, `down`, `auth`).

Type is 16 px (notices 14 px). Notices are red for errors, amber for waits/queues and green for confirmations. A pressed softkey lights up until the key is released; the focused message gets a mint left bar and white outline.

### State banner

When something needs attention, a 30 px banner with an icon and a colour takes the composer's place (typing brings the composer back):

| State | Banner | Colour |
|---|---|---|
| Recording | `● Recording 0:07` (`● Note 0:07` in Notes) | red, plus red top bar |
| Paused | `❚❚ Paused 0:07` | amber, plus amber top bar |
| Discard confirm | `✕ Delete 0:07 clip? Back again` | dark red |
| Sending | `↑ Sending…` | blue |
| Queued | `↻ Message queued · sending soon` | dark amber |
| Offline | `↻ Offline · message queued` | grey |
| Failed / no reply | `! Failed · Menu › Retry last` | dark red |
| Reading aloud | `))) Reading · 5 stops` | teal, mint line |

The archive confirm explains itself on screen.

### Chat list

`#` opens the chat list, most recently used first, so the open chat is on top and the previous one is one Down away. A speed-dial strip sits above the chats; each chat takes two lines:

```
+------------------------------+
| Chats · 6                    |
|[1]Notes [2]Klaus [3]Last [4]Today| speed dial (dimmed when unavailable)
|[What's on the sho…       now]|  title + time (now, 5m, 14:05, Yday, Mon, 12 Oct)
|[Milk, eggs, coffee and so…  ]|  preview: latest message, "You: …" for your own
| Remind me what the p…    40m |
| Klaus is thinking…           |  amber while a reply is pending
| ! Draft a reply to …    Yday |
| Failed · open, Menu › Retry  |  red when the last turn failed
| ↻ Conversation 6      12 Oct |
| Queued · sends when online   |  amber with a queued clip or message
+------------------------------+
```

Speed dial on the chat list:

| Key | Goes to |
|---|---|
| 1 | Notes for Plato (dimmed unless the build has `NOKIA_NOTES_URL`) |
| 2 | A new Klaus chat with the recorder already running: `#` `2`, speak, Call |
| 3 | The last chat you used before this one (archived chats are skipped) |
| 4 | Today (dimmed unless the build has `NOKIA_NOTES_URL`), see below |

### Search

The **right softkey on the chat list** opens **Search chats**: a dedicated screen that looks through the chats already saved on the phone, with no server round-trip.

```
+------------------------------+
| Search chats                 |
|> milk                        |  the query, one line
| [What's on the shop…    ]    |  hit: chat title (mint when the
|  Milk, eggs, coffee and…     |  match is in the title) + snippet
| [No match for “zzz”]         |  amber when nothing matches
| Clear        OPEN            |
+------------------------------+
```

- Type with the letters and digits, Backspace deletes, **SoftLeft (Clear)** wipes the query, **OK (Open)** opens the focused hit.
- Matching is **case- and accent-insensitive** across chat titles and stored message text: `plover` finds `plöver`, `SHOPPING` finds `Shopping`, `Romo` finds `Rømø` (the Ø/Å/Æ/Ö/Ü/é table is folded on both sides, so one spelling finds the other).
- **One hit per chat**: a title hit wins (labelled `Title`), otherwise the first matching message is quoted as a one-line snippet centred on the match. Results are capped at 12 (the screen height), archived chats are excluded, and text hits are newest-first.
- **OK opens the chat and focuses the first matching message**, not just the top, so you land on the hit.
- Purely local: search reads only the stored sessions (`klaus.sessions.v2`); nothing goes to the bridge. It lives behind one softkey on the chat list to stay out of the way; up/down move over the results, `*` or Backspace on an empty query returns to the chats.

Chats named `Conversation N` take an automatic title from the first thing you said (typed, or the transcript when the bridge returns one), else from the first reply when the chat opened with an untranscribed clip; Menu › Rename fixes a title by hand and stops automatic titles for that chat.

## Keys

Softkey labels per state:

| State | Left | Centre | Right |
|---|---|---|---|
| Idle | Type | Talk | Menu |
| Recording | Delete | Pause | Send |
| Paused | Delete | Resume (Send if the recorder cannot pause) | Send |
| Typing | Clear | Send | Voice |
| Rename | Clear | Save | Cancel |
| Menu / chat list | Close | Select / Open | Search (chat list) |
| Search | Clear | Open | |
| Keys screen | Close | OK | |
| Today | Close | Update | |
| Meeting | | Stop | (Stop) |

On the chat list, 1-4 are speed dial (see Chat list), and the right key opens Search (its own keys below).
| Archive confirm | Cancel | Archive | |
| Quick replies | Close | Send | |

The recording timer is in the state banner, so both clip states share Delete (left) and Send (right).

Idle keys:

| Key | Action |
|-----|--------|
| Centre (OK) | Start recording |
| SoftLeft | Focus the composer (typing) |
| SoftRight | Menu: 1 New chat, 2 Rename, 3 Archive (confirm), 4 Retry last, 5 Read aloud on/off, 6 Vibrate on/off, 7 Night mode on/off, 8 Large text on/off, 9 Keys (a one-screen key list); a digit picks the item at once |
| ↑ / ↓ | Focus previous / next message (full-row highlight). ↓ past the newest returns to live |
| ← / →, 4 / 6 | Previous / next open chat (wraps, skips archived) |
| 1 / 9 | Oldest / newest message |
| 2 / 8 | Page up / down |
| 5 | Read the focused message aloud (latest reply if none); a focused clip placeholder, or a chat with no reply, plays your last clip. While this chat is being read (banner `))) Reading · 5 stops`), 5 stops reading and drops queued replies; again stops playback |
| 0 | Quick replies: 1-9 sends one at once (see below) |
| # | Chat list (most recent first, with previews) |
| Right softkey (chat list) | Search chats: case- and accent-insensitive over titles and stored text; OK opens the hit with its first match focused |
| 3 | New chat |
| 7 | Archive chat (confirm with OK or 7, Back cancels) |
| * | Notes for Plato (see below); SoftRight (Chat), Back or * returns |
| Backspace | Cancel the pending request, else discard an unsent clip, else clear message focus, else let KaiOS close the app |

While typing, digits and Backspace go to the input; Enter or Call sends a JSON `{text}` turn; Backspace on an empty input (or Escape) leaves typing.

While recording or paused:

| Key | Recording | Paused |
|-----|-----------|--------|
| Centre (OK) | Pause (banner shows `❚❚ Paused 0:07`) | Resume; sends instead when the recorder has no `pause()` |
| Call (green) | Send | Send |
| SoftRight | Send (fallback if the system reserves Call) | Send |
| SoftLeft | Delete (discard) | Delete (discard) |
| Backspace | Discard; clips over 3 s ask for a second Backspace | Same |

Clips are recorded as Ogg/Opus at 16 kbps (about 3.4 KB per second of speech); a recorder that rejects the bitrate option falls back to its default.

## Reply visualisation

Replies Klaus writes in a small line-based mini-syntax are drawn as compact visuals instead of plain text, so a list or ratio reads at one glance on 240x320:

- **Bar chart** — every line is `Label 80%`, `Label: 80%`, `80% Label` or (without a percent sign) `Label: 80`. Up to six bars; the value text stays beside the track, bars fill left to right and cap at 100.
- **Checklist** — every line is `- [ ]`, `- [x]`, `- [✓]` (or `*`/`1.` bullets) followed by the item. Up to eight items; done items get a mint ✓, open items an amber `-`.
- **Timeline** — every line starts with `HH:MM` (optionally followed by text). Up to eight entries; the time sits in a fixed slot at left.

Rules: the whole message must match (one unmatched line sends the entire reply back to plain text), at least two lines are needed, and only assistant text is parsed — your own messages, voice placeholders and everything else render exactly as before. Labels clip to 14 characters and item text to 26, so a visual never wraps a line at normal or large text. The app cannot choose the format; ask Klaus in plain words for a list or a chart and it uses these lines.

```
 Milk 80%                - [ ] Gate open      09:30 Plumber in
 Eggs 40%                 - [x] Cells off     17:45 Bins out
 (two bars, 80/40)        (checklist)         (timeline)
```

When Gecko's `MediaRecorder.pause()` is missing, Pause stops the recorder and keeps the clip; it is only uploaded on Send. The timer excludes paused time.

### Today

`#` `4` opens **Today** (needs `NOKIA_NOTES_URL`), read from the notes service (`GET /today`, notes token):

```
+------------------------------+
| Today · Thu 29 Oct           |
| Updated 14:02                |  freshness: Updated / Offline · 14:05
| REMINDERS                    |
| Yday  Pay the plumber        |  open and overdue (red time)
| 9:30  Take the bins out      |  earlier today (dimmed)
| 15:00 Call mum               |
| +1 without a time            |
| LATEST IN PLATO'S INBOX      |
| 13:00 [Idea] Pub quiz app…   |  six newest notes, tasks, ideas, meetings
| CALENDAR & MAIL              |
| Not connected yet            |
| Close       UPDATE           |
+------------------------------+
```

Up/Down scroll, OK updates, Back or the left key closes. The last answer is kept (`klaus.today.v1`) so the screen opens at once, also away from home Wi-Fi, with the freshness line saying how old it is. Reminders are the `Nokia-Reminder-*` files written by voice commands; a reminder leaves Today when its file is moved out of the inbox or its `status` is no longer `open`. Calendar and mail are a placeholder: they need credentials the notes service does not have.

## Display

- **Menu › Night mode**: black background with warm amber text and no bright mint or white surfaces, for dark rooms. Recording red, paused amber and the error/queue colours keep their meaning; the main text pairs stay above 4.5:1 contrast.
- **Menu › Large text**: message bubbles 19 px (from 16), menu and list rows 18 px, notices 16 px; the bars and softkeys keep their size so the layout holds.

Both are kept across restarts (`klaus.night`, `klaus.large`) and can be combined.

## Vibration

Short vibrations confirm what happened without looking at the screen (`navigator.vibrate`; phones without a vibrator stay silent):

| Event | Pattern |
|---|---|
| Recorder started (also on resume) | one tick (40 ms) |
| Paused | double tick |
| Clip, text or quick reply sent | one firm pulse (90 ms) |
| Klaus reply or saved note arrived | triple tick |
| Error notice | two long pulses, at most once every 4 s |

Menu › Vibrate switches them off and on (a sample tick when switching on); the choice is kept across restarts (`klaus.haptics`).

## Quick replies

`0` opens nine canned answers; a digit sends one at once as a typed turn (Up/Down + OK also works, Back closes without sending). The list follows the language of Klaus's latest reply:

| Key | English | Danish |
|---|---|---|
| 1 | Yes | Ja |
| 2 | No | Nej |
| 3 | Thanks! | Tak! |
| 4 | Tell me more | Fortæl mere |
| 5 | Shorter, please | Kortere, tak |
| 6 | Explain it simply | Forklar det enkelt |
| 7 | What should I do next? | Hvad skal jeg gøre nu? |
| 8 | Remind me later | Mind mig om det senere |
| 9 | Stop, that's all | Stop, det var det |

Quick replies wait while Klaus is still replying, queue like typed text when offline, and are not offered on the Notes screen. Auto read-aloud (previously `0`) is toggled with Menu › Read aloud.

## Notes for Plato

`*` opens the **Notes → Plato** screen (purple bar) when the package was built with `NOKIA_NOTES_URL`. OK records a voice note and Call sends it; the left key types a note. Notes go to the quick-note inbox service ([`configs/nokia-notes`](../nokia-notes/README.md)) with their own token, never to Klaus; each note becomes a dated Markdown file and the phone shows `Saved: <one-line summary>`.

Start a note with a keyword to route it (see [Voice commands](../nokia-notes/README.md#voice-commands)): `Task …`/`Opgave …` saves a tagged task, `Idea …`/`Idé …` an idea, and `Remind me at 3 pm to …`/`Husk … kl. 15` a reminder with its time. A chip at the top of the screen confirms the result for 4 s or until the next key (`✓ Task saved`, `✓ Reminder 15:00`; blue for tasks, purple for ideas, amber for reminders, green for notes) and the log reads `Task saved: Buy milk`.

### Meeting mode

`0` on the Notes screen records a meeting: the top bar turns red and the banner reads `● Meeting 12:34 · 12 ✓` (12 finished minutes saved). The recording is cut into one-minute Ogg segments (16 kbps, about 120 KB each); each segment is queued and uploaded as soon as it ends, so a crash or a dead battery loses at most the minute in progress. The next segment's recorder starts before the previous one stops, so nothing falls between them.

| Key | Action |
|---|---|
| OK (`Stop`), Call or the right key | Stop: the last segment is saved, then the service is asked to write the note (`Meeting 42:10 saved. Plato writes the note.`) |
| Back | Nothing is stopped or closed; the notice says the meeting is still recording |
| Anything else | Ignored until the meeting stops |

The service transcribes the segments with Freyr and writes one meeting note with a summary, decisions and action items ([details](../nokia-notes/README.md#meetings)); the notes log shows `Meeting 42:10` / `Meeting saved: transcript and summary follow in Plato's inbox` and a coral `✓ Meeting saved` chip. Segments queue like notes while offline (IndexedDB), in order, with the finish request last. If the app is closed mid-meeting, the next launch sends the saved parts and asks for the note (`A meeting was cut short; its 3 saved parts are being sent.`).

While recording a meeting the app asks KaiOS for a CPU wake lock and does not stop when the screen turns off or the app is hidden. Whether Gecko 48 keeps the microphone running with the screen off is not verified yet (device check).

Notes queue in order while the service is unreachable (for example away from home Wi-Fi); the queue (`klaus.notes.v1`) and clips (IndexedDB `note:<id>`) survive restarts and are sent with their original request id on launch, on reconnect, when opening Notes and every 30 s after a failure. Chat navigation keys are paused on the Notes screen.

## Behaviour

- **Empty chat**: the hint lists the main keys (`OK talk · Left type`, `0 quick reply · # chats`) and changes to `Listening… Call sends · OK pauses` while the first clip records.
- **Ready to record**: the app reopens the last chat and opens the microphone 300 ms after it becomes visible (and again after each recording), so Centre starts the recorder in about 3 ms instead of 60-125 ms. The stream is released whenever the app is hidden or closed; KaiOS shows its microphone indicator while the app is in front.
- **Sessions**: up to 128 chats (open + archived). Archived chats are hidden from navigation but keep polling and speaking. Each chat stores its last activity time (`updatedAt`: sending, a new message, opening it) and whether it was renamed by hand (`named`); older stores are migrated on load.
- **Pending turns**: a thinking bubble shows `sending`/`thinking`/`cancelling` with an elapsed timer. Polling backs off from 1.5 s to 8 s and stops after `pollTimeoutMs` (default 180000) with "no reply yet"; Menu › Retry last resumes polling.
- **Voice clips in the chat**: a sent clip appears at once as a dashed `Voice clip · 0:07` bubble on your side. Transcript first: when the bridge returns a user message for that turn (the transcript), it takes the placeholder's place; otherwise the placeholder stays before Klaus's reply. Placeholders are stored per chat (`voiceTurns`: position and length), never read aloud, and `5` on a focused one plays the recording (`No transcript for this clip yet.` after a restart). Back on an unsent clip removes its placeholder too. The bridge currently returns no transcript for audio turns, so voice chats show placeholders until it does.
- **Transcript**: new messages are appended without re-rendering; scroll position is preserved unless you were already at the bottom. The empty-chat hint is hidden while the first turn is pending.
- **Unsent clips**: every clip is written to IndexedDB before it is uploaded and gets a request id (`outboxId`, persisted with the session) that every resend reuses, so the bridge deduplicates it. Clips recorded without signal, or whose upload was cut off, are resent automatically after a successful connection probe, including after an app restart, or with Menu › Retry last; the clip is deleted once the bridge accepts it. Back discards a queued clip. Retry last also resends the last typed message after a failure.
- **Network loss**: the connection is re-probed every 15 s while offline (60 s while connected) and on the system `online` event; a failed send or the `offline` event turns the dot red at once. Typed messages that never reached the bridge are queued (persisted as `textPending`) and resent on reconnect. A turn POST lost mid-flight is resent with the same `X-Request-Id`, which the bridge deduplicates, once the bridge is reachable again, also after an app restart; a poll showing the bridge already has that request id ends the resend. Back cancels a queued resend.
- **Cancel**: Back fires `POST .../cancel` with `{turnRequestId}`; polling continues until the server confirms.
- **TTS**: replies are queued per session. The message being read gets a mint outline and the `Reading` banner; both clear when speech ends, is stopped with 5, or a recording starts. Turning auto read-aloud off stops current speech. Danish text (æøå or common Danish words) uses a `da-*` voice when installed, otherwise English.
- **Persistence**: `localStorage` key `klaus.sessions.v2` (migrates `v1`), capped at 1 MiB by trimming oldest messages. Setting `klaus.autoread`.

## Source layout

| File | Purpose |
|---|---|
| `keys.ts` | Pure key map, softkey labels, state banner, notice colours, chat-list rows and titles, focus/backoff/time/language helpers (unit tested) |
| `viz.ts` | Reply mini-syntax parser: bar charts, checklists, timelines (unit tested) |
| `storage.ts` | Session model, localStorage persistence, IndexedDB clip store |
| `api.ts` | mozSystem XHR and connection probe |
| `tts.ts` | Serialized speech queue, current item and change callback |
| `ui.ts` | DOM rendering (textContent only) |
| `notes.ts` | Notes queue for the Plato inbox service |
| `app.ts` | Controller: recording, turns, polling, menus and key dispatch |

## Build

`./build.sh [output.zip]` type-checks and concatenates the files above into an ES5 `app.js`, validates the manifest and builds the package. `app.js` is generated and not committed. For a connected package set `NOKIA_BRIDGE_URL` and `NOKIA_CONFIG_FILE` (see `config.js`); optional `NOKIA_POLL_TIMEOUT_MS` overrides the poll timeout; optional `NOKIA_NOTES_URL` with `NOKIA_NOTES_CONFIG_FILE` (private `{"token"}`) enables Notes.

```
node tests/nokia-audio.cjs      # audio lifecycle (also exports the fake-DOM harness)
node tests/nokia-sessions.cjs   # session switch/create/reload
node tests/nokia-connection.cjs # bridge, TTS, archive
node tests/nokia-chat-ui.cjs    # softkeys, pause/resume/Call send, typing, menu, key map
node tests/nokia-reliability.cjs # reconnect probes, queued text, idempotent resend
node tests/nokia-quick-notes.cjs # Notes screen, notes queue, restart resend
node tests/nokia-chat-list.cjs   # chat list rows, automatic titles, times, recency
node tests/nokia-voice-transcript.cjs # clip placeholders, transcript first
node tests/nokia-quick-replies.cjs # 0 + digit quick replies
node tests/nokia-read-aloud.cjs  # 5 read/stop, reading banner and outline
node tests/nokia-speed-dial.cjs  # chat list 1 Notes, 2 Klaus, 3 Last
node tests/nokia-viz.cjs         # reply visualisation: bars, checks, timelines, plain-text fallback
node tests/nokia-polish.cjs      # menu digits, Keys screen, empty hint, version
```

## Notes

- Requires a privileged install (`type: "privileged"`, `permissions.systemXHR`); see `manifest.webapp`.
- Verified on a Nokia 6300 4G (KaiOS 2.5.4): Centre start/pause/resume (native `MediaRecorder.pause()`), Call send, SoftRight send while paused, Backspace discard with confirm, typed send, and Wi-Fi off/on queue and resend. Clip upload after a restart without signal is verified on the handset (0.3.3), as are Notes voice/typed/offline-queued notes (0.3.4), the pending first turn of a new chat and a paused-then-resumed clip (0.4.0), and the 0.5.0 state banner, softkey labels, press feedback, focus highlight and archive confirm; the voice list remains unverified. The 0.6.0 chat list, clip placeholders, quick replies, read-aloud stop, speed dial, numbered menu and Keys screen are unit tested and rendered at 240x320 in headless Chromium, not yet verified on the handset. The 0.7.0 vibrations, voice-command chip, meeting mode, Today screen, night mode and large text are likewise unit tested and rendered headless only; on the handset still to check: vibration patterns, the chip and night palette in the Gecko font, a two-minute meeting across a segment cut, and whether a meeting keeps recording with the screen off (CPU wake lock).
