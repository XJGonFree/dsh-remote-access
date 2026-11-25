/**
 * Host half of `dsh-remote-access`.
 *
 * The official DSH Web GUI authenticates with a per-process token in its own
 * URL and refuses any request whose `Host` is not a loopback authority (an
 * ordinary 403). That makes the GUI unreachable from a phone, another PC, or a
 * tunnel: you cannot copy the URL, and you cannot type a public hostname into
 * the fence.
 *
 * This plugin answers by putting a small reverse proxy in front of the GUI on
 * its own fixed port. Remote clients talk to *that* port and never to the GUI
 * port, so:
 *
 * - every proxied request is rewritten to a loopback `Host` and carries the
 *   browser-auth cookie redeemed from `connection.authenticatedUrl`, which is
 *   exactly what the GUI's own fence wants, so it never sees a foreign host and
 *   never answers 403;
 * - the plugin's own gate (a device cookie minted by a QR pairing link, or by
 *   typing the passphrase once) decides who may proxy at all;
 * - LAN clients and clients arriving through the user's own tunnel/reverse
 *   proxy reach the same listener, because it binds a fixed port on all
 *   interfaces.
 *
 * The listener is a whole-site proxy: it forwards every path and every
 * WebSocket upgrade, so the official client bundles, the RPC stream and static
 * assets all keep working without a path allowlist to maintain.
 */

import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

export const name = 'dsh-remote-access'

const NS = 'dsh-remote-access'
const API_BASE = `/api/${NS}`
const STATE_PATH = `${API_BASE}/state`
const UPDATE_PATH = `${API_BASE}/update`
const PAIR_PATH = `${API_BASE}/pair`
const REVOKE_PATH = `${API_BASE}/revoke`
const TRUST_HEADER = 'x-dsh-remote-access'

/** Prefix for gateway-owned routes on the plugin's own listener. */
const GATE_PREFIX = '/__dsr/'
const GATE_LOGIN = `${GATE_PREFIX}login`
const GATE_LOGOUT = `${GATE_PREFIX}logout`
const GATE_HEALTH = `${GATE_PREFIX}health`
const GATE_CSS = `${GATE_PREFIX}mobile.css`

const DEVICE_COOKIE = 'dsr-device'
const DEVICE_MAX_AGE_S = 365 * 24 * 60 * 60
const PAIR_TTL_MS = 5 * 60 * 1000
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_FAILURES = 8
const LAST_SEEN_WRITE_MS = 60 * 1000
const DEFAULT_PORT = 8788
const DEFAULT_BIND = '0.0.0.0'

/** Payload shape marker: bump when the panel contract changes. */
const CONTRACT = 1

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function header(request, name) {
  const value = request.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
  })
  response.end(text)
}

function sendHtml(response, statusCode, html, extraHeaders) {
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(html)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isLoopbackAddress(value) {
  const address = String(value ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (address === '') return false
  return address === 'localhost'
    || address === 'localhost.'
    || address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? '')
  if (raw === '') return ''
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

function portOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).port
  } catch {
    return ''
  }
}

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes <= limit) chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

function readFormBody(request, limit = 8 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes <= limit) chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(new URLSearchParams())
      }
    })
    request.on('error', () => resolve(new URLSearchParams()))
  })
}

function parseCookies(raw) {
  const out = Object.create(null)
  if (typeof raw !== 'string' || raw === '') return out
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    if (key === '') continue
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      out[key] = part.slice(index + 1).trim()
    }
  }
  return out
}

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function describeAgent(userAgent) {
  const agent = String(userAgent ?? '')
  const device = /iPhone/i.test(agent)
    ? 'iPhone'
    : /iPad/i.test(agent)
      ? 'iPad'
      : /Android/i.test(agent)
        ? 'Android'
        : /Macintosh|Mac OS X/i.test(agent)
          ? 'Mac'
          : /Windows/i.test(agent)
            ? 'Windows'
            : /Linux/i.test(agent)
              ? 'Linux'
              : '设备'
  const browser = /EdgA|Edg\//i.test(agent)
    ? 'Edge'
    : /CriOS|Chrome\//i.test(agent)
      ? 'Chrome'
      : /FxiOS|Firefox\//i.test(agent)
        ? 'Firefox'
        : /Safari\//i.test(agent)
          ? 'Safari'
          : '浏览器'
  return `${device} · ${browser}`
}

function firstLine(text) {
  const value = String(text ?? '').trim()
  if (value === '') return ''
  return value.split(/\r?\n/)[0].slice(0, 400)
}

/* ------------------------------------------------------------------ *
 * Paths and configuration store
 * ------------------------------------------------------------------ */

function pluginDirectory() {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function configPath() {
  return path.join(dshHome(), NS, 'config.json')
}

function defaultConfig() {
  return {
    enabled: true,
    port: DEFAULT_PORT,
    bindHost: DEFAULT_BIND,
    publicBaseUrl: '',
    mobileAdapt: true,
    restrictHosts: false,
    allowedHosts: [],
    passphraseSalt: '',
    passphraseHash: '',
    devices: [],
    pairTokens: [],
  }
}

function sanitizeConfig(raw) {
  const base = defaultConfig()
  if (raw === null || typeof raw !== 'object') return base
  const port = Number(raw.port)
  base.enabled = raw.enabled !== false
  base.port = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT
  base.bindHost = typeof raw.bindHost === 'string' && raw.bindHost.trim() !== ''
    ? raw.bindHost.trim()
    : DEFAULT_BIND
  base.publicBaseUrl = typeof raw.publicBaseUrl === 'string' ? raw.publicBaseUrl.trim() : ''
  base.mobileAdapt = raw.mobileAdapt !== false
  base.restrictHosts = raw.restrictHosts === true
  base.allowedHosts = Array.isArray(raw.allowedHosts)
    ? raw.allowedHosts
      .filter(item => typeof item === 'string')
      .map(item => item.trim().toLowerCase())
      .filter(item => item !== '')
      .slice(0, 64)
    : []
  base.passphraseSalt = typeof raw.passphraseSalt === 'string' ? raw.passphraseSalt : ''
  base.passphraseHash = typeof raw.passphraseHash === 'string' ? raw.passphraseHash : ''
  base.devices = Array.isArray(raw.devices)
    ? raw.devices
      .filter(item => item !== null && typeof item === 'object' && typeof item.id === 'string')
      .slice(0, 128)
      .map(item => ({
        id: String(item.id),
        token: typeof item.token === 'string' ? item.token : '',
        name: typeof item.name === 'string' ? item.name : '设备',
        ip: typeof item.ip === 'string' ? item.ip : '',
        userAgent: typeof item.userAgent === 'string' ? item.userAgent : '',
        createdAt: Number(item.createdAt) || Date.now(),
        lastSeenAt: Number(item.lastSeenAt) || Number(item.createdAt) || Date.now(),
      }))
    : []
  base.pairTokens = Array.isArray(raw.pairTokens)
    ? raw.pairTokens
      .filter(item => item !== null && typeof item === 'object' && typeof item.token === 'string')
      .slice(0, 32)
      .map(item => ({
        token: String(item.token),
        base: typeof item.base === 'string' ? item.base : '',
        expiresAt: Number(item.expiresAt) || 0,
      }))
    : []
  return base
}

function loadConfig(log) {
  const file = configPath()
  try {
    const text = fs.readFileSync(file, 'utf8')
    return sanitizeConfig(JSON.parse(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log?.warn?.(`${NS}: could not read ${file}: ${String(error?.message ?? error)}`)
    }
    return defaultConfig()
  }
}

/* ------------------------------------------------------------------ *
 * Inner authentication
 * ------------------------------------------------------------------ */

const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

function splitSetCookie(raw) {
  if (typeof raw !== 'string' || raw === '') return []
  // A single header may carry several cookies joined by a comma that is itself
  // followed by `name=`; split only on that shape.
  return raw.split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/).map(part => part.trim()).filter(Boolean)
}

function cookiePairsFrom(setCookieHeaders) {
  const pairs = []
  for (const raw of setCookieHeaders) {
    for (const part of splitSetCookie(raw)) {
      const pair = part.split(';')[0]?.trim() ?? ''
      if (pair !== '') pairs.push(pair)
    }
  }
  return pairs
}

function createInnerAuth(getLaunchUrl, log) {
  let cached
  let inflight
  const state = { value: 'pending', lastError: '' }

  async function redeem() {
    const launchUrl = getLaunchUrl()
    if (typeof launchUrl !== 'string' || launchUrl === '') {
      state.value = 'unavailable'
      state.lastError = 'connection.authenticatedUrl is not available'
      return undefined
    }
    try {
      const response = await fetch(launchUrl, { redirect: 'manual' })
      const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean)
      const pairs = cookiePairsFrom(raw)
      const auth = pairs.find(pair => pair.startsWith(BROWSER_AUTH_COOKIE_PREFIX))
      if (auth !== undefined) {
        cached = auth
        state.value = 'ok'
        state.lastError = ''
        return cached
      }
      // Some builds hand back the cookie only after following the token
      // redirect; follow it once by hand so both shapes work.
      const location = response.headers.get('location')
      if (location !== null && response.status >= 300 && response.status < 400) {
        const next = new URL(location, launchUrl).href
        const followed = await fetch(next, { redirect: 'manual' })
        const raw2 = typeof followed.headers.getSetCookie === 'function'
          ? followed.headers.getSetCookie()
          : [followed.headers.get('set-cookie')].filter(Boolean)
        const auth2 = cookiePairsFrom(raw2).find(pair => pair.startsWith(BROWSER_AUTH_COOKIE_PREFIX))
        if (auth2 !== undefined) {
          cached = auth2
          state.value = 'ok'
          state.lastError = ''
          return cached
        }
      }
      state.value = 'unavailable'
      state.lastError = `no ${BROWSER_AUTH_COOKIE_PREFIX}* cookie (status ${String(response.status)})`
      return undefined
    } catch (error) {
      state.value = 'unavailable'
      state.lastError = String(error?.message ?? error)
      log?.warn?.(`${NS}: could not redeem the GUI cookie: ${state.lastError}`)
      return undefined
    }
  }

  return {
    get status() { return state.value },
    get lastError() { return state.lastError },
    invalidate() { cached = undefined; state.value = 'pending' },
    async value() {
      if (cached !== undefined) return cached
      if (inflight !== undefined) return inflight
      inflight = redeem().finally(() => { inflight = undefined })
      return inflight
    },
  }
}

/* ------------------------------------------------------------------ *
 * Proxy: request rewriting
 * ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

const REQUEST_DROP = new Set([
  'host', 'origin', 'referer', 'cookie', 'content-length',
  'forwarded', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cdn-loop', 'true-client-ip', 'x-real-ip', 'accept-encoding',
  'range', 'if-range', 'x-dsh-remote-device',
])

function isDroppedRequestHeader(name) {
  const key = name.toLowerCase()
  if (HOP_BY_HOP.has(key) || REQUEST_DROP.has(key)) return true
  if (key.startsWith('sec-')) return true
  if (key.startsWith('x-forwarded-')) return true
  if (key.startsWith('x-dsr-')) return true
  return false
}

/**
 * Build the header set the GUI's fence wants: a loopback authority, same-origin
 * fetch metadata, and the redeemed browser-auth cookie. Anything that could
 * leak the remote origin (forwarding headers, browser fetch metadata) is gone.
 */
function upstreamHeaders(request, innerCookie) {
  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (isDroppedRequestHeader(key)) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  headers.host = `127.0.0.1:${state.dshPort}`
  headers['sec-fetch-site'] = 'same-origin'
  if (innerCookie !== undefined) headers.cookie = innerCookie
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
    headers.connection = 'keep-alive'
  }
  return headers
}

/** Response headers worth returning; the inner auth cookie never leaves. */
function downstreamHeaders(upstream) {
  const headers = {}
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'set-cookie') {
      const kept = (Array.isArray(value) ? value : [value]).filter((line) => {
        const pair = String(line).split(';')[0]?.trim() ?? ''
        return !pair.startsWith(BROWSER_AUTH_COOKIE_PREFIX)
      })
      if (kept.length > 0) headers['set-cookie'] = kept
      continue
    }
    headers[lower] = value
  }
  return headers
}

/* ------------------------------------------------------------------ *
 * Mobile adaptation layer
 * ------------------------------------------------------------------ */

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">'

/**
 * Deliberately structural, not cosmetic: it only removes the things that break
 * a narrow touch screen (iOS input zoom, fixed-width dialogs, media overflow,
 * code fences forcing horizontal scroll). It does not re-style the official UI.
 */
const MOBILE_CSS = `@media (max-width: 820px){
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{overflow-x:hidden}
img,svg,video,canvas{max-width:100%;height:auto}
pre,table,.dsh-scroll-x{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
input,textarea,select{font-size:16px!important}
button,[role="button"],a[href]{touch-action:manipulation}
[role="dialog"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]{max-width:calc(100vw - 16px)!important}
body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
}
@media (hover: none){
*{scrollbar-width:none}
*::-webkit-scrollbar{display:none}
}
`

function rewriteHtml(html) {
  let out = html
  // A later viewport meta loses to earlier ones in some engines; replace them.
  out = out.replace(/<meta[^>]+name=["']viewport["'][^>]*>/gi, '')
  const link = `<link rel="stylesheet" href="${GATE_CSS}?v=1" data-dsr="mobile">`
  const injected = `${VIEWPORT_META}${link}`
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (match) => `${match}${injected}`)
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, (match) => `${match}<head>${injected}</head>`)
  } else {
    out = injected + out
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Gateway pages
 * ------------------------------------------------------------------ */

function pageShell(title, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
${VIEWPORT_META}
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#0f1115;color:#e8eaed;padding:20px}
.card{width:100%;max-width:420px;background:#171a21;border:1px solid #262b36;border-radius:14px;
padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:19px;letter-spacing:.2px}
p{margin:0 0 14px;font-size:13px;line-height:1.65;color:#9aa3b2}
label{display:block;font-size:12px;color:#9aa3b2;margin:0 0 6px}
input[type=password]{width:100%;height:40px;padding:0 12px;border-radius:9px;
border:1px solid #2c3240;background:#11141a;color:#e8eaed;font-size:16px;outline:none}
input[type=password]:focus{border-color:#4b6cf5}
button{width:100%;height:40px;margin-top:12px;border:0;border-radius:9px;
background:#4b6cf5;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
button[disabled]{opacity:.55;cursor:default}
.meta{margin-top:16px;padding-top:14px;border-top:1px solid #232833;font-size:11px;
color:#6b7484;line-height:1.7;word-break:break-all}
.err{margin:12px 0 0;padding:9px 11px;border-radius:8px;background:#3a1d20;
border:1px solid #5c2a2e;color:#ffb4b4;font-size:12px;line-height:1.6}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#a8b6ff}
@media (prefers-color-scheme: light){
body{background:#f4f5f7;color:#1a1d23}
.card{background:#fff;border-color:#e3e6eb;box-shadow:0 12px 34px rgba(16,24,40,.1)}
p{color:#5b6472}label{color:#5b6472}
input[type=password]{background:#f7f8fa;border-color:#dfe3ea;color:#1a1d23}
.meta{color:#8b93a1;border-top-color:#eceef2}
.err{background:#fdeceb;border-color:#f5c2c0;color:#9f1c19}
code{color:#2f45c5}
}
</style></head><body><div class="card">${body}</div></body></html>`
}

function loginPage(options) {
  const { host, error, hasPassphrase } = options
  return pageShell('连接到 DSH', `
<h1>连接到 DSH</h1>
<p>你正在通过 <code>${escapeHtml(host)}</code> 访问本机的 DSH 界面。<br>
这是本机页面，不是公网服务——输入一次密文后，这台设备会被记住。</p>
<form method="post" action="${GATE_LOGIN}">
  <label for="passphrase">密文</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password"
         ${hasPassphrase ? '' : 'disabled'} placeholder="${hasPassphrase ? '输入密文' : '尚未设置密文'}" autofocus>
  <button type="submit" ${hasPassphrase ? '' : 'disabled'}>进入</button>
</form>
${error !== '' ? `<div class="err">${escapeHtml(error)}</div>` : ''}
<div class="meta">
地址：${escapeHtml(host)}<br>
${hasPassphrase ? '没有密文？在 DSH 里打开左侧栏的「远程访问」，用二维码配对。' : '请先在 DSH 左侧栏的「远程访问」面板里设置密文。'}
</div>`)
}

function forbiddenPage(options) {
  const { host, allowed } = options
  return pageShell('地址未被信任', `
<h1>地址未被信任</h1>
<p>这个插件开启了 Host 白名单，<code>${escapeHtml(host)}</code> 不在名单内，因此请求被拒绝。</p>
<p>在 DSH 左侧栏的「远程访问」里把这个地址加进白名单，或者关闭 Host 限制。</p>
<div class="meta">当前白名单：${escapeHtml(allowed.join('、') || '（空）')}</div>`)
}

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

const state = {
  dshPort: 0,
  config: defaultConfig(),
  server: undefined,
  /** 'idle' | 'listening' | 'failed' */
  phase: 'idle',
  error: '',
  log: undefined,
  innerAuth: undefined,
  lastSeenWriteAt: 0,
  saveTimer: undefined,
  loginFailures: new Map(),
  startedAt: 0,
}

function lanAddresses() {
  const out = []
  const interfaces = os.networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      const address = String(entry.address ?? '')
      if (address === '' || address.startsWith('169.254.')) continue
      out.push({ address, name })
    }
  }
  // Prefer the classic home/office range over VPN and virtual adapters.
  out.sort((left, right) => {
    const score = (item) => (item.address.startsWith('192.168.') ? 0 : item.address.startsWith('10.') ? 1 : 2)
    return score(left) - score(right)
  })
  return out
}

function autoHosts() {
  const hosts = ['127.0.0.1', 'localhost', '::1']
  for (const entry of lanAddresses()) hosts.push(entry.address)
  return hosts
}

function normalizeBase(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.search = ''
    url.hash = ''
    return url.href.replace(/\/$/, '')
  } catch {
    return ''
  }
}

function baseCandidates() {
  const config = state.config
  const out = []
  const publicUrl = normalizeBase(config.publicBaseUrl)
  if (publicUrl !== '') out.push(publicUrl)
  for (const entry of lanAddresses()) out.push(`http://${entry.address}:${String(config.port)}`)
  out.push(`http://127.0.0.1:${String(config.port)}`)
  return out
}

function save(immediate = false) {
  const write = () => {
    state.saveTimer = undefined
    const file = configPath()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify(state.config, null, 2)}\n`, 'utf8')
    } catch (error) {
      state.log?.warn?.(`${NS}: could not write ${file}: ${String(error?.message ?? error)}`)
    }
  }
  if (immediate) {
    if (state.saveTimer !== undefined) clearTimeout(state.saveTimer)
    write()
    return
  }
  if (state.saveTimer !== undefined) return
  state.saveTimer = setTimeout(write, 400)
  state.saveTimer.unref?.()
}

function touchDevice(device) {
  device.lastSeenAt = Date.now()
  const now = Date.now()
  if (now - state.lastSeenWriteAt > LAST_SEEN_WRITE_MS) {
    state.lastSeenWriteAt = now
    save()
  }
}

function deviceFor(request) {
  const cookies = parseCookies(header(request, 'cookie'))
  const token = cookies[DEVICE_COOKIE]
  if (typeof token !== 'string' || token === '') return undefined
  const device = state.config.devices.find(item => item.token === token)
  if (device === undefined) return undefined
  touchDevice(device)
  return device
}

function pairTokenFor(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const now = Date.now()
  state.config.pairTokens = state.config.pairTokens.filter(item => item.expiresAt > now)
  return state.config.pairTokens.find(item => item.token === raw)
}

/* ------------------------------------------------------------------ *
 * Gateway: authentication
 * ------------------------------------------------------------------ */

function loginKey(request) {
  return String(request.socket?.remoteAddress ?? 'unknown')
}

function loginBlocked(request) {
  const entry = state.loginFailures.get(loginKey(request))
  if (entry === undefined) return false
  if (Date.now() > entry.until) {
    state.loginFailures.delete(loginKey(request))
    return false
  }
  return entry.count >= LOGIN_MAX_FAILURES
}

function noteLoginFailure(request) {
  const key = loginKey(request)
  const now = Date.now()
  const entry = state.loginFailures.get(key)
  if (entry === undefined || now > entry.until) {
    state.loginFailures.set(key, { count: 1, until: now + LOGIN_WINDOW_MS })
    return
  }
  entry.count += 1
}

function verifyPassphrase(passphrase) {
  const config = state.config
  if (config.passphraseHash === '' || config.passphraseSalt === '') return false
  const computed = sha256(`${config.passphraseSalt}:${passphrase}`)
  const expected = Buffer.from(config.passphraseHash, 'hex')
  const actual = Buffer.from(computed, 'hex')
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

function setPassphrase(passphrase) {
  const config = state.config
  const salt = randomToken(16)
  config.passphraseSalt = salt
  config.passphraseHash = sha256(`${salt}:${passphrase}`)
}

function mintDevice(request, label) {
  const device = {
    id: crypto.randomUUID(),
    token: randomToken(24),
    name: label ?? describeAgent(header(request, 'user-agent')),
    ip: String(request.socket?.remoteAddress ?? ''),
    userAgent: String(header(request, 'user-agent') ?? '').slice(0, 400),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  state.config.devices.push(device)
  save(true)
  return device
}

function deviceCookie(device) {
  return `${DEVICE_COOKIE}=${device.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(DEVICE_MAX_AGE_S)}`
}

function hostAllowed(request) {
  if (!state.config.restrictHosts) return true
  const host = hostnameOf(header(request, 'host'))
  if (host === '') return false
  if (autoHosts().includes(host)) return true
  return state.config.allowedHosts.some((entry) => {
    const allowed = hostnameOf(entry)
    return allowed !== '' && allowed === host
  })
}

/* ------------------------------------------------------------------ *
 * Gateway: reverse proxy
 * ------------------------------------------------------------------ */

async function proxyHttp(request, response) {
  const target = state.dshPort
  if (!Number.isInteger(target) || target <= 0) {
    sendText(response, 503, 'DSH web server port is unknown.')
    return
  }
  const innerCookie = await state.innerAuth.value()
  const path = request.url ?? '/'
  const options = {
    host: '127.0.0.1',
    port: target,
    method: request.method ?? 'GET',
    path,
    headers: upstreamHeaders(request, innerCookie),
  }

  const upstream = http.request(options, (reply) => {
    const headers = downstreamHeaders(reply)
    const isHtml = String(reply.headers['content-type'] ?? '').toLowerCase().includes('text/html')
    const encoding = String(reply.headers['content-encoding'] ?? '').toLowerCase()
    const rewrite = isHtml && state.config.mobileAdapt && (encoding === '' || encoding === 'identity')

    if (!rewrite) {
      response.writeHead(reply.statusCode ?? 502, headers)
      reply.pipe(response)
      reply.on('error', () => response.destroy())
      return
    }

    const chunks = []
    reply.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    reply.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const rewritten = Buffer.from(rewriteHtml(body), 'utf8')
      delete headers['content-length']
      headers['content-length'] = String(rewritten.length)
      headers['cache-control'] = 'no-store'
      response.writeHead(reply.statusCode ?? 200, headers)
      response.end(rewritten)
    })
    reply.on('error', () => response.destroy())
  })

  upstream.on('error', (error) => {
    if (!response.headersSent) {
      sendText(response, 502, `DSH web server is not answering on 127.0.0.1:${String(target)} (${String(error?.message ?? error)}).`)
      return
    }
    response.destroy()
  })

  upstream.setTimeout(0)
  request.pipe(upstream)
  request.on('aborted', () => upstream.destroy())
  response.on('close', () => upstream.destroy())
}

function proxyUpgrade(request, socket, head) {
  const target = state.dshPort
  if (!Number.isInteger(target) || target <= 0) {
    socket.destroy()
    return
  }
  socket.on('error', () => socket.destroy())
  state.innerAuth.value().then((innerCookie) => {
    if (socket.destroyed) return
    const upstream = net.connect(target, '127.0.0.1', () => {
      const lines = [`GET ${request.url ?? '/'} HTTP/1.1`, `Host: 127.0.0.1:${String(target)}`]
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        if (lower === 'host' || lower === 'cookie') continue
        if (lower === 'origin' || lower === 'referer') continue
        if (lower.startsWith('x-forwarded-') || lower.startsWith('x-dsr-')) continue
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
      }
      if (innerCookie !== undefined) lines.push(`Cookie: ${innerCookie}`)
      // Both of these are hop-by-hop and were stripped by the loop above, but the
      // upstream handshake fails unless they are present: `Connection: Upgrade`
      // alone is not enough, the Upgrade header names the protocol.
      lines.push(`Upgrade: ${String(request.headers.upgrade ?? 'websocket')}`)
      lines.push('Connection: Upgrade')
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head !== undefined && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
      upstream.setKeepAlive(true, 20000)
      socket.setKeepAlive(true, 20000)
    })
    upstream.on('error', () => socket.destroy())
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
}

/* ------------------------------------------------------------------ *
 * Gateway: request routing
 * ------------------------------------------------------------------ */

async function handleGateway(request, response) {
  const url = new URL(request.url ?? '/', `http://${header(request, 'host') ?? '127.0.0.1'}`)
  const pathname = url.pathname
  const hostHeader = header(request, 'host') ?? ''

  if (!hostAllowed(request)) {
    sendHtml(response, 403, forbiddenPage({
      host: hostHeader,
      allowed: [...autoHosts(), ...state.config.allowedHosts],
    }))
    return
  }

  if (pathname === GATE_HEALTH) {
    sendJson(response, 200, { ok: true, service: NS, contract: CONTRACT })
    return
  }

  if (pathname === GATE_CSS) {
    sendText(response, 200, MOBILE_CSS, 'text/css; charset=utf-8')
    return
  }

  if (pathname === GATE_LOGOUT) {
    const device = deviceFor(request)
    if (device !== undefined) {
      state.config.devices = state.config.devices.filter(item => item.id !== device.id)
      save(true)
    }
    sendHtml(response, 200, pageShell('已退出', `
<h1>已退出</h1>
<p>这台设备的访问凭据已撤销。需要时重新扫描配对码或用密文登录。</p>
<div class="meta">地址：${escapeHtml(hostHeader)}</div>`), {
      'set-cookie': `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    })
    return
  }

  // QR pairing: a single-use token in the URL mints a device cookie and then
  // redirects to a clean address so the token never survives in history.
  const pairToken = url.searchParams.get('pair')
  if (pairToken !== null) {
    const entry = pairTokenFor(pairToken)
    if (entry === undefined) {
      sendHtml(response, 410, loginPage({
        host: hostHeader,
        error: '这个配对码已经失效（一次性，5 分钟内有效）。请在 DSH 里重新生成。',
        hasPassphrase: state.config.passphraseHash !== '',
      }))
      return
    }
    state.config.pairTokens = state.config.pairTokens.filter(item => item.token !== pairToken)
    const device = mintDevice(request)
    url.searchParams.delete('pair')
    const target = `${url.pathname}${url.search}`
    sendHtml(response, 200, pageShell('配对成功', `
<h1>配对成功</h1>
<p>这台设备已加入信任列表，正在打开 DSH 界面…</p>
<div class="meta">${escapeHtml(device.name)} · ${escapeHtml(hostHeader)}</div>
<script>location.replace(${JSON.stringify(target)});</script>`), {
      'set-cookie': deviceCookie(device),
    })
    return
  }

  if (pathname === GATE_LOGIN) {
    if ((request.method ?? 'GET') !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (loginBlocked(request)) {
      sendHtml(response, 429, loginPage({
        host: hostHeader,
        error: '尝试次数过多，请 5 分钟后再试。',
        hasPassphrase: state.config.passphraseHash !== '',
      }))
      return
    }
    const form = await readFormBody(request)
    const passphrase = form.get('passphrase') ?? ''
    if (!verifyPassphrase(passphrase)) {
      noteLoginFailure(request)
      sendHtml(response, 401, loginPage({
        host: hostHeader,
        error: '密文不正确。',
        hasPassphrase: state.config.passphraseHash !== '',
      }))
      return
    }
    state.loginFailures.delete(loginKey(request))
    const device = mintDevice(request)
    response.writeHead(302, {
      location: '/',
      'set-cookie': deviceCookie(device),
      'cache-control': 'no-store',
    })
    response.end()
    return
  }

  if (pathname.startsWith(GATE_PREFIX)) {
    sendText(response, 404, 'Not found.')
    return
  }

  if (deviceFor(request) === undefined) {
    sendHtml(response, 401, loginPage({
      host: hostHeader,
      error: '',
      hasPassphrase: state.config.passphraseHash !== '',
    }))
    return
  }

  await proxyHttp(request, response)
}

/* ------------------------------------------------------------------ *
 * Listener lifecycle
 * ------------------------------------------------------------------ */

function stopListener() {
  return new Promise((resolve) => {
    const server = state.server
    state.server = undefined
    if (server === undefined) {
      state.phase = 'idle'
      resolve()
      return
    }
    server.close(() => resolve())
    try {
      server.closeAllConnections?.()
    } catch {
      // Older runtimes: connections will drain on their own.
    }
    state.phase = 'idle'
  })
}

async function startListener() {
  const config = state.config
  if (!config.enabled) {
    state.phase = 'idle'
    state.error = ''
    return
  }
  if (config.port === state.dshPort) {
    state.phase = 'failed'
    state.error = `端口 ${String(config.port)} 与 DSH 自身的 Web 端口相同，请换一个。`
    return
  }
  const server = http.createServer((request, response) => {
    handleGateway(request, response).catch((error) => {
      state.log?.warn?.(`${NS}: gateway error: ${String(error?.message ?? error)}`)
      if (!response.headersSent) sendText(response, 500, 'Internal gateway error.')
      else response.destroy()
    })
  })
  server.on('upgrade', (request, socket, head) => {
    if (!hostAllowed(request) || deviceFor(request) === undefined) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    proxyUpgrade(request, socket, head)
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  await new Promise((resolve) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      state.phase = 'failed'
      state.error = error?.code === 'EADDRINUSE'
        ? `端口 ${String(config.port)} 已被其它程序占用。`
        : `无法监听 ${config.bindHost}:${String(config.port)}：${String(error?.message ?? error)}`
      state.server = undefined
      state.log?.warn?.(`${NS}: ${state.error}`)
      resolve()
    }
    const onListening = () => {
      server.removeListener('error', onError)
      state.server = server
      state.phase = 'listening'
      state.error = ''
      state.startedAt = Date.now()
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(config.port, config.bindHost)
    } catch (error) {
      onError(error)
    }
  })
}

async function restartListener() {
  await stopListener()
  await startListener()
}

/* ------------------------------------------------------------------ *
 * Panel API
 * ------------------------------------------------------------------ */

function lanUrls() {
  const config = state.config
  return lanAddresses().map(entry => `http://${entry.address}:${String(config.port)}`)
}

function publicState() {
  const config = state.config
  return {
    contract: CONTRACT,
    enabled: config.enabled,
    listening: state.phase === 'listening',
    port: config.port,
    bindHost: config.bindHost,
    dshPort: state.dshPort,
    error: state.error === '' ? null : state.error,
    publicBaseUrl: config.publicBaseUrl === '' ? null : config.publicBaseUrl,
    publicUrl: normalizeBase(config.publicBaseUrl) || null,
    mobileAdapt: config.mobileAdapt,
    restrictHosts: config.restrictHosts,
    allowedHosts: [...config.allowedHosts],
    autoHosts: autoHosts(),
    lanUrls: lanUrls(),
    passphraseSet: config.passphraseHash !== '',
    devices: config.devices.map(device => ({
      id: device.id,
      name: device.name,
      ip: device.ip,
      userAgent: device.userAgent,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    })),
    innerAuth: state.innerAuth.status,
  }
}

async function handleState(request, response) {
  if ((request.method ?? 'GET') !== 'GET' && (request.method ?? 'GET') !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }
  sendJson(response, 200, publicState())
}

let qrEncode

async function loadQr() {
  if (qrEncode !== undefined) return qrEncode
  try {
    const module = await import('./qr.js')
    const candidate = module.qrSvg ?? module.default ?? module.encodeSvg
    qrEncode = typeof candidate === 'function' ? candidate : null
  } catch (error) {
    state.log?.warn?.(`${NS}: QR encoder unavailable: ${String(error?.message ?? error)}`)
    qrEncode = null
  }
  return qrEncode
}

async function handlePair(request, response) {
  if ((request.method ?? 'GET') !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  if (!state.config.enabled || state.phase !== 'listening') {
    sendJson(response, 400, { ok: false, error: '监听未启动，先打开远程访问开关。' })
    return
  }
  const body = await readJsonBody(request)
  const requested = typeof body?.base === 'string' ? normalizeBase(body.base) : ''
  const candidates = requested !== '' ? [requested] : baseCandidates()
  const base = candidates[0] ?? ''
  if (base === '') {
    sendJson(response, 400, { ok: false, error: '找不到可用的访问地址，先设置公网地址或确认已连上局域网。' })
    return
  }
  const now = Date.now()
  state.config.pairTokens = state.config.pairTokens
    .filter(item => item.expiresAt > now)
    .slice(-15)
  const token = randomToken(18)
  state.config.pairTokens.push({ token, base, expiresAt: now + PAIR_TTL_MS })
  save(true)

  const url = `${base}/?pair=${token}`
  const encode = await loadQr()
  let svg = ''
  if (encode !== null) {
    try {
      svg = encode(url)
    } catch (error) {
      state.log?.warn?.(`${NS}: QR encode failed: ${String(error?.message ?? error)}`)
      svg = ''
    }
  }
  sendJson(response, 200, { ok: true, url, svg, expiresAt: now + PAIR_TTL_MS })
}

function applyUpdate(body) {
  const config = state.config
  const notices = []
  let restart = false

  if (typeof body.enabled === 'boolean' && body.enabled !== config.enabled) {
    config.enabled = body.enabled
    restart = true
  }
  if (body.port !== undefined) {
    const port = Number(body.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { error: '端口必须是 1024–65535 之间的整数。' }
    }
    if (port === state.dshPort) {
      return { error: `端口 ${String(port)} 是 DSH 自己的 Web 端口，请换一个。` }
    }
    if (port !== config.port) {
      config.port = port
      restart = true
    }
  }
  if (body.publicBaseUrl !== undefined) {
    const raw = String(body.publicBaseUrl ?? '').trim()
    if (raw === '') {
      config.publicBaseUrl = ''
    } else {
      const normalized = normalizeBase(raw)
      if (normalized === '') return { error: '公网地址不是合法的 http(s) 地址。' }
      config.publicBaseUrl = normalized
    }
  }
  if (typeof body.mobileAdapt === 'boolean') config.mobileAdapt = body.mobileAdapt
  if (typeof body.restrictHosts === 'boolean') config.restrictHosts = body.restrictHosts
  if (Array.isArray(body.allowedHosts)) {
    config.allowedHosts = body.allowedHosts
      .filter(item => typeof item === 'string')
      .map(item => String(item).trim().toLowerCase())
      .filter(item => item !== '')
      .slice(0, 64)
  }
  if (body.passphrase !== undefined) {
    const passphrase = String(body.passphrase ?? '')
    if (passphrase === '') {
      return { error: '密文不能为空。' }
    }
    if (passphrase.length < 6) {
      return { error: '密文至少 6 位。' }
    }
    if (passphrase.length > 128) {
      return { error: '密文最多 128 位。' }
    }
    setPassphrase(passphrase)
    notices.push('密文已更新；已经配对的设备不受影响。')
  }

  save(true)
  return { restart, notices }
}

async function handleUpdate(request, response) {
  if ((request.method ?? 'GET') !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  const body = await readJsonBody(request)
  if (body === null) {
    sendJson(response, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
    return
  }
  const result = applyUpdate(body)
  if (result.error !== undefined) {
    sendJson(response, 400, { ok: false, error: result.error })
    return
  }
  if (result.restart === true) await restartListener()
  sendJson(response, 200, { ok: true, state: publicState() })
}

async function handleRevoke(request, response) {
  if ((request.method ?? 'GET') !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  const body = await readJsonBody(request)
  if (body === null) {
    sendJson(response, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
    return
  }
  if (body.all === true) {
    state.config.devices = []
  } else {
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendJson(response, 400, { ok: false, error: '缺少设备 id。' })
      return
    }
    const before = state.config.devices.length
    state.config.devices = state.config.devices.filter(device => device.id !== id)
    if (state.config.devices.length === before) {
      sendJson(response, 404, { ok: false, error: '没有这台设备。' })
      return
    }
  }
  save(true)
  sendJson(response, 200, { ok: true, state: publicState() })
}

/**
 * Panel routes live on the official GUI port and are reachable only from
 * loopback, so a remote client can never drive the control plane even though it
 * can use the proxied GUI.
 */
function isTrustedPanelRequest(request) {
  if (header(request, TRUST_HEADER) !== '1') return false
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const site = header(request, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const host = header(request, 'host')
  if (host === undefined || host === '') return false
  const origin = header(request, 'origin')
  if (origin === undefined || origin === '') return isLoopbackAddress(hostnameOf(host))
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && isLoopbackAddress(url.hostname)
      && url.host === host
  } catch {
    return false
  }
}

function guard(handler) {
  return async (request, response) => {
    if (!isTrustedPanelRequest(request)) {
      sendJson(response, 403, { ok: false, error: '只接受本机同源的 DSH 面板请求。' })
      return
    }
    await handler(request, response)
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export const inject = ['webServer', 'connection']

export function apply(ctx) {
  state.log = ctx.logger
  state.config = loadConfig(ctx.logger)

  const origin = (() => {
    try {
      return new URL(ctx.webServer.getOrigin())
    } catch {
      return undefined
    }
  })()
  const portFromOrigin = Number(origin?.port ?? '')
  const portFromServer = Number(ctx.webServer.port ?? '')
  state.dshPort = Number.isInteger(portFromOrigin) && portFromOrigin > 0
    ? portFromOrigin
    : Number.isInteger(portFromServer) && portFromServer > 0
      ? portFromServer
      : 7743

  const launchBase = `http://127.0.0.1:${String(state.dshPort)}/`
  state.innerAuth = createInnerAuth(() => {
    const authenticate = ctx.connection?.authenticatedUrl
    if (typeof authenticate !== 'function') return ''
    try {
      return String(authenticate.call(ctx.connection, launchBase))
    } catch (error) {
      state.log?.warn?.(`${NS}: authenticatedUrl failed: ${String(error?.message ?? error)}`)
      return ''
    }
  }, ctx.logger)

  ctx.effect(() => () => {
    if (state.saveTimer !== undefined) clearTimeout(state.saveTimer)
    state.saveTimer = undefined
    save(true)
  }, `${NS}: persist configuration`)

  ctx.effect(() => {
    startListener().catch((error) => {
      state.phase = 'failed'
      state.error = String(error?.message ?? error)
    })
    return () => {
      stopListener().catch(() => {})
    }
  }, `${NS}: gateway listener`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: guard(handleState),
  }), `${NS}: state route`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPDATE_PATH,
    handler: guard(handleUpdate),
  }), `${NS}: update route`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PAIR_PATH,
    handler: guard(handlePair),
  }), `${NS}: pair route`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVOKE_PATH,
    handler: guard(handleRevoke),
  }), `${NS}: revoke route`)

  ctx.effect(() => {
    // Warm the inner credential so the first remote request is not the one that
    // pays for the redemption round trip.
    state.innerAuth.value().catch(() => {})
    return () => {}
  }, `${NS}: warm inner auth`)
}
