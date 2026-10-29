// Pure key-map and presentation logic. No DOM access, so tests can call it directly.
namespace Klaus {
  export type Mode = "idle" | "recording" | "paused" | "typing" | "rename" | "menu" | "sessions" | "confirm";

  export type Action =
    "none" | "type" | "talk" | "menu" | "back" | "cancel" | "send" | "pause" | "resume" | "discard" | "clear" | "voice" |
    "close" | "select" | "up" | "down" | "prev" | "next" | "top" | "bottom" |
    "pageUp" | "pageDown" | "read" | "autoread" | "sessions" | "new" | "archive" | "exitInput";

  // Clips longer than this need a second Backspace before they are discarded.
  export var DISCARD_CONFIRM_MS = 3000;

  var IDLE_KEYS: { [key: string]: Action } = {
    SoftLeft: "type", Enter: "talk", " ": "talk", SoftRight: "menu",
    Backspace: "back", Escape: "back",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "prev", ArrowRight: "next",
    "4": "prev", "6": "next", "1": "top", "9": "bottom", "2": "pageUp", "8": "pageDown",
    "5": "read", r: "read", R: "read", "0": "autoread", "#": "sessions", "3": "new", "7": "archive"
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
        if (key === "Call") return "send";
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

  // Softkey labels [left, centre, right] per mode.
  export function softkeysFor(mode: Mode, elapsed: string, canResume?: boolean): string[] {
    switch (mode) {
      case "recording": return ["Cancel", "Pause", elapsed];
      case "paused": return ["Delete", canResume ? "Resume" : "Send", "Send"];
      case "typing": return ["Clear", "Send", "Voice"];
      case "rename": return ["Clear", "Save", "Cancel"];
      case "menu": return ["Close", "Select", ""];
      case "sessions": return ["Close", "Open", ""];
      case "confirm": return ["Cancel", "Archive", ""];
      default: return ["Type", "Talk", "Menu"];
    }
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
