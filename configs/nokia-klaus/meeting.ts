// Meeting recorder: one long recording cut into self-contained Ogg segments (60 s by default)
// so each finished minute can be queued and uploaded while the meeting goes on. Every segment
// gets its own MediaRecorder on the same microphone stream; the next one starts before the
// previous stops so no speech falls between them.
namespace Klaus {
  export var MEETING_SEGMENT_MS = 60000;

  export type MeetingRecorder = {
    start: (stream: MediaStream) => void;
    tick: () => void;           // call every second: cuts a segment when it is due
    stop: () => void;           // the last segment is delivered, then onEnd
    elapsed: () => number;
    parts: () => number;        // segments delivered so far
    running: () => boolean;
  };

  export function createMeetingRecorder(bitrate: number, onSegment: (blob: Blob) => void,
    onEnd: (elapsedMs: number) => void, onError: () => void): MeetingRecorder {
    var stream: MediaStream | null = null;
    var current: MediaRecorder | null = null;
    var startedAt = 0, segStart = 0, endedAt = 0, delivered = 0;
    var stopping = false, active = false;
    var open = 0; // recorders started and not yet stopped

    function make(final: () => boolean): MediaRecorder {
      var rec: MediaRecorder;
      try { rec = new MediaRecorder(stream as MediaStream, { audioBitsPerSecond: bitrate }); }
      catch (_e) { rec = new MediaRecorder(stream as MediaStream); }
      var chunks: Blob[] = [];
      rec.ondataavailable = function (event: BlobEvent): void { if (event.data && event.data.size) chunks.push(event.data); };
      rec.onerror = function (): void { if (active) { active = false; onError(); } };
      rec.onstop = function (): void {
        open--;
        if (chunks.length) {
          var blob: Blob | null = null;
          try { blob = new Blob(chunks, { type: rec.mimeType || "audio/ogg" }); } catch (_e) { /* skip */ }
          chunks = [];
          if (blob) { delivered++; onSegment(blob); }
        }
        if (final() && open <= 0) { active = false; onEnd(endedAt - startedAt); }
      };
      rec.start();
      open++;
      return rec;
    }

    function stopRec(rec: MediaRecorder): void {
      try { if (rec.state !== "inactive") rec.stop(); else if (rec.onstop) (rec.onstop as any)(); }
      catch (_e) { if (rec.onstop) (rec.onstop as any)(); }
    }

    function rotate(): void {
      var old = current;
      try { current = make(function (): boolean { return stopping; }); }
      catch (_e) { current = old; return; } // keep the running segment; try again next tick
      segStart = Date.now();
      if (old) stopRec(old);
    }

    return {
      start: function (s: MediaStream): void {
        stream = s; stopping = false; active = true; delivered = 0; open = 0;
        startedAt = segStart = Date.now();
        current = make(function (): boolean { return stopping; });
      },
      tick: function (): void {
        if (active && !stopping && Date.now() - segStart >= MEETING_SEGMENT_MS) rotate();
      },
      stop: function (): void {
        if (!active || stopping) return;
        stopping = true;
        endedAt = Date.now();
        if (current) stopRec(current); else { active = false; onEnd(endedAt - startedAt); }
      },
      elapsed: function (): number { return (stopping ? endedAt : Date.now()) - startedAt; },
      parts: function (): number { return delivered; },
      running: function (): boolean { return active; }
    };
  }
}
