// DOM rendering for the 240x320 chat screen. Text is always set via textContent.
namespace Klaus {
  var bar: HTMLElement, indexEl: HTMLElement, titleEl: HTMLElement, connEl: HTMLElement;
  var chatEl: HTMLElement, listEl: HTMLElement, thinkingEl: HTMLElement, echoEl: HTMLElement;
  var chipEl: HTMLElement, chipTimer: any = null;
  var statusEl: HTMLElement, bannerEl: HTMLElement, uploadEl: HTMLElement, levelEl: HTMLElement, skEls: HTMLElement[], overlayEl: HTMLElement, overlayTitle: HTMLElement, overlayList: HTMLElement;
  export var composer: HTMLInputElement;

  // Virtualised transcript: only a window around the viewport lives in the DOM, capped at UI_POOL_MAX
  // message rows, so long chats stay cheap on Gecko 48. One row node per window slot is created
  // once and recycled across windows; two spacer elements carry the estimated height of the
  // hidden rows so the scroll viewport never jumps on repaint.
  var rendered: HTMLElement[] = [];       // pool: one node per slot, reused across windows
  var renderedFor = "";
  var savedKeys: string[] = [];           // row keys of the whole current session (prefix check)
  var liveMessages: ApiMessage[] = [];
  var liveCount = 0;
  var heights: number[] = [];             // measured row heights, by message index
  var poolStart = 0, poolEnd = 0;
  var selectedRow = -1;
  var readingRow = -1;
  var emptyEl: HTMLElement | null = null; // "No messages yet" placeholder
  var pendingShown = false;               // a thinking bubble is visible
  var spcTop: HTMLElement, spcBottom: HTMLElement;

  export var UI_POOL_MAX = 30;            // hard cap for live message rows
  var ROW_HEIGHT = 38;                    // estimate for a text row before it is measured

  function byId(id: string): HTMLElement { return document.getElementById(id) as HTMLElement; }

  function show(node: HTMLElement, visible: boolean): void {
    var cls = (node.className || "").replace(/\s*\bhidden\b/g, "");
    node.className = visible ? cls : (cls ? cls + " hidden" : "hidden");
  }

  export function uiInit(): void {
    bar = byId("bar"); indexEl = byId("session-index"); titleEl = byId("session-title"); connEl = byId("connection");
    chatEl = byId("chat"); listEl = byId("transcript"); thinkingEl = byId("thinking"); echoEl = byId("echo");
    statusEl = byId("status"); bannerEl = byId("banner"); uploadEl = byId("upload"); levelEl = byId("level"); composer = byId("composer") as HTMLInputElement;
    skEls = [byId("sk-left"), byId("sk-center"), byId("sk-right")];
    overlayEl = byId("overlay"); overlayTitle = byId("overlay-title"); overlayList = byId("overlay-list");
    chipEl = byId("chip");
    show(chipEl, false); show(thinkingEl, false); show(echoEl, false); show(statusEl, false); show(bannerEl, false); show(uploadEl, false); show(levelEl, false); show(overlayEl, false);
    spcTop = document.createElement("div"); spcTop.className = "spc";
    spcBottom = document.createElement("div"); spcBottom.className = "spc";
  }

  export function uiTopbar(index: number, count: number, title: string): void {
    uiTopbarLabel(index + "/" + count, title);
  }

  export function uiTopbarLabel(label: string, title: string): void {
    indexEl.textContent = label;
    titleEl.textContent = title;
  }

  var CONN_CLASS: { [state: string]: string } = {
    "CONNECTED": "ok", "AUTH ERROR": "bad", "GATEWAY DOWN": "warn", "UNREACHABLE": "bad", "NOT CONNECTED": "off"
  };

  // Short word next to the dot when something is wrong, so the state reads without colour.
  var CONN_WORD: { [state: string]: string } = { "AUTH ERROR": "auth", "GATEWAY DOWN": "down", "UNREACHABLE": "offline" };

  export function uiConn(state: ConnState): void {
    connEl.textContent = CONN_WORD[state] ? "● " + CONN_WORD[state] : "●";
    connEl.className = CONN_CLASS[state] || "off";
    connEl.setAttribute("data-state", state);
    connEl.setAttribute("aria-label", state);
  }

  export function setSoftkeys(left: string, centre: string, right: string): void {
    skEls[0].textContent = left; skEls[1].textContent = centre; skEls[2].textContent = right;
  }

  // Press feedback: the softkey lights up until the key is released.
  export function uiKeyDown(index: number): void {
    if (skEls[index]) skEls[index].className = "press";
  }

  export function uiKeyUp(): void {
    for (var i = 0; i < skEls.length; i++) skEls[i].className = "";
  }

  // One-line notice above the composer, coloured by kind; hidden when empty.
  // A notice shrinks the chat: a reader at the newest message stays there.
  export function uiStatus(text: string): void {
    var stick = atBottom();
    statusEl.textContent = text;
    statusEl.className = noticeKind(text);
    show(statusEl, !!text);
    if (stick) uiScrollBottom();
  }

  // Confirmation chip at the top of the chat ("✓ Task saved", "✓ Reminder 15:00"), coloured
  // by kind; it fades after 4 s or on the next key press.
  export function uiChip(text: string, kind: string): void {
    chipEl.textContent = text;
    chipEl.className = kind;
    show(chipEl, !!text);
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = text ? setTimeout(function (): void { chipTimer = null; show(chipEl, false); }, 4000) : null;
  }

  export function uiChipHide(): void {
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = null; }
    show(chipEl, false);
  }

  // State strip in place of the composer; the composer returns when there is no banner.
  export function uiBanner(banner: Banner | null, typing: boolean): void {
    bannerEl.textContent = banner ? banner.icon + " " + banner.text : "";
    bannerEl.className = banner ? banner.kind : "";
    show(bannerEl, !!banner && !typing);
    show(composer, typing || !banner);
  }

  // Gecko 48 may not expose WebAudio for a microphone stream. In that case the
  // caller leaves this hidden and recording continues normally.
  export function uiLevel(amount: number | null): void {
    show(levelEl, amount !== null);
    if (amount === null) return;
    var bars = levelEl.getElementsByTagName("i");
    var lit = Math.max(0, Math.min(bars.length, Math.ceil(amount * bars.length)));
    for (var i = 0; i < bars.length; i++) bars[i].className = i < lit ? "on" : "";
  }

  export function uiUpload(amount: number | null): void {
    show(uploadEl, amount !== null);
    if (amount !== null) (uploadEl.firstElementChild as HTMLElement).style.width = Math.round(Math.max(0, Math.min(1, amount)) * 100) + "%";
  }

  export function uiComposerHint(mode: Mode, notes: boolean): void {
    var hint = mode === "rename" ? "Chat name" : mode === "typing" ? (notes ? "Type a note" : "Type a message")
      : notes ? "OK: talk · Left: type a note" : "OK: talk · Left: type";
    composer.setAttribute("placeholder", hint);
  }

  function atBottom(): boolean {
    return (chatEl.scrollTop || 0) >= maxScroll() - 4;
  }

  function maxScroll(): number {
    return Math.max(0, (chatEl.scrollHeight || 0) - (chatEl.clientHeight || 0));
  }

  // Test/render hook: the live window bounds, so the node budget can be pinned exactly.
  export function uiPoolInfo(): { start: number; end: number; live: number; total: number } {
    return { start: poolStart, end: poolEnd, live: poolEnd - poolStart, total: liveCount };
  }

  export function uiScrollBottom(): void {
    // Pin to the bottom; the window must follow the viewport, whose bounds the spacers
    // define, so the pin and the window settle over a few passes (one when the reader was
    // already near the end, a few more when the whole history lands at once at launch).
    for (var i = 0; i < 3; i++) {
      chatEl.scrollTop = maxScroll();
      windowRender();
      measureHeights();
      if (chatEl.scrollTop >= maxScroll() - 1) break;
    }
  }

  function vizSpan(cls: string, text: string): HTMLElement {
    var el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // A reply whose lines all match the mini-syntax is drawn as bars, checks or a
  // timeline; anything else renders as plain text unchanged.
  function fillViz(viz: Viz, bubble: HTMLElement): void {
    var box = document.createElement("div");
    box.className = viz.kind === "bars" ? "viz vbars" : viz.kind === "checks" ? "viz vchecks" : "viz vtimes";
    var i: number;
    var line: HTMLElement;
    if (viz.kind === "bars") {
      for (i = 0; i < viz.items.length; i++) {
        var bar = viz.items[i];
        line = document.createElement("div");
        line.className = "vline vbar";
        line.appendChild(vizSpan("vlabel", clipLine(bar.label, VIZ_LABEL_CHARS)));
        var track = document.createElement("div");
        track.className = "vtrack";
        var fill = document.createElement("div");
        fill.className = "vfill";
        fill.style.width = vizBarWidth(bar.value) + "%";
        track.appendChild(fill);
        line.appendChild(track);
        line.appendChild(vizSpan("vval", vizBarText(bar)));
        box.appendChild(line);
      }
    } else if (viz.kind === "checks") {
      for (i = 0; i < viz.items.length; i++) {
        var item = viz.items[i];
        line = document.createElement("div");
        line.className = "vline vchk " + (item.done ? "on" : "off");
        line.appendChild(vizSpan("vmark", item.done ? "✓" : "-"));
        line.appendChild(vizSpan("vtext", item.text ? clipLine(item.text, VIZ_TEXT_CHARS) : ""));
        box.appendChild(line);
      }
    } else {
      for (i = 0; i < viz.items.length; i++) {
        var t = viz.items[i];
        line = document.createElement("div");
        line.className = "vline vtim";
        line.appendChild(vizSpan("vtime", t.time));
        line.appendChild(vizSpan("vtext", t.text ? clipLine(t.text, VIZ_TEXT_CHARS) : ""));
        box.appendChild(line);
      }
    }
    bubble.appendChild(box);
  }

  // ── Virtualisation helpers ─────────────────────────────────────────
  function rowKey(m: ApiMessage): string { return m.role + ":" + m.text + ":" + (m.voice ? "v" : ""); }

  function rowHeight(row: HTMLElement): number {
    var h = (row as any).offsetHeight;
    return typeof h === "number" && h > 0 ? h : ROW_HEIGHT;
  }

  // average of the measured row heights; the fallback a window never saw
  function estAvg(): number {
    var sum = 0, n = 0;
    for (var i = 0; i < heights.length && i < liveCount; i++) {
      if (heights[i]) { sum += heights[i]; n++; }
    }
    return n ? sum / n : ROW_HEIGHT;
  }

  // Estimated pixel offset of the row band [from, to); unmeasured rows use the average.
  function estRange(from: number, to: number): number {
    var avg = estAvg(), known = 0, missing = 0;
    for (var i = from; i < to; i++) {
      if (i < heights.length && heights[i]) known += heights[i];
      else missing++;
    }
    return known + missing * avg;
  }

  function estTop(index: number): number { return estRange(0, index); }

  // The live pool: a viewport-sized window anchored on the reader, grown to hold the focused
  // row, clipped at UI_POOL_MAX. Estimates use measured row heights when available, so a short
  // sight (read position past the estimated total) can never yield an empty window: it anchors
  // to the newest rows and the next measured pass settles the position.
  function poolSlice(): { start: number; end: number } {
    if (!liveCount) return { start: 0, end: 0 };
    var top = chatEl.scrollTop || 0;
    var vh = (chatEl.clientHeight || 0) + ROW_HEIGHT;
    var fit = Math.ceil(vh / estAvg());
    if (fit < 1) fit = 1;
    if (fit > UI_POOL_MAX) fit = UI_POOL_MAX; // the cap binds for very tall viewports
    var idx = 0, acc = 0;
    for (var i = 0; i < liveCount; i++) {
      var h = (i < heights.length && heights[i]) ? heights[i] : ROW_HEIGHT;
      if (acc + h > top) { idx = i; break; }
      acc += h;
      idx = i + 1;
    }
    var start: number, end: number;
    if (idx >= liveCount) { // the reader sits past the estimated total: anchor to the bottom
      start = Math.max(0, liveCount - fit);
      end = liveCount;
    } else {
      start = idx;
      end = Math.min(liveCount, idx + fit);
    }
    // The focused row always survives the cap: it extends the pool beyond the window.
    if (selectedRow >= 0 && selectedRow < start) start = selectedRow;
    if (selectedRow >= 0 && selectedRow >= end) end = Math.min(liveCount, selectedRow + 1);
    if (end - start > UI_POOL_MAX) {
      var nearEnd = estTop(liveCount) - top <= maxScroll() + vh;
      if (nearEnd) start = end - UI_POOL_MAX;
      else end = start + UI_POOL_MAX;
    }
    if (start < 0) start = 0;
    if (end > liveCount) end = liveCount;
    return { start: start, end: end };
  }

  function setSpacer(spc: HTMLElement, h: number): void {
    spc.style.height = h + "px";
  }

  // Repaint the live pool: slot nodes are recycled across windows, never re-created on
  // scroll. Hidden rows stay out of the DOM; the two spacers carry their estimated height
  // so the scroll viewport never moves on repaint. State (sel/reading) is painted here too,
  // from selectedRow/readingRow, so this is the single source of truth for row classes.
  function windowRender(): void {
    if (!liveCount) return;
    var slice = poolSlice();
    poolStart = slice.start; poolEnd = slice.end;
    var count = poolEnd - poolStart;
    for (var g = rendered.length; g < count; g++) rendered.push(makeRow(liveMessages[poolStart + g]));
    for (var k = 0; k < count; k++) paintSlot(k);
    if (spcTop.parentNode) listEl.removeChild(spcTop);
    if (spcBottom.parentNode) listEl.removeChild(spcBottom);
    for (var p = count; p < rendered.length; p++) if (rendered[p].parentNode) listEl.removeChild(rendered[p]);
    var want: HTMLElement[] = [];
    if (poolStart > 0) want.push(spcTop);
    for (var w = 0; w < count; w++) want.push(rendered[w]);
    if (poolEnd < liveCount) want.push(spcBottom);
    if (listEl.children.length !== want.length) {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      for (var v = 0; v < want.length; v++) listEl.appendChild(want[v]);
    } else {
      for (var m2 = 0; m2 < want.length; m2++) {
        if (listEl.children[m2] !== want[m2]) {
          while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
          for (var v2 = 0; v2 < want.length; v2++) listEl.appendChild(want[v2]);
          break;
        }
      }
    }
    setSpacer(spcTop, poolStart > 0 ? estRange(0, poolStart) : 0);
    setSpacer(spcBottom, poolEnd < liveCount ? estRange(poolEnd, liveCount) : 0);
  }

  // Paint window slot k with the message it currently shows (visual, text and state classes).
  function paintSlot(k: number): void {
    var m = liveMessages[poolStart + k];
    var row = rendered[k];
    var viz: Viz | null = null;
    if (m.role === "assistant" && !m.voice) { try { viz = parseViz(m.text); } catch (_e) { viz = null; } }
    var cls = "msg " + (m.role === "user" ? "user" : "bot") + (m.voice ? " voice" : "");
    if (selectedRow === poolStart + k) cls += " sel";
    if (readingRow === poolStart + k) cls += " reading";
    row.className = cls;
    var bubble = row.firstChild as HTMLElement | null;
    if (!bubble || !/\bbubble\b/.test(bubble.className || "")) {
      while (row.firstChild) row.removeChild(row.firstChild);
      bubble = document.createElement("div");
      bubble.className = "bubble";
      row.appendChild(bubble);
    }
    if (viz) { while (bubble.firstChild) bubble.removeChild(bubble.firstChild); fillViz(viz, bubble); }
    else {
      // a recycled slot may still hold a visual: drop it, plain text rules the rest
      while (bubble.firstChild) bubble.removeChild(bubble.firstChild);
      bubble.textContent = m.text;
    }
  }

  function measureHeights(): void {
    var count = Math.min(poolEnd - poolStart, rendered.length), changed = false;
    for (var k = 0; k < count; k++) {
      var i = poolStart + k;
      if (i >= heights.length) heights.length = i + 1;
      var r = rowHeight(rendered[k]);
      if ((heights[i] || 0) < r) { heights[i] = r; changed = true; }
    }
    if (changed) {
      setSpacer(spcTop, poolStart > 0 ? estRange(0, poolStart) : 0);
      setSpacer(spcBottom, poolEnd < liveCount ? estRange(poolEnd, liveCount) : 0);
    }
  }

  function makeRow(msg: ApiMessage): HTMLElement {
    var row: HTMLElement;
    var viz = null;
    if (msg.role === "assistant" && !msg.voice) {
      try { viz = parseViz(msg.text); } catch (_e) { viz = null; }
    }
    row = document.createElement("div");
    row.className = "msg " + (msg.role === "user" ? "user" : "bot") + (msg.voice ? " voice" : "");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (viz) fillViz(viz, bubble);
    else bubble.textContent = msg.text;
    row.appendChild(bubble);
    return row;
  }

  function clearList(): void {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    rendered = []; savedKeys = []; heights = [];
    liveMessages = []; liveCount = 0; poolStart = 0; poolEnd = 0;
    selectedRow = -1; emptyEl = null; readingRow = -1;
  }

  // Render a session's messages. Keeps already-live rows when the prefix is unchanged, grows
  // the pool only for the new window, and pins the reader at the bottom when they were there.
  export function uiMessages(sessionId: string, messages: ApiMessage[], emptyText?: string): void {
    var stick = atBottom();
    var prefixOk = renderedFor === sessionId && messages.length >= savedKeys.length;
    for (var i = 0; prefixOk && i < savedKeys.length; i++) {
      if (savedKeys[i] !== messages[i].role + ":" + messages[i].text + ":" + (messages[i].voice ? "v" : "")) prefixOk = false;
    }
    if (!prefixOk || !messages.length) { clearList(); stick = true; }
    renderedFor = sessionId;
    if (!messages.length) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = emptyText || emptyHint("idle", false);
      listEl.appendChild(empty);
      emptyEl = empty;
      show(empty, !pendingShown); // the first turn is already on its way
      return;
    }
    if (emptyEl) { listEl.removeChild(emptyEl); emptyEl = null; }
    if (prefixOk) {
      // Same session, same prefix: new rows are only added; the pool and measured heights
      // survive so existing row nodes keep their identity.
      for (var k = savedKeys.length; k < messages.length; k++) savedKeys.push(rowKey(messages[k]));
    } else {
      clearList();
      for (var k2 = 0; k2 < messages.length; k2++) savedKeys.push(rowKey(messages[k2]));
    }
    liveMessages = messages; liveCount = messages.length;
    windowRender();
    measureHeights();
    if (stick) uiScrollBottom();
  }

  // Change the empty-chat hint in place (e.g. while the first clip records).
  export function uiEmptyHint(text: string): void {
    if (emptyEl) emptyEl.textContent = text;
  }

  // Rows in index.html wrap a .bubble child; fall back to the row itself.
  function setBubble(row: HTMLElement, text: string): void {
    var bubble = row.firstElementChild as HTMLElement | null;
    (bubble || row).textContent = text;
  }

  // Pending turn: optional echo of the typed text plus the animated thinking bubble.
  export function uiThinking(label: string | null, echo: string | null): void {
    setBubble(echoEl, echo || "");
    show(echoEl, !!(label && echo));
    setBubble(thinkingEl, label || "");
    var wasVisible = !/\bhidden\b/.test(thinkingEl.className || "");
    show(thinkingEl, !!label);
    pendingShown = !!label;
    if (emptyEl) show(emptyEl, !label);
    if (label && !wasVisible && selectedRow < 0) uiScrollBottom();
  }

  // Move the scroll so the indexed row starts at the top of the view (estimates get one
  // refinement pass once the window is measured).
  function scrollToIndex(index: number): void {
    var max = maxScroll();
    var est = estTop(index);
    chatEl.scrollTop = Math.min(max, Math.max(0, est));
    windowRender();
    measureHeights();
    var est2 = estTop(index);
    if (Math.abs(est2 - est) > 4) {
      chatEl.scrollTop = Math.min(max, Math.max(0, est2));
      windowRender();
      measureHeights();
    }
  }

  // Highlight a full message row; scroll it into view unless paging already placed it.
  export function uiSelect(index: number, scroll: boolean): void {
    selectedRow = index;
    if (index < 0) {
      if (scroll) uiScrollBottom();
      return;
    }
    if (index >= poolStart && index < poolEnd) {
      if (scroll) {
        var slot = index - poolStart;
        if (slot >= 0 && slot < rendered.length) {
          try { (rendered[slot] as any).scrollIntoView(false); } catch (_e) { /* old engines */ }
        }
        windowRender();
        measureHeights();
      }
    } else if (scroll) {
      scrollToIndex(index);
      windowRender();
    }
    windowRender(); // repaint the state classes (sel) on whatever slot now holds the row
  }

  // Mark the message being read aloud (-1 clears).
  export function uiReading(index: number): void {
    var changed = readingRow !== index;
    readingRow = index;
    if (changed) windowRender();
  }

  // Scroll one page and return the first message row in view (or -1 at the bottom).
  export function uiPage(direction: number): number {
    var page = Math.max(40, (chatEl.clientHeight || 200) - 24);
    var top = chatEl.scrollTop || 0;
    var max = maxScroll();
    chatEl.scrollTop = Math.min(max, Math.max(0, top + direction * page));
    windowRender();
    measureHeights();
    if (top >= max - 4 && direction > 0) return -1;
    var newTop = chatEl.scrollTop || 0;
    for (var i = 0; i < liveCount; i++) {
      if (estTop(i + 1) > newTop) return i;
    }
    return liveCount ? liveCount - 1 : -1;
  }

  // note: plain explanatory text under the title (confirm screens), never selectable.
  // numbered: compact rows led by their digit shortcut (1-9).
  export function uiOverlay(title: string, items: string[], selected: number, note?: string, numbered?: boolean): void {
    overlayTitle.textContent = title;
    while (overlayList.firstChild) overlayList.removeChild(overlayList.firstChild);
    if (note) {
      var p = document.createElement("p");
      p.className = /\n/.test(note) ? "note keys" : "note";
      p.textContent = note;
      overlayList.appendChild(p);
    }
    for (var i = 0; i < items.length; i++) {
      var row = document.createElement("div");
      row.className = (numbered ? "item num" : "item") + (i === selected ? " sel" : "");
      if (numbered) {
        row.appendChild(span("key", String(i + 1)));
        row.appendChild(span("label", items[i]));
      } else row.textContent = items[i];
      overlayList.appendChild(row);
      if (i === selected) { try { (row as any).scrollIntoView(false); } catch (_e) { /* old engines */ } }
    }
    show(overlayEl, true);
  }

  function span(cls: string, text: string): HTMLElement {
    var el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // Chat list: two lines per chat (marker + title + time, then a preview), state colours.
  // dial: speed-dial chips shown above the chats; a falsy enabled entry is dimmed.
  export function uiSessionList(title: string, rows: SessionRow[], selected: number,
                                dial?: string[], enabled?: boolean[]): void {
    overlayTitle.textContent = title;
    while (overlayList.firstChild) overlayList.removeChild(overlayList.firstChild);
    if (dial && dial.length) {
      var strip = document.createElement("div");
      strip.className = "dial";
      for (var d = 0; d < dial.length; d++) {
        var chip = document.createElement("span");
        chip.className = enabled && !enabled[d] ? "chip off" : "chip";
        chip.appendChild(span("key", String(d + 1)));
        chip.appendChild(span("label", dial[d]));
        strip.appendChild(chip);
      }
      overlayList.appendChild(strip);
    }
    for (var i = 0; i < rows.length; i++) {
      var row = document.createElement("div");
      row.className = "item chat" + (rows[i].kind ? " " + rows[i].kind : "") + (rows[i].pinned ? " pinned" : "") + (i === selected ? " sel" : "");
      var top = document.createElement("div");
      top.className = "l1";
      if (rows[i].pinned) top.appendChild(span("pino", "P"));
      top.appendChild(span("t", rows[i].title));
      top.appendChild(span("tm", rows[i].time));
      row.appendChild(top);
      var pv = document.createElement("div");
      pv.className = "pv";
      pv.textContent = rows[i].preview;
      row.appendChild(pv);
      overlayList.appendChild(row);
      if (i === selected) { try { (row as any).scrollIntoView(false); } catch (_e) { /* old engines */ } }
    }
    show(overlayEl, true);
  }

  // Today: a freshness line, then titled sections of rows (time, optional kind tag, text).
  export function uiToday(title: string, freshness: string, sections: TodaySection[]): void {
    overlayTitle.textContent = title;
    var top = overlayList.scrollTop;
    while (overlayList.firstChild) overlayList.removeChild(overlayList.firstChild);
    var fresh = document.createElement("p");
    fresh.className = "fresh" + (/Offline|unreachable/.test(freshness) ? " warn" : "");
    fresh.textContent = freshness;
    overlayList.appendChild(fresh);
    for (var i = 0; i < sections.length; i++) {
      var head = document.createElement("div");
      head.className = "sec";
      head.textContent = sections[i].title;
      overlayList.appendChild(head);
      for (var j = 0; j < sections[i].rows.length; j++) {
        var r = sections[i].rows[j];
        var row = document.createElement("div");
        row.className = "trow" + (r.cls ? " " + r.cls : "");
        if (r.time) row.appendChild(span("tm", r.time));
        if (r.tag) row.appendChild(span("tag", r.tag));
        row.appendChild(span("tx", r.text));
        overlayList.appendChild(row);
      }
    }
    overlayList.scrollTop = top;
    show(overlayEl, true);
  }

  // Search: a query row plus one result per chat (title or first matching message).
  // Rows reuse the chat-list two-line layout so the reading feel is the same.
  export function uiSearch(query: string, rows: Array<{ title: string; match: string; inTitle: boolean }>, selected: number): void {
    overlayTitle.textContent = "Search chats";
    while (overlayList.firstChild) overlayList.removeChild(overlayList.firstChild);
    var qrow = document.createElement("div");
    qrow.className = "squery";
    qrow.appendChild(span("sq", "> "));
    qrow.appendChild(span("sqtext", query || "type to search…"));
    overlayList.appendChild(qrow);
    if (!query) {
      var help = document.createElement("p");
      help.className = "snote";
      help.textContent = "Letters, digits and Back; OK opens, SoftLeft clears.";
      overlayList.appendChild(help);
    } else if (!rows.length) {
      var nomatch = document.createElement("p");
      nomatch.className = "snote warn";
      nomatch.textContent = "No match for \u201c" + clipLine(query, 20) + "\u201d";
      overlayList.appendChild(nomatch);
    }
    for (var i = 0; i < rows.length; i++) {
      var row = document.createElement("div");
      row.className = "item chat sres" + (i === selected ? " sel" : "");
      var top = document.createElement("div");
      top.className = "l1";
      var t = span("t", rows[i].title);
      if (rows[i].inTitle) t.className += " inTitle";
      top.appendChild(t);
      row.appendChild(top);
      var pv = document.createElement("div");
      pv.className = "pv";
      pv.textContent = rows[i].match;
      row.appendChild(pv);
      overlayList.appendChild(row);
      if (i === selected) { try { (row as any).scrollIntoView(false); } catch (_e) { /* old engines */ } }
    }
    show(overlayEl, true);
  }

  export function uiOverlayScroll(delta: number): void {
    overlayList.scrollTop = Math.max(0, overlayList.scrollTop + delta);
  }

  export function uiOverlayHide(): void { show(overlayEl, false); }

  // Display options on <body>: "night" (dim warm palette), "large" (bigger reading text).
  export function uiDisplay(night: boolean, large: boolean): void {
    var body = document.body;
    if (body) body.className = (night ? "night" : "") + (night && large ? " " : "") + (large ? "large" : "");
  }

  export function uiBarRecording(on: boolean, notes?: boolean, paused?: boolean): void {
    bar.className = on ? (paused ? "paused" : "rec") : notes ? "notes" : "";
  }
}
