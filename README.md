# sap-cf-socks

SOCKS5 proxy client for SAP BTP Cloud Foundry that enables CAP applications to reach on-premise resources (databases, APIs) through SAP Cloud Connector.

SAP's BTP Connectivity service exposes a SOCKS5 proxy with a proprietary authentication method (`0x80`) — a JWT from the connectivity service combined with an optional Cloud Connector Location ID, exchanged during the SOCKS5 auth phase. The on-premise tunnel to the target host is established as part of that auth exchange. This library handles the full handshake and returns a ready `net.Socket` that database drivers (`pg`, `tedious`) can use directly.

## Prerequisites

- SAP BTP Cloud Foundry environment
- A `connectivity` service instance bound to your application
- SAP Cloud Connector configured with an access control entry for your on-premise host

## Installation

```bash
npm install sap-cf-socks
```

## Usage

```js
const { ConnectivitySocks } = require('sap-cf-socks')

const socks = new ConnectivitySocks(
  { host: 'my-onprem-db.internal', port: 5432 },
  'pg-primary'
)

// Resolves once the SOCKS5 tunnel through Cloud Connector is fully open
const socket = await socks.connectSocksSocket()

// Pass the socket to your database driver, e.g. node-postgres:
const { Client } = require('pg')
const client = new Client({
  host: 'my-onprem-db.internal',
  port: 5432,
  database: 'mydb',
  user: 'myuser',
  password: 'mypassword',
  stream: socket,
})
await client.connect()
```

### Reconnecting on disconnect

`ConnectivitySocks` extends `EventEmitter` and emits lifecycle events. Use them to reconnect when the Cloud Connector drops the tunnel:

```js
socks.on('close', async () => {
  const socket = await socks.reconnect()
  client.stream = socket
})

socks.on('timeout', async () => {
  const socket = await socks.reconnect()
  client.stream = socket
})

socks.on('error', (err) => {
  console.error('Tunnel error:', err.message)
})
```

### Injecting credentials (local development / testing)

By default, credentials are read from the BTP `connectivity` service binding via `@sap/xsenv`. You can inject them directly for local testing or alternative environments:

```js
const socks = new ConnectivitySocks(
  { host: 'my-onprem-db.internal', port: 5432 },
  'pg-primary',
  {
    credentials: {
      onpremise_proxy_host: '...',
      onpremise_socks5_proxy_port: '...',
      token_service_url: '...',
      clientid: '...',
      clientsecret: '...',
    }
  }
)
```

## API

### `new ConnectivitySocks(envConfig, name, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `envConfig.host` | `string` | On-premise target hostname (as registered in Cloud Connector access control) |
| `envConfig.port` | `number\|string` | On-premise target port |
| `name` | `string` | Identifier used in log output |
| `options.keepAliveMs` | `number` | TCP keepalive interval in ms (default: `30000`) |
| `options.timeoutMs` | `number` | Inactivity timeout in ms (default: `300000`) |
| `options.credentials` | `object` | Connectivity service credentials — skips `xsenv` lookup when provided |

Throws if credentials are not found and `options.credentials` is not set.

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connectSocksSocket()` | `Promise<net.Socket>` | Opens the SOCKS5 tunnel. Resolves after the Cloud Connector auth handshake completes. Safe to call again after a disconnect. |
| `reconnect()` | `Promise<net.Socket>` | Destroys the current socket and calls `connectSocksSocket()`. |
| `getSocket()` | `net.Socket\|null` | Returns the active socket, or `null` before first connect or after `endSocket()`. |
| `getStatus()` | `string` | Current state: `disconnected` · `connecting` · `ready` · `end` · `close` · `timeout` · `error` |
| `endSocket()` | `void` | Destroys the socket and resets status to `disconnected`. |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `ready` | `socket` | SOCKS5 tunnel fully established |
| `close` | — | Socket connection closed |
| `end` | — | Remote end closed the connection |
| `timeout` | — | Socket timed out due to inactivity |
| `error` | `Error` | Socket or handshake error |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BTP_CONNECTIVITY_LOCATION_ID` | No | Cloud Connector Location ID for multi-Cloud Connector setups |

## How It Works

The SAP BTP Connectivity service exposes a SOCKS5 proxy with a custom authentication method (`0x80`). The auth request payload is:

```
[0x01]                    1 byte  — auth method version
[JWT length]              4 bytes — big-endian int32
[JWT]                     N bytes — OAuth client-credentials token
[Location ID length]      1 byte  — 0 if not used
[Location ID]             M bytes — Cloud Connector location ID, base64-encoded
```

The Cloud Connector establishes the on-premise TCP tunnel to the destination host during this auth exchange. A `0x00` in byte 1 of the 2-byte response indicates success; other values are logged with a description.

The OAuth token is fetched with client credentials and cached until 60 seconds before expiry. Concurrent refresh requests share a single in-flight HTTP call.

## BTP Service Binding

The `connectivity` service binding must provide:

```json
{
  "onpremise_proxy_host": "...",
  "onpremise_socks5_proxy_port": "...",
  "token_service_url": "...",
  "clientid": "...",
  "clientsecret": "..."
}
```

This is automatically available when you bind a `connectivity` service instance to your Cloud Foundry application.

## License

MIT
