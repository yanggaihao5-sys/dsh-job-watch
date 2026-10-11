/**
 * dsh-job-watch — browser half, wrapped in the harness client-bundle format.
 *
 * The GUI does NOT load a client bundle as a plain ES module: the served file
 * must call window.__ModuleLoader__.load({ id, factory }) so the module system
 * registers the factory before apply is requested.
 *
 * What it does: every tracked conversation row in the left sidebar gets a colour
 * bar plus a dot — pink while a tracked job of that conversation runs, green
 * once it finished (the user must come back and analyse), amber when the id
 * cannot be found. The host half owns all state (it queries the configured
 * providers and clears the green marker when the user speaks); this half only
 * reads '/api/job-watch/state' and paints.
 *
 * Deliberately framework-free (plain DOM, no React, no slots): the official
 * sidebar exposes no per-row decoration slot, so the mark is injected into the
 * row element itself. The row's session id is recovered from the React fiber
 * chain hanging off that DOM node (`memoizedProps.node.id`); if that ever stops
 * working the console reports it instead of failing silently.
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-watch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Same-origin state endpoint owned by the host half. */
    const STATE_URL = '/api/job-watch/state'

    /** How often the (cheap, local) state endpoint is re-read. */
    const STATE_MS = 15000

    /** How often the sidebar DOM is re-scanned for rows. */
    const SCAN_MS = 1500

    /** Injected stylesheet id — one instance per page, replaced on hot reload. */
    const STYLE_ID = 'dsh-job-watch-style'

    /** Marker element class names. */
    const BAR_CLASS = 'dsh-job-watch-bar'
    const DOT_CLASS = 'dsh-job-watch-dot'

    /** Per-element marker bookkeeping property. */
    const FLAG = '__dshJobWatch'

    /** Row attribute carrying the state (handy in devtools, and for CSS). */
    const ATTR = 'data-job-watch'

    /** Paint colours; the host sends the same values and wins when present. */
    const COLOR = { running: '#ec4899', done: '#22c55e', unknown: '#f59e0b' }

    /** Tooltip text per state. */
    const LABEL = {
      running: 'Job running',
      done: 'Job finished · come back and analyse',
      unknown: 'Job not found by its provider',
    }

    /** Latest host snapshot. */
    let state = { sessions: {} }

    /** Row detection diagnostics, exposed for troubleshooting. */
    let stats = { rows: 0, resolved: 0, marked: 0 }

    /** One injected stylesheet (idempotent across hot reloads). */
    function ensureStyle() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null && existing !== undefined) existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.' + BAR_CLASS + '{position:absolute;left:0;top:2px;bottom:2px;width:3px;',
        'border-radius:0 2px 2px 0;z-index:6;pointer-events:auto}',
        '.' + DOT_CLASS + '{flex:0 0 auto;width:8px;height:8px;margin-right:6px;border-radius:50%;',
        'z-index:6;pointer-events:auto;box-shadow:0 0 0 2px rgba(127,127,127,0.18)}',
        '.' + DOT_CLASS + '[data-running="1"]{animation:dsh-job-watch-pulse 1.4s ease-in-out infinite}',
        '@keyframes dsh-job-watch-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)}}',
      ].join('')
      document.head.appendChild(style)
    }

    /** Colour for one rollup state. */
    function colorOf(sessionState) {
      const fromHost = state !== null && typeof state === 'object' && state.colors !== null && typeof state.colors === 'object'
        ? state.colors[sessionState]
        : undefined
      if (typeof fromHost === 'string' && fromHost !== '') return fromHost
      return COLOR[sessionState] !== undefined ? COLOR[sessionState] : COLOR.unknown
    }

    /** Tooltip for one rollup state, listing the tracked jobs. */
    function titleOf(info) {
      const head = LABEL[info.state] !== undefined ? LABEL[info.state] : LABEL.unknown
      const jobs = Array.isArray(info.jobs) ? info.jobs : []
      const parts = []
      for (const job of jobs) {
        if (job === null || typeof job !== 'object') continue
        const where = typeof job.provider === 'string' ? job.provider + ' ' : ''
        parts.push(where + String(job.jobId) + (typeof job.stat === 'string' ? ' (' + job.stat + ')' : ''))
      }
      return parts.length === 0 ? head : head + '\n' + parts.join('\n')
    }

    /**
     * Recover a conversation's session id from a sidebar row element.
     *
     * The row renderer puts nothing identifying in the DOM, but React hangs the
     * fiber chain off the node: walking `return` a few frames reaches the
     * `SessionNodeItem` props, whose `node` is the SessionNode (it always
     * carries `updatedAt`, and `blank` for the provisional row — the search
     * result node does not, so the two row kinds cannot be confused).
     */
    function sessionIdOf(element) {
      let fiber
      const names = Object.getOwnPropertyNames(element)
      for (const name of names) {
        if (name.indexOf('__reactFiber$') === 0) { fiber = element[name]; break }
      }
      if (fiber === undefined || fiber === null) return undefined
      for (let depth = 0; fiber !== undefined && fiber !== null && depth < 24; depth++) {
        const props = fiber.memoizedProps
        if (props !== null && typeof props === 'object') {
          const node = props.node
          if (node !== null && typeof node === 'object' && typeof node.id === 'string'
            && (node.updatedAt !== undefined || node.blank !== undefined)) {
            return node.id
          }
          if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId
        }
        fiber = fiber.return
      }
      return undefined
    }

    /** Remove one row's marker. */
    function unmark(row) {
      const mark = row[FLAG]
      if (mark !== undefined && mark !== null) {
        if (mark.bar !== undefined && mark.bar !== null) mark.bar.remove()
        if (mark.dot !== undefined && mark.dot !== null) mark.dot.remove()
        delete row[FLAG]
      }
      row.removeAttribute(ATTR)
    }

    /** Create the marker pair inside one row and remember it. */
    function mark(row, info) {
      const bar = document.createElement('span')
      bar.className = BAR_CLASS
      const dot = document.createElement('span')
      dot.className = DOT_CLASS
      try {
        if (typeof getComputedStyle === 'function' && getComputedStyle(row).position === 'static') {
          row.style.position = 'relative'
        }
      } catch (error) {
        row.style.position = 'relative'
      }
      row.appendChild(bar)
      row.appendChild(dot)
      row[FLAG] = { bar: bar, dot: dot }
      return row[FLAG]
    }

    /** Paint (or refresh) one row from its session rollup. */
    function paint(row, info) {
      if (info === undefined || info === null) { unmark(row); return }
      let mark_ = row[FLAG]
      const alive = mark_ !== undefined && mark_ !== null
        && mark_.bar !== undefined && mark_.bar.isConnected === true && mark_.bar.parentNode === row
        && mark_.dot !== undefined && mark_.dot.isConnected === true && mark_.dot.parentNode === row
      if (!alive) {
        if (mark_ !== undefined && mark_ !== null) unmark(row)
        mark_ = mark(row, info)
      }
      const color = colorOf(info.state)
      mark_.bar.style.background = color
      mark_.dot.style.background = color
      mark_.dot.setAttribute('data-running', info.state === 'running' ? '1' : '0')
      const title = titleOf(info)
      mark_.bar.title = title
      mark_.dot.title = title
      row.setAttribute(ATTR, String(info.state))
      stats.marked++
    }

    /** One pass over every sidebar row. */
    function scan(removeAll) {
      const sessions = state !== null && typeof state === 'object' && state.sessions !== null && typeof state.sessions === 'object'
        ? state.sessions
        : {}
      const rows = document.querySelectorAll('[role="treeitem"]')
      stats.rows = rows.length
      stats.resolved = 0
      stats.marked = 0
      for (const row of rows) {
        const sessionId = sessionIdOf(row)
        if (sessionId === undefined) {
          if (removeAll === true) unmark(row)
          continue
        }
        stats.resolved++
        if (removeAll === true) { unmark(row); continue }
        paint(row, sessions[sessionId])
      }
    }

    /** Re-read the host snapshot and repaint immediately. */
    function refresh() {
      if (typeof fetch !== 'function') return
      fetch(STATE_URL, { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok === true ? response.json() : null))
        .then((payload) => {
          if (payload === null || typeof payload !== 'object') return
          state = payload
          scan(false)
        })
        .catch(() => { /* host half not up yet — the next tick retries */ })
    }

    /**
     * Mount the sidebar colour marks.
     * @param ctx - client plugin context (only `effect` is used).
     */
    function apply(ctx) {
      ensureStyle()
      refresh()
      let scanTimer = null
      let stateTimer = null
      scanTimer = setInterval(() => { scan(false) }, SCAN_MS)
      stateTimer = setInterval(() => { if (document.hidden !== true) refresh() }, STATE_MS)

      // "I just came back to the page" is a user-activity signal: refetch right
      // away instead of waiting for the next tick. The host half turns a state
      // request whose ledger is stale into a real query, so returning to the tab
      // after a sleep also refreshes the job states.
      const onVisible = () => { if (document.hidden !== true) refresh() }
      document.addEventListener('visibilitychange', onVisible)
      window.addEventListener('focus', onVisible)

      const teardown = () => {
        if (scanTimer !== null) clearInterval(scanTimer)
        if (stateTimer !== null) clearInterval(stateTimer)
        scanTimer = null
        stateTimer = null
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('focus', onVisible)
        scan(true)
        const style = document.getElementById(STYLE_ID)
        if (style !== null && style !== undefined) style.remove()
      }

      if (ctx !== null && ctx !== undefined && typeof ctx.effect === 'function') {
        ctx.effect(() => teardown, 'job-watch: sidebar marks')
      } else {
        window.addEventListener('pagehide', teardown)
      }

      // Exposed so a wiring problem is diagnosable from the console instead of
      // looking like "the feature does nothing".
      window.__dshJobWatch = {
        stats: () => stats,
        state: () => state,
        rescans: () => { scan(false) },
        refresh: () => { refresh() },
      }
      console.log('[job-watch] mounted: sidebar conversation colour marks (pink = job running, green = finished, come back and analyse)')
    }

    exports.apply = apply
    return module.exports
  },
})
