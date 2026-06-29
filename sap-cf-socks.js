'use strict'

const EventEmitter = require('events')
const xsenv = require('@sap/xsenv')
const https = require('https')
const { SocksClient } = require('socks')
const net = require('net')

const log = console.log // eslint-disable-line no-console

const SOCKS_AUTH_MESSAGES = [
  'SUCCESS: SOCKS5 authentication complete.',
  'FAILURE: Connection closed by backend or general scenario failure.',
  'FORBIDDEN: No matching host mapping found in Cloud Connector access control settings.',
  'NETWORK_UNREACHABLE: The Cloud Connector is not connected to the subaccount and the Cloud Connector Location ID used by the cloud application cannot be identified.',
  'HOST_UNREACHABLE: Cannot open connection to the backend, that is, the host is unreachable.',
  'CONNECTION_REFUSED: Authentication failure.',
  'TTL_EXPIRED: Not used.',
  'COMMAND_UNSUPPORTED: Only the SOCKS5 CONNECT command is supported.',
  'ADDRESS_UNSUPPORTED: Only the SOCKS5 DOMAIN and IPv4 address types are supported.',
]

class ConnectivitySocks extends EventEmitter {
  #jwtCache
  #socket
  #connectivityCredentials
  #envConfig
  #socketStatus
  #socketName
  #keepAliveMs
  #timeoutMs
  #tokenRefreshInFlight

  /**
   * @param {{ host: string, port: number|string }} envConfig  On-premise target host and port
   * @param {string} name  Identifier used in log output
   * @param {{ keepAliveMs?: number, timeoutMs?: number, credentials?: object }} [options]
   */
  constructor(envConfig, name, options = {}) {
    super()

    if (!envConfig?.host) throw new Error('envConfig.host is required')
    if (!envConfig?.port) throw new Error('envConfig.port is required')
    if (!name) throw new Error('name is required')

    this.#envConfig = envConfig
    this.#socketName = name
    this.#keepAliveMs = options.keepAliveMs ?? 30000
    this.#timeoutMs = options.timeoutMs ?? 300000
    this.#jwtCache = { expiration: 0, jwt: null }
    this.#tokenRefreshInFlight = null
    this.#socket = null
    this.#socketStatus = 'disconnected'

    if (options.credentials) {
      this.#connectivityCredentials = options.credentials
    } else {
      xsenv.loadEnv()
      this.#connectivityCredentials = xsenv.cfServiceCredentials('connectivity')
      if (!this.#connectivityCredentials) {
        throw new Error(
          'No connectivity credentials found. On SAP BTP: check service binding. ' +
          'For local testing: pass credentials via options.credentials.'
        )
      }
    }
  }

  async #fetchToken() {
    return new Promise((resolve, reject) => {
      log(`[${this.#socketName}] Renewing connectivity access token`)
      const url = `${this.#connectivityCredentials.token_service_url}/oauth/token?grant_type=client_credentials`
      const auth = Buffer.from(
        `${this.#connectivityCredentials.clientid}:${this.#connectivityCredentials.clientsecret}`
      ).toString('base64')

      https.get(url, { headers: { Authorization: `Basic ${auth}` } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Token endpoint returned HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString())
            if (!body.access_token) {
              reject(new Error(`Token response missing access_token: ${JSON.stringify(body)}`))
              return
            }
            this.#jwtCache.expiration = Date.now() + (body.expires_in - 60) * 1000
            this.#jwtCache.jwt = body.access_token
            resolve(body.access_token)
          } catch (err) {
            reject(new Error(`Failed to parse token response: ${err.message}`))
          }
        })
      }).on('error', (err) => {
        reject(new Error(`Token request failed: ${err.message}`))
      })
    })
  }

  async #getToken() {
    if (Date.now() < this.#jwtCache.expiration) return this.#jwtCache.jwt
    // Guard concurrent refreshes — share the in-flight promise
    if (!this.#tokenRefreshInFlight) {
      this.#tokenRefreshInFlight = this.#fetchToken().finally(() => {
        this.#tokenRefreshInFlight = null
      })
    }
    return this.#tokenRefreshInFlight
  }

  #buildSocksOptions(jwt) {
    const locationId = process.env.BTP_CONNECTIVITY_LOCATION_ID ?? ''
    const locationBase64 = locationId ? Buffer.from(locationId).toString('base64') : ''

    const jwtBytes = Buffer.from(jwt)
    const jwtLenBuf = Buffer.alloc(4)
    jwtLenBuf.writeInt32BE(jwtBytes.byteLength)

    const locationBytes = Buffer.from(locationBase64)
    const locationLenBuf = Buffer.alloc(1)
    locationLenBuf.writeUInt8(locationBytes.byteLength)

    return {
      proxy: {
        host: this.#connectivityCredentials.onpremise_proxy_host,
        port: parseInt(this.#connectivityCredentials.onpremise_socks5_proxy_port, 10),
        type: 5,
        custom_auth_method: 0x80,
        custom_auth_request_handler: async () => Buffer.concat([
          Buffer.from([0x01]),         // auth method version
          jwtLenBuf,                   // JWT length (4-byte big-endian)
          jwtBytes,                    // JWT
          locationLenBuf,              // Location ID length (1 byte, 0 if unused)
          locationBytes,               // Location ID (base64, empty if unused)
        ]),
        custom_auth_response_size: 2,
        custom_auth_response_handler: async (data) => {
          const statusByte = data[1]
          const message = statusByte < SOCKS_AUTH_MESSAGES.length
            ? SOCKS_AUTH_MESSAGES[statusByte]
            : 'ERROR: Unknown SOCKS5 auth response.'
          log(`[${this.#socketName}] ${message}`)
          return statusByte === 0x00
        },
      },
      command: 'connect',
      destination: {
        host: this.#envConfig.host,
        port: parseInt(this.#envConfig.port, 10),
      },
    }
  }

  #attachSocketListeners(reject) {
    this.#socket.on('close', () => {
      this.#socketStatus = 'close'
      log(`[${this.#socketName}] Connection closed`)
      this.emit('close')
    })
    this.#socket.on('error', (err) => {
      this.#socketStatus = 'error'
      log(`[${this.#socketName}] Socket error: ${err.message}`)
      this.emit('error', err)
      reject(err)
    })
    this.#socket.on('end', () => {
      this.#socketStatus = 'end'
      log(`[${this.#socketName}] Socket ended by remote`)
      this.emit('end')
    })
    this.#socket.on('timeout', () => {
      this.#socketStatus = 'timeout'
      log(`[${this.#socketName}] Socket timeout due to inactivity`)
      this.emit('timeout')
    })
  }

  /**
   * Opens the SOCKS5 tunnel through SAP Cloud Connector.
   * The returned socket is ready for use with a database driver.
   * @returns {Promise<net.Socket>}
   */
  async connectSocksSocket() {
    if (this.#socket) this.#socket.destroy()
    this.#socket = new net.Socket()
    this.#socketStatus = 'connecting'

    return new Promise((resolve, reject) => {
      this.#attachSocketListeners(reject)

      this.#socket.setKeepAlive(true, this.#keepAliveMs)
      this.#socket.setTimeout(this.#timeoutMs)

      this.#socket.connect(
        parseInt(this.#connectivityCredentials.onpremise_socks5_proxy_port, 10),
        this.#connectivityCredentials.onpremise_proxy_host,
        async () => {
          try {
            const jwt = await this.#getToken()
            const options = this.#buildSocksOptions(jwt)
            const socksClient = new SocksClient(options)

            // 'established' fires after the full SOCKS5 + Cloud Connector auth exchange
            // completes — this is the point at which the on-premise tunnel is open
            socksClient.on('established', ({ socket }) => {
              this.#socketStatus = 'ready'
              log(`[${this.#socketName}] SOCKS5 tunnel established`)
              this.emit('ready', socket)
              resolve(socket)
            })

            socksClient.on('error', (err) => {
              this.#socketStatus = 'error'
              log(`[${this.#socketName}] SOCKS5 handshake error: ${err.message}`)
              this.emit('error', err)
              reject(err)
            })

            socksClient.connect(this.#socket)
          } catch (err) {
            this.#socketStatus = 'error'
            reject(err)
          }
        }
      )
    })
  }

  /**
   * Destroys the current socket and opens a new SOCKS5 tunnel.
   * @returns {Promise<net.Socket>}
   */
  async reconnect() {
    log(`[${this.#socketName}] Reconnecting...`)
    return this.connectSocksSocket()
  }

  /** @returns {net.Socket|null} */
  getSocket() {
    return this.#socket
  }

  /** @returns {'disconnected'|'connecting'|'ready'|'end'|'close'|'timeout'|'error'} */
  getStatus() {
    return this.#socketStatus
  }

  endSocket() {
    log(`[${this.#socketName}] Socket destroyed`)
    if (this.#socket) {
      this.#socket.destroy()
      this.#socket = null
    }
    this.#socketStatus = 'disconnected'
  }
}

module.exports.ConnectivitySocks = ConnectivitySocks
