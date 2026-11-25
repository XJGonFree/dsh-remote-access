window.__ModuleLoader__.load({
  id: 'dsh-remote-access',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const h = React.createElement

    /** Stable id shared by the sidebar row and the main-slot page. */
    const PANEL_ID = 'dsh-remote-access'
    /** Sidebar row order: market 1, Schedule 10, context 20, proc-monitor 25, this 26, skills 30. */
    const PANEL_ORDER = 26
    /** Locale namespace this plugin owns. */
    const NS = 'dsh-remote-access'
    /** Routes are DOCUMENT-RELATIVE: the GUI is served under `<base href="./">`. */
    const API = {
      state: 'api/dsh-remote-access/state',
      update: 'api/dsh-remote-access/update',
      pair: 'api/dsh-remote-access/pair',
      revoke: 'api/dsh-remote-access/revoke',
    }
    /** Marker header the host requires on every request. */
    const HEADER = 'x-dsh-remote-access'
    const POLL_MS = 4000
    const TICK_MS = 1000
    /** Pixel box of the white QR card; a phone camera needs a real square. */
    const QR_SIZE = 220
    const UA_MAX = 46

    const zh = {
      'meta.title': '远程访问',
      'meta.description': '在一个固定的本地端口上提供官方 DSH Web 界面，供手机或其它电脑访问；带二维码配对、密文、移动端适配与设备管理。',
      'entry.label': '远程访问',
      'panel.title': '远程访问',
      'panel.subtitle': '把官方界面开到一个固定端口，手机和其它电脑都能用。',
      'panel.loading': '正在读取访问设置…',
      'panel.refresh': '刷新',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.cancel': '取消',
      'panel.saving': '正在保存…',
      'panel.failed': '操作没有成功',
      'panel.error.offline': '无法连接主机：请确认 dsh 仍在运行，再点刷新重试。',
      'panel.enable': '开启远程访问端口',
      'panel.enable.hint': '关闭后端口立刻停止监听，已经配对的设备也连不上。',
      'panel.section.status': '状态',
      'panel.status.listener': '监听状态',
      'panel.status.listening': '监听中',
      'panel.status.stopped': '未开启',
      'panel.status.port': '端口',
      'panel.status.bind': '绑定地址',
      'panel.status.dshPort': '转发到',
      'panel.status.urls': '访问地址',
      'panel.status.noUrls': '还没有可用地址。开启端口后，这里会列出本机和局域网地址。',
      'panel.status.error': '上次错误',
      'panel.status.innerAuth': '内层登录',
      'panel.innerAuth.ok': '正常',
      'panel.innerAuth.pending': '等待登录',
      'panel.innerAuth.unavailable': '不可用',
      'panel.status.hint': '把端口开到网络上是一个安全决定：同一个网络里的人只要能连上这个端口，就能看到登录界面。请配合密文或配对码使用，不要在公网上裸奔。',
      'panel.section.pair': '配对',
      'panel.pair.hint': '用手机扫码，一次配对就把访问凭据带到手机上。',
      'panel.pair.singleUse': '配对码一次性使用，几分钟后自动失效。',
      'panel.pair.create': '生成配对码',
      'panel.pair.creating': '正在生成…',
      'panel.pair.refresh': '刷新二维码',
      'panel.pair.empty': '还没有生成配对码。',
      'panel.pair.expired': '配对码已过期，请刷新。',
      'panel.pair.countdown': '{n} 秒后失效',
      'panel.pair.urlLabel': '配对链接',
      'panel.pair.qrAlt': '配对二维码',
      'panel.section.pass': '密文',
      'panel.pass.set': '已设置密文',
      'panel.pass.unset': '尚未设置密文',
      'panel.pass.label': '密文',
      'panel.pass.placeholder': '输入新的密文',
      'panel.pass.save': '设置 / 修改密文',
      'panel.pass.generate': '生成随机密文',
      'panel.pass.hint': '扫不了码的设备改用密文登录：这是备用入口，走通之后同样拿到访问凭据。',
      'panel.pass.empty': '密文不能为空。',
      'panel.pass.saved': '密文已更新',
      'panel.section.mobile': '移动端适配',
      'panel.mobile.label': '为窄屏重写页面',
      'panel.mobile.hint': '开启后，插件会给转发出去的 HTML 加上 viewport 标记和一层窄屏样式，让官方界面在手机上能正常缩放和点按。',
      'panel.section.hosts': '主机信任',
      'panel.hosts.restrict': '限制访问主机名',
      'panel.hosts.restrict.on': '只回答列表里列出的主机名，其它一律拒绝。',
      'panel.hosts.restrict.off': '不做 Host 校验：这个插件不会因为 Host 拒绝请求（没有 403），唯一的门是密文和设备 Cookie。',
      'panel.hosts.allowed': '额外允许的主机名',
      'panel.hosts.allowed.placeholder': '每行一个，例如 dsh.example.com',
      'panel.hosts.allowed.hint': '填你的公网隧道域名或反向代理域名。回环和局域网地址始终被信任，不用填。',
      'panel.hosts.auto': '自动识别（只读）',
      'panel.hosts.auto.empty': '没有识别到回环或局域网地址。',
      'panel.hosts.save': '保存主机名',
      'panel.hosts.saved': '主机名已保存',
      'panel.section.devices': '已配对设备',
      'panel.devices.count': '{n} 台',
      'panel.devices.empty': '还没有已配对的设备。',
      'panel.col.name': '设备',
      'panel.col.ip': 'IP',
      'panel.col.created': '配对时间',
      'panel.col.lastSeen': '最近访问',
      'panel.col.ua': 'User-Agent',
      'panel.col.action': '操作',
      'panel.devices.revoke': '撤销',
      'panel.devices.confirm': '确认撤销？',
      'panel.devices.revokeAll': '撤销全部',
      'panel.devices.revokeAllConfirm': '确认全部撤销？',
      'panel.devices.revoked': '已撤销该设备',
      'panel.devices.revokedAll': '已撤销全部设备',
      'panel.devices.unknown': '未知设备',
    }

    const en = {
      'meta.title': 'Remote access',
      'meta.description': 'Serves the official DSH web GUI on one fixed local port for phones and other PCs, with QR pairing, a passphrase, mobile adaptation, and device management.',
      'entry.label': 'Remote access',
      'panel.title': 'Remote access',
      'panel.subtitle': 'Serves the official UI on one fixed port so a phone or another PC can use it.',
      'panel.loading': 'Reading remote access settings…',
      'panel.refresh': 'Refresh',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
      'panel.cancel': 'Cancel',
      'panel.saving': 'Saving…',
      'panel.failed': 'That did not work',
      'panel.error.offline': 'Cannot reach the host: check that dsh is still running, then refresh.',
      'panel.enable': 'Enable the remote access port',
      'panel.enable.hint': 'Turning this off stops the listener at once; paired devices lose access too.',
      'panel.section.status': 'Status',
      'panel.status.listener': 'Listener',
      'panel.status.listening': 'Listening',
      'panel.status.stopped': 'Off',
      'panel.status.port': 'Port',
      'panel.status.bind': 'Bind address',
      'panel.status.dshPort': 'Proxies to',
      'panel.status.urls': 'Reachable URLs',
      'panel.status.noUrls': 'No reachable address yet. Once the port is on, local and LAN addresses appear here.',
      'panel.status.error': 'Last error',
      'panel.status.innerAuth': 'Inner login',
      'panel.innerAuth.ok': 'OK',
      'panel.innerAuth.pending': 'Waiting for login',
      'panel.innerAuth.unavailable': 'Unavailable',
      'panel.status.hint': 'Opening a port to a network is a security decision: anyone on that network who can reach the port can see the login screen. Use it with the passphrase or a pairing code, never bare on the public internet.',
      'panel.section.pair': 'Pairing',
      'panel.pair.hint': 'Scan with a phone to carry the access credential over in one step.',
      'panel.pair.singleUse': 'The pairing code works once and expires after a few minutes.',
      'panel.pair.create': 'Create pairing code',
      'panel.pair.creating': 'Creating…',
      'panel.pair.refresh': 'Refresh QR code',
      'panel.pair.empty': 'No pairing code has been minted yet.',
      'panel.pair.expired': 'The pairing code expired. Refresh it.',
      'panel.pair.countdown': 'expires in {n}s',
      'panel.pair.urlLabel': 'Pairing link',
      'panel.pair.qrAlt': 'Pairing QR code',
      'panel.section.pass': 'Passphrase',
      'panel.pass.set': 'A passphrase is set',
      'panel.pass.unset': 'No passphrase set',
      'panel.pass.label': 'Passphrase',
      'panel.pass.placeholder': 'Enter a new passphrase',
      'panel.pass.save': 'Set / change passphrase',
      'panel.pass.generate': 'Generate random passphrase',
      'panel.pass.hint': 'Devices that cannot scan the code sign in with the passphrase instead: it is the fallback entry and grants the same access credential.',
      'panel.pass.empty': 'The passphrase cannot be empty.',
      'panel.pass.saved': 'Passphrase updated',
      'panel.section.mobile': 'Mobile adaptation',
      'panel.mobile.label': 'Rewrite pages for narrow screens',
      'panel.mobile.hint': 'When on, the plugin adds a viewport meta tag and a narrow-screen CSS layer to the proxied HTML so the official UI scales and taps correctly on a phone.',
      'panel.section.hosts': 'Host trust',
      'panel.hosts.restrict': 'Restrict by host name',
      'panel.hosts.restrict.on': 'Only the listed host names are answered; everything else is refused.',
      'panel.hosts.restrict.off': 'No Host check: this plugin refuses nothing by Host (no 403). The passphrase and the device cookie are the only gate.',
      'panel.hosts.allowed': 'Extra allowed host names',
      'panel.hosts.allowed.placeholder': 'One per line, for example dsh.example.com',
      'panel.hosts.allowed.hint': 'Put your public tunnel or reverse-proxy hostname here. Loopback and LAN addresses are always trusted and need no entry.',
      'panel.hosts.auto': 'Detected automatically (read-only)',
      'panel.hosts.auto.empty': 'No loopback or LAN address was detected.',
      'panel.hosts.save': 'Save host names',
      'panel.hosts.saved': 'Host names saved',
      'panel.section.devices': 'Paired devices',
      'panel.devices.count': '{n} device(s)',
      'panel.devices.empty': 'No device has been paired yet.',
      'panel.col.name': 'Device',
      'panel.col.ip': 'IP',
      'panel.col.created': 'Paired',
      'panel.col.lastSeen': 'Last seen',
      'panel.col.ua': 'User-Agent',
      'panel.col.action': 'Action',
      'panel.devices.revoke': 'Revoke',
      'panel.devices.confirm': 'Revoke it?',
      'panel.devices.revokeAll': 'Revoke all',
      'panel.devices.revokeAllConfirm': 'Revoke all?',
      'panel.devices.revoked': 'Device revoked',
      'panel.devices.revokedAll': 'All devices revoked',
      'panel.devices.unknown': 'Unknown device',
    }

    let runtimeT
    function setRuntimeTranslate(t) {
      runtimeT = t
    }
    function tt(key, values) {
      const text = runtimeT !== undefined ? runtimeT(key, values) : key
      if (values === undefined) return text
      let out = text
      for (const [name, value] of Object.entries(values)) out = out.replaceAll(`{${name}}`, String(value))
      return out
    }

    /* ---------------------------------------------------------------- *
     * API client
     * ---------------------------------------------------------------- */

    function apiFailure(message, code) {
      const error = new Error(message)
      error.code = code
      return error
    }

    /** The host refuses any request without the marker header. */
    async function request(path, options) {
      const method = options?.method ?? 'GET'
      const headers = { [HEADER]: '1' }
      const init = { method, headers, cache: 'no-store' }
      if (options?.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(path, init)
      } catch {
        throw apiFailure(tt('panel.error.offline'), 'offline')
      }
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const message = body !== null && typeof body === 'object' && typeof body.error === 'string' && body.error !== ''
          ? body.error
          : `HTTP ${response.status}`
        throw apiFailure(message, response.status)
      }
      return body
    }

    /* ---------------------------------------------------------------- *
     * Formatting and small browser helpers
     * ---------------------------------------------------------------- */

    /** Timestamps arrive as epoch ms; render them in the viewer's locale. */
    function formatStamp(value) {
      const time = Number(value)
      if (!Number.isFinite(time) || time <= 0) return '—'
      return new Date(time).toLocaleString()
    }

    function shortUa(value) {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return ''
      return text.length > UA_MAX ? `${text.slice(0, UA_MAX)}…` : text
    }

    /** The host hands back a standalone `<svg>` string; render it as an image. */
    function svgDataUrl(svg) {
      try {
        return `data:image/svg+xml;base64,${btoa(svg)}`
      } catch {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      }
    }

    /** 16 characters, no look-alikes (0/O, 1/l/I), generated locally. */
    function randomPassphrase() {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
      const bytes = new Uint8Array(16)
      const crypto = globalThis.crypto
      if (crypto !== undefined && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
      else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
      let out = ''
      for (const byte of bytes) out += alphabet[byte % alphabet.length]
      return out
    }

    /** Clipboard API first, then the old textarea trick for non-secure contexts. */
    async function copyText(text) {
      if (typeof text !== 'string' || text === '') return false
      const nav = globalThis.navigator
      if (nav !== undefined && nav.clipboard !== undefined && typeof nav.clipboard.writeText === 'function') {
        try {
          await nav.clipboard.writeText(text)
          return true
        } catch {}
      }
      try {
        const doc = globalThis.document
        if (doc === undefined) return false
        const area = doc.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.cssText = 'position:fixed;top:-1000px;left:-1000px'
        doc.body.appendChild(area)
        area.select()
        const ok = doc.execCommand('copy')
        doc.body.removeChild(area)
        return ok === true
      } catch {
        return false
      }
    }

    /* ---------------------------------------------------------------- *
     * Styles (theme tokens only; the QR card is the one neutral white)
     * ---------------------------------------------------------------- */

    const S = {
      view: { height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'var(--dsw-font-family)' },
      header: { flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 10px' },
      headerText: { minWidth: 0, flex: 1 },
      title: { margin: 0, fontSize: 16, fontWeight: 700, lineHeight: 1.3 },
      subtitle: { marginTop: 2, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: { flex: 'none', height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
      ghost: { flex: 'none', height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
      danger: { flex: 'none', height: 26, padding: '0 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-state-error-primary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' },
      copy: { flex: 'none', height: 22, padding: '0 7px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' },
      bannerWrap: { flex: 'none', display: 'flex', flexDirection: 'column', gap: 6, padding: '0 16px' },
      banner: { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      bannerError: { padding: '7px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      bannerTitle: { display: 'block', fontWeight: 600, marginBottom: 2 },
      loading: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '14px 16px' },
      scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 16px 20px' },
      section: { marginBottom: 18 },
      sectionHead: { margin: '4px 0 8px' },
      sectionTitle: { fontSize: 13, fontWeight: 600 },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0 8px', lineHeight: 1.55 },
      row: { display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6 },
      rowLabel: { flex: 'none', width: 92, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      rowValue: { flex: 1, minWidth: 0, fontSize: 12, wordBreak: 'break-all' },
      inlineRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      urlRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
      link: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-primary)', textDecoration: 'underline', wordBreak: 'break-all' },
      muted: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      field: { marginBottom: 8 },
      fieldLabel: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 },
      input: { width: '100%', boxSizing: 'border-box', height: 28, padding: '0 9px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12, outline: 'none' },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: 66, padding: '6px 9px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5, outline: 'none', resize: 'vertical' },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12 },
      badgeRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
      badge: { display: 'inline-block', padding: '0 6px', borderRadius: 4, fontSize: 11, lineHeight: '18px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-secondary)' },
      badgeStrong: { display: 'inline-block', padding: '0 6px', borderRadius: 4, fontSize: 11, lineHeight: '18px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)' },
      chipList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: { padding: '1px 7px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-l1)', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      qrBox: { marginBottom: 10 },
      qrCard: { width: QR_SIZE, height: QR_SIZE, boxSizing: 'border-box', padding: 10, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      qrImg: { display: 'block', width: '100%', height: '100%' },
      countdown: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
      expired: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 },
      empty: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0 14px' },
      tableWrap: { width: '100%', overflowX: 'auto' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap' },
      td: { padding: '8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
      deviceName: { fontWeight: 600, wordBreak: 'break-word' },
      ua: { maxWidth: 200, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      errorText: { color: 'var(--dsw-alias-state-error-primary)' },
    }

    /* ---------------------------------------------------------------- *
     * Components
     * ---------------------------------------------------------------- */

    function PanelIcon({ size }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        h('rect', { key: 'a', x: 3, y: 6, width: 10, height: 7.6, rx: 1.4 }),
        h('path', { key: 'b', d: 'M1.8 6V4.6a1.2 1.2 0 0 1 1.2-1.2H6' }),
        h('path', { key: 'c', d: 'M8 6V2.6' }),
        h('path', { key: 'd', d: 'M6.6 9.2h2.8M8 9.2v2' }),
      ])
    }

    function Button({ children, onClick, disabled, variant, title }) {
      const style = variant === 'ghost' ? S.ghost : variant === 'danger' ? S.danger : S.button
      return h('button', {
        type: 'button',
        style,
        disabled: disabled === true,
        title,
        onClick: disabled === true ? undefined : onClick,
      }, children)
    }

    /** Copy with a transient confirmation; the timer is cleared on unmount. */
    function CopyButton({ text, label }) {
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1600)
        return () => clearTimeout(timer)
      }, [copied])
      return h('button', {
        type: 'button',
        style: S.copy,
        disabled: typeof text !== 'string' || text === '',
        'aria-label': label ?? tt('panel.copy'),
        onClick: async () => {
          const ok = await copyText(text)
          if (ok) setCopied(true)
        },
      }, copied ? tt('panel.copied') : tt('panel.copy'))
    }

    function Section({ title, children }) {
      return h('section', { style: S.section }, [
        h('div', { key: 'h', style: S.sectionHead }, h('span', { key: 't', style: S.sectionTitle }, title)),
        h('div', { key: 'b' }, children),
      ])
    }

    function Row({ label, children }) {
      return h('div', { style: S.row }, [
        h('span', { key: 'l', style: S.rowLabel }, label),
        h('div', { key: 'v', style: S.rowValue }, children),
      ])
    }

    function Field({ id, label, hint, children }) {
      return h('div', { style: S.field }, [
        h('label', { key: 'l', style: S.fieldLabel, htmlFor: id }, label),
        h('div', { key: 'c' }, children),
        hint !== undefined ? h('div', { key: 'h', style: S.hint }, hint) : null,
      ])
    }

    function Toggle({ id, label, hint, checked, disabled, onChange }) {
      return h('div', null, [
        h('label', { key: 'l', style: S.toggleRow, htmlFor: id }, [
          h('input', {
            key: 'i',
            id,
            type: 'checkbox',
            checked: checked === true,
            disabled: disabled === true,
            onChange: (event) => { if (onChange) onChange(event.target.checked) },
          }),
          h('span', { key: 't' }, label),
        ]),
        hint !== undefined ? h('div', { key: 'h', style: S.hint }, hint) : null,
      ])
    }

    /* ---------------------------------------------------------------- *
     * Page
     * ---------------------------------------------------------------- */

    /*
     * NOTE for the smoke harness: the first N hook calls below are the page's own
     * useState slots, in this order:
     *   0 snapshot, 1 error, 2 notice, 3 busy, 4 qr, 5 qrLeft, 6 passDraft,
     *   7 hostsDraft, 8 hostsDirty, 9 pendingAll, 10 pendingId
     * Child components (CopyButton) call useState after the page body has run.
     */
    function ProcRemotePage() {
      const [snapshot, setSnapshot] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const [busy, setBusy] = useState(undefined)
      const [qr, setQr] = useState(undefined)
      const [qrLeft, setQrLeft] = useState(0)
      const [passDraft, setPassDraft] = useState('')
      const [hostsDraft, setHostsDraft] = useState('')
      const [hostsDirty, setHostsDirty] = useState(false)
      const [pendingAll, setPendingAll] = useState(false)
      const [pendingId, setPendingId] = useState(undefined)
      const mounted = useRef(true)
      const inFlight = useRef(false)

      const load = useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
          const next = await request(API.state)
          if (!mounted.current) return
          setSnapshot(next)
          setError(undefined)
        } catch (cause) {
          if (!mounted.current) return
          setError(String(cause?.message ?? cause))
        } finally {
          inFlight.current = false
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        load()
        return () => {
          mounted.current = false
        }
      }, [load])

      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const allowedKey = Array.isArray(snapshot?.allowedHosts) ? snapshot.allowedHosts.join('\n') : ''
      useEffect(() => {
        if (hostsDirty) return
        setHostsDraft(allowedKey)
      }, [allowedKey, hostsDirty])

      /* Countdown: recompute from the clock, stop the timer at zero. */
      useEffect(() => {
        if (qr === undefined || qr === null) {
          setQrLeft(0)
          return undefined
        }
        let timer
        const tick = () => {
          const end = Number(qr.expiresAt)
          const left = Number.isFinite(end) ? Math.max(0, Math.ceil((end - Date.now()) / TICK_MS)) : 0
          setQrLeft(left)
          if (left <= 0 && timer !== undefined) {
            clearInterval(timer)
            timer = undefined
          }
        }
        tick()
        if (Number(qr.expiresAt) > Date.now()) timer = setInterval(tick, TICK_MS)
        return () => {
          if (timer !== undefined) clearInterval(timer)
        }
      }, [qr])

      /** Every mutation goes through here: one busy key, one error banner, one refetch. */
      const mutate = useCallback(async (key, action, successKey, skipReload) => {
        setBusy(key)
        setError(undefined)
        setNotice(undefined)
        try {
          const result = await action()
          if (result !== null && typeof result === 'object' && result.state !== undefined) setSnapshot(result.state)
          else if (skipReload !== true) await load()
          if (successKey !== undefined) setNotice(tt(successKey))
          return true
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          return false
        } finally {
          setBusy(undefined)
        }
      }, [load])

      const toggleEnabled = useCallback((next) => {
        void mutate('enabled', () => request(API.update, { method: 'POST', body: { enabled: next } }))
      }, [mutate])
      const toggleMobile = useCallback((next) => {
        void mutate('mobile', () => request(API.update, { method: 'POST', body: { mobileAdapt: next } }))
      }, [mutate])
      const toggleRestrict = useCallback((next) => {
        void mutate('restrict', () => request(API.update, { method: 'POST', body: { restrictHosts: next } }))
      }, [mutate])

      const createPair = useCallback(() => {
        void mutate('pair', async () => {
          const result = await request(API.pair, { method: 'POST', body: {} })
          if (result !== null && typeof result === 'object' && typeof result.url === 'string') {
            setQr({ url: result.url, svg: typeof result.svg === 'string' ? result.svg : '', expiresAt: Number(result.expiresAt) || 0 })
          }
          return result
        }, undefined, true)
      }, [mutate])

      const savePassphrase = useCallback(async () => {
        const value = passDraft.trim()
        if (value === '') {
          setNotice(undefined)
          setError(tt('panel.pass.empty'))
          return
        }
        const ok = await mutate('pass', () => request(API.update, { method: 'POST', body: { passphrase: value } }), 'panel.pass.saved')
        if (ok) setPassDraft('')
      }, [passDraft, mutate])

      const saveHosts = useCallback(async () => {
        const list = String(hostsDraft).split('\n').map(line => line.trim()).filter(line => line !== '')
        const ok = await mutate('hosts', () => request(API.update, { method: 'POST', body: { allowedHosts: list } }), 'panel.hosts.saved')
        if (ok) setHostsDirty(false)
      }, [hostsDraft, mutate])

      const revokeOne = useCallback((id) => {
        if (typeof id !== 'string' || id === '') return
        if (pendingId !== id) {
          setPendingId(id)
          setNotice(undefined)
          return
        }
        setPendingId(undefined)
        void mutate(`revoke:${id}`, () => request(API.revoke, { method: 'POST', body: { id } }), 'panel.devices.revoked')
      }, [pendingId, mutate])

      const revokeAll = useCallback(() => {
        if (!pendingAll) {
          setPendingAll(true)
          setNotice(undefined)
          return
        }
        setPendingAll(false)
        void mutate('revokeAll', () => request(API.revoke, { method: 'POST', body: { all: true } }), 'panel.devices.revokedAll')
      }, [pendingAll, mutate])

      const hasState = snapshot !== undefined && snapshot !== null
      const s = hasState ? snapshot : {}

      const urls = useMemo(() => {
        if (!hasState) return []
        const list = []
        if (typeof s.publicUrl === 'string' && s.publicUrl !== '') list.push({ key: `public:${s.publicUrl}`, url: s.publicUrl })
        if (Array.isArray(s.lanUrls)) {
          for (const url of s.lanUrls) if (typeof url === 'string' && url !== '') list.push({ key: `lan:${url}`, url })
        }
        return list
      }, [hasState, s.publicUrl, s.lanUrls])

      const devices = Array.isArray(s.devices) ? s.devices : []
      const autoHosts = Array.isArray(s.autoHosts) ? s.autoHosts : []
      const innerAuth = s.innerAuth === 'ok' || s.innerAuth === 'pending' || s.innerAuth === 'unavailable' ? s.innerAuth : undefined
      const innerAuthText = innerAuth === undefined ? '—' : tt('panel.innerAuth.' + innerAuth)

      function buildStatus() {
        return h(Section, { key: 'status', title: tt('panel.section.status') }, [
          h(Toggle, {
            key: 'enable', id: 'dsh-ra-enabled', label: tt('panel.enable'), hint: tt('panel.enable.hint'),
            checked: s.enabled === true, disabled: busy !== undefined, onChange: toggleEnabled,
          }),
          h(Row, { key: 'listener', label: tt('panel.status.listener') }, h('span', {
            style: s.listening === true ? S.badgeStrong : S.badge,
          }, s.listening === true ? tt('panel.status.listening') : tt('panel.status.stopped'))),
          h(Row, { key: 'port', label: tt('panel.status.port') }, String(s.port ?? '—')),
          h(Row, { key: 'bind', label: tt('panel.status.bind') }, String(s.bindHost ?? '—')),
          h(Row, { key: 'dsh', label: tt('panel.status.dshPort') }, `127.0.0.1:${String(s.dshPort ?? '—')}`),
          h(Row, { key: 'auth', label: tt('panel.status.innerAuth') }, innerAuthText),
          h(Row, { key: 'urls', label: tt('panel.status.urls') }, urls.length === 0
            ? h('span', { style: S.muted }, tt('panel.status.noUrls'))
            : h('div', null, urls.map(item => h('div', { key: item.key, style: S.urlRow }, [
              h('a', { key: 'a', style: S.link, href: item.url, target: '_blank', rel: 'noreferrer' }, item.url),
              h(CopyButton, { key: 'c', text: item.url }),
            ])))),
          typeof s.error === 'string' && s.error !== ''
            ? h(Row, { key: 'error', label: tt('panel.status.error') }, h('span', { style: S.errorText }, s.error))
            : null,
          h('div', { key: 'hint', style: S.hint }, tt('panel.status.hint')),
        ])
      }

      function buildPair() {
        const minted = qr !== undefined && qr !== null
        const hasSvg = minted && typeof qr.svg === 'string' && qr.svg !== ''
        return h(Section, { key: 'pair', title: tt('panel.section.pair') }, [
          h('div', { key: 'hint', style: S.hint }, tt('panel.pair.hint')),
          h('div', { key: 'acts', style: S.inlineRow }, h(Button, { onClick: createPair, disabled: busy !== undefined },
            busy === 'pair' ? tt('panel.pair.creating') : minted ? tt('panel.pair.refresh') : tt('panel.pair.create'))),
          !minted
            ? h('div', { key: 'empty', style: S.empty }, tt('panel.pair.empty'))
            : h('div', { key: 'box', style: S.qrBox }, [
              hasSvg
                ? h('div', { key: 'card', style: S.qrCard }, h('img', {
                  key: 'i', src: svgDataUrl(qr.svg), alt: tt('panel.pair.qrAlt'),
                  width: QR_SIZE - 20, height: QR_SIZE - 20, style: S.qrImg,
                }))
                : null,
              h('div', { key: 'left', style: qrLeft > 0 ? S.countdown : S.expired },
                qrLeft > 0 ? tt('panel.pair.countdown', { n: qrLeft }) : tt('panel.pair.expired')),
              h(Field, { key: 'url', id: 'dsh-ra-pair-url', label: tt('panel.pair.urlLabel') },
                h('div', { style: S.inlineRow }, [
                  h('input', {
                    key: 'i', id: 'dsh-ra-pair-url', type: 'text', readOnly: true, style: S.input, value: qr.url,
                    onFocus: (event) => { try { event.target.select() } catch {} },
                  }),
                  h(CopyButton, { key: 'c', text: qr.url }),
                ])),
              h('div', { key: 'note', style: S.hint }, tt('panel.pair.singleUse')),
            ]),
        ])
      }

      function buildPass() {
        return h(Section, { key: 'pass', title: tt('panel.section.pass') }, [
          h('div', { key: 'state', style: S.badgeRow }, h('span', {
            style: s.passphraseSet === true ? S.badgeStrong : S.badge,
          }, s.passphraseSet === true ? tt('panel.pass.set') : tt('panel.pass.unset'))),
          h('div', { key: 'hint', style: S.hint }, tt('panel.pass.hint')),
          h(Field, { key: 'field', id: 'dsh-ra-pass', label: tt('panel.pass.label') }, h('input', {
            id: 'dsh-ra-pass', type: 'password', style: S.input, value: passDraft,
            placeholder: tt('panel.pass.placeholder'), autoComplete: 'new-password',
            disabled: busy !== undefined,
            onChange: (event) => setPassDraft(event.target.value),
          })),
          h('div', { key: 'acts', style: S.inlineRow }, [
            h(Button, {
              key: 'save', onClick: savePassphrase,
              disabled: busy !== undefined || String(passDraft).trim() === '',
            }, busy === 'pass' ? tt('panel.saving') : tt('panel.pass.save')),
            h(Button, {
              key: 'gen', variant: 'ghost', disabled: busy !== undefined,
              onClick: () => setPassDraft(randomPassphrase()),
            }, tt('panel.pass.generate')),
          ]),
        ])
      }

      function buildMobile() {
        return h(Section, { key: 'mobile', title: tt('panel.section.mobile') }, h(Toggle, {
          id: 'dsh-ra-mobile', label: tt('panel.mobile.label'), hint: tt('panel.mobile.hint'),
          checked: s.mobileAdapt === true, disabled: busy !== undefined, onChange: toggleMobile,
        }))
      }

      function buildHosts() {
        return h(Section, { key: 'hosts', title: tt('panel.section.hosts') }, [
          h(Toggle, {
            key: 'restrict', id: 'dsh-ra-restrict', label: tt('panel.hosts.restrict'),
            hint: s.restrictHosts === true ? tt('panel.hosts.restrict.on') : tt('panel.hosts.restrict.off'),
            checked: s.restrictHosts === true, disabled: busy !== undefined, onChange: toggleRestrict,
          }),
          h(Field, { key: 'allowed', id: 'dsh-ra-hosts', label: tt('panel.hosts.allowed'), hint: tt('panel.hosts.allowed.hint') },
            h('textarea', {
              id: 'dsh-ra-hosts', style: S.textarea, value: hostsDraft, spellCheck: false, rows: 3,
              placeholder: tt('panel.hosts.allowed.placeholder'), disabled: busy !== undefined,
              onChange: (event) => {
                setHostsDirty(true)
                setHostsDraft(event.target.value)
              },
            })),
          h('div', { key: 'save', style: S.inlineRow }, h(Button, { onClick: saveHosts, disabled: busy !== undefined },
            busy === 'hosts' ? tt('panel.saving') : tt('panel.hosts.save'))),
          h(Row, { key: 'auto', label: tt('panel.hosts.auto') }, autoHosts.length === 0
            ? h('span', { style: S.muted }, tt('panel.hosts.auto.empty'))
            : h('div', { style: S.chipList }, autoHosts.map(host => h('span', {
              key: String(host), style: S.chip,
            }, String(host))))),
        ])
      }

      function buildDeviceRow(row) {
        const id = row !== null && typeof row === 'object' && typeof row.id === 'string' ? row.id : ''
        const pending = id !== '' && pendingId === id
        const name = row !== null && typeof row === 'object' && typeof row.name === 'string' && row.name !== ''
          ? row.name
          : tt('panel.devices.unknown')
        return h('tr', { key: id !== '' ? id : `${name}:${String(row?.createdAt ?? '')}` }, [
          h('td', { key: 'n', style: S.td }, h('div', { style: S.deviceName }, name)),
          h('td', { key: 'i', style: { ...S.td, ...S.muted } }, typeof row?.ip === 'string' ? row.ip : '—'),
          h('td', { key: 'c', style: { ...S.td, ...S.muted, whiteSpace: 'nowrap' } }, formatStamp(row?.createdAt)),
          h('td', { key: 'l', style: { ...S.td, ...S.muted, whiteSpace: 'nowrap' } }, formatStamp(row?.lastSeenAt)),
          h('td', {
            key: 'u', style: { ...S.td, ...S.ua }, title: typeof row?.userAgent === 'string' ? row.userAgent : '',
          }, shortUa(row?.userAgent) || '—'),
          h('td', { key: 'a', style: S.td }, h('div', { style: S.inlineRow }, pending
            ? [
              h(Button, { key: 'y', variant: 'danger', disabled: busy !== undefined, onClick: () => revokeOne(id) },
                busy === `revoke:${id}` ? tt('panel.saving') : tt('panel.devices.confirm')),
              h(Button, { key: 'n', variant: 'ghost', disabled: busy !== undefined, onClick: () => setPendingId(undefined) },
                tt('panel.cancel')),
            ]
            : h(Button, { key: 'r', variant: 'danger', disabled: busy !== undefined || id === '', onClick: () => revokeOne(id) },
              tt('panel.devices.revoke')))),
        ])
      }

      function buildDevices() {
        return h(Section, { key: 'devices', title: tt('panel.section.devices') }, [
          h('div', { key: 'head', style: { ...S.inlineRow, marginBottom: 8 } }, [
            h('span', { key: 'c', style: S.muted }, tt('panel.devices.count', { n: devices.length })),
            h(Button, {
              key: 'all', variant: 'danger', disabled: busy !== undefined || devices.length === 0, onClick: revokeAll,
            }, busy === 'revokeAll'
              ? tt('panel.saving')
              : pendingAll ? tt('panel.devices.revokeAllConfirm') : tt('panel.devices.revokeAll')),
            pendingAll
              ? h(Button, { key: 'cancel', variant: 'ghost', disabled: busy !== undefined, onClick: () => setPendingAll(false) },
                tt('panel.cancel'))
              : null,
          ]),
          devices.length === 0
            ? h('div', { key: 'empty', style: S.empty }, tt('panel.devices.empty'))
            : h('div', { key: 'wrap', style: S.tableWrap }, h('table', { style: S.table }, [
              h('thead', { key: 'h' }, h('tr', null, [
                h('th', { key: 'n', style: S.th }, tt('panel.col.name')),
                h('th', { key: 'i', style: S.th }, tt('panel.col.ip')),
                h('th', { key: 'c', style: S.th }, tt('panel.col.created')),
                h('th', { key: 'l', style: S.th }, tt('panel.col.lastSeen')),
                h('th', { key: 'u', style: S.th }, tt('panel.col.ua')),
                h('th', { key: 'a', style: S.th }, tt('panel.col.action')),
              ])),
              h('tbody', { key: 'b' }, devices.map(row => buildDeviceRow(row))),
            ])),
        ])
      }

      return h('div', {
        style: S.view, 'data-dsh-plugin': PANEL_ID, 'data-dsh-remote-access-view': '',
      }, [
        h('div', { key: 'h', style: S.header }, [
          h('div', { key: 't', style: S.headerText }, [
            h('h1', { key: 'x', style: S.title }, tt('panel.title')),
            h('div', { key: 's', style: S.subtitle }, tt('panel.subtitle')),
          ]),
          h(Button, { key: 'r', disabled: busy !== undefined, onClick: () => { setNotice(undefined); void load() } },
            tt('panel.refresh')),
        ]),
        h('div', { key: 'b', style: S.bannerWrap, 'aria-live': 'polite' }, [
          error !== undefined
            ? h('div', { key: 'e', style: S.bannerError }, [
              h('strong', { key: 't', style: S.bannerTitle }, tt('panel.failed')),
              h('span', { key: 'm' }, String(error)),
            ])
            : null,
          notice !== undefined ? h('div', { key: 'n', style: S.banner }, String(notice)) : null,
        ]),
        hasState
          ? h('div', { key: 'scroll', style: S.scroll }, [
            buildStatus(),
            buildPair(),
            buildPass(),
            buildMobile(),
            buildHosts(),
            buildDevices(),
          ])
          : h('div', { key: 'loading', style: S.loading }, tt('panel.loading')),
      ])
    }

    /* ---------------------------------------------------------------- *
     * Client plugin
     * ---------------------------------------------------------------- */

    function registerPanel(ctx) {
      const slots = ctx.slots
      const disposers = []
      disposers.push(slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => tt('entry.label'),
      }, PanelIcon)))
      disposers.push(slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
      }, ProcRemotePage)))
      return () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return () => {}
        }
      }, 'dsh-remote-access: dictionaries')

      try {
        setRuntimeTranslate(ctx.locale.bind(NS))
      } catch {}

      ctx.effect(() => {
        try {
          return registerPanel(ctx)
        } catch (error) {
          console.warn('[dsh-remote-access] panel registration failed:', error)
          return () => {}
        }
      }, 'dsh-remote-access: panel')
    }

    return { name: NS, inject, apply }
  },
})
