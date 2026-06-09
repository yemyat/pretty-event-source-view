import { normalizeEvent, previewData, splitUrl } from "./format.js";
import type { JsonValue, NormalizedEvent, RawCapturedEvent } from "./format.js";

type ActiveTab = "pretty" | "raw";

type PanelState = {
  events: NormalizedEvent[];
  selectedRowId: string | null;
  activeTab: ActiveTab;
  renderedDetailKey: string | null;
  paused: boolean;
  injected: boolean;
  pollTimer: number | null;
};

type WatcherSnapshot = {
  paused: boolean;
  events: RawCapturedEvent[];
};

type EvalResult<T> = { value: T; error?: never } | { error: string; value?: never };

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

const state: PanelState = {
  events: [],
  selectedRowId: null,
  activeTab: "pretty",
  renderedDetailKey: null,
  paused: false,
  injected: false,
  pollTimer: null,
};

const elements = {
  workspace: getElement<HTMLElement>(".workspace"),
  status: getElement<HTMLElement>("#status"),
  filterInput: getElement<HTMLInputElement>("#filterInput"),
  injectButton: getElement<HTMLButtonElement>("#injectButton"),
  pauseButton: getElement<HTMLButtonElement>("#pauseButton"),
  clearButton: getElement<HTMLButtonElement>("#clearButton"),
  copyButton: getElement<HTMLButtonElement>("#copyButton"),
  splitter: getElement<HTMLElement>("#splitter"),
  prettyTab: getElement<HTMLButtonElement>("#prettyTab"),
  rawTab: getElement<HTMLButtonElement>("#rawTab"),
  expandAllButton: getElement<HTMLButtonElement>("#expandAllButton"),
  collapseAllButton: getElement<HTMLButtonElement>("#collapseAllButton"),
  eventRows: getElement<HTMLElement>("#eventRows"),
  detailTitle: getElement<HTMLElement>("#detailTitle"),
  detailUrlHost: getElement<HTMLElement>("#detailUrlHost"),
  detailUrlPath: getElement<HTMLElement>("#detailUrlPath"),
  detailOutput: getElement<HTMLElement>("#detailOutput"),
};

const isDevTools = typeof chrome !== "undefined" && Boolean(chrome.devtools?.inspectedWindow);

elements.injectButton.addEventListener("click", () => {
  if (isDevTools) {
    injectWatcher();
  }
});

elements.pauseButton.addEventListener("click", () => {
  setPaused(!state.paused);
});

elements.clearButton.addEventListener("click", () => {
  clearEvents();
});

elements.copyButton.addEventListener("click", async () => {
  const event = getSelectedEvent();

  if (!event) {
    return;
  }

  const text = state.activeTab === "raw" ? event.pretty.raw : event.pretty.pretty;
  await navigator.clipboard?.writeText(text);
  setStatus("Copied");
});

elements.prettyTab.addEventListener("click", () => {
  state.activeTab = "pretty";
  renderDetail();
});

elements.rawTab.addEventListener("click", () => {
  state.activeTab = "raw";
  renderDetail();
});

elements.filterInput.addEventListener("input", renderRows);
elements.splitter.addEventListener("pointerdown", startResize);
elements.splitter.addEventListener("keydown", resizeWithKeyboard);
elements.expandAllButton.addEventListener("click", () => setJsonNodesOpen(true));
elements.collapseAllButton.addEventListener("click", () => setJsonNodesOpen(false));

if (isDevTools) {
  elements.injectButton.textContent = "Inject";
  chrome.devtools.network.onNavigated.addListener(() => {
    state.events = [];
    state.selectedRowId = null;
    state.renderedDetailKey = null;
    render();
    injectWatcher();
  });
  injectWatcher();
} else {
  elements.injectButton.disabled = true;
  elements.pauseButton.disabled = true;
  elements.clearButton.disabled = true;
  setStatus("Open this panel in DevTools");
}

async function injectWatcher() {
  setStatus("Injecting");

  try {
    const response = await fetch(chrome.runtime.getURL("src/panel/injected-hook.js"));
    const source = await response.text();
    const result = await evalInPage(source);

    if (result?.error) {
      setStatus(result.error);
      return;
    }

    state.injected = true;
    setStatus("Watching inspected page");
    startPolling();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Injection failed");
  }
}

function startPolling() {
  if (state.pollTimer !== null) {
    window.clearInterval(state.pollTimer);
  }

  state.pollTimer = window.setInterval(pollInspectedPage, 350);
  pollInspectedPage();
}

async function pollInspectedPage(): Promise<void> {
  const result = await evalInPage<WatcherSnapshot | null>(
    "window.__eventSourceJsonViewer?.getSnapshot?.() || null",
  );

  if (result?.error) {
    setStatus(result.error);
    return;
  }

  if (!result?.value) {
    setStatus("Reload after opening this panel");
    return;
  }

  applySnapshot(result.value);
}

function evalInPage<T = unknown>(expression: string): Promise<EvalResult<T>> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      expression,
      { useContentScriptContext: false },
      (value, exceptionInfo) => {
        if (exceptionInfo?.isException) {
          resolve({ error: exceptionInfo.description || "Page evaluation failed" });
          return;
        }

        resolve({ value: value as T });
      },
    );
  });
}

function applySnapshot(snapshot: WatcherSnapshot): void {
  state.paused = Boolean(snapshot.paused);
  state.events = snapshot.events.map(normalizeEvent);
  updatePauseButton();
  render();
  setStatus(`${state.events.length} event${state.events.length === 1 ? "" : "s"}`);
}

async function setPaused(paused: boolean): Promise<void> {
  state.paused = paused;
  updatePauseButton();

  if (isDevTools) {
    await evalInPage(`window.__eventSourceJsonViewer?.${paused ? "pause" : "resume"}?.()`);
  }

  setStatus(paused ? "Paused" : "Watching");
}

async function clearEvents() {
  state.events = [];
  state.selectedRowId = null;
  state.renderedDetailKey = null;

  if (isDevTools) {
    await evalInPage("window.__eventSourceJsonViewer?.clear?.()");
  }

  render();
  setStatus("Cleared");
}

function render() {
  renderRows();
  renderDetail();
}

function renderRows() {
  const filter = elements.filterInput.value.trim().toLowerCase();
  const rows = state.events.filter((event) => {
    if (!filter) {
      return true;
    }

    return [event.id, event.source, event.eventName, event.url, event.data]
      .join(" ")
      .toLowerCase()
      .includes(filter);
  });

  elements.eventRows.replaceChildren(...rows.map(createRow));

  if (!rows.some((event) => event.rowId === state.selectedRowId)) {
    state.selectedRowId = rows.at(-1)?.rowId || null;
  }
}

function createRow(event: NormalizedEvent): HTMLButtonElement {
  const row = document.createElement("button");
  row.className = `event-row ${event.pretty.ok ? "" : "invalid-json"} ${event.rowId === state.selectedRowId ? "active" : ""}`;
  row.type = "button";
  row.dataset.rowId = event.rowId;
  row.innerHTML = `
    <span class="event-cell id"></span>
    <span class="event-cell data"></span>
    <span class="event-cell time"></span>
  `;

  getRowCell(row, ".id").textContent = event.id || " ";
  getRowCell(row, ".data").textContent = previewData(event.data);
  getRowCell(row, ".time").textContent = formatTime(event.time);
  row.addEventListener("click", () => {
    state.selectedRowId = event.rowId;
    render();
  });

  return row;
}

function getRowCell(row: Element, selector: string): HTMLElement {
  const cell = row.querySelector<HTMLElement>(selector);

  if (!cell) {
    throw new Error(`Missing row cell: ${selector}`);
  }

  return cell;
}

function renderDetail() {
  const event = getSelectedEvent();

  elements.prettyTab.classList.toggle("active", state.activeTab === "pretty");
  elements.rawTab.classList.toggle("active", state.activeTab === "raw");
  elements.copyButton.disabled = !event;
  elements.expandAllButton.disabled = !event?.pretty.ok || state.activeTab !== "pretty";
  elements.collapseAllButton.disabled = !event?.pretty.ok || state.activeTab !== "pretty";

  if (!event) {
    state.renderedDetailKey = null;
    elements.detailTitle.textContent = "No event selected";
    elements.detailUrlHost.textContent = "";
    elements.detailUrlPath.textContent = "";
    setTextOutput("");
    elements.detailOutput.classList.remove("invalid");
    return;
  }

  const urlParts = splitUrl(event.url);

  elements.detailTitle.textContent = formatTime(event.time) || "Unknown time";
  elements.detailUrlHost.textContent = urlParts.host;
  elements.detailUrlPath.textContent = urlParts.path;
  elements.detailUrlHost.title = event.url || "";
  elements.detailUrlPath.title = event.url || "";
  elements.detailOutput.classList.toggle("invalid", !event.pretty.ok);

  const detailKey = `${event.rowId}:${state.activeTab}:${event.data}`;

  if (state.renderedDetailKey === detailKey) {
    return;
  }

  state.renderedDetailKey = detailKey;

  if (state.activeTab === "pretty" && event.pretty.ok) {
    setJsonTreeOutput(event.pretty.value);
  } else {
    setTextOutput(state.activeTab === "raw" ? event.pretty.raw : event.pretty.pretty);
  }
}

function getSelectedEvent() {
  return state.events.find((event) => event.rowId === state.selectedRowId) || null;
}

function setTextOutput(text: string): void {
  elements.detailOutput.classList.add("raw-output");
  elements.detailOutput.replaceChildren();
  elements.detailOutput.textContent = text;
}

function setJsonTreeOutput(value: JsonValue): void {
  elements.detailOutput.classList.remove("raw-output");
  elements.detailOutput.replaceChildren(createJsonTree(value));
}

function createJsonTree(value: JsonValue): HTMLElement {
  const tree = document.createElement("div");
  tree.className = "json-tree";
  tree.append(createJsonValue(value, "", true));
  return tree;
}

function createJsonValue(value: JsonValue, key: string, isLast: boolean): HTMLElement {
  if (Array.isArray(value) || isPlainObject(value)) {
    return createJsonNode(value, key, isLast);
  }

  const line = document.createElement("div");
  line.className = "json-line";
  appendKey(line, key);
  appendPrimitive(line, value);
  appendComma(line, isLast);
  return line;
}

function createJsonNode(
  value: JsonValue[] | { [key: string]: JsonValue },
  key: string,
  isLast: boolean,
): HTMLDetailsElement {
  const isArray = Array.isArray(value);
  const entries: Array<[string | number, JsonValue]> = isArray
    ? value.map((item, index) => [index, item])
    : Object.entries(value);
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const children = document.createElement("div");
  const close = document.createElement("div");

  details.className = "json-node";
  details.open = true;
  children.className = "json-children";
  close.className = "json-close";

  appendKey(summary, key);
  appendToken(summary, isArray ? "[" : "{", "json-punctuation");
  appendToken(summary, nodeCountLabel(value), "json-node-count");
  appendToken(summary, isArray ? "]" : "}", "json-collapsed-close");

  entries.forEach(([childKey, childValue], index) => {
    children.append(
      createJsonValue(childValue, isArray ? "" : String(childKey), index === entries.length - 1),
    );
  });

  appendToken(close, isArray ? "]" : "}", "json-punctuation");
  appendComma(close, isLast);

  details.append(summary, children, close);
  return details;
}

function appendKey(parent: HTMLElement, key: string): void {
  if (key === "") {
    return;
  }

  appendToken(parent, JSON.stringify(String(key)), "json-key");
  appendToken(parent, ": ", "json-punctuation");
}

function appendPrimitive(parent: HTMLElement, value: JsonValue): void {
  if (typeof value === "string") {
    appendToken(parent, JSON.stringify(value), "json-string");
  } else if (typeof value === "number") {
    appendToken(parent, String(value), "json-number");
  } else if (typeof value === "boolean") {
    appendToken(parent, String(value), "json-boolean");
  } else if (value === null) {
    appendToken(parent, "null", "json-null");
  } else {
    appendToken(parent, JSON.stringify(value), "json-string");
  }
}

function appendComma(parent: HTMLElement, isLast: boolean): void {
  if (!isLast) {
    appendToken(parent, ",", "json-punctuation");
  }
}

function appendToken(parent: HTMLElement, text: string, className: string): void {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  parent.append(span);
}

function nodeCountLabel(value: JsonValue[] | { [key: string]: JsonValue }): string {
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  const noun = Array.isArray(value) ? "item" : "key";
  return ` ${count} ${noun}${count === 1 ? "" : "s"} `;
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setJsonNodesOpen(open: boolean): void {
  elements.detailOutput
    .querySelectorAll<HTMLDetailsElement>("details.json-node")
    .forEach((node) => {
      node.open = open;
    });
}

function startResize(event: PointerEvent): void {
  if (window.matchMedia("(max-width: 880px)").matches) {
    return;
  }

  event.preventDefault();
  elements.splitter.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  updateSplit(event.clientX);

  const move = (moveEvent: PointerEvent) => updateSplit(moveEvent.clientX);
  const stop = () => {
    elements.splitter.removeEventListener("pointermove", move);
    elements.splitter.removeEventListener("pointerup", stop);
    elements.splitter.removeEventListener("pointercancel", stop);
    document.body.classList.remove("resizing");
  };

  elements.splitter.addEventListener("pointermove", move);
  elements.splitter.addEventListener("pointerup", stop);
  elements.splitter.addEventListener("pointercancel", stop);
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const current =
    Number.parseFloat(
      getComputedStyle(elements.workspace).getPropertyValue("--left-panel-width"),
    ) || 58;
  const next = current + (event.key === "ArrowLeft" ? -3 : 3);
  elements.workspace.style.setProperty(
    "--left-panel-width",
    `${Math.min(78, Math.max(28, next))}%`,
  );
}

function updateSplit(clientX: number): void {
  const bounds = elements.workspace.getBoundingClientRect();
  const leftWidth = clientX - bounds.left;
  const percent = Math.min(78, Math.max(28, (leftWidth / bounds.width) * 100));
  elements.workspace.style.setProperty("--left-panel-width", `${percent}%`);
}

function updatePauseButton() {
  elements.pauseButton.textContent = state.paused ? "Resume" : "Pause";
}

function setStatus(message: string): void {
  elements.status.textContent = message;
}

function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
