// DOM rendering for the 240x320 chat screen. Text is always set via textContent.
namespace Klaus {
  var bar: HTMLElement, indexEl: HTMLElement, titleEl: HTMLElement, connEl: HTMLElement;
  var chatEl: HTMLElement, listEl: HTMLElement, thinkingEl: HTMLElement, echoEl: HTMLElement;
  var chipEl: HTMLElement, chipTimer: any = null;
  var statusEl: HTMLElement, bannerEl: HTMLElement, skEls: HTMLElement[], overlayEl: HTMLElement, overlayTitle: HTMLElement, overlayList: HTMLElement;
  export var composer: HTMLInputElement;

  var rendered: HTMLElement[] = [];
  var renderedFor = "";
  var renderedTexts: string[] = [];
  var selectedRow = -1;
  var emptyEl: HTMLElement | null = null; // "No messages yet" placeholder
  var pendingShown = false;               // a thinking bubble is visible

  function byId(id: string): HTMLElement { return document.getElementById(id) as HTMLElement; }

  function show(node: HTMLElement, visible: boolean): void {
    var cls = (node.className || "").replace(/\s*\bhidden\b/g, "");
    node.className = visible ? cls : (cls ? cls + " hidden" : "hidden");
  }

  export function uiInit(): void {
    bar = byId("bar"); indexEl = byId("session-index"); titleEl = byId("session-title"); connEl = byId("connection");
    chatEl = byId("chat"); listEl = byId("transcript"); thinkingEl = byId("thinking"); echoEl = byId("echo");
    statusEl = byId("status"); bannerEl = byId("banner"); composer = byId("composer") as HTMLInputElement;
    skEls = [byId("sk-left"), byId("sk-center"), byId("sk-right")];
    overlayEl = byId("overlay"); overlayTitle = byId("overlay-title"); overlayList = byId("overlay-list");
    chipEl = byId("chip");
    show(chipEl, false); show(thinkingEl, false); show(echoEl, false); show(statusEl, false); show(bannerEl, false); show(overlayEl, false);
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
  export function uiStatus(text: string): void {
    statusEl.textContent = text;
    statusEl.className = noticeKind(text);
    show(statusEl, !!text);
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

  export function uiComposerHint(mode: Mode, notes: boolean): void {
    var hint = mode === "rename" ? "Chat name" : mode === "typing" ? (notes ? "Type a note" : "Type a message")
      : notes ? "OK: talk · Left: type a note" : "OK: talk · Left: type";
    composer.setAttribute("placeholder", hint);
  }

  function atBottom(): boolean {
    var max = (chatEl.scrollHeight || 0) - (chatEl.clientHeight || 0);
    return chatEl.scrollTop >= max - 4;
  }

  export function uiScrollBottom(): void {
    chatEl.scrollTop = Math.max(0, (chatEl.scrollHeight || 0) - (chatEl.clientHeight || 0));
  }

  function makeRow(msg: ApiMessage): HTMLElement {
    var row = document.createElement("div");
    row.className = "msg " + (msg.role === "user" ? "user" : "bot") + (msg.voice ? " voice" : "");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;
    row.appendChild(bubble);
    return row;
  }

  function clearList(): void {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    rendered = []; renderedTexts = []; selectedRow = -1; emptyEl = null; readingRow = -1;
  }

  // Render a session's messages. Appends only new rows when the already-rendered prefix
  // is unchanged; otherwise rebuilds. Keeps the reader's scroll position unless they
  // were already at the bottom.
  export function uiMessages(sessionId: string, messages: ApiMessage[], emptyText?: string): void {
    var stick = atBottom();
    var prefixOk = renderedFor === sessionId && messages.length >= rendered.length;
    for (var i = 0; prefixOk && i < rendered.length; i++) {
      if (renderedTexts[i] !== messages[i].role + ":" + messages[i].text) prefixOk = false;
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
    for (var j = rendered.length; j < messages.length; j++) {
      var row = makeRow(messages[j]);
      listEl.appendChild(row);
      rendered.push(row);
      renderedTexts.push(messages[j].role + ":" + messages[j].text);
    }
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

  // Highlight a full message row; scroll it into view unless paging already placed it.
  export function uiSelect(index: number, scroll: boolean): void {
    if (selectedRow >= 0 && rendered[selectedRow]) {
      rendered[selectedRow].className = rendered[selectedRow].className.replace(/\s*\bsel\b/g, "");
    }
    selectedRow = index;
    if (index >= 0 && rendered[index]) {
      rendered[index].className += " sel";
      if (scroll) { try { (rendered[index] as any).scrollIntoView(false); } catch (_e) { /* old engines */ } }
    } else if (scroll) {
      uiScrollBottom();
    }
  }

  // Mark the message being read aloud (-1 clears).
  var readingRow = -1;
  export function uiReading(index: number): void {
    if (readingRow >= 0 && rendered[readingRow]) {
      rendered[readingRow].className = rendered[readingRow].className.replace(/\s*\breading\b/g, "");
    }
    readingRow = index;
    if (index >= 0 && rendered[index]) rendered[index].className += " reading";
  }

  // Scroll one page and return the first message row in view (or -1 at the bottom).
  export function uiPage(direction: number): number {
    var page = Math.max(40, (chatEl.clientHeight || 200) - 24);
    var max = Math.max(0, (chatEl.scrollHeight || 0) - (chatEl.clientHeight || 0));
    chatEl.scrollTop = Math.min(max, Math.max(0, chatEl.scrollTop + direction * page));
    if (direction > 0 && chatEl.scrollTop >= max) return -1;
    for (var i = 0; i < rendered.length; i++) {
      if ((rendered[i].offsetTop || 0) >= chatEl.scrollTop) return i;
    }
    return rendered.length ? rendered.length - 1 : -1;
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
      row.className = "item chat" + (rows[i].kind ? " " + rows[i].kind : "") + (i === selected ? " sel" : "");
      var top = document.createElement("div");
      top.className = "l1";
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

  export function uiOverlayScroll(delta: number): void {
    overlayList.scrollTop = Math.max(0, overlayList.scrollTop + delta);
  }

  export function uiOverlayHide(): void { show(overlayEl, false); }

  export function uiBarRecording(on: boolean, notes?: boolean, paused?: boolean): void {
    bar.className = on ? (paused ? "paused" : "rec") : notes ? "notes" : "";
  }
}
