// Quick notes for Plato: a persisted FIFO of voice/text notes posted to the notes inbox
// service (configs/nokia-notes). Each note keeps one request id for every resend, clips live
// in IndexedDB under "note:<id>", and the log of saved notes is shown like a chat.
// Meetings use the same queue: each recorded segment is an audio item for
// /meetings/<id>/segments/<n>, and a final JSON item asks the service to write the note.
namespace Klaus {
  export type MeetingFinish = { segments: number; startedAt: number; durationMs: number; segmentMs: number };

  export type QueuedNote = {
    id: string; audio: boolean; text: string | null; at: number;
    meeting?: string; seq?: number; finish?: MeetingFinish;
  };

  export type OpenMeeting = { id: string; seq: number; startedAt: number };

  export type NotesBox = {
    log: ApiMessage[];
    queue: QueuedNote[];
    sending: boolean;
    add: (blob: Blob | null, text: string | null) => void;
    flush: () => void;
    meetingStart: () => void;
    meetingSegment: (blob: Blob) => void;
    meetingFinish: (durationMs: number) => void;
  };

  // What a queued item is, for the pending bubble.
  export function queuedLabel(q: QueuedNote): string {
    if (q.finish) return "Meeting " + formatElapsed(q.finish.durationMs);
    if (q.meeting) return "Meeting part " + q.seq;
    return q.audio ? "Voice note" : q.text || "";
  }

  var NOTES_KEY = "klaus.notes.v1";
  var MEETING_KEY = "klaus.meeting.v1"; // the meeting being recorded, for recovery after a crash
  var RETRY_MS = 30000;

  function noteClipKey(id: string): string { return "note:" + id; }

  export function createNotesBox(url: string, token: string,
    changed: () => void, notice: (text: string) => void,
    settled?: (saved: boolean, label: string, kind: string) => void): NotesBox {
    var cfg: RuntimeConfig = { bridgeUrl: url, bridgeToken: token };
    var box: NotesBox = { log: [], queue: [], sending: false, add: add, flush: flush,
      meetingStart: meetingStart, meetingSegment: meetingSegment, meetingFinish: meetingFinish };
    var meeting: OpenMeeting | null = null;
    var retryTimer: any = null;
    var held: { [id: string]: Blob } = Object.create(null); // this run's clips; IndexedDB keeps them across restarts

    try {
      var raw = JSON.parse(localStorage.getItem(NOTES_KEY) || "null");
      if (raw && Array.isArray(raw.log)) box.log = validateMessages(raw.log);
      if (raw && Array.isArray(raw.queue)) {
        box.queue = raw.queue.filter(function (q: any): boolean {
          if (!q || typeof q.id !== "string" || typeof q.at !== "number") return false;
          if (q.meeting !== undefined && (typeof q.meeting !== "string" || !(q.audio === true && typeof q.seq === "number") &&
            !(q.finish && typeof q.finish.segments === "number"))) return false;
          return q.audio === true || typeof q.text === "string" || !!q.finish;
        });
      }
    } catch (_e) { /* corrupt store: start empty */ }

    // A meeting still open at launch was cut short (app closed or crashed): send what was
    // recorded and ask for its note.
    try {
      var open = JSON.parse(localStorage.getItem(MEETING_KEY) || "null");
      if (open && typeof open.id === "string" && typeof open.seq === "number" && typeof open.startedAt === "number") {
        meeting = open;
        meetingFinish(open.seq * MEETING_SEGMENT_MS);
        box.log.push({ role: "assistant", text: "A meeting was cut short; its " + open.seq + " saved parts are being sent." });
        save();
      }
    } catch (_e) { /* ignore */ }

    function save(): void {
      while (box.log.length > 128) box.log.shift();
      try { localStorage.setItem(NOTES_KEY, JSON.stringify({ log: box.log, queue: box.queue })); }
      catch (_e) { notice("Storage unavailable; notes may not persist."); }
    }

    function saveMeeting(): void {
      try {
        if (meeting) localStorage.setItem(MEETING_KEY, JSON.stringify(meeting));
        else localStorage.removeItem(MEETING_KEY);
      } catch (_e) { /* the queue itself is saved separately */ }
    }

    function meetingStart(): void {
      meeting = { id: makeUUID(), seq: 0, startedAt: Date.now() };
      saveMeeting();
    }

    function meetingSegment(blob: Blob): void {
      if (!meeting) return;
      meeting.seq++;
      var item: QueuedNote = { id: makeUUID(), audio: true, text: null, at: Date.now(), meeting: meeting.id, seq: meeting.seq };
      held[item.id] = blob;
      clipPut(noteClipKey(item.id), blob);
      box.queue.push(item);
      saveMeeting();
      save();
      changed();
      flush();
    }

    function meetingFinish(durationMs: number): void {
      if (!meeting) return;
      box.queue.push({ id: makeUUID(), audio: false, text: null, at: Date.now(), meeting: meeting.id,
        finish: { segments: meeting.seq, startedAt: meeting.startedAt, durationMs: Math.round(durationMs), segmentMs: MEETING_SEGMENT_MS } });
      meeting = null;
      saveMeeting();
      save();
      changed();
      flush();
    }

    // A meeting part went up: no log line, the final item reports the meeting.
    function partDone(note: QueuedNote, problem: string | null): void {
      box.queue.shift();
      delete held[note.id];
      clipDelete(noteClipKey(note.id));
      if (problem) box.log.push({ role: "assistant", text: problem });
      save();
      changed();
      flush();
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
      if (saved !== null && note.finish) saved = "transcript and summary follow in Plato's inbox";
      box.log.push({ role: "user", text: queuedLabel(note) });
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
      var part = !!note.meeting && !note.finish;
      var target = !note.meeting ? url + "/notes"
        : url + "/meetings/" + note.meeting + (note.finish ? "/finish" : "/segments/" + note.seq);
      xhr(cfg, "POST", target, {
        contentType: note.audio ? "audio/ogg" : "application/json",
        requestId: note.id,
        body: body,
        onSuccess: function (status: number, text: string): void {
          box.sending = false;
          if (part && (status === 200 || status === 201)) partDone(note, null);
          else if (part && (status === 400 || status === 413 || status === 415)) partDone(note, "Meeting part " + note.seq + " rejected by Plato (" + status + ").");
          else if (status === 200 || status === 201 || (note.finish && status === 202)) {
            var summary = "", label = "", kind = "";
            try {
              var r = JSON.parse(text);
              summary = String(r.summary || "");
              if (typeof r.label === "string") label = r.label.slice(0, 40);
              if (/^(note|task|idea|reminder|meeting)$/.test(r.kind)) kind = r.kind;
            } catch (_e) { /* saved anyway */ }
            notice("");
            finish(note, summary || "note", null, label, kind);
          } else if (status === 422 && !part) finish(note, null, "No speech heard; not saved.");
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
      if (note.finish) { post(note, JSON.stringify(note.finish)); return; }
      if (!note.audio) { post(note, JSON.stringify({ text: note.text })); return; }
      if (held[note.id]) { post(note, held[note.id]); return; }
      clipGet(noteClipKey(note.id), function (blob: Blob | null): void {
        if (blob) post(note, blob);
        else if (note.meeting) { box.sending = false; partDone(note, "Meeting part " + note.seq + " was lost before sending."); }
        else { box.sending = false; finish(note, null, "Voice note lost before sending."); }
      });
    }

    return box;
  }
}
