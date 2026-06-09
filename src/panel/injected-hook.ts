type CapturedStreamEvent = {
  rowId?: number;
  time?: string;
  source: string;
  url: string;
  id: string;
  eventName: string;
  data: string;
};

type StreamParser = {
  buffer: string;
  source: string;
  url: string;
};

type ParsedStreamEvent = {
  id: string;
  eventName: string;
  data: string;
};

type ViewerSnapshot = {
  version: string;
  active: boolean;
  paused: boolean;
  installedAt: string;
  events: CapturedStreamEvent[];
};

type ViewerState = ViewerSnapshot & {
  nextId: number;
  clear: () => void;
  pause: () => void;
  resume: () => void;
  getSnapshot: () => ViewerSnapshot;
};

type ViewerWindow = Window & Record<string, ViewerState | undefined>;

type WatchedXhr = XMLHttpRequest & {
  __eventSourceJsonViewerUrl?: string;
  __eventSourceJsonViewerOffset?: number;
  __eventSourceJsonViewerParser?: StreamParser;
};

type PatchableEventSourcePrototype = {
  addEventListener: (
    this: EventSource,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    this: EventSource,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => void;
};

type XhrPrototype = XMLHttpRequest & {
  open: (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void;
  send: (this: XMLHttpRequest, ...args: unknown[]) => void;
};

(() => {
  const key = "__eventSourceJsonViewer";
  const viewerWindow = window as unknown as ViewerWindow;

  if (viewerWindow[key]?.version === "0.1.0") {
    viewerWindow[key].active = true;
    return;
  }

  const previous = viewerWindow[key];
  const state: ViewerState = {
    version: "0.1.0",
    active: true,
    paused: Boolean(previous?.paused),
    installedAt: new Date().toISOString(),
    events: Array.isArray(previous?.events) ? previous.events : [],
    nextId: Number(previous?.nextId || 1),
    clear() {
      state.events = [];
      state.nextId = 1;
    },
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
    },
    getSnapshot() {
      return {
        version: state.version,
        active: state.active,
        paused: state.paused,
        installedAt: state.installedAt,
        events: state.events.slice(),
      };
    },
  };

  const originalEventSource = window.EventSource;
  const originalFetch = window.fetch?.bind(window);
  const xhrPrototype = window.XMLHttpRequest?.prototype as XhrPrototype | undefined;
  const originalXhrOpen = xhrPrototype?.open;
  const originalXhrSend = xhrPrototype?.send;

  function addEvent(event: Omit<CapturedStreamEvent, "rowId" | "time">): void {
    if (state.paused) {
      return;
    }

    state.events.push({
      rowId: state.nextId++,
      time: new Date().toISOString(),
      ...event,
    });

    if (state.events.length > 2000) {
      state.events.splice(0, state.events.length - 2000);
    }
  }

  function parseEventStreamChunk(parser: StreamParser, chunk: string): void {
    parser.buffer += chunk.replace(/\r\n/g, "\n");
    const blocks = parser.buffer.split("\n\n");
    parser.buffer = blocks.pop() || "";

    for (const block of blocks) {
      const event = parseEventBlock(block);

      if (event) {
        addEvent({
          source: parser.source,
          url: parser.url,
          id: event.id,
          eventName: event.eventName,
          data: event.data,
        });
      }
    }
  }

  function parseEventBlock(block: string): ParsedStreamEvent | null {
    const lines = block.split("\n");
    const data: string[] = [];
    let id = "";
    let eventName = "message";

    for (const line of lines) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

      if (field === "data") {
        data.push(value);
      } else if (field === "id") {
        id = value;
      } else if (field === "event") {
        eventName = value || "message";
      }
    }

    if (!data.length && !id) {
      return null;
    }

    return {
      id,
      eventName,
      data: data.join("\n"),
    };
  }

  function getFetchUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }

    if (input instanceof URL) {
      return input.href;
    }

    return input.url || "";
  }

  function readStream(response: Response, url: string): void {
    const contentType = response.headers?.get?.("content-type") || "";

    if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
      return;
    }

    const parser: StreamParser = {
      buffer: "",
      source: "fetch",
      url,
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    function pump(): void {
      reader
        .read()
        .then((result) => {
          if (result.done) {
            parseEventStreamChunk(parser, decoder.decode());
            return;
          }

          parseEventStreamChunk(parser, decoder.decode(result.value, { stream: true }));
          pump();
        })
        .catch(() => {});
    }

    pump();
  }

  if (typeof originalEventSource === "function") {
    const eventSourcePrototype =
      originalEventSource.prototype as unknown as PatchableEventSourcePrototype;
    const originalAddEventListener = eventSourcePrototype.addEventListener;
    const originalRemoveEventListener = eventSourcePrototype.removeEventListener;
    const listenerMap = new WeakMap<EventListener, Map<string, EventListener>>();

    function WatchedEventSource(url: string | URL, config?: EventSourceInit): EventSource {
      const source = new originalEventSource(url, config);
      const sourceUrl = String(url);

      source.addEventListener("message", (event) => {
        addEvent({
          source: "EventSource",
          url: sourceUrl,
          id: event.lastEventId || "",
          eventName: "message",
          data: event.data,
        });
      });

      return source;
    }

    const watchedEventSource = WatchedEventSource as unknown as typeof EventSource;
    watchedEventSource.prototype = originalEventSource.prototype;
    Object.setPrototypeOf(watchedEventSource, originalEventSource);

    eventSourcePrototype.addEventListener = function addEventListener(
      this: EventSource,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (typeof listener !== "function" || type === "message") {
        return originalAddEventListener.call(this, type, listener, options);
      }

      let byType = listenerMap.get(listener);

      if (!byType) {
        byType = new Map();
        listenerMap.set(listener, byType);
      }

      if (byType.has(type)) {
        return originalAddEventListener.call(this, type, byType.get(type) || listener, options);
      }

      const wrapped: EventListener = function watchedEventSourceListener(
        this: EventSource,
        event: Event,
      ): void {
        const messageEvent = event as MessageEvent<string>;

        if (typeof messageEvent.data !== "undefined") {
          addEvent({
            source: "EventSource",
            url: this.url || "",
            id: messageEvent.lastEventId || "",
            eventName: type || "message",
            data: String(messageEvent.data),
          });
        }

        listener.call(this, event);
      };

      byType.set(type, wrapped);

      return originalAddEventListener.call(this, type, wrapped, options);
    };

    eventSourcePrototype.removeEventListener = function removeEventListener(
      this: EventSource,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (typeof listener !== "function") {
        return originalRemoveEventListener.call(this, type, listener, options);
      }

      const wrapped = listenerMap.get(listener)?.get(type);
      return originalRemoveEventListener.call(this, type, wrapped || listener, options);
    };

    window.EventSource = watchedEventSource;
  }

  if (typeof originalFetch === "function") {
    window.fetch = function watchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = getFetchUrl(input);

      return originalFetch(input, init).then((response) => {
        try {
          readStream(response.clone(), url);
        } catch {}

        return response;
      });
    };
  }

  if (xhrPrototype && originalXhrOpen && originalXhrSend) {
    xhrPrototype.open = function watchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      const xhr = this as WatchedXhr;
      xhr.__eventSourceJsonViewerUrl = String(url || "");
      xhr.__eventSourceJsonViewerOffset = 0;
      xhr.__eventSourceJsonViewerParser = {
        buffer: "",
        source: "XMLHttpRequest",
        url: xhr.__eventSourceJsonViewerUrl,
      };

      return originalXhrOpen.call(this, method, url, ...rest);
    };

    xhrPrototype.send = function watchedSend(this: XMLHttpRequest, ...args: unknown[]): void {
      const xhr = this as WatchedXhr;

      xhr.addEventListener("progress", () => {
        const contentType = xhr.getResponseHeader?.("content-type") || "";

        if (!contentType.toLowerCase().includes("text/event-stream")) {
          return;
        }

        const offset = xhr.__eventSourceJsonViewerOffset || 0;
        const nextText = xhr.responseText.slice(offset);
        xhr.__eventSourceJsonViewerOffset = xhr.responseText.length;

        if (xhr.__eventSourceJsonViewerParser) {
          parseEventStreamChunk(xhr.__eventSourceJsonViewerParser, nextText);
        }
      });

      return originalXhrSend.call(this, ...args);
    };
  }

  viewerWindow[key] = state;
})();
