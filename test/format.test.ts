import { describe, expect, test } from "vitest";
import { formatPayload, normalizeEvent, previewData, splitUrl } from "../src/panel/format.js";

describe("formatPayload", () => {
  test("pretty prints JSON", () => {
    const result = formatPayload('{"type":"start","nested":{"ok":true}}');

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ type: "start", nested: { ok: true } });
    expect(result.pretty).toMatch(/\n  "type": "start"/);
    expect(result.pretty).toMatch(/\n  "nested": \{/);
    expect(result.summary).toBe("2 keys");
  });

  test("keeps invalid JSON readable", () => {
    const result = formatPayload("not-json");

    expect(result.ok).toBe(false);
    expect(result.pretty).toBe("not-json");
    expect(result.summary).toBe("Plain text");
  });
});

describe("normalizeEvent", () => {
  test("creates the row shape used by the panel", () => {
    const event = normalizeEvent(
      {
        eventName: "message",
        source: "Demo",
        data: '{"ok":true}',
        time: "2026-06-09T01:00:00.000Z",
      },
      0,
    );

    expect(event.eventName).toBe("message");
    expect(event.source).toBe("Demo");
    expect(event.pretty.ok).toBe(true);
  });
});

test("previewData trims long one-line output", () => {
  expect(previewData("a".repeat(10), 5)).toBe("aa...");
});

test("splitUrl separates host and path", () => {
  const url =
    "https://chore-shared-chat-frontend-step-4.dev.chalkie.ai/api/documents/a1f3675f-9738-4d32-aa17-eaab4e5c1f76/conversation/messages";
  const result = splitUrl(url);

  expect(result.host).toBe("chore-shared-chat-frontend-step-4.dev.chalkie.ai");
  expect(result.path).toBe(
    "/api/documents/a1f3675f-9738-4d32-aa17-eaab4e5c1f76/conversation/messages",
  );
});
