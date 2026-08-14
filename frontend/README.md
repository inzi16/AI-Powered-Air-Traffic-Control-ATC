# Smart ATC frontend

React 19 and TypeScript interface for the Smart Air Traffic Control LLM-assisted aviation training and operations console. Project architecture, capabilities, verification evidence, and release guidance are documented in the [repository README](../README.md).

## Development

Use Node.js 22+ and start the FastAPI backend on `http://127.0.0.1:8000`. The Vite development server proxies `/api` and WebSocket traffic to that backend.

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`.

## Quality checks

```powershell
npm run lint
npm run build
npm run preview
```

`npm run build` performs the TypeScript project build before producing the Vite bundle. The service worker and install/update behavior are enabled in production builds.

## Endpoint configuration

- `VITE_API_BASE` overrides the default same-origin `/api` REST prefix.
- `VITE_WS_URL` optionally supplies an explicit WebSocket endpoint.

Operational mutations are network-only: the PWA may retain its static interface while offline, but it does not queue commands for later execution.
