// Quick notes for Plato: a persisted FIFO of voice/text notes posted to the notes inbox
// service (configs/nokia-notes). Each note keeps one request id for every resend, clips live
// in IndexedDB under "note:<id>", and the log of saved notes is shown like a chat.
namespace Klaus {
  export type QueuedNote = { id: string; audio: boolean; text: string | null; at: number };

  export type NotesBox = {
    log: ApiMessage[];
    queue: QueuedNote[];
    sending: boolean;
    add: (blob: Blob | null, text: string | null) => void;
    flush: () => void;
  };

  var NOTES_KEY = "klaus.notes.v1";
  var RETRY_MS = 30000;

  function noteClipKey(id: string): string { return "note:" + id; }

  export function createNotesBox(url: string, token: string,
    changed: () => void, notice: (text: string) => void,
    settled?: (saved: boolean, label: string, kind: string) => void): NotesBox {
    var cfg: RuntimeConfig = { bridgeUrl: url, bridgeToken: token };
    var box: NotesBox = { log: [], queue: [], sending: false, add: add, flush: flush };
    var retryTimer: any = null;
    var held: { [id: string]: Blob } = Object.create(null); // this run's clips; IndexedDB keeps them across restarts

    try {
      var raw = JSON.parse(localStorage.getItem(NOTES_KEY) || "null");
      if (raw && Array.isArray(raw.log)) box.log = validateMessages(raw.log);
      if (raw && Array.isArray(raw.queue)) {
        box.queue = raw.queue.filter(function (q: any): boolean {
          return q && typeof q.id === "string" && typeof q.at === "number" &&
            (q.audio === true || typeof q.text === "string");
        });
      }
    } catch (_e) { /* corrupt store: start empty */ }

    function save(): void {
      while (box.log.length > 128) box.log.shift();
      try { localStorage.setItem(NOTES_KEY, JSON.stringify({ log: box.log, queue: box.queue })); }
      catch (_e) { notice("Storage unavailable; notes may not persist."); }
    }

    function add(blob: Blob | null, text: string | null): void {
      var note: QueuedNote = { id: makeUUID(), audio: !!blob, text: blob ? null : text, at: Date.now() };
      if (blob) { held[note.id] = blob; clipPut(noteClipKey(note.id), blob); }
      box.queue.push(note);
      save();
      changed();
      flush();
    }

    // Settle the head of the queue: log the outcome and move on to the next note.
    // label/kind: the service's reading of a leading keyword ("Task saved", "Reminder 15:00").
    function finish(note: QueuedNote, saved: string | null, problem: string | null, label?: string, kind?: string): void {
      box.queue.shift();
      if (note.audio) { delete held[note.id]; clipDelete(noteClipKey(note.id)); }
      box.log.push({ role: "user", text: note.audio ? "Voice note" : (note.text || "") });
      var routed = !!label && !!kind && kind !== "note";
      box.log.push({ role: "assistant", text: saved !== null ? (routed ? label : "Saved") + ": " + saved : problem || "Not saved." });
      save();
      changed();
      if (settled) settled(saved !== null, label || "Note saved", kind || "note");
      flush();
    }

    function later(message: string): void {
      box.sending = false;
      changed();
      notice(message);
      if (!retryTimer) retryTimer = setTimeout(function (): void { retryTimer = null; flush(); }, RETRY_MS);
    }

    function post(note: QueuedNote, body: Blob | string): void {
      xhr(cfg, "POST", url + "/notes", {
        contentType: note.audio ? "audio/ogg" : "application/json",
        requestId: note.id,
        body: body,
        onSuccess: function (status: number, text: string): void {
          box.sending = false;
          if (status === 200 || status === 201) {
            var summary = "", label = "", kind = "";
            try {
              var r = JSON.parse(text);
              summary = String(r.summary || "");
              if (typeof r.label === "string") label = r.label.slice(0, 40);
              if (/^(note|task|idea|reminder)$/.test(r.kind)) kind = r.kind;
            } catch (_e) { /* saved anyway */ }
            notice("");
            finish(note, summary || "note", null, label, kind);
          } else if (status === 422) finish(note, null, "No speech heard; not saved.");
          else if (status === 400 || status === 413 || status === 415) finish(note, null, "Rejected by Plato (" + status + ").");
          else if (status === 401 || status === 403) later("Notes auth error (" + status + "). Check notes config.");
          else later("Plato busy (" + status + "). Note queued; retrying.");
        },
        onError: function (): void { later("Plato unreachable. Note queued; sends on home Wi-Fi."); }
      });
    }

    // Send the oldest queued note; one request at a time keeps notes in order.
    function flush(): void {
      if (box.sending || !box.queue.length) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      var note = box.queue[0];
      box.sending = true;
      changed();
      if (!note.audio) { post(note, JSON.stringify({ text: note.text })); return; }
      if (held[note.id]) { post(note, held[note.id]); return; }
      clipGet(noteClipKey(note.id), function (blob: Blob | null): void {
        if (blob) post(note, blob);
        else { box.sending = false; finish(note, null, "Voice note lost before sending."); }
      });
    }

    return box;
  }
}
