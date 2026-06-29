# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js library that creates SOCKS5 proxy sockets through the SAP BTP Cloud Connector, enabling CAP applications running on Cloud Foundry to reach on-premise databases and services. The core export is `ConnectivitySocks` in `sap-cf-socks.js`.

## Development Commands

```bash
cds watch      # CAP development server with file watching
npx eslint .   # Lint
```

No test runner is configured.

## Architecture

**`sap-cf-socks.js`** is the entire implementation. `app/`, `db/`, and `srv/` are empty CAP scaffolding placeholders.

### `ConnectivitySocks extends EventEmitter`

**Constructor** — `(envConfig, name, options?)`:
- `envConfig.host/port` — on-premise target (as registered in Cloud Connector access control)
- `name` — used as a log prefix
- `options.credentials` — inject credentials directly (skips `xsenv`; useful for testing)
- `options.keepAliveMs` / `options.timeoutMs` — defaults 30 000 / 300 000
- Falls back to `xsenv.cfServiceCredentials('connectivity')` if no credentials injected; throws if not found

**Token management** — `#fetchToken()` / `#getToken()`:
- Client-credentials OAuth call to `token_service_url`; cached with 60-second early-expiry buffer
- Concurrent callers share one in-flight HTTP request (guarded by `#tokenRefreshInFlight`)

**`#buildSocksOptions(jwt)`** — assembles the `socks` library options for the SAP Cloud Connector custom auth method (`0x80`). The auth payload is:
```
[0x01]           1 byte  — auth version
[JWT length]     4 bytes — big-endian int32
[JWT]            N bytes
[Location len]   1 byte  — 0 if BTP_CONNECTIVITY_LOCATION_ID not set
[Location ID]    M bytes — base64-encoded
```
The Cloud Connector establishes the TCP tunnel to the on-premise host *during* this auth exchange, not after a separate CONNECT command. Do not change this flow.

**`connectSocksSocket()`**:
- Destroys any existing socket, creates a fresh `net.Socket`, attaches lifecycle listeners, then calls `socket.connect()` to the SOCKS5 proxy
- Inside the TCP connect callback: fetches token, builds options, hands the socket to `SocksClient`
- Resolves on `SocksClient 'established'` event — this is the correct point because the on-premise tunnel is open only after the custom auth completes
- Emits `ready`, `close`, `end`, `timeout`, `error` for the caller to react to (e.g. call `reconnect()`)

**`reconnect()`** — destroys the current socket and calls `connectSocksSocket()`.

**`getStatus()`** returns one of: `disconnected` · `connecting` · `ready` · `end` · `close` · `timeout` · `error`.

### Environment

`connectivity` service binding must provide: `onpremise_proxy_host`, `onpremise_socks5_proxy_port`, `token_service_url`, `clientid`, `clientsecret`.

Optional env var: `BTP_CONNECTIVITY_LOCATION_ID` — Cloud Connector location ID for multi-connector setups.

## ESLint

`.eslintrc` declares CAP CQL globals (`SELECT`, `INSERT`, `UPSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `CDL`, `CQL`, `CXL`, `cds`) and sets `no-console: off`.
