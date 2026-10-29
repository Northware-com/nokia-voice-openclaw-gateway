// Pure key-map and presentation logic. No DOM access, so tests can call it directly.
namespace Klaus {
  export type Mode = "idle" | "recording" | "paused" | "typing" | "rename" | "menu" | "sessions" | "confirm";

  export type Action =
    "none" | "type" | "talk" | "menu" | "back" | "cancel" | "send" | "pause" | "resume" | "discard" | "clear" | "voice" |
    "close" | "select" | "up" | "down" | "prev" | "next" | "top" | "bottom" |
    "pageUp" | "pageDown" | "read" | "autoread" | "sessions" | "new" | "archive" | "exitInput" | "notes";

  // Clips longer than this need a second Backspace before they are discarded.
  export var DISCARD_CONFIRM_MS = 3000;

  var IDLE_KEYS: { [key: string]: Action } = {
    SoftLeft: "type", Enter: "talk", " ": "talk", SoftRight: "menu",
    Backspace: "back", Escape: "back",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "prev", ArrowRight: "next",
    "4": "prev", "6": "next", "1": "top", "9": "bottom", "2": "pageUp", "8": "pageDown",
    "5": "read", r: "read", R: "read", "0": "autoread", "#": "sessions", "3": "new", "7": "archive", "*": "notes"
  };

  var LIST_KEYS: { [key: string]: Action } = {
    ArrowUp: "up", ArrowDown: "down", Enter: "select", " ": "select",
    SoftLeft: "close", Backspace: "close", Escape: "close"
  };

  // Map a KeyboardEvent.key to an action for the current mode.
  // Unmapped keys return "none" so the default (e.g. typing a digit) still happens.
  // Centre is "Enter" on KaiOS, so the green Call key is the dedicated send key.
  // canResume: the recorder supports pause(); otherwise Centre in "paused" sends.
  export function mapKey(mode: Mode, key: string, inputEmpty: boolean, canResume?: boolean): Action {
    switch (mode) {
      case "recording":
        if (key === "Call" || key === "SoftRight") return "send";
        if (key === "Enter" || key === " ") return "pause";
        if (key === "Backspace") return "discard";
        if (key === "SoftLeft" || key === "Escape") return "cancel";
        return "none";
      case "paused":
        if (key === "Call" || key === "SoftRight") return "send";
        if (key === "Enter" || key === " ") return canResume ? "resume" : "send";
        if (key === "Backspace") return "discard";
        if (key === "SoftLeft" || key === "Escape") return "cancel";
        return "none";
      case "typing":
      case "rename":
        if (key === "Enter" || key === "Call") return "send";
        if (key === "SoftLeft") return "clear";
        if (key === "SoftRight") return mode === "typing" ? "voice" : "exitInput";
        if (key === "Escape") return "exitInput";
        if (key === "Backspace") return inputEmpty ? "exitInput" : "none";
        return "none";
      case "menu":
      case "sessions":
        return LIST_KEYS[key] || "none";
      case "confirm":
        if (key === "Enter" || key === " " || key === "7") return "select";
        if (key === "SoftLeft" || key === "Backspace" || key === "Escape") return "close";
        return "none";
      default:
        return IDLE_KEYS[key] || "none";
    }
  }

  // Softkey labels [left, centre, right] per mode. In Notes the right key returns to the chats.
  // The recording timer lives in the state banner, so both clip states share Delete/Send.
  export function softkeysFor(mode: Mode, _elapsed: string, canResume?: boolean, notes?: boolean): string[] {
    switch (mode) {
      case "recording": return ["Delete", "Pause", "Send"];
      case "paused": return ["Delete", canResume ? "Resume" : "Send", "Send"];
      case "typing": return ["Clear", "Send", "Voice"];
      case "rename": return ["Clear", "Save", "Cancel"];
      case "menu": return ["Close", "Select", ""];
      case "sessions": return ["Close", "Open", ""];
      case "confirm": return ["Cancel", "Archive", ""];
      default: return ["Type", "Talk", notes ? "Chat" : "Menu"];
    }
  }

  // At-a-glance state strip above the softkeys. Glyphs are limited to ones the
  // Nokia 6300 font renders as plain text (no colour emoji): ● ❚❚ ✕ ↑ ↻ !
  export type BannerKind = "rec" | "paused" | "discard" | "sending" | "queued" | "offline" | "failed";
  export interface Banner { kind: BannerKind; icon: string; text: string; }
  export interface BannerState {
    mode: Mode; elapsed: string; discardArmed?: boolean; notes?: boolean;
    sending?: boolean; failed?: boolean; stalled?: boolean; queued?: number; connected?: boolean;
  }

  export function stateBanner(s: BannerState): Banner | null {
    var what = s.notes ? "note" : "clip";
    if (s.mode === "recording" || s.mode === "paused") {
      if (s.discardArmed) return { kind: "discard", icon: "✕", text: "Delete " + s.elapsed + " " + what + "? Back again" };
      if (s.mode === "paused") return { kind: "paused", icon: "❚❚", text: "Paused " + s.elapsed };
      return { kind: "rec", icon: "●", text: (s.notes ? "Note " : "Recording ") + s.elapsed };
    }
    if (s.mode !== "idle") return null;
    if (s.failed) return { kind: "failed", icon: "!", text: "Failed · Menu › Retry last" };
    if (s.stalled) return { kind: "failed", icon: "!", text: "No reply yet · Menu › Retry" };
    if (s.sending) return { kind: "sending", icon: "↑", text: s.notes ? "Saving note…" : "Sending…" };
    if (s.queued) {
      var n = s.queued > 1 ? s.queued + " " + what + "s" : (s.notes ? "Note" : "Message");
      return s.connected
        ? { kind: "queued", icon: "↻", text: n + " queued · sending soon" }
        : { kind: "offline", icon: "↻", text: "Offline · " + n.toLowerCase() + " queued" };
    }
    return null;
  }

  // Colour class for the one-line notice: errors red, waits amber, confirmations green.
  export function noticeKind(text: string): string {
    if (/fail|error|unavailable|denied|could not|unsupported|no audio|cannot/i.test(text)) return "error";
    if (/offline|queued|not connected|not sent|cancel|discard|waiting|still|maximum|only one|first/i.test(text)) return "warn";
    if (/saved|renamed|created|archived|back online|read aloud (on|off)|^sent/i.test(text)) return "ok";
    return "info";
  }

  // Chat list row: state marker first so pending/failed/queued chats stand out.
  export function sessionListLabel(title: string, busy: boolean, failed: boolean, queued: boolean): string {
    var mark = failed ? "! " : busy ? "… " : queued ? "↻ " : "";
    return mark + title;
  }

  // Message focus: -1 means "live" (nothing selected, pinned to newest).
  export function moveFocus(selected: number, count: number, delta: number): number {
    if (!count) return -1;
    if (selected < 0) return delta < 0 ? count - 1 : -1;
    var next = selected + delta;
    if (next >= count) return -1;
    return next < 0 ? 0 : next;
  }

  export function formatElapsed(ms: number): string {
    var total = Math.max(0, Math.floor(ms / 1000));
    var sec = total % 60;
    return Math.floor(total / 60) + ":" + (sec < 10 ? "0" : "") + sec;
  }

  // Exponential poll backoff: 1.5s, 2.25s, 3.4s ... capped at 8s.
  export function pollDelay(attempt: number): number {
    return Math.min(8000, Math.round(1500 * Math.pow(1.5, Math.max(0, attempt))));
  }

  var DANISH_WORDS = ["og", "ikke", "jeg", "det", "er", "til", "på", "har", "med", "som", "kan",
    "vil", "hvad", "hej", "tak", "du", "skal", "også", "være", "meget", "hvordan", "godt", "nej", "ja"];

  // "da" when the text contains æøå or several common Danish words, otherwise "en".
  export function detectLang(text: string): string {
    if (/[æøåÆØÅ]/.test(text)) return "da";
    var words = text.toLowerCase().split(/[^a-zæøå]+/);
    var hits = 0;
    for (var i = 0; i < words.length; i++) {
      if (words[i] && DANISH_WORDS.indexOf(words[i]) >= 0) hits++;
    }
    return hits >= 2 ? "da" : "en";
  }

  // Pick an utterance language. Danish only when a Danish voice exists.
  export function ttsLang(text: string, voices: Array<{ lang: string }>): string {
    if (detectLang(text) !== "da") return "en-US";
    for (var i = 0; i < voices.length; i++) {
      if (voices[i] && /^da/i.test(voices[i].lang)) return voices[i].lang;
    }
    return "en-US";
  }
}
