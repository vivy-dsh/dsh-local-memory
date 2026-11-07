/**
 * ActMem's outbound archive ledger.
 *
 * The local `memory-card-full.jsonl` stays the source of truth for this installation; this module only
 * derives delivery intents from it, asks the archive owner for the real state before re-sending, and
 * removes an intent only after a receipt is durably appended. A missing receipt therefore means
 * "unknown", never "archived".
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ARCHIVE_ID_PATTERN, ARCHIVE_SCHEMA_VERSION, archiveDigest } from '../../_shared/archive-contract.mjs'
import { isSubjectId, normalizeProvenance } from '../../_shared/contracts.mjs'

export const ARCHIVE_OUT_SCHEMA_VERSION = 1

const DEFAULTS = Object.freeze({
  enabled: true,
  batchLimit: 50,
  batchBytes: 200000,
  statusLimit: 200,
  baseDelayMs: 60000,
  maxDelayMs: 1800000,
  maxAttempts: 0,
  maxPending: 10000,
})

const MAX_DELAY = 86_400_000

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

export function normalizeArchiveOutConfig(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const baseDelayMs = clampInt(source.baseDelayMs, DEFAULTS.baseDelayMs, 1000, MAX_DELAY)
  const maxDelayMs = Math.max(baseDelayMs, clampInt(source.maxDelayMs, Math.max(baseDelayMs, DEFAULTS.maxDelayMs), baseDelayMs, MAX_DELAY))
  return {
    enabled: source.enabled !== false,
    batchLimit: clampInt(source.batchLimit, DEFAULTS.batchLimit, 1, 200),
    batchBytes: clampInt(source.batchBytes, DEFAULTS.batchBytes, 4096, 393216),
    statusLimit: clampInt(source.statusLimit, DEFAULTS.statusLimit, 1, 200),
    baseDelayMs,
    maxDelayMs,
    maxAttempts: clampInt(source.maxAttempts, DEFAULTS.maxAttempts, 0, 100),
    maxPending: clampInt(source.maxPending, DEFAULTS.maxPending, 1, 100000),
  }
}

function fail(code, message, hint) {
  const error = new Error(message)
  error.code = code
  if (hint) error.hint = hint
  return error
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function errorRecord(code, error, at) {
  const record = {
    code: String(code || error?.code || 'ACTMEM_ARCHIVE_TRANSPORT_FAILED'),
    message: String(error?.message ?? error),
    at: iso(at),
  }
  if (error?.hint) record.hint = String(error.hint)
  return record
}

function errorResult(error, extra = {}) {
  const code = String(error?.code || 'ACTMEM_ARCHIVE_TRANSPORT_FAILED')
  return {
    ok: false,
    code,
    error: String(error?.message ?? error),
    ...(error?.hint ? { hint: String(error.hint) } : {}),
    ...extra,
  }
}

function errorFromResponse(response) {
  const error = new Error(String(response?.error || '归档组件返回失败'))
  error.code = String(response?.code || 'ACTMEM_ARCHIVE_TRANSPORT_FAILED')
  if (response?.hint) error.hint = String(response.hint)
  return error
}

function identityOf(stat) {
  return { dev: Number(stat.dev), ino: Number(stat.ino) }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

function sectionOf(record) {
  if (record.platform === 'pet') return 'pet'
  if (Array.isArray(record.tags) && record.tags.includes('owner')) return 'owner'
  if (record.platform === 'bili') return 'bili'
  if (record.platform === 'qq') return 'qq'
  return 'other'
}

function importanceOf(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number / 100)) : 0.5
}

/**
 * `archive_id` is minted here and stays stable across retries: a record edit bumps the revision, which
 * produces a new id instead of silently reusing the old ledger entry.
 */
function buildIntent(record, subjectId, at) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('ACTMEM_ARCHIVE_INTENT_INVALID', '归档记录必须是对象')
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) throw fail('ACTMEM_ARCHIVE_INTENT_INVALID', '归档记录缺少 id')
  const revision = Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : 1
  const archiveId = `arch_${id}_r${revision}`
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) throw fail('ACTMEM_ARCHIVE_INTENT_INVALID', `归档标识 ${archiveId} 不合法`)
  const content = String(record.text ?? '').trim()
  if (!content) throw fail('ACTMEM_ARCHIVE_INTENT_INVALID', `归档记录 ${id} 没有正文`)
  let provenance
  try { provenance = normalizeProvenance(record.provenance) } catch { throw fail('ACTMEM_ARCHIVE_INTENT_INVALID', `归档记录 ${id} 缺少有效 provenance`) }
  const meta = {
    project: sectionOf(record),
    topic: String(record.kind || 'general'),
    timestamp: String(record.createdAt || record.archivedAt || iso(at)),
    session_id: String(record.conversationKey || ''),
    importance: importanceOf(record.importance),
    revision,
    provenance,
  }
  return {
    version: ARCHIVE_OUT_SCHEMA_VERSION,
    archive_id: archiveId,
    digest: archiveDigest({ schema_version: ARCHIVE_SCHEMA_VERSION, subject_id: subjectId, archive_id: archiveId, content, meta }),
    subject_id: subjectId,
    content,
    meta,
    attempts: 0,
    created_at: iso(at),
    next_attempt_at: 0,
    last_error: null,
  }
}

function readRange(file, start, length) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const bytes = readSync(fd, buffer, read, length - read, start + read)
      if (bytes <= 0) break
      read += bytes
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export function createArchiveOutbox({ stateDir, fullJsonl, config, subject, send, log = () => {}, now = Date.now } = {}) {
  if (!stateDir || !fullJsonl) throw new Error('归档出站账本需要 stateDir 与 fullJsonl')
  if (typeof subject !== 'function' || typeof send !== 'function') throw new Error('归档出站账本需要 subject 与 send')
  const outboxDir = join(stateDir, 'data', 'archive-outbox')
  const pendingDir = join(outboxDir, 'pending')
  const conflictDir = join(outboxDir, 'conflict')
  const stateFile = join(outboxDir, 'state.json')
  const receiptsFile = join(outboxDir, 'receipts.jsonl')
  const clock = () => {
    const value = Number(now())
    return Number.isFinite(value) ? value : Date.now()
  }
  const currentConfig = () => normalizeArchiveOutConfig(typeof config === 'function' ? config() : config)
  const pendingPath = archiveId => join(pendingDir, `${archiveId}.json`)
  const conflictPath = archiveId => join(conflictDir, `${archiveId}.json`)

  function ensureDirs() {
    mkdirSync(outboxDir, { recursive: true, mode: 0o700 })
    mkdirSync(pendingDir, { recursive: true, mode: 0o700 })
    mkdirSync(conflictDir, { recursive: true, mode: 0o700 })
  }

  function defaultState() {
    return { version: 1, scan_offset: 0, scan_identity: null, next_attempt_at: 0, last_error: null, swept_lines: 0, invalid_lines: 0 }
  }

  function loadState() {
    if (!existsSync(stateFile)) return null
    let data
    try { data = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { throw fail('ACTMEM_ARCHIVE_STATE_INVALID', '归档出站状态损坏，已暂停投递', '检查 data/archive-outbox/state.json 后重试') }
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.scan_offset) || data.scan_offset < 0) throw fail('ACTMEM_ARCHIVE_STATE_INVALID', '归档出站状态格式无效，已暂停投递', '检查 data/archive-outbox/state.json 后重试')
    return { ...defaultState(), ...data }
  }

  function writeState(state) {
    const temp = `${stateFile}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(temp, stateFile)
  }

  function atomicJson(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }

  function writeIntent(intent) {
    ensureDirs()
    atomicJson(pendingPath(intent.archive_id), intent)
  }

  function deleteIntent(intent) {
    try { unlinkSync(pendingPath(intent.archive_id)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  function quarantine(intent, conflict) {
    ensureDirs()
    atomicJson(conflictPath(intent.archive_id), { ...intent, conflict })
    deleteIntent(intent)
  }

  function listPending() {
    try { return readdirSync(pendingDir).filter(name => name.endsWith('.json')) } catch { return [] }
  }

  function readPendingIntents() {
    const intents = []
    for (const name of listPending()) {
      try {
        const intent = JSON.parse(readFileSync(join(pendingDir, name), 'utf8'))
        if (intent && typeof intent.archive_id === 'string' && ARCHIVE_ID_PATTERN.test(intent.archive_id)) intents.push(intent)
      } catch { /* unreadable intents stay on disk and are retried after an operator fixes them */ }
    }
    return intents
  }

  function countConflicts() {
    try { return readdirSync(conflictDir).filter(name => name.endsWith('.json')).length } catch { return 0 }
  }

  function countReceipts() {
    try { return readFileSync(receiptsFile, 'utf8').split('\n').filter(line => line.trim()).length } catch { return 0 }
  }

  function receiptKeys() {
    try {
      const keys = new Set()
      for (const line of readFileSync(receiptsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const receipt = JSON.parse(line)
          if (receipt?.archive_id && receipt?.digest) keys.add(`${receipt.archive_id}\n${receipt.digest}`)
        } catch { /* a broken receipt line must not hide the valid ones */ }
      }
      return keys
    } catch { return new Set() }
  }

  function appendReceipt(receipt) {
    ensureDirs()
    if (receiptKeys().has(`${receipt.archive_id}\n${receipt.digest}`)) return
    writeFileSync(receiptsFile, `${JSON.stringify(receipt)}\n`, { flag: 'a', mode: 0o600 })
  }

  function receiptFromStatus(state, intent, subjectId) {
    return {
      archive_id: intent.archive_id,
      digest: state.digest,
      memory_ids: Array.isArray(state.memory_ids) ? state.memory_ids : [],
      chunks: Number.isInteger(state.chunks) ? state.chunks : 0,
      subject_id: state.subject_id ?? subjectId,
      received_at: state.received_at ?? iso(clock()),
    }
  }

  function receiptFromResult(result, intent, subjectId) {
    const receipt = result?.receipt ?? {}
    return {
      archive_id: intent.archive_id,
      digest: receipt.digest ?? intent.digest,
      memory_ids: Array.isArray(receipt.memory_ids) ? receipt.memory_ids : [],
      chunks: Number.isInteger(receipt.chunks) ? receipt.chunks : 0,
      subject_id: receipt.subject_id ?? subjectId,
      received_at: receipt.received_at ?? iso(clock()),
    }
  }

  function resolveSubject() {
    return Promise.resolve().then(() => subject()).then(value => {
      if (!isSubjectId(value)) throw fail('SUBJECT_UNAVAILABLE', '无法确定本安装的 subject，归档投递已暂停', '确认 dsh-superagent 已启动并完成主体初始化')
      return value
    })
  }

  function persistStateAfterBatch(at, lastError) {
    let state
    try { state = loadState() || defaultState() } catch { return }
    const intents = readPendingIntents()
    const upcoming = intents.map(intent => Number(intent.next_attempt_at) || 0).filter(value => value > at).sort((a, b) => a - b)
    state.next_attempt_at = upcoming[0] || 0
    state.last_error = lastError ?? intents.find(intent => intent.last_error)?.last_error ?? null
    try { writeState(state) } catch (error) { log(`归档出站状态写入失败：${String(error?.message ?? error)}`) }
  }

  function scheduleFailure(intent, error, cfg, at) {
    intent.attempts = (Number(intent.attempts) || 0) + 1
    intent.last_error = errorRecord(error?.code, error, at)
    if (cfg.maxAttempts > 0 && intent.attempts >= cfg.maxAttempts) {
      quarantine(intent, {
        code: 'ACTMEM_ARCHIVE_MAX_ATTEMPTS',
        message: `归档 ${intent.archive_id} 连续投递 ${intent.attempts} 次仍失败`,
        at: iso(at),
        cause: intent.last_error,
      })
      return 'quarantined'
    }
    const delay = Math.min(cfg.baseDelayMs * 2 ** Math.max(0, intent.attempts - 1), cfg.maxDelayMs)
    intent.next_attempt_at = at + delay
    try { writeIntent(intent) } catch (writeError) { log(`归档意图写回失败：${String(writeError?.message ?? writeError)}`) }
    return 'backoff'
  }

  function recordReceiptFailure(intent, error, cfg, at) {
    intent.attempts = (Number(intent.attempts) || 0) + 1
    intent.last_error = errorRecord('ACTMEM_ARCHIVE_RECEIPT_WRITE_FAILED', error, at)
    intent.next_attempt_at = at + cfg.baseDelayMs
    try { writeIntent(intent) } catch (writeError) { log(`归档意图写回失败：${String(writeError?.message ?? writeError)}`) }
  }

  async function sweep() {
    const cfg = currentConfig()
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' }
    let subjectId
    try { subjectId = await resolveSubject() } catch (error) { return errorResult(error) }
    let state
    try { state = loadState() } catch (error) { return errorResult(error) }
    try { ensureDirs() } catch (error) { return errorResult(error) }
    let stat = null
    try { stat = existsSync(fullJsonl) ? statSync(fullJsonl) : null } catch { stat = null }
    if (!state) {
      state = defaultState()
      if (stat) {
        state.scan_offset = stat.size
        state.scan_identity = identityOf(stat)
      }
      try { writeState(state) } catch (error) { return errorResult(error) }
      return { ok: true, initialized: true, scanned: 0, intents: 0, invalid: 0 }
    }
    if (!stat) {
      if (state.scan_identity !== null || state.scan_offset !== 0) {
        state.scan_identity = null
        state.scan_offset = 0
        try { writeState(state) } catch (error) { return errorResult(error) }
      }
      return { ok: true, scanned: 0, intents: 0, invalid: 0 }
    }
    const identity = identityOf(stat)
    if (!sameIdentity(state.scan_identity, identity) || stat.size < state.scan_offset) {
      state.scan_offset = 0
      state.scan_identity = identity
    }
    let buffer
    try { buffer = readRange(fullJsonl, state.scan_offset, stat.size - state.scan_offset) } catch (error) { return errorResult(error) }
    const text = buffer.toString('utf8')
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak < 0) {
      try { writeState(state) } catch (error) { return errorResult(error) }
      return { ok: true, scanned: 0, intents: 0, invalid: 0 }
    }
    const lines = text.slice(0, lastBreak + 1).split('\n')
    lines.pop()
    const at = clock()
    let offset = state.scan_offset
    let pendingCount = listPending().length
    let scanned = 0, intents = 0, invalid = 0
    let backlogFull = false
    for (const raw of lines) {
      const lineBytes = Buffer.byteLength(raw, 'utf8') + 1
      const line = raw.trim()
      if (!line) { offset += lineBytes; continue }
      scanned += 1
      let intent
      try { intent = buildIntent(JSON.parse(line), subjectId, at) } catch (error) {
        invalid += 1
        state.invalid_lines = (Number(state.invalid_lines) || 0) + 1
        state.last_error = errorRecord('ACTMEM_ARCHIVE_INTENT_INVALID', error, at)
        offset += lineBytes
        continue
      }
      if (existsSync(pendingPath(intent.archive_id)) || existsSync(conflictPath(intent.archive_id))) {
        offset += lineBytes
        continue
      }
      if (pendingCount >= cfg.maxPending) { backlogFull = true; break }
      try { writeIntent(intent) } catch (error) {
        state.scan_offset = offset
        try { writeState(state) } catch {}
        return errorResult(error, { code: 'ACTMEM_ARCHIVE_INTENT_WRITE_FAILED' })
      }
      pendingCount += 1
      intents += 1
      offset += lineBytes
    }
    state.scan_offset = offset
    state.swept_lines = (Number(state.swept_lines) || 0) + scanned
    try { writeState(state) } catch (error) { return errorResult(error) }
    if (backlogFull) return { ok: false, code: 'ACTMEM_ARCHIVE_BACKLOG_FULL', error: `待投递归档意图已达上限 ${cfg.maxPending}`, scanned, intents, invalid }
    return { ok: true, scanned, intents, invalid }
  }

  async function drain() {
    const cfg = currentConfig()
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' }
    const at = clock()
    let state
    try { state = loadState() } catch (error) { return errorResult(error) }
    if (state?.next_attempt_at && at < state.next_attempt_at && listPending().length) return { ok: true, skipped: 'backoff' }
    let subjectId
    try { subjectId = await resolveSubject() } catch (error) { return errorResult(error) }
    const swept = await sweep()
    if (swept.skipped) return swept
    if (swept.ok === false && swept.code !== 'ACTMEM_ARCHIVE_BACKLOG_FULL') return swept
    try { state = loadState() || defaultState() } catch (error) { return errorResult(error) }

    const intents = readPendingIntents()
    let quarantined = 0
    for (const intent of intents) {
      if (intent.subject_id === subjectId) continue
      quarantine(intent, errorRecord('ACTMEM_ARCHIVE_SUBJECT_MISMATCH', fail('ACTMEM_ARCHIVE_SUBJECT_MISMATCH', `归档 ${intent.archive_id} 属于另一个主体`), at))
      quarantined += 1
    }
    const eligible = readPendingIntents()
      .filter(intent => (Number(intent.next_attempt_at) || 0) <= at)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || left.archive_id.localeCompare(right.archive_id))
    const batch = []
    let bytes = 0
    const limit = Math.min(cfg.batchLimit, cfg.statusLimit)
    for (const intent of eligible) {
      if (batch.length >= limit) break
      const size = Buffer.byteLength(JSON.stringify({ archive_id: intent.archive_id, digest: intent.digest, content: intent.content, meta: intent.meta }), 'utf8')
      if (batch.length && bytes + size > cfg.batchBytes) break
      batch.push(intent)
      bytes += size
    }

    let delivered = 0
    let receiptFailures = 0
    let transportError = null
    let lastFailure = null
    if (batch.length) {
      let states
      try {
        const response = await send('/archive/status', { archive_ids: batch.map(intent => intent.archive_id) })
        if (!response || response.ok === false) throw errorFromResponse(response)
        if (!Array.isArray(response.states)) throw fail('ACTMEM_ARCHIVE_STATUS_INVALID', '归档状态响应缺少 states')
        states = new Map(response.states.map(entry => [entry.archive_id, entry]))
      } catch (error) {
        for (const intent of batch) scheduleFailure(intent, error, cfg, at)
        transportError = error
        lastFailure = errorRecord(error?.code, error, at)
      }
      if (!transportError) {
        const toSend = []
        for (const intent of batch) {
          const remote = states.get(intent.archive_id)
          if (!remote) { toSend.push(intent); continue }
          if (remote.state === 'archived') {
            if (remote.digest !== intent.digest) {
              quarantine(intent, {
                code: 'ACTMEM_ARCHIVE_DIGEST_CONFLICT',
                message: `归档 ${intent.archive_id} 在归档端已有不同正文`,
                stored_digest: remote.digest ?? null,
                at: iso(at),
              })
              quarantined += 1
              continue
            }
            try {
              appendReceipt(receiptFromStatus(remote, intent, subjectId))
              deleteIntent(intent)
              delivered += 1
            } catch (error) {
              recordReceiptFailure(intent, error, cfg, at)
              lastFailure = intent.last_error
              receiptFailures += 1
            }
            continue
          }
          if (remote.state === 'conflict') {
            quarantine(intent, {
              code: remote.code || 'ACTMEM_ARCHIVE_ROWS_INCONSISTENT',
              message: `归档 ${intent.archive_id} 的账本行不一致`,
              at: iso(at),
            })
            quarantined += 1
            continue
          }
          toSend.push(intent)
        }
        if (!receiptFailures && toSend.length) {
          try {
            const response = await send('/archive', {
              schema_version: ARCHIVE_SCHEMA_VERSION,
              subject_id: subjectId,
              items: toSend.map(intent => ({ archive_id: intent.archive_id, digest: intent.digest, content: intent.content, meta: intent.meta })),
            })
            if (!response || response.ok === false) throw errorFromResponse(response)
            const results = Array.isArray(response.results) ? response.results : []
            const byId = new Map(results.map(result => [result.archive_id, result]))
            for (const intent of toSend) {
              const result = byId.get(intent.archive_id)
              if (!result) {
                scheduleFailure(intent, fail('ACTMEM_ARCHIVE_RESULT_MISSING', `归档 ${intent.archive_id} 没有逐项结果`), cfg, at)
                lastFailure = intent.last_error
                continue
              }
              if (result.state === 'archived' || result.state === 'duplicate') {
                try {
                  appendReceipt(receiptFromResult(result, intent, subjectId))
                  deleteIntent(intent)
                  delivered += 1
                } catch (error) {
                  recordReceiptFailure(intent, error, cfg, at)
                  lastFailure = intent.last_error
                  receiptFailures += 1
                }
                continue
              }
              if (result.state === 'conflict' || result.state === 'rejected') {
                quarantine(intent, {
                  code: result.code || (result.state === 'conflict' ? 'ACTMEM_ARCHIVE_DIGEST_CONFLICT' : 'ACTMEM_ARCHIVE_REJECTED'),
                  message: String(result.message || `归档 ${intent.archive_id} 被拒绝`),
                  ...(result.stored_digest ? { stored_digest: result.stored_digest } : {}),
                  at: iso(at),
                })
                quarantined += 1
                continue
              }
              scheduleFailure(intent, fail('ACTMEM_ARCHIVE_RESULT_INVALID', `归档 ${intent.archive_id} 的结果状态无效`), cfg, at)
              lastFailure = intent.last_error
            }
          } catch (error) {
            for (const intent of toSend) scheduleFailure(intent, error, cfg, at)
            transportError = error
            lastFailure = errorRecord(error?.code, error, at)
          }
        }
      }
    }

    persistStateAfterBatch(at, lastFailure)
    const pending = listPending().length
    if (transportError) return errorResult(transportError, { pending, delivered, quarantined, ...(swept.warning ? { warning: swept.warning } : {}) })
    if (receiptFailures) return { ok: false, code: 'ACTMEM_ARCHIVE_RECEIPT_WRITE_FAILED', error: '归档回执写入失败，意图已保留', pending, delivered, quarantined }
    return {
      ok: true,
      delivered,
      quarantined,
      pending,
      ...(swept.ok === false ? { warning: 'ACTMEM_ARCHIVE_BACKLOG_FULL' } : {}),
    }
  }

  function status() {
    const cfg = currentConfig()
    let state
    let stateError = null
    try { state = loadState() || defaultState() } catch (error) { state = defaultState(); stateError = errorRecord(error?.code, error, clock()) }
    return {
      ok: true,
      enabled: cfg.enabled,
      pending: listPending().length,
      conflicts: countConflicts(),
      receipts: countReceipts(),
      invalid: Number(state.invalid_lines) || 0,
      lastError: stateError || state.last_error || null,
      nextAttemptAt: Number(state.next_attempt_at) || null,
      scanOffset: Number(state.scan_offset) || 0,
      config: cfg,
    }
  }

  return { sweep, drain, status }
}
