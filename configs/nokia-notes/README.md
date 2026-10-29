# Nokia quick-note inbox

A small HTTP service that receives quick notes from the phone's Notes screen (`*` in `nokia-klaus`) and writes them as dated Markdown files into an inbox directory, for example an Obsidian vault's `01-Inbox`. Notes never reach the OpenClaw gateway or the bridge; they use their own token.

- `POST /notes` with `Authorization: Bearer <token>` and a UUID `X-Request-Id`
  - `audio/ogg` (Opus, max 5 MiB): transcribed by a WhisperX HTTP service (`POST <whisperUrl>/transcribe`, multipart `file`, JSON `text`/`language`/`duration_s`)
  - `application/json` `{"text": "..."}` (max 4000 characters)
  - `201 {"file", "summary", "kind", "label", "due"?}` once written (see Voice commands); a resend with the same request id returns `200` with the same result and writes nothing (also across restarts, the last 2048 ids are kept in `stateFile`)
  - `422 no_speech` for an empty transcript, `503` when the transcriber is down (the phone keeps the note and retries), `400/401/413/415` for bad input
- `GET /health` (authenticated) returns `{"ok": true}`

The phone shows the one-line `summary` (first sentence, at most 80 characters) as `Saved: ...`.

## Voice commands

A keyword at the start of a voice or typed note routes it; the keyword is dropped from the title, the body keeps the words as said:

| Said | Kind | File | Phone chip |
|---|---|---|---|
| `Task …`, `To-do …`, `Opgave …`, `Ny opgave …` | task | `Nokia-Task-….md`, `status: open`, `tags: [task, nokia]` | `✓ Task saved` |
| `Idea …`, `Idé …`, `Ide …` | idea | `Nokia-Idea-….md`, `status: inbox`, `tags: [idea, nokia]` | `✓ Idea saved` |
| `Remind me (to) …`, `Reminder …`, `Husk (at) …`, `Husk mig på …`, `Påmind mig om …` | reminder | `Nokia-Reminder-….md`, `status: open`, `due:`, `tags: [reminder, nokia]` | `✓ Reminder 15:00` |
| anything else | note | `Nokia-Note-….md` (format below) | `✓ Note saved` |

Reminder times, in the service's local time zone: `at 3 pm`, `at 15:00`, `at 3` (English 1-7 without am/pm means the afternoon), `kl. 15`, `klokken 9.30`, `in 20 minutes`, `in an hour`, `in half an hour`, `om 10 minutter`, `om en halv time`, `tomorrow`/`i morgen`, `tonight`/`i aften` (20:00), weekdays (`on Friday`, `på fredag`; today's weekday means next week). A day without a time means 09:00; a time already passed today means tomorrow. Without any time the reminder is saved with no `due` and the chip says `Reminder, no time`. The label (`Reminder tomorrow 9:00`, `Reminder Fri 9:00`, `Reminder 3 Nov 9:00`) is fixed when the note is saved.

The parser is deliberately small and literal (`commands.ts`); anything it does not recognise stays in the reminder text, and the original words are always kept in the body.

## Note format

`Nokia-Note-YYYY-MM-DD-HHMMSS.md` (suffix `-2`, `-3` on collisions), written atomically:

```markdown
---
type: note
status: inbox
created: 2026-10-29T07:05:09+00:00
source: Nokia voice note
request_id: 0f6c...
language: en
duration_s: 4.2
transcription: WhisperX (Freyr), unreviewed
summary: "Buy oat milk tomorrow."
---

# Buy oat milk tomorrow.

Buy oat milk tomorrow. Also call the garage about the Opel.
```

Audio is not stored; only the transcript is kept.

## Run

```sh
npm run build:notes
umask 077; mkdir -p ~/.config/nokia-notes
# config.json (0600):
# {"listen": "192.168.1.10", "port": 8790, "token": "<32-128 URL-safe chars>",
#  "inboxDir": "/path/to/vault/01-Inbox", "stateFile": "/home/me/.local/state/nokia-notes/state.json",
#  "whisperUrl": "http://freyr:9090"}
NOKIA_NOTES_CONFIG=~/.config/nokia-notes/config.json node configs/nokia-notes/dist/main.js
```

`nokia-notes.service` is a systemd user unit template (no root needed; enable lingering to run without a login session).

Package the phone app with the same token in a private file `{"token": "..."}`:

```sh
NOKIA_NOTES_URL=http://192.168.1.10:8790 NOKIA_NOTES_CONFIG_FILE=~/private/notes.json \
NOKIA_BRIDGE_URL=... NOKIA_CONFIG_FILE=... bash configs/nokia-klaus/build.sh ~/private/klaus.zip
```

## Security

- The notes URL must be HTTPS, or plain HTTP to a private LAN address (10/8, 172.16/12, 192.168/16). Over plain HTTP the token and note content are readable on that LAN; use it only on a trusted home network or put the service behind HTTPS.
- Bind `listen` to the LAN address the phone uses, not `0.0.0.0`. The service is not meant to be exposed to the internet; doing so (for example with a tunnel) is an explicit operator decision.
- The token is compared in constant time and never logged. Notes are written with mode 0644 to the inbox; the state file is 0600.
- Away from that network, notes queue on the phone (persisted, clips in IndexedDB) and are sent in order once it is reachable again.
