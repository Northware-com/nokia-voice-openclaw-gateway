// DOM rendering for the 240x320 chat screen. Text is always set via textContent.
namespace Klaus {
  var bar: HTMLElement, indexEl: HTMLElement, titleEl: HTMLElement, connEl: HTMLElement;
  var chatEl: HTMLElement, listEl: HTMLElement, thinkingEl: HTMLElement, echoEl: HTMLElement;
  var statusEl: HTMLElement, skEls: HTMLElement[], overlayEl: HTMLElement, overlayTitle: HTMLElement, overlayList: HTMLElement;
  export var composer: HTMLInputElement;

  var rendered: HTMLElement[] = [];
  var renderedFor = "";
  var renderedTexts: string[] = [];
  var selectedRow = -1;

  function byId(id: string): HTMLElement { return document.getElementById(id) as HTMLElement; }

  function show(node: HTMLElement, visible: boolean): void {
    var cls = (node.className || "").replace(/\s*\bhidden\b/g, "");
    node.className = visible ? cls : (cls ? cls + " hidden" : "hidden");
  }

  export function uiInit(): void {
    bar = byId("bar"); indexEl = byId("session-index"); titleEl = byId("session-title"); connEl = byId("connection");
    chatEl = byId("chat"); listEl = byId("transcript"); thinkingEl = byId("thinking"); echoEl = byId("echo");
    statusEl = byId("status"); composer = byId("composer") as HTMLInputElement;
    skEls = [byId("sk-left"), byId("sk-center"), byId("sk-right")];
    overlayEl = byId("overlay"); overlayTitle = byId("overlay-title"); overlayList = byId("overlay-list");
    show(thinkingEl, false); show(echoEl, false); show(statusEl, false); show(overlayEl, false);
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

  export function uiConn(state: ConnState): void {
    connEl.textContent = "●";
    connEl.className = CONN_CLASS[state] || "off";
    connEl.setAttribute("data-state", state);
    connEl.setAttribute("aria-label", state);
  }

  export function setSoftkeys(left: string, centre: string, right: string): void {
    skEls[0].textContent = left; skEls[1].textContent = centre; skEls[2].textContent = right;
  }

  // One-line notice above the composer; hidden when empty.
  export function uiStatus(text: string): void {
    statusEl.textContent = text;
    show(statusEl, !!text);
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
    row.className = "msg " + (msg.role === "user" ? "user" : "bot");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;
    row.appendChild(bubble);
    return row;
  }

  function clearList(): void {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    rendered = []; renderedTexts = []; selectedRow = -1;
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
      empty.textContent = emptyText || "No messages yet. Press OK to talk.";
      listEl.appendChild(empty);
      return;
    }
    if (!rendered.length && listEl.firstChild) listEl.removeChild(listEl.firstChild);
    for (var j = rendered.length; j < messages.length; j++) {
      var row = makeRow(messages[j]);
      listEl.appendChild(row);
      rendered.push(row);
      renderedTexts.push(messages[j].role + ":" + messages[j].text);
    }
    if (stick) uiScrollBottom();
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

  export function uiOverlay(title: string, items: string[], selected: number): void {
    overlayTitle.textContent = title;
    while (overlayList.firstChild) overlayList.removeChild(overlayList.firstChild);
    for (var i = 0; i < items.length; i++) {
      var row = document.createElement("div");
      row.className = i === selected ? "item sel" : "item";
      row.textContent = items[i];
      overlayList.appendChild(row);
      if (i === selected) { try { (row as any).scrollIntoView(false); } catch (_e) { /* old engines */ } }
    }
    show(overlayEl, true);
  }

  export function uiOverlayHide(): void { show(overlayEl, false); }

  export function uiBarRecording(on: boolean, notes?: boolean): void {
    bar.className = on ? "rec" : notes ? "notes" : "";
  }
}
