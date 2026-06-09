# EventSource JSON Viewer

A small Chrome DevTools panel for inspecting Server-Sent Events with clickable rows and a pretty JSON detail pane.

## Use it in Chrome

1. Run `vp install`.
2. Run `vp build`.
3. Open `chrome://extensions`.
4. Turn on Developer mode.
5. Click Load unpacked.
6. Choose this folder: `/Users/yemyat/src/tries/2026-06-09-chrome-event-source/dist`.
7. Open DevTools on a page that uses Server-Sent Events.
8. Open the `EventSource JSON` panel.
9. Click `Inject`, then reload the page if the stream already started.

The panel watches `EventSource`, `fetch` responses with `text/event-stream`, and basic streaming `XMLHttpRequest` responses. Data stays in the inspected page and the DevTools panel.

## Development

```sh
vp check
vp test
vp build
```

Use `vp` for normal project commands. Vite+ still uses pnpm underneath because `package.json` declares `packageManager`, and `pnpm-lock.yaml` keeps installs repeatable.
