/**
 * dsh-job-watch — host half (Node side).
 *
 * Attaches a long-running job id to *one conversation* and keeps its state
 * fresh, so the Web GUI sidebar can colour that conversation's row:
 * pink while a tracked job runs, green once it finished (come back and
 * analyse the result), amber when the id cannot be found anywhere.
 *
 * The plugin owns no job logic of its own. A *provider* is a shell command plus
 * one regex applied per output line; anything that can list what is running is a
 * provider — an HPC scheduler (`squeue`, `bjobs`, a site wrapper), `tmux
 * list-sessions` on a bare-metal box where "a job" is a session name, or your
 * own status CLI. No cluster, queue or path is hard-coded here.
 *
 * State lives in $DSH_HOME/job-watch.json (override with `statePath`).
 */
import { exec } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Stable cordis plugin name (matches the cordis.patch.yml insert id). */
export const name = 'job-watch'

/** Capabilities this plugin needs from the host. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Every knob, and its default. All of them are overridable from the config. */
const DEFAULTS = {
  /** How often the providers are queried. */
  pollMinutes: 30,
  /** Short tick that exists only to notice a suspended machine and catch up. */
  heartbeatSeconds: 60,
  /** Per-command timeout. A hung provider must not stall the ledger. */
  commandTimeoutSeconds: 45,
  /** Never query twice within this gap (registration + page refresh overlap). */
  minPollGapSeconds: 20,
  /** A page request refreshes the state early when the ledger is older than this. */
  requestStaleSeconds: 300,
  /** A registered but never-yet-seen job stays "running" this long, then goes amber. */
  unknownAfterSeconds: 420,
  /** Finished + acknowledged rows are dropped after this long. */
  pruneDays: 7,
  /** What a job vanishing from its provider's listing means: 'done' or 'unknown'. */
  missingMeans: 'done',
  /** Ledger path; empty = $DSH_HOME/job-watch.json. */
  statePath: '',
  /** Provider list; see README. An empty list means nothing can ever be seen. */
  providers: [],
}

const DEFAULT_RUNNING_STATES = [
  'RUN', 'RUNNING', 'WAIT', 'WAITING', 'PEND', 'PENDING', 'QUEUE', 'QUEUED',
  'START', 'STARTING', 'REQUEUE', 'REQUEUED', 'SUSP', 'SUSPENDED', 'DEPEND',
]

const DEFAULT_DONE_STATES = [
  'DONE', 'COMPLETE', 'COMPLETED', 'EXIT', 'EXITED', 'FAIL', 'FAILED',
  'ABORT', 'ABORTED', 'KILL', 'KILLED', 'CANCEL', 'CANCELLED', 'CANCELED',
  'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL',
]

/** Sidebar colours; the browser half uses these when the host sends none. */
const COLORS = { running: '#ec4899', done: '#22c55e', unknown: '#f59e0b' }

const ANSI = /\u001b\[[0-9;]*m/g

/** Wall-vs-monotonic drift above this means the machine was suspended. */
const WAKE_DRIFT_MS = 90 * 1000

/** Job ids are opaque strings: a scheduler number, a tmux session name, a hash. */
const ID_PATTERN = /^[A-Za-z0-9_.:@-]+$/

/**
 * Text injected into every agent's system prompt.
 *
 * The colour only ever appears if the *agent* registers the job id after
 * submitting it — nothing can be inferred from a shell command the agent ran in
 * some other process. So the rule is stated where the agent reads it, and the
 * tool description repeats it.
 */
export const JOB_WATCH_GUIDANCE = [
  '## Long-running jobs → sidebar colour (dsh-job-watch)',
  'After submitting a long-running job (HPC scheduler, `tmux` on a bare-metal box, any provider configured for this profile),',
  'call `job_watch(action="register", jobIds=["<id>"], provider="<provider id>", etaMinutes=<total minutes>)` in the SAME conversation.',
  'That conversation\'s sidebar row turns pink while any tracked job runs and green when all of them finished — green is the',
  '"come back and analyse the result" signal, and it disappears the moment the user really speaks in that conversation.',
  'When reporting status, write each job as `<id> [<provider>] <state> (<STAT>)` and always append the recommended finish time',
  'the tool returns. Never invent a finish time when no ETA was registered: say it cannot be estimated and give the way to measure it.',
  'Triggers: 作业跑完没, 登记作业号, 侧边栏颜色, HPC 作业标记, tmux 作业, job finished?, register job id, sidebar colour.',
].join('\n')

/** $DSH_HOME, falling back to ~/.dsh (the same convention the host uses). */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

function readJson(file, fallback) {
  try {
    const text = readFileSync(file, 'utf8')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function stripAnsi(text) {
  return String(text === undefined || text === null ? '' : text).replace(ANSI, '')
}

function firstLine(text) {
  const line = stripAnsi(text).split(/\r?\n/).find((candidate) => candidate.trim() !== '')
  return line === undefined ? '' : line.trim()
}

function mono() {
  return Number(process.hrtime.bigint()) / 1e6
}

/**
 * Run one provider command.
 *
 * A non-zero exit is NOT fatal: `tmux list-sessions` exits 1 on a box with no
 * sessions, and several schedulers write the listing to stdout while warning on
 * stderr. stdout is parsed regardless, and the failure is reported alongside.
 */
function runCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    try {
      exec(command, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({
          ok: error === null || error === undefined,
          stdout: String(stdout === undefined || stdout === null ? '' : stdout),
          stderr: String(stderr === undefined || stderr === null ? '' : stderr),
          errorText: error === null || error === undefined ? '' : String(error.message === undefined ? error : error.message),
        })
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', errorText: String(error) })
    }
  })
}

/**
 * Parse one provider's stdout into `jobId -> { stat, name }`.
 *
 * The pattern is applied per line and needs a named group `id`; `stat` and `name`
 * are optional (a tmux session listing has neither). Lines that do not match are
 * ignored, so headers, banners and warnings cost nothing.
 */
export function parseListing(text, pattern) {
  const out = new Map()
  let regex
  try {
    regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
  } catch {
    return out
  }
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    if (rawLine.trim() === '') continue
    const match = rawLine.match(regex)
    if (match === null) continue
    const groups = match.groups === undefined ? {} : match.groups
    const rawId = groups.id !== undefined ? groups.id : match[1]
    const id = rawId === undefined || rawId === null ? '' : String(rawId).trim()
    if (id === '') continue
    const rawStat = groups.stat
    const rawName = groups.name
    out.set(id, {
      stat: rawStat === undefined || rawStat === null || String(rawStat).trim() === ''
        ? undefined
        : String(rawStat).trim().toUpperCase(),
      name: rawName === undefined || rawName === null || String(rawName).trim() === ''
        ? undefined
        : String(rawName).trim(),
    })
  }
  return out
}

/**
 * Fold one raw STAT into the vocabulary the browser half paints.
 * No `stat` at all (a present tmux session) counts as running: being listed IS
 * the evidence that it is alive.
 */
export function foldState(stat, provider) {
  const running = provider !== undefined && provider !== null && Array.isArray(provider.runningStates)
    ? provider.runningStates
    : DEFAULT_RUNNING_STATES
  const done = provider !== undefined && provider !== null && Array.isArray(provider.doneStates)
    ? provider.doneStates
    : DEFAULT_DONE_STATES
  if (stat === undefined || stat === null || String(stat).trim() === '') return 'running'
  const value = String(stat).trim().toUpperCase()
  if (running.includes(value)) return 'running'
  if (done.includes(value)) return 'done'
  return 'unknown'
}

function flattenMessage(data) {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return ''
  const content = data.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Whether one `user/message` is a REAL prompt typed by the user.
 *
 * The same event type also carries injected context (workspace instructions,
 * skill catalogs, runtime snapshots). Clearing the green marker on an injected
 * message would silently defeat the feature, so a cheap discriminator is applied
 * and `job_watch(action='clear')` stays the manual fallback. Injected envelopes
 * on this host start with `<` (e.g. `<system-reminder>`) or with the
 * runtime-context banner.
 */
export function isRealPrompt(data) {
  const text = flattenMessage(data).trim()
  if (text === '') return false
  if (text.startsWith('<')) return false
  if (text.startsWith('Current runtime context')) return false
  return true
}

/**
 * The recommended finish time, printed for every tracked job.
 *
 * Deliberately never guesses: either the arithmetic is exact (registration time
 * + the ETA the caller supplied) or the answer says it cannot be estimated and
 * names where to measure it instead.
 */
export function recommendFinish(job, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  if (job === null || job === undefined) return '(no job)'
  const fmt = (ms) => new Date(ms).toLocaleString('en-GB', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const stat = typeof job.stat === 'string' ? job.stat : 'provider no longer lists it'
  if (job.state === 'done') return `finished (${stat}) — analyse it now`
  if (job.state === 'unknown') {
    return 'not found by its provider yet — check the job id, or that the provider can see it '
      + `(job_watch(action="refresh") re-queries now)`
  }
  const base = Number.isFinite(job.startedAt) ? job.startedAt : job.registeredAt
  if (Number.isFinite(job.etaMinutes) && job.etaMinutes > 0 && Number.isFinite(base)) {
    const end = base + job.etaMinutes * 60000
    const left = Math.round((end - now) / 60000)
    if (left > 0) return `expected to finish ${fmt(end)} (about ${left} min left; estimate = registration time + the ${job.etaMinutes} min ETA you gave)`
    return `by your ${job.etaMinutes} min ETA it should already have finished (${fmt(end)}) but the provider still reports it running — refresh, or read the job's log`
  }
  return 'no reliable estimate (no ETA was registered). Register one to get one: '
    + `job_watch(action="register", jobIds=["${job.jobId}"], provider="${job.provider}", etaMinutes=<minutes>) — `
    + 'or read it off the job itself (the scheduler\'s elapsed-time column, or the progress line in the job\'s log)'
}

/** Validate and normalise the plugin config; unknown providers are dropped. */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
  const states = (value, fallback) => (Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().toUpperCase())
    : fallback)
  const providers = []
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : []
  for (const entry of rawProviders) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || entry.id.trim() === '') continue
    if (typeof entry.command !== 'string' || entry.command.trim() === '') continue
    if (typeof entry.linePattern !== 'string' || entry.linePattern.trim() === '') continue
    providers.push({
      id: entry.id.trim(),
      label: typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : entry.id.trim(),
      command: entry.command,
      linePattern: entry.linePattern,
      runningStates: states(entry.runningStates, DEFAULT_RUNNING_STATES),
      doneStates: states(entry.doneStates, DEFAULT_DONE_STATES),
    })
  }
  return {
    pollMinutes: positive(raw.pollMinutes, DEFAULTS.pollMinutes),
    heartbeatSeconds: positive(raw.heartbeatSeconds, DEFAULTS.heartbeatSeconds),
    commandTimeoutSeconds: positive(raw.commandTimeoutSeconds, DEFAULTS.commandTimeoutSeconds),
    minPollGapSeconds: positive(raw.minPollGapSeconds, DEFAULTS.minPollGapSeconds),
    requestStaleSeconds: positive(raw.requestStaleSeconds, DEFAULTS.requestStaleSeconds),
    unknownAfterSeconds: positive(raw.unknownAfterSeconds, DEFAULTS.unknownAfterSeconds),
    pruneDays: positive(raw.pruneDays, DEFAULTS.pruneDays),
    missingMeans: raw.missingMeans === 'unknown' ? 'unknown' : 'done',
    statePath: typeof raw.statePath === 'string' ? raw.statePath : DEFAULTS.statePath,
    providers,
  }
}

/**
 * Mount the ledger, the poller, the `job_watch` tool, the HTTP routes and the
 * session listener.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const statePath = cfg.statePath !== '' ? cfg.statePath : join(dshHome(), 'job-watch.json')

  const stored = readJson(statePath, {})
  /** @type {Record<string, any>} */
  let ledger = {
    version: 1,
    jobs: stored.jobs !== null && typeof stored.jobs === 'object' ? stored.jobs : {},
    lastPollAt: Number.isFinite(stored.lastPollAt) ? stored.lastPollAt : 0,
    lastPollOk: stored.lastPollOk === true,
    lastPollMs: Number.isFinite(stored.lastPollMs) ? stored.lastPollMs : 0,
    lastChanges: Array.isArray(stored.lastChanges) ? stored.lastChanges : [],
  }

  /** Last successful listing, per provider: providerId -> Map(jobId -> {stat,name}). */
  let listing = new Map()
  let inflight = null
  let lastTickWall = Date.now()
  let lastTickMono = mono()

  if (cfg.providers.length === 0) {
    try {
      ctx.logger?.warn?.('[job-watch] no provider is configured — the plugin is mounted but can never see a job; add a `providers:` list to the profile patch')
    } catch { /* logging must never break mounting */ }
  }

  function save() {
    try {
      writeJsonFile(statePath, ledger)
    } catch (error) {
      try { ctx.logger?.warn?.(`[job-watch] cannot write ${statePath}: ${String(error)}`) } catch { /* ignore */ }
    }
  }

  function keyOf(providerId, jobId) {
    return String(providerId) + ':' + String(jobId)
  }

  function prune(now) {
    const cutoff = now - cfg.pruneDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const [key, job] of Object.entries(ledger.jobs)) {
      const stamp = Number.isFinite(job.ackedAt) ? job.ackedAt : job.registeredAt
      if (job.acked === true && Number.isFinite(stamp) && stamp < cutoff) {
        delete ledger.jobs[key]
        removed++
      }
    }
    return removed
  }

  /** Everything the browser half paints, plus the poll bookkeeping. */
  function snapshot() {
    const rank = { unknown: 0, done: 1, running: 2 }
    const sessions = {}
    for (const job of Object.values(ledger.jobs)) {
      if (job.acked === true) continue
      let entry = sessions[job.sessionId]
      if (entry === undefined) {
        entry = { state: 'unknown', jobs: [] }
        sessions[job.sessionId] = entry
      }
      entry.jobs.push({
        jobId: job.jobId,
        provider: job.provider,
        state: job.state,
        ...(typeof job.stat === 'string' ? { stat: job.stat } : {}),
        ...(typeof job.name === 'string' ? { name: job.name } : {}),
      })
      if ((rank[job.state] === undefined ? 0 : rank[job.state]) > (rank[entry.state] === undefined ? 0 : rank[entry.state])) {
        entry.state = job.state
      }
    }
    return {
      colors: COLORS,
      sessions,
      pollMinutes: cfg.pollMinutes,
      lastPollAt: ledger.lastPollAt,
      lastPollOk: ledger.lastPollOk,
      lastPollMs: ledger.lastPollMs,
      providers: cfg.providers.map((provider) => ({ id: provider.id, label: provider.label })),
    }
  }

  /** The green marker clears the moment the user really speaks in that conversation. */
  function ackSession(sessionId) {
    let cleared = 0
    const now = Date.now()
    for (const job of Object.values(ledger.jobs)) {
      if (job.sessionId !== sessionId) continue
      if (job.state !== 'done' || job.acked === true) continue
      job.acked = true
      job.ackedAt = now
      cleared++
    }
    if (cleared > 0) {
      prune(now)
      save()
    }
    return cleared
  }

  async function doPoll(reason) {
    const started = Date.now()
    const nextListing = new Map()
    const errors = []
    for (const provider of cfg.providers) {
      const result = await runCommand(provider.command, cfg.commandTimeoutSeconds * 1000)
      nextListing.set(provider.id, parseListing(result.stdout, provider.linePattern))
      if (result.ok !== true) {
        const detail = firstLine(result.stderr) !== '' ? firstLine(result.stderr) : firstLine(result.errorText)
        errors.push(provider.id + ': ' + (detail === '' ? 'command failed' : detail))
      }
    }

    const now = Date.now()
    const changes = []
    for (const job of Object.values(ledger.jobs)) {
      const provider = cfg.providers.find((candidate) => candidate.id === job.provider)
      if (provider === undefined) continue
      const seen = nextListing.get(provider.id) === undefined ? undefined : nextListing.get(provider.id).get(job.jobId)
      const before = job.state
      if (seen !== undefined) {
        job.stat = seen.stat
        if (seen.name !== undefined) job.name = seen.name
        job.state = foldState(seen.stat, provider)
        job.seenAt = now
        if (!Number.isFinite(job.startedAt)) job.startedAt = job.registeredAt
      } else if (Number.isFinite(job.seenAt)) {
        job.state = cfg.missingMeans === 'done' ? 'done' : 'unknown'
        delete job.stat
      } else {
        job.state = now - job.registeredAt > cfg.unknownAfterSeconds * 1000 ? 'unknown' : 'running'
      }
      if (before !== job.state) {
        changes.push({
          jobId: job.jobId,
          provider: job.provider,
          from: before,
          to: job.state,
          ...(typeof job.stat === 'string' ? { stat: job.stat } : {}),
        })
      }
    }

    listing = nextListing
    ledger.lastPollAt = now
    ledger.lastPollOk = errors.length === 0
    ledger.lastPollMs = now - started
    ledger.lastChanges = changes
    prune(now)
    save()
    return {
      ok: errors.length === 0,
      reason,
      ms: ledger.lastPollMs,
      changes,
      errors,
      providers: cfg.providers.map((provider) => ({ id: provider.id, seen: nextListing.get(provider.id).size })),
    }
  }

  function poll(reason) {
    if (inflight !== null) return inflight
    inflight = doPoll(reason).finally(() => { inflight = null })
    return inflight
  }

  /**
   * Query only when the ledger has gone stale. This is what turns an incoming
   * page request — or a machine waking up from sleep — into a real query without
   * ever hammering the providers.
   */
  function catchUp(reason, staleMs) {
    if (Date.now() - ledger.lastPollAt < staleMs) return false
    void poll(reason)
    return true
  }

  /** Register `jobIds` (or auto-claim what the providers currently list). */
  async function register(sessionId, input) {
    const wanted = Array.isArray(input.jobIds)
      ? input.jobIds.filter((value) => typeof value === 'string' && ID_PATTERN.test(value.trim())).map((value) => value.trim())
      : []
    const rejected = Array.isArray(input.jobIds)
      ? input.jobIds.filter((value) => typeof value !== 'string' || !ID_PATTERN.test(String(value).trim()))
      : []

    let providers = cfg.providers
    if (typeof input.provider === 'string' && input.provider.trim() !== '') {
      const wanted_ = input.provider.trim()
      const found = cfg.providers.filter((provider) => provider.id === wanted_)
      if (found.length === 0) {
        return {
          message: `Unknown provider "${wanted_}". Configured providers: `
            + (cfg.providers.length === 0 ? '(none — add a `providers:` list to the profile patch)' : cfg.providers.map((provider) => provider.id).join(', ')),
          jobs: [],
        }
      }
      providers = found
    }

    // Auto-claim needs a listing that is at least as recent as the registration.
    if (wanted.length === 0 && providers.length > 0) {
      await poll('register')
    }

    const now = Date.now()
    const registered = []
    for (const provider of providers) {
      const items = wanted.length > 0
        ? wanted.map((jobId) => [jobId, undefined])
        : Array.from((listing.get(provider.id) === undefined ? new Map() : listing.get(provider.id)).entries())
      for (const [jobId, seen] of items) {
        if (wanted.length === 0 && seen !== undefined && foldState(seen.stat, provider) !== 'running') continue
        if (wanted.length === 0) {
          const claimed = Object.values(ledger.jobs).some((job) => job.provider === provider.id && job.jobId === jobId)
          if (claimed) continue
        }
        const key = keyOf(provider.id, jobId)
        const existing = ledger.jobs[key]
        const entry = existing !== undefined && existing !== null ? existing : {
          jobId,
          provider: provider.id,
          registeredAt: now,
          startedAt: now,
        }
        entry.sessionId = sessionId
        entry.acked = false
        delete entry.ackedAt
        if (typeof input.note === 'string' && input.note.trim() !== '') entry.note = input.note.trim()
        if (typeof input.etaMinutes === 'number' && Number.isFinite(input.etaMinutes) && input.etaMinutes > 0) entry.etaMinutes = input.etaMinutes
        if (typeof seen === 'object' && seen !== null) {
          entry.stat = seen.stat
          if (seen.name !== undefined) entry.name = seen.name
          entry.state = foldState(seen.stat, provider)
          entry.seenAt = now
        } else if (entry.state === undefined) {
          entry.state = 'running'
        }
        ledger.jobs[key] = entry
        registered.push(key)
      }
    }
    save()

    const polled = await poll('register')

    const lines = []
    if (registered.length === 0) {
      lines.push(wanted.length > 0
        ? 'Nothing registered: no job id passed validation.'
        : 'Nothing registered by auto-claim: no provider currently lists a running job that is not already tracked.')
    } else {
      lines.push(`Registered ${registered.length} job(s) to this conversation:`)
      for (const key of registered) {
        const job = ledger.jobs[key]
        lines.push(`- ${job.jobId} [${job.provider}] ${job.state}${typeof job.stat === 'string' ? ' (' + job.stat + ')' : ''}`
          + `${typeof job.name === 'string' ? ' · ' + job.name : ''}`)
        lines.push(`  ⏰ ${recommendFinish(job, Date.now())}`)
      }
    }
    if (rejected.length > 0) lines.push(`Rejected (allowed: letters, digits, _ . : @ -): ${rejected.join(', ')}`)
    lines.push(`Sidebar: this conversation is now ${snapshot().sessions[sessionId] === undefined ? 'unmarked' : snapshot().sessions[sessionId].state}; `
      + `re-queried every ${cfg.pollMinutes} min (sleep/wake and reopening the page also re-query). Green disappears once you speak here.`)
    if (polled.errors.length > 0) lines.push(`Provider warnings: ${polled.errors.join(' | ')}`)
    if (polled.changes.length > 0) {
      lines.push('State changes this poll: ' + polled.changes.map((change) => `${change.jobId} ${change.from} → ${change.to}`).join(', '))
    }
    return { message: lines.join('\n'), jobs: registered.map((key) => ledger.jobs[key]) }
  }

  /** The full report for this conversation (plus who else is tracking). */
  function report(action, polled, sessionId) {
    const now = Date.now()
    const mine = Object.values(ledger.jobs).filter((job) => job.sessionId === sessionId)
    const others = Object.values(ledger.jobs).filter((job) => job.sessionId !== sessionId)
    const lines = []
    if (mine.length === 0) {
      lines.push('No job is tracked in this conversation.')
    } else {
      lines.push(`Tracking ${mine.length} job(s) in this conversation:`)
      for (const job of mine) {
        lines.push(`- ${job.jobId} [${job.provider}] ${job.state}${typeof job.stat === 'string' ? ' (' + job.stat + ')' : ''}`
          + `${typeof job.name === 'string' ? ' · ' + job.name : ''}`)
        lines.push(`  ⏰ ${recommendFinish(job, now)}`)
      }
    }
    const running = mine.filter((job) => job.state === 'running').length
    const done = mine.filter((job) => job.state === 'done' && job.acked !== true).length
    if (mine.length > 0) {
      lines.push(`Sidebar: ${running > 0 ? 'pink (running)' : done > 0 ? 'green (finished — come back and analyse)' : 'no colour yet'}; `
        + `last poll ${ledger.lastPollAt === 0 ? 'never' : new Date(ledger.lastPollAt).toLocaleString('en-GB', { hour12: false })}`
        + `${ledger.lastPollOk === true ? '' : ' (last poll reported a provider error)'}`)
    }
    if (others.length > 0) lines.push(`${others.length} other job(s) are tracked, in other conversations.`)
    if (polled !== null && polled !== undefined) {
      if (polled.changes.length > 0) lines.push('State changes: ' + polled.changes.map((change) => `${change.jobId} ${change.from} → ${change.to}`).join(', '))
      if (polled.errors.length > 0) lines.push('Provider warnings: ' + polled.errors.join(' | '))
    }
    return { message: lines.join('\n'), jobs: mine, action }
  }

  const toolDefinition = {
    name: 'job_watch',
    description: 'Attach a long-running job id to THIS conversation so the DSH Web sidebar colour-marks the conversation: '
      + 'pink while a tracked job runs, green once it finished (the user must come back and analyse the result), amber when the id cannot be found. '
      + 'The plugin polls the configured providers by itself (default every 30 minutes); this tool is how a job id gets attached to a conversation. '
      + 'Call it IMMEDIATELY after submitting a job — a job nobody registered has no colour. '
      + 'Every answer lists each tracked job as `<id> [provider] state (STAT)`, names the jobs whose state just changed, and prints a recommended finish time '
      + '(calculated from the ETA you register; it says so explicitly when no ETA was given rather than guessing). '
      + 'Actions: register (default; omit jobIds to auto-claim every running job no one tracks yet), list, clear (drop this conversation\'s markers, e.g. before resubmitting), refresh (query now). '
      + 'Triggers: 作业提交后上报, 登记作业号, 作业跑完没, 侧边栏颜色, 作业标记, HPC 作业, tmux 作业, register job id, job finished?, sidebar colour.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'list', 'clear', 'refresh'],
          description: 'register (default, attach job ids) / list (what this conversation tracks) / clear (drop this conversation\'s markers) / refresh (query the providers now)',
        },
        jobIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job ids to register: a scheduler job number, a tmux session name, any opaque id the configured provider can find. '
            + 'Omit to auto-claim every job the providers currently list as running and that nobody tracks yet. For clear, omit to drop all of this conversation\'s markers.',
        },
        provider: {
          type: 'string',
          description: 'Which configured provider the ids belong to. Omit when only one provider is configured (then all providers are used for auto-claim).',
        },
        note: {
          type: 'string',
          description: 'Optional free-text note (experiment name, what this job is) kept in the ledger for your own later reference.',
        },
        etaMinutes: {
          type: 'number',
          description: 'Optional: your estimate of the total runtime in minutes. Registering it lets every later report compute a recommended finish time; without it the report says the time cannot be estimated.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          message: { type: 'string' },
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                jobId: { type: 'string' },
                provider: { type: 'string' },
                state: { type: 'string' },
                stat: { type: 'string' },
                name: { type: 'string' },
                sessionId: { type: 'string' },
              },
              required: ['jobId', 'provider', 'state'],
            },
          },
        },
        required: ['action', 'message', 'jobs'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },

    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'register'
      const session = exec?.agent?.session
      const sessionId = session?.id !== undefined && session?.id !== null ? String(session.id) : ''
      if (sessionId === '') throw new Error('job_watch must be called from a conversation (no session id available)')

      if (action === 'refresh') return { action, ...report(action, await poll('manual'), sessionId) }
      if (action === 'list') return { action, ...report(action, null, sessionId) }

      if (action === 'clear') {
        let removed = 0
        const wanted = Array.isArray(input.jobIds)
          ? input.jobIds.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
          : []
        for (const [key, job] of Object.entries(ledger.jobs)) {
          if (job.sessionId !== sessionId) continue
          if (job.acked === true) continue
          if (wanted.length > 0 && !wanted.includes(job.jobId)) continue
          delete ledger.jobs[key]
          removed++
        }
        save()
        return {
          action,
          message: removed === 0
            ? 'Nothing to clear in this conversation.'
            : `Cleared ${removed} marker(s) from this conversation.`,
          jobs: [],
        }
      }

      const result = await register(sessionId, input)
      return {
        action,
        message: result.message,
        jobs: result.jobs.map((job) => ({
          jobId: String(job.jobId),
          provider: String(job.provider),
          state: String(job.state),
          ...(typeof job.stat === 'string' ? { stat: job.stat } : {}),
          ...(typeof job.name === 'string' ? { name: job.name } : {}),
          ...(typeof job.sessionId === 'string' ? { sessionId: job.sessionId } : {}),
        })),
      }
    },
  }

  // ---- wiring --------------------------------------------------------------

  const routes = [
    {
      kind: 'exact',
      path: '/api/job-watch/state',
      handler: (req, res) => {
        // Opening or refreshing the GUI is a user-activity signal: when the
        // ledger is stale (machine was asleep, page closed for hours), query
        // now. Fire-and-forget so the response is never held up by a provider.
        catchUp('request', cfg.requestStaleSeconds * 1000)
        sendJson(res, 200, snapshot())
      },
    },
    {
      kind: 'exact',
      path: '/api/job-watch/ack',
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const body = await readJsonBody(req)
        const sessionId = body !== null && typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') { sendJson(res, 400, { ok: false, error: 'sessionId is required' }); return }
        sendJson(res, 200, { ok: true, cleared: ackSession(sessionId) })
      },
    },
    {
      kind: 'exact',
      path: '/api/job-watch/refresh',
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        const result = await poll('manual')
        sendJson(res, 200, { ...result, state: snapshot() })
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'job-watch: routes')

  ctx.effect(() => ctx.tools.register(toolDefinition), 'job-watch: tool')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-job-watch',
    order: 152,
    text: JOB_WATCH_GUIDANCE,
  }), 'job-watch: guidance')

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object') return
    if (event.type !== 'user/message') return
    const sessionId = session?.id !== undefined && session?.id !== null ? String(session.id) : ''
    if (sessionId === '') return
    if (!isRealPrompt(event.data)) return
    const cleared = ackSession(sessionId)
    if (cleared > 0) {
      try { ctx.logger?.info?.(`[job-watch] session ${sessionId} has a new instruction — cleared ${cleared} finished marker(s)`) } catch { /* ignore */ }
    }
  })

  const timer = setInterval(() => {
    catchUp('interval', cfg.pollMinutes * 60 * 1000)
  }, cfg.pollMinutes * 60 * 1000)
  timer.unref?.()

  // A suspended machine freezes every timer, so a timer firing "on time" proves
  // nothing. The wall clock advancing much faster than the monotonic clock is
  // the actual evidence of a suspend — catch up immediately when it appears.
  const heartbeatTimer = setInterval(() => {
    const wall = Date.now()
    const monotonic = mono()
    const wallDelta = wall - lastTickWall
    const monotonicDelta = monotonic - lastTickMono
    lastTickWall = wall
    lastTickMono = monotonic
    if (wallDelta - monotonicDelta > WAKE_DRIFT_MS) {
      catchUp('wake', cfg.minPollGapSeconds * 1000)
      return
    }
    catchUp('heartbeat', cfg.pollMinutes * 60 * 1000)
  }, cfg.heartbeatSeconds * 1000)
  heartbeatTimer.unref?.()

  ctx.effect(() => () => {
    clearInterval(timer)
    clearInterval(heartbeatTimer)
  }, 'job-watch: poller')

  // One look at startup so a marker left over from a previous run is refreshed.
  const startupTimer = setTimeout(() => { void poll('startup') }, 5000)
  startupTimer.unref?.()

  return undefined
}

// ---- small HTTP helpers ----------------------------------------------------

function sendJson(res, status, body) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch {
    // The socket may already be gone; nothing useful to do.
  }
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { resolve(null) }
    })
    req.on('error', () => { resolve(null) })
  })
}
