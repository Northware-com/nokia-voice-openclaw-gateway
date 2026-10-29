// Reply visualisation: a small deterministic mini-syntax drawn INSIDE received
// replies — horizontal bar charts, checklists and timelines. Everything else
// stays plain text. Parsing is pure (no DOM access) so tests pin the rules.
namespace Klaus {
  export interface VizBar { label: string; value: number; pct: boolean; }
  export interface VizCheck { done: boolean; text: string; }
  export interface VizTime { time: string; text: string; }
  export type Viz =
    | { kind: "bars"; items: VizBar[] }
    | { kind: "checks"; items: VizCheck[] }
    | { kind: "times"; items: VizTime[] };

  // Larger lists would overflow 240x320, so the whole message stays plain text.
  export var VIZ_MAX = { bars: 6, checks: 8, times: 8 };
  export var VIZ_LABEL_CHARS = 14;
  export var VIZ_TEXT_CHARS = 26;

  // "- [ ]", "* [x]", "1. [✓]"... a box with " " means open, else done.
  var VIZ_CHECK_LINE = /^\s*(?:[-*•]|\d+\.)\s*\[( |x|X|\u2713)\]\s+(.*)$/;
  // "9:30  Take the bins out" — optional trailing text.
  var VIZ_TIME_LINE = /^\s*(\d{1,2}:\d{2})\s*(.*)$/;
  // "Milk 80%" or "Milk: 80%"
  var VIZ_BAR_PCT_END = /^\s*([^\s\[\]:%]{1,32})\s*[:\-–—]?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/;
  // "80% Milk"
  var VIZ_BAR_PCT_FIRST = /^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*[:\-–—]?\s*(\S.*)$/;
  // "Milk: 80" (no percent sign)
  var VIZ_BAR_N = /^\s*([^\s\[\]:%]{1,32})\s*[:\-–—]\s*(\d{1,3}(?:\.\d+)?)\s*$/;

  function barValue(v: string): number {
    var n = parseFloat(v.replace(",", ""));
    return isNaN(n) ? 0 : n;
  }

  function parseBar(line: string): VizBar | null {
    var m = line.match(VIZ_BAR_PCT_END);
    if (m) return { label: m[1], value: barValue(m[2]), pct: true };
    m = line.match(VIZ_BAR_PCT_FIRST);
    if (m) return { label: m[2], value: barValue(m[1]), pct: true };
    m = line.match(VIZ_BAR_N);
    if (m) return { label: m[1], value: barValue(m[2]), pct: false };
    return null;
  }

  // A message is a visualisation only when EVERY non-empty line matches one
  // mini-syntax, with at least two such lines. Anything mixed or unmatched
  // falls through to plain text, so ordinary replies can never break.
  export function parseViz(text: string): Viz | null {
    if (!text) return null;
    var lines: string[] = [];
    var all = String(text).split(/\r?\n/);
    for (var i = 0; i < all.length; i++) if (all[i].replace(/\s+$/, "")) lines.push(all[i]);
    if (lines.length < 2) return null;

    if (lines.length <= VIZ_MAX.checks) {
      var checks: VizCheck[] = [];
      for (i = 0; i < lines.length; i++) {
        var m = lines[i].match(VIZ_CHECK_LINE);
        if (!m) break;
        checks.push({ done: m[1] !== " ", text: m[2] || "" });
      }
      if (checks.length === lines.length) return { kind: "checks", items: checks };
    }
    if (lines.length <= VIZ_MAX.times) {
      var times: VizTime[] = [];
      for (i = 0; i < lines.length; i++) {
        m = lines[i].match(VIZ_TIME_LINE);
        if (!m) break;
        times.push({ time: m[1], text: m[2] || "" });
      }
      if (times.length === lines.length) return { kind: "times", items: times };
    }
    if (lines.length <= VIZ_MAX.bars) {
      var bars: VizBar[] = [];
      for (i = 0; i < lines.length; i++) {
        var bar = parseBar(lines[i]);
        if (!bar) break;
        bars.push(bar);
      }
      if (bars.length === lines.length) return { kind: "bars", items: bars };
    }
    return null;
  }

  // Bar width in percent of the full track (values cap at 100).
  export function vizBarWidth(value: number): number {
    var w = Math.round(Math.max(0, Math.min(100, value)));
    return w < 2 ? 2 : w;
  }

  // Bar value text: "80%" for percent lines, the raw number for "Label: N".
  export function vizBarText(bar: VizBar): string {
    var n = bar.value % 1 === 0 ? String(Math.round(bar.value)) : String(bar.value);
    return bar.pct ? n + "%" : n;
  }
}