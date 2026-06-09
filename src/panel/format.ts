export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FormattedPayload =
  | {
      ok: true;
      type: "array" | "object" | "string" | "number" | "boolean";
      value: JsonValue;
      pretty: string;
      raw: string;
      summary: string;
    }
  | {
      ok: false;
      type: "text";
      value: null;
      pretty: string;
      raw: string;
      summary: "Plain text";
      error: string;
    };

export type RawCapturedEvent = {
  id?: string;
  eventId?: string;
  rowId?: string | number;
  eventName?: string;
  type?: string;
  source?: string;
  url?: string;
  data?: unknown;
  time?: string;
};

export type NormalizedEvent = {
  id: string;
  rowId: string;
  eventName: string;
  source: string;
  url: string;
  data: string;
  time: string;
  pretty: FormattedPayload;
};

export type SplitUrlResult = {
  host: string;
  path: string;
};

export function formatPayload(rawData: unknown): FormattedPayload {
  const text = String(rawData ?? "");

  try {
    const parsed = JSON.parse(text) as JsonValue;
    return {
      ok: true,
      type: getJsonType(parsed),
      value: parsed,
      pretty: JSON.stringify(parsed, null, 2),
      raw: text,
      summary: summarizeJson(parsed),
    };
  } catch (error) {
    return {
      ok: false,
      type: "text",
      value: null,
      pretty: text,
      raw: text,
      summary: "Plain text",
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

function getJsonType(value: JsonValue): "array" | "object" | "string" | "number" | "boolean" {
  if (Array.isArray(value)) {
    return "array";
  }

  if (typeof value === "string") {
    return "string";
  }

  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  return "object";
}

export function summarizeJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return `${keys.length} key${keys.length === 1 ? "" : "s"}`;
  }

  return typeof value;
}

export function previewData(rawData: unknown, maxLength = 180): string {
  const text = String(rawData ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

export function splitUrl(rawUrl: unknown): SplitUrlResult {
  const text = String(rawUrl ?? "").trim();

  if (!text) {
    return {
      host: "No URL captured",
      path: "",
    };
  }

  try {
    const url = new URL(text);

    return {
      host: url.host,
      path: `${url.pathname}${url.search}${url.hash}`,
    };
  } catch {
    if (text.startsWith("/")) {
      return {
        host: "Current page",
        path: text,
      };
    }

    return {
      host: "Endpoint",
      path: text,
    };
  }
}

export function normalizeEvent(event: RawCapturedEvent, index: number): NormalizedEvent {
  const data = String(event.data ?? "");
  const time = event.time || new Date().toISOString();

  return {
    id: event.id || event.eventId || "",
    rowId: String(event.rowId || `${time}-${index}`),
    eventName: event.eventName || event.type || "message",
    source: event.source || "EventSource",
    url: event.url || "",
    data,
    time,
    pretty: formatPayload(data),
  };
}
