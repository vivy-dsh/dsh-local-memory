import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { createQqSync } from './qq-sync.mjs'
import { withBridgeMaintenance } from './bridge-maintenance.mjs'
import { scanText } from './privacy.mjs'
import {
  assessConversationClosure, classifyMessage, closeGate, closurePromptBlock, closureStatus,
  closureSuppressesWake, makeClosureRecord, normalizeClosureConfig, normalizeClosureRecord, reopenClosure,
} from './conversation-closure.mjs'
import {
  buildExtractionPrompt, buildResearchPrompt, buildSlangContext, capSlangEntries, loadSlang,
  parseExtractionJson, parseResearchJson, saveSlang, SLANG_MAX_ENTRIES,
  SLANG_STATUS, upsertSlangEntry,
} from './slang-learner.mjs'
import { buildHistoryCatchupLine, historyWatermark, normalizeHistoryConfig, selectMissedHistory, summarizeHistoryCatchup } from './history-catchup.mjs'
import { buildContextSnapshot } from './context-snapshot.mjs'
import { dedupeSessionMappings } from './session-map.mjs'
import { ACTMEM_SCHEMA_VERSION, ActMemError, anchorCard, bumpRevision, inspectActMem, readRelations } from './actmem.mjs'
import { createArchiveOutbox, normalizeArchiveOutConfig } from './archive-out.mjs'
import { isSubjectId } from '../../_shared/contracts.mjs'
import { resolveSubject } from '../../_shared/subject.mjs'
import {
  addManualMemory, archiveDecayedToFull, clearFirstMeeting, compactMemoryCard, createEmptyCard,
  designateFirstMeeting, ensureFullArchiveStatsAsync, fullMemoryCardStatus, ingestBiliEntries, ingestInboxLines, loadMemoryCard, maintainMemoryCard, memoryCardStatus, mergeMemories,
  markOwnerNotified, needsDailyDecay, normalizeCard, normalizeMemoryCardConfig, readArchiveRecordPage, recallFullMemoryAsync, redactForMemory, refreshInitialState, renderMemoryCard, resolveMemoryCardPaths, saveFullMemoryCard, saveMemoryCardOutputs, shouldNotifyOwner,
} from './card-engine.mjs'

function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temp, file)
}

const SLANG_DEFAULT_CONFIG = Object.freeze({ enabled: true, maxEntries: SLANG_MAX_ENTRIES, injectMax: 8 })

function normalizeSlangConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const integer = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : SLANG_DEFAULT_CONFIG.enabled,
    maxEntries: integer(source.maxEntries, SLANG_DEFAULT_CONFIG.maxEntries, 1, SLANG_MAX_ENTRIES),
    injectMax: integer(source.injectMax, SLANG_DEFAULT_CONFIG.injectMax, 1, 30),
  }
}

/** Owns all writes to the memory card and event journal. */
export function createMemoryService({ stateDir, biliMemory = null, qqFeedFile = null, alignmentFile = null, qqConfigFile = null, notifyOwner = null, subject = null, archiveSend = null }) {
  if (!stateDir) throw new Error('Memory state directory is required')
  const paths = resolveMemoryCardPaths(join(stateDir, 'data'))
  const configFile = join(stateDir, 'config.json')
  const eventsFile = join(paths.dir, 'events.jsonl')
  const cursorFile = join(paths.dir, 'events-cursor.json')
  const legacyMarker = join(paths.dir, 'legacy-imported.json')
  const legacyInflight = join(paths.dir, 'legacy-import-inflight.json')
  const journalInflight = join(paths.dir, 'events-inflight.json')
  const biliRefreshFile = join(paths.dir, 'bili-refresh-pending.json')
  const biliRefreshIntent = join(paths.dir, 'bili-refresh-intent.json')
  const manualActionFile = join(paths.dir, 'manual-action-pending.json')
  const settingsPending = join(paths.dir, 'settings-pending.json')
  const restorePending = join(paths.dir, 'restore-pending.json')
  const backupDir = join(stateDir, 'backups')
  const closureFile = join(paths.dir, 'closures.json')
  const slangFile = join(paths.dir, 'slang.json')
  const historyStateFile = join(paths.dir, 'history-watermarks.json')
  const qqSync = createQqSync({ stateDir, feedFile: qqFeedFile, alignmentFile, qqConfigFile })
  let chain = Promise.resolve()
  let featureChain = Promise.resolve()
  let subjectCache = null
  let actmemMigrationBackedUp = false
  let outputsReady = false
  let journalCache = null
  let lastBiliAutoAttempt = 0
  let lastQqAutoAttempt = 0
  let stagedBiliRefresh = null
  let closing = false
  let disposePromise = null
  const shutdown = new AbortController()
  async function prepareLegacyArchive() {
    if (!existsSync(paths.fullJson) || existsSync(paths.fullJsonl)) return
    await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./legacy-archive-worker.mjs', import.meta.url), { workerData: { paths }, resourceLimits: { maxOldGenerationSizeMb: 512 } })
      let result
      worker.once('message', value => { result = value })
      worker.once('error', reject)
      worker.once('exit', code => {
        if (code !== 0) reject(new Error(`旧版归档转换工作线程退出（${code}），原文件已保留`))
        else if (!result?.ok) reject(new Error(result?.error || '旧版归档转换失败，原文件已保留'))
        else resolve()
      })
    })
  }
  const serial = (task, { prepareArchive = true } = {}) => {
    if (closing) return Promise.reject(new Error('记忆插件已关闭'))
    const run = async () => { if (prepareArchive) { await prepareLegacyArchive(); await ensureFullArchiveStatsAsync(paths) } return task() }
    const result = chain.then(run, run)
    chain = result.catch(() => {})
    return result
  }
  const featureSerial = task => {
    if (closing) return Promise.reject(new Error('记忆插件已关闭'))
    const result = featureChain.then(task, task)
    featureChain = result.catch(() => {})
    return result
  }
  const readConfigFile = () => {
    if (!existsSync(configFile)) return {}
    const value = JSON.parse(readFileSync(configFile, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆配置格式无效')
    return value
  }
  const archiveOutbox = archiveSend
    ? createArchiveOutbox({
      stateDir,
      fullJsonl: paths.fullJsonl,
      config: () => { try { return readConfigFile().archiveOut ?? {} } catch { return {} } },
      subject: ensureSubject,
      send: archiveSend,
      log: message => console.warn(message),
    })
    : null
  const closureConfig = () => normalizeClosureConfig(readConfigFile().closure ?? {})
  const historyConfig = () => normalizeHistoryConfig(readConfigFile().history ?? {})
  const slangConfig = () => normalizeSlangConfig(readConfigFile().slang ?? {})
  function loadClosures() {
    if (!existsSync(closureFile)) return { version: 1, records: {} }
    let data
    try { data = JSON.parse(readFileSync(closureFile, 'utf8')) } catch { throw new Error('对话收尾记录损坏，原文件已保留') }
    if (!data || data.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) throw new Error('对话收尾记录格式无效，原文件已保留')
    const cfg = closureConfig(), records = {}
    for (const [key, value] of Object.entries(data.records)) {
      const record = normalizeClosureRecord(value, cfg)
      if (record) records[key] = record
    }
    return { version: 1, records }
  }
  function saveClosures(data) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    atomicJson(closureFile, data)
  }
  function loadHistoryState() {
    if (!existsSync(historyStateFile)) return { version: 1, keys: {} }
    let data
    try { data = JSON.parse(readFileSync(historyStateFile, 'utf8')) } catch { throw new Error('补历史水位记录损坏，原文件已保留') }
    if (!data || data.version !== 1 || !data.keys || typeof data.keys !== 'object' || Array.isArray(data.keys)) throw new Error('补历史水位记录格式无效，原文件已保留')
    return data
  }
  function readSlangState() {
    return loadSlang(slangFile).filter(entry => entry.content)
  }
  function writeSlangState(entries) {
    return saveSlang(slangFile, entries, { max: slangConfig().maxEntries })
  }
  const config = () => {
    if (!existsSync(configFile)) return normalizeMemoryCardConfig({ notifyOwner: false })
    return normalizeMemoryCardConfig(JSON.parse(readFileSync(configFile, 'utf8')).memoryCard ?? {})
  }
  // cardInjection 段：常驻记忆卡注入的开关与范围（默认关），见 card-prompt.mjs。
  const injectionConfig = () => {
    try { return readConfigFile().cardInjection ?? {} } catch { return {} }
  }
  const syncConfig = () => {
    const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')).biliSync ?? {} : {}
    const interval = Number(saved.intervalMs)
    return { enabled: saved.enabled === true, intervalMs: Number.isFinite(interval) ? Math.max(60000, Math.min(86400000, interval)) : 600000 }
  }
  const ownerAlertConfig = () => {
    const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')).ownerAlert : null
    return { enabled: saved?.enabled === true }
  }
  const card = () => {
    const value = loadMemoryCard(paths)
    if (!value && existsSync(paths.json)) throw new Error('Memory card is corrupt; restore a backup before modifying it')
    return value || createEmptyCard()
  }
  async function ensureSubject() {
    if (subjectCache) return subjectCache
    const resolve = subject ?? (() => resolveSubject({ env: process.env }))
    const value = await resolve()
    if (!isSubjectId(value)) {
      const error = new Error(`主体 ID 无效：${JSON.stringify(value)}`)
      error.code = 'SUBJECT_UNAVAILABLE'
      error.hint = '确认 dsh-superagent 已启动并完成主体初始化，然后重试'
      throw error
    }
    subjectCache = value
    return value
  }
  async function prepareActMem() {
    const subjectId = await ensureSubject()
    const current = card()
    const inspection = inspectActMem(current, subjectId)
    if (inspection.legacyRecords && current.records.length && !actmemMigrationBackedUp) {
      backupCard()
      actmemMigrationBackedUp = true
    }
    anchorCard(current, { subjectId })
    return { subjectId, card: current, inspection }
  }
  function biliEntriesForImport() {
    const file = join(paths.dir, 'bili-memory.json')
    if (biliMemory?.paths?.publication && existsSync(biliMemory.paths.publication)) {
      const result = biliMemory.ensureRoleFreeOutputs()
      if (!result?.ok) throw new Error(result?.error || 'Bilibili publication recovery failed')
    }
    if (!existsSync(file)) return []
    const entries = JSON.parse(readFileSync(file, 'utf8')).entries
    if (!Array.isArray(entries)) throw new Error('Bilibili memory is invalid')
    if (typeof biliMemory?.purposeEntries === 'function') {
      if (!biliMemory.roleFreeStatus()?.ready) {
        const result = biliMemory.ensureRoleFreeOutputs?.()
        if (!biliMemory.roleFreeStatus()?.ready) throw new Error(`Bilibili memory conversion is incomplete${result?.error ? `: ${result.error}` : ''}`)
      }
      return biliMemory.purposeEntries()
    }
    return entries
  }
  // 渲染读的是哪一份：有 biliMemory 时从活卡渲染，否则读注入文件。
  function platformCardSource(platform) {
    return typeof biliMemory?.neutralizeEntries === 'function'
      ? paths.json
      : (platform === 'bili' ? paths.promptBili : paths.promptQq)
  }
  function platformCardFingerprint(platform) {
    try { const info = statSync(platformCardSource(platform)); return `${info.size}:${info.mtimeMs}` }
    catch { return 'missing' }
  }
  function platformCardText(platform) {
    if (config().enabled === false) return ''
    if (!existsSync(paths.json)) return ''
    if (typeof biliMemory?.neutralizeEntries !== 'function') {
      const file = platformCardSource(platform)
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    }
    const current = card(), cfg = config()
    const sanitized = biliMemory.neutralizeEntries(current.records.filter(record => record.scope === 'bili' || record.platform === 'bili'))
    let index = 0
    const view = { ...current, records: current.records.map(record => record.scope === 'bili' || record.platform === 'bili' ? sanitized[index++] : record) }
    return renderMemoryCard(view, { config: cfg, platform, maxChars: cfg.injectMaxChars[platform] }).trim()
  }
  function journalSnapshot() {
    try { const st = statSync(eventsFile); return { fingerprint: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, identity: `${st.dev}:${st.ino}`, size: st.size } }
    catch (error) { if (error.code === 'ENOENT') return { fingerprint: 'missing', identity: null, size: 0 }; throw error }
  }
  function journalFingerprint() { return journalSnapshot().fingerprint }
  function journalCursor() {
    const cursor = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, 'utf8')).count : 0
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Memory event cursor is invalid')
    return cursor
  }
  function bloomPositions(platform, id) {
    const hash = createHash('sha256').update(JSON.stringify([platform, id])).digest()
    const first = hash.readUInt32LE(0), step = hash.readUInt32LE(4) | 1
    return [0, 1, 2, 3].map(index => ((first + Math.imul(index, step)) >>> 0) % (512 * 1024 * 8))
  }
  function bloomAdd(bits, platform, id) { for (const n of bloomPositions(platform, id)) bits[n >>> 3] |= 1 << (n & 7) }
  function bloomMaybe(bits, platform, id) { return bloomPositions(platform, id).every(n => (bits[n >>> 3] & (1 << (n & 7))) !== 0) }
  async function* readEvents(start = 0) {
    let handle
    try { handle = await fs.promises.open(eventsFile, 'r') }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    try {
      const size = (await handle.stat()).size
      if (size) {
        const last = Buffer.alloc(1)
        if ((await handle.read(last, 0, 1, size - 1)).bytesRead !== 1 || last[0] !== 10) throw new Error('Memory event journal is incomplete; restore or repair the journal')
      }
      if (!Number.isSafeInteger(start) || start < 0 || start > size) throw new Error('Memory event cursor is invalid')
      if (start > 0) { const previous = Buffer.alloc(1); if ((await handle.read(previous, 0, 1, start - 1)).bytesRead !== 1 || previous[0] !== 10) throw new Error('Memory event cursor is invalid') }
      if (start === size) return
      let carry = Buffer.alloc(0), offset = start
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const stream = handle.createReadStream({ start, end: size - 1, highWaterMark: 64 * 1024, autoClose: false })
      for await (const chunk of stream) {
        const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
        let begin = 0, newline
        while ((newline = bytes.indexOf(10, begin)) !== -1) {
          const line = bytes.subarray(begin, newline); offset += line.length + 1; begin = newline + 1
          if (line.length > 16 * 1024 * 1024) throw new Error('Memory event journal contains an oversized record')
          if (line.length) {
            const text = decoder.decode(line)
            if (text.length > 4 * 1024 * 1024) throw new Error('Memory event journal contains an oversized record')
            yield { event: JSON.parse(text), endOffset: offset }
          }
        }
        carry = bytes.subarray(begin)
        if (carry.length > 16 * 1024 * 1024) throw new Error('Memory event journal contains an oversized record')
      }
      if (carry.length) throw new Error('Memory event journal is incomplete; restore or repair the journal')
    } finally { await handle.close() }
  }
  async function validatedJournal() {
    const fingerprint = journalFingerprint(), cursor = journalCursor()
    if (journalCache && journalCache.fingerprint === fingerprint && journalCache.cursor === cursor) return journalCache
    const bits = Buffer.alloc(512 * 1024)
    let total = 0, cursorOffset = 0
    for await (const { event, endOffset } of readEvents()) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Memory event journal contains an invalid record')
      total++
      if (total === cursor) cursorOffset = endOffset
      if (typeof event.platform === 'string' && typeof event.id === 'string') bloomAdd(bits, event.platform, event.id)
    }
    if (journalFingerprint() !== fingerprint) throw new Error('Memory event journal changed while reading')
    if (cursor > total) throw new Error('Memory event cursor is invalid')
    journalCache = { fingerprint, cursor, cursorOffset, total, bits }
    return journalCache
  }
  async function* legacyInboxLines(files, { start = 0 } = {}) {
    for (const file of files) {
      const handle = await fs.promises.open(file, 'r')
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let carry = Buffer.alloc(0)
        const decode = bytes => {
          if (bytes.length > 16 * 1024 * 1024) throw new Error('Legacy memory inbox contains an oversized record')
          const line = decoder.decode(bytes)
          if (line.length > 4 * 1024 * 1024) throw new Error('Legacy memory inbox contains an oversized record')
          return line
        }
        for await (const chunk of handle.createReadStream({ start, highWaterMark: 64 * 1024, autoClose: false })) {
          const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
          let start = 0, end
          while ((end = bytes.indexOf(10, start)) !== -1) {
            const line = decode(bytes.subarray(start, end)); start = end + 1
            if (line) { JSON.parse(line); yield line }
          }
          carry = bytes.subarray(start)
          if (carry.length > 16 * 1024 * 1024) throw new Error('Legacy memory inbox contains an oversized record')
        }
        if (carry.length) { const line = decode(carry); JSON.parse(line); yield line }
      } finally { await handle.close() }
    }
  }
  function archiveSnapshot() {
    try { const st = statSync(paths.fullJsonl); return { identity: `${st.dev}:${st.ino}`, size: st.size } }
    catch (error) { if (error.code === 'ENOENT') return { identity: null, size: 0 }; throw error }
  }
  async function recoverArchive(inflight, inboxLines, entries, cfg, transform = null) {
    const preview = card()
    const evicted = []
    ingestBiliEntries(preview, entries, cfg, inflight.now, evicted)
    ingestInboxLines(preview, inboxLines, cfg, inflight.now, evicted)
    const candidates = new Set([...evicted, ...preview.records].filter(record => record.id && !record.fullArchivedAt).map(record => record.id))
    if (transform) {
      transform(preview, evicted)
      for (const record of [...evicted, ...preview.records]) if (record.id && !record.fullArchivedAt) candidates.add(record.id)
    }
    const existing = new Set(), { size: offset, identity } = inflight.archive
    if (existsSync(paths.fullJsonl)) {
      const before = statSync(paths.fullJsonl)
      if (before.size < offset || (identity !== null && `${before.dev}:${before.ino}` !== identity)) throw new Error('Memory archive changed during recovery')
      if (before.size) {
        const handle = await fs.promises.open(paths.fullJsonl, 'r')
        try {
          const last = Buffer.alloc(1); await handle.read(last, 0, 1, before.size - 1)
          if (last[0] !== 10) throw new Error('Memory archive is incomplete; preserve and repair it before recovery')
          if (offset) { await handle.read(last, 0, 1, offset - 1); if (last[0] !== 10) throw new Error('Memory archive recovery offset is invalid') }
        } finally { await handle.close() }
        if (offset < before.size) for await (const line of legacyInboxLines([paths.fullJsonl], { start: offset })) { const record = JSON.parse(line); if (candidates.has(record?.id)) existing.add(record.id) }
        const after = statSync(paths.fullJsonl)
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Memory archive changed during recovery')
      }
      await ensureFullArchiveStatsAsync(paths, Date.now(), { force: true })
    } else if (identity !== null || offset !== 0) throw new Error('Memory archive disappeared during recovery')
    return existing
  }
  async function importLegacy(subjectId = null) {
    const actmemSubject = subjectId ?? await ensureSubject()
    const inboxSources = () => {
      const rotations = readdirSync(paths.dir).filter(name => /^memory-inbox\.jsonl\.\d+$/.test(name))
      rotations.sort((a, b) => {
        const left = BigInt(a.slice(a.lastIndexOf('.') + 1)), right = BigInt(b.slice(b.lastIndexOf('.') + 1))
        return left === right ? (a < b ? -1 : a > b ? 1 : 0) : left > right ? -1 : 1
      })
      return [...rotations.map(name => join(paths.dir, name)), paths.inbox]
    }
    const sources = inboxSources(), snapshots = [], identities = []
    const fingerprint = file => {
      try { const st = statSync(file); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` }
      catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error }
    }
    const sourcesChanged = () => {
      const current = inboxSources()
      return current.length !== sources.length || current.some((file, index) => file !== sources[index] || fingerprint(file) !== identities[index])
    }
    try {
      for (const source of sources) {
        const before = fingerprint(source); identities.push(before)
        if (before === 'missing') continue
        const temporary = join(paths.dir, `.legacy-inbox-${randomUUID()}.tmp`)
        snapshots.push(temporary)
        await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
        await fs.promises.chmod(temporary, 0o600)
        if (fingerprint(source) !== before) throw new Error('Legacy memory inbox changed during import')
      }
      const hash = createHash('sha256'); let lineCount = 0
      for await (const line of legacyInboxLines(snapshots)) {
        hash.update(`${Buffer.byteLength(line)}:`).update(line)
        lineCount++
      }
      const bili = biliEntriesForImport()
      hash.update('\0bili:').update(JSON.stringify(bili))
      const digest = hash.digest('hex'), checkpoint = card().meta.legacyImport
      const maxBatches = Math.ceil(Math.max(lineCount, bili.length) / 250)
      if (checkpoint && (checkpoint.digest !== digest || !Number.isSafeInteger(checkpoint.batches) || checkpoint.batches < 0 || checkpoint.batches > maxBatches)) {
        throw new Error('Legacy memory import changed after partial progress; restore the original source before retrying')
      }
      const completed = checkpoint?.batches ?? 0
      let inflight = existsSync(legacyInflight) ? JSON.parse(readFileSync(legacyInflight, 'utf8')) : null
      if (inflight && (inflight.digest !== digest || !Number.isSafeInteger(inflight.batch) || inflight.batch < 1 || inflight.batch > maxBatches || !Number.isSafeInteger(inflight.now) || typeof inflight.config !== 'string' || !inflight.archive || !Number.isSafeInteger(inflight.archive.size) || inflight.archive.size < 0 || !('identity' in inflight.archive))) throw new Error('Legacy memory import recovery marker is invalid or the source changed')
      if (inflight && inflight.batch <= completed) { await fs.promises.rm(legacyInflight); inflight = null }
      if (inflight && inflight.batch !== completed + 1) throw new Error('Legacy memory import recovery marker does not match the card')
      if (sourcesChanged()) throw new Error('Legacy memory inbox changed during import')
      let batch = [], start = 0
      const flush = async () => {
        const batches = start / 250 + 1
        if (batches > completed) {
          const cfg = config(), currentConfig = JSON.stringify(cfg), entries = bili.slice(start, start + 250)
          let existingArchiveIds = null
          if (inflight) {
            if (inflight.batch !== batches || inflight.config !== currentConfig) throw new Error('Legacy memory import configuration changed during recovery')
            existingArchiveIds = await recoverArchive(inflight, batch, entries, cfg)
          } else {
            inflight = { digest, batch: batches, now: Date.now(), config: currentConfig, archive: archiveSnapshot() }
            atomicJson(legacyInflight, inflight)
          }
          maintainMemoryCard({ paths, config: cfg, fullPaths: paths, inboxLines: batch, biliEntries: entries, now: inflight.now, existingArchiveIds, legacyImportCheckpoint: { digest, batches }, actmem: { subjectId: actmemSubject } })
          await fs.promises.rm(legacyInflight)
          inflight = null
        }
        start += 250; batch = []
      }
      for await (const line of legacyInboxLines(snapshots)) {
        batch.push(line)
        if (batch.length === 250) { await flush(); await yieldToLoop() }
      }
      if (batch.length) { await flush(); await yieldToLoop() }
      while (start < bili.length) { await flush(); await yieldToLoop() }
      if (sourcesChanged()) throw new Error('Legacy memory inbox changed during import')
      atomicJson(legacyMarker, { importedAt: new Date().toISOString() })
    } finally {
      for (const file of snapshots) await fs.promises.rm(file, { force: true })
    }
  }
  async function resumeBiliRefresh(subjectId = null) {
    if (!existsSync(biliRefreshFile)) return
    const actmemSubject = subjectId ?? await ensureSubject()
    const pending = JSON.parse(readFileSync(biliRefreshFile, 'utf8'))
    if (!pending || pending.version !== 1 || typeof pending.id !== 'string' || !Array.isArray(pending.entries) || typeof pending.config !== 'string' || pending.digest !== createHash('sha256').update(JSON.stringify(pending.entries)).digest('hex')) throw new Error('Bilibili refresh recovery data is invalid')
    const cfg = config()
    if (JSON.stringify(cfg) !== pending.config) throw new Error('Bilibili refresh configuration changed during recovery')
    const maxBatches = Math.ceil(pending.entries.length / 250), checkpoint = card().meta.biliRefresh
    const completed = checkpoint?.id === pending.id ? checkpoint.batches : 0
    if (!Number.isSafeInteger(completed) || completed < 0 || completed > maxBatches) throw new Error('Bilibili refresh checkpoint is invalid')
    let inflight = pending.inflight ?? null
    if (inflight && (!Number.isSafeInteger(inflight.batch) || inflight.batch < 1 || inflight.batch > maxBatches || !Number.isSafeInteger(inflight.now) || !inflight.archive || !Number.isSafeInteger(inflight.archive.size) || inflight.archive.size < 0 || !('identity' in inflight.archive))) throw new Error('Bilibili refresh recovery marker is invalid')
    if (inflight && inflight.batch <= completed) { pending.inflight = null; atomicJson(biliRefreshFile, pending); inflight = null }
    if (inflight && inflight.batch !== completed + 1) throw new Error('Bilibili refresh recovery marker does not match the card')
    for (let index = completed; index < maxBatches; index++) {
      const entries = pending.entries.slice(index * 250, (index + 1) * 250)
      let existingArchiveIds = null
      if (inflight) {
        existingArchiveIds = await recoverArchive(inflight, [], entries, cfg)
      } else {
        inflight = { batch: index + 1, now: Date.now(), archive: archiveSnapshot() }
        pending.inflight = inflight
        atomicJson(biliRefreshFile, pending)
      }
      maintainMemoryCard({ paths, config: cfg, fullPaths: paths, biliEntries: entries, now: inflight.now, existingArchiveIds, biliRefreshCheckpoint: { id: pending.id, batches: index + 1 }, actmem: { subjectId: actmemSubject } })
      pending.inflight = null
      atomicJson(biliRefreshFile, pending)
      inflight = null
      await yieldToLoop()
    }
    await fs.promises.rm(biliRefreshFile)
  }
  function biliIndexDigest() {
    try { return createHash('sha256').update(readFileSync(join(paths.dir, 'bili-memory.json'))).digest('hex') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  function stageBiliImport(id, cfg) {
    const entries = biliEntriesForImport()
    atomicJson(biliRefreshFile, { version: 1, id, entries, digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), config: cfg, inflight: null })
  }
  async function resumeBiliIntent(subjectId = null) {
    if (!existsSync(biliRefreshIntent)) return
    const actmemSubject = subjectId ?? await ensureSubject()
    const intent = JSON.parse(readFileSync(biliRefreshIntent, 'utf8'))
    if (!intent || intent.version !== 1 || typeof intent.id !== 'string' || typeof intent.config !== 'string' || !(intent.baseline === null || /^[a-f0-9]{64}$/.test(intent.baseline))) throw new Error('Bilibili refresh intent is invalid')
    if (JSON.stringify(config()) !== intent.config) throw new Error('Bilibili refresh configuration changed during recovery')
    if (existsSync(biliRefreshFile)) {
      const pending = JSON.parse(readFileSync(biliRefreshFile, 'utf8'))
      if (pending.id !== intent.id) throw new Error('Bilibili refresh intent does not match pending import')
      await resumeBiliRefresh(actmemSubject)
    } else if (card().meta.biliRefresh?.id !== intent.id) {
      if (biliMemory?.paths?.publication && existsSync(biliMemory.paths.publication)) {
        const result = biliMemory.ensureRoleFreeOutputs()
        if (!result?.ok) throw new Error(result?.error || 'Bilibili publication recovery failed')
      }
      if (biliIndexDigest() !== intent.baseline) {
        if (!biliMemory) throw new Error('Bilibili memory source is unavailable during recovery')
        stageBiliImport(intent.id, intent.config)
        await resumeBiliRefresh(actmemSubject)
      }
    }
    await fs.promises.rm(biliRefreshIntent)
  }
  function applyManualAction(current, action, payload, cfg, now, evicted = null) {
    let outcome = { ok: true }
    if (action === 'add') {
      const result = addManualMemory(current, { ...payload, text: redactForMemory(payload.text, { scope: payload.scope === 'bili' || payload.scope === 'shared' ? 'bili' : 'qq' }) }, cfg, now, evicted)
      if (!result.added) throw new Error('Memory is empty or duplicated')
    } else if (action === 'pin') {
      const item = current.records.find(record => record.id === String(payload.id ?? ''))
      if (!item) throw new Error('Memory not found')
      const pinned = payload.pinned !== false
      if (item.pinned !== pinned) { item.pinned = pinned; item.anchor = pinned; outcome.revision = bumpRevision(item) }
      else outcome.revision = item.revision
    } else if (action === 'update') {
      const item = current.records.find(record => record.id === String(payload.id ?? ''))
      if (!item) throw new ActMemError('ACTMEM_UPDATE_INVALID', '记忆不存在或已被删除')
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== item.revision) {
        throw new ActMemError('ACTMEM_REVISION_CONFLICT', `记忆已被修改（当前 revision ${item.revision}）`, '刷新后基于最新 revision 重试')
      }
      let changed = false
      const scope = item.scope === 'bili' ? 'bili' : 'qq'
      if (payload.text !== undefined) {
        const text = redactForMemory(payload.text, { scope, maxChars: 1200 })
        if (!text) throw new ActMemError('ACTMEM_UPDATE_INVALID', '记忆正文不能为空')
        if (text !== item.text) { item.text = text; changed = true }
      }
      if (payload.title !== undefined) {
        const title = redactForMemory(payload.title, { scope, maxChars: 100 }).slice(0, 80)
        if (title !== item.title) { item.title = title; changed = true }
      }
      if (!item.text && !item.title) throw new ActMemError('ACTMEM_UPDATE_INVALID', '记忆正文和标题不能都为空')
      if (payload.importance !== undefined && payload.importance !== item.importance) { item.importance = payload.importance; changed = true }
      if (payload.pinned !== undefined && payload.pinned !== item.pinned) { item.pinned = payload.pinned; item.anchor = payload.pinned; changed = true }
      if (payload.relations !== undefined) {
        for (const relation of payload.relations) {
          if (relation.targetId === item.id || !current.records.some(record => record.id === relation.targetId)) {
            throw new ActMemError('ACTMEM_RELATION_INVALID', `关系目标不存在：${relation.targetId}`)
          }
        }
        if (JSON.stringify(payload.relations) !== JSON.stringify(item.relations ?? [])) { item.relations = payload.relations; changed = true }
      }
      if (changed) outcome.revision = bumpRevision(item)
      else outcome.revision = item.revision
    } else if (action === 'forget') {
      const item = current.records.find(record => record.id === String(payload.id ?? ''))
      if (!item || item.pinned) throw new Error('Memory not found or pinned')
      current.records = current.records.filter(record => record !== item)
      current.stats.forgotten = (Number(current.stats.forgotten) || 0) + 1
    } else if (action === 'ack') {
      current.alerts.acknowledgedLevel = Math.max(0, Math.min(3, Number(payload.level) || Number(current.alerts.level) || 0))
      current.alerts.acknowledgedAt = new Date(now).toISOString()
    } else if (action === 'compact') {
      outcome.steps = compactMemoryCard(current, cfg, { targetRatio: payload.targetRatio ?? 0.8, now })
      current.lastMaintenanceAt = new Date(now).toISOString()
    }
    else if (action === 'set-first-meet') outcome = designateFirstMeeting(current, payload.ids, { now })
    else if (action === 'clear-first-meet') outcome = clearFirstMeeting(current)
    else if (action === 'merge-memories') outcome = mergeMemories(current, payload.ids, { title: payload.title, pinned: payload.pinned !== false, now })
    else throw new Error('Unknown memory action')
    if (outcome.ok === false) throw new Error(outcome.error || 'Memory action failed')
    current.updatedAt = new Date(now).toISOString()
    return outcome
  }
  function safeManualPayload(action, payload) {
    if (action === 'add') {
      const scope = payload.scope === 'bili' || payload.scope === 'shared' ? payload.scope : 'qq'
      return { scope, text: redactForMemory(payload.text, { scope: scope === 'qq' ? 'qq' : 'bili' }), title: redactForMemory(payload.title ?? '', { scope, maxChars: 100 }), importance: Number.isFinite(Number(payload.importance)) ? Number(payload.importance) : undefined,
        tags: Array.isArray(payload.tags) ? payload.tags.map(tag => redactForMemory(String(tag), { scope, maxChars: 100 })) : [] }
    }
    if (action === 'merge-memories' || action === 'set-first-meet') {
      const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.map(String).filter(Boolean))] : []
      const limit = action === 'merge-memories' ? 50 : 20
      if (ids.length > limit) throw new Error(`一次最多选择 ${limit} 条记忆`)
      return action === 'merge-memories' ? { ids, title: redactForMemory(String(payload.title ?? '').trim().slice(0, 80), { scope: 'qq', maxChars: 100 }), pinned: payload.pinned !== false } : { ids }
    }
    if (action === 'pin') return { id: String(payload.id ?? ''), pinned: payload.pinned !== false }
    if (action === 'update') {
      const id = String(payload.id ?? '')
      if (!id) throw new ActMemError('ACTMEM_UPDATE_INVALID', '记忆 ID 不能为空')
      const expectedRevision = payload.expectedRevision === undefined ? undefined : Number(payload.expectedRevision)
      if (expectedRevision !== undefined && !Number.isSafeInteger(expectedRevision)) throw new ActMemError('ACTMEM_UPDATE_INVALID', 'expectedRevision 必须是整数')
      const importance = payload.importance === undefined ? undefined : Number(payload.importance)
      return {
        id, expectedRevision,
        ...(payload.text !== undefined ? { text: String(payload.text) } : {}),
        ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
        ...(importance !== undefined ? { importance: Number.isFinite(importance) ? Math.max(1, Math.min(100, Math.round(importance))) : undefined } : {}),
        ...(payload.pinned !== undefined ? { pinned: payload.pinned === true } : {}),
        ...(payload.relations !== undefined ? { relations: readRelations(payload.relations, { strict: true }) } : {}),
      }
    }
    if (action === 'forget') return { id: String(payload.id ?? '') }
    if (action === 'ack') return { level: Number(payload.level) || 0 }
    if (action === 'maintain') return { forceDecay: payload.forceDecay === true }
    if (action === 'compact') {
      const value = Number(payload.targetRatio)
      return { targetRatio: Number.isFinite(value) && value !== 0 ? value : 0.8 }
    }
    if (action === 'clear-first-meet') return {}
    throw new Error('Unknown memory action')
  }
  async function resumeManualAction({ fresh = false } = {}) {
    if (!existsSync(manualActionFile)) return null
    const pending = JSON.parse(readFileSync(manualActionFile, 'utf8'))
    if (!pending || pending.version !== 1 || typeof pending.id !== 'string' || typeof pending.action !== 'string' || !pending.payload || typeof pending.payload !== 'object' || Array.isArray(pending.payload) || !Number.isSafeInteger(pending.now) || typeof pending.config !== 'string' || !pending.archive || !Number.isSafeInteger(pending.archive.size) || pending.archive.size < 0 || !('identity' in pending.archive)) throw new Error('Manual memory action recovery data is invalid')
    const cfg = config()
    if (JSON.stringify(cfg) !== pending.config) throw new Error('Manual memory action configuration changed during recovery')
    if (card().meta.manualAction?.id === pending.id) {
      saveMemoryCardOutputs(paths, card(), cfg)
      saveFullMemoryCard(paths, cfg, pending.now)
      await fs.promises.rm(manualActionFile)
      return { ok: true, recovered: true }
    }
    const transform = pending.action === 'maintain' ? null : (preview, evicted) => applyManualAction(preview, pending.action, pending.payload, cfg, pending.now, evicted)
    const existing = fresh ? null : await recoverArchive(pending, [], [], cfg, transform)
    let outcome
    if (pending.action === 'maintain') {
      const { subjectId } = await prepareActMem()
      const result = maintainMemoryCard({ paths, config: cfg, fullPaths: paths, forceDecay: pending.payload.forceDecay === true, now: pending.now, existingArchiveIds: existing, manualActionCheckpoint: { id: pending.id }, actmem: { subjectId } })
      outcome = { ok: true, changed: result.changed }
    } else {
      const { card: current } = await prepareActMem()
      archiveDecayedToFull(paths, current, cfg, pending.now, existing)
      const evicted = []
      outcome = applyManualAction(current, pending.action, pending.payload, cfg, pending.now, evicted)
      const records = [...new Map([...evicted, ...current.records].map(record => [record.id, record])).values()]
      archiveDecayedToFull(paths, { ...current, records }, cfg, pending.now, existing)
      if (evicted.length) refreshInitialState(current)
      current.meta.manualAction = { id: pending.id }
      saveMemoryCardOutputs(paths, current, cfg, pending.now)
      saveFullMemoryCard(paths, cfg, pending.now)
    }
    await fs.promises.rm(manualActionFile)
    return outcome
  }
  function restoreDigest() {
    try { return createHash('sha256').update(readFileSync(paths.json)).digest('hex') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function recoverRestore() {
    if (!existsSync(restorePending)) return
    let pending
    try { pending = JSON.parse(readFileSync(restorePending, 'utf8')) } catch { throw new Error('记忆恢复记录损坏，原文件已保留') }
    if (!pending || pending.version !== 1 || !(pending.before === null || /^[a-f0-9]{64}$/.test(pending.before || '')) || !/^[a-f0-9]{64}$/.test(pending.after || '') || typeof pending.config !== 'string') throw new Error('记忆恢复记录无效，原文件已保留')
    const current = restoreDigest()
    if (current === pending.after) {
      if (JSON.stringify(config()) !== pending.config) throw new Error('记忆恢复期间配置发生变化，原文件已保留')
      saveMemoryCardOutputs(paths, card(), config())
      outputsReady = true
    } else if (current !== pending.before) throw new Error('记忆恢复期间记忆卡发生变化，原文件已保留')
    await fs.promises.rm(restorePending)
  }
  async function processPending() {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    await recoverRestore()
    card() // Never replace a malformed card with an empty one.
    if (existsSync(settingsPending)) {
      let pending
      try { pending = JSON.parse(readFileSync(settingsPending, 'utf8')) } catch { throw new Error('记忆设置恢复记录损坏，原文件已保留') }
      if (!pending || pending.version !== 1 || !['oldConfig', 'newConfig', 'card'].every(key => /^[a-f0-9]{64}$/.test(pending[key] || ''))) throw new Error('记忆设置恢复记录无效，原文件已保留')
      const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      const current = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
      const configHash = hash(current)
      if (configHash !== pending.oldConfig && configHash !== pending.newConfig) throw new Error('记忆设置恢复期间配置发生变化，原文件已保留')
      if (configHash === pending.newConfig) {
        const currentCard = !existsSync(paths.json) && pending.initialCard ? pending.initialCard : card()
        if (hash(currentCard) !== pending.card) throw new Error('记忆设置恢复期间记忆卡发生变化，原文件已保留')
        saveMemoryCardOutputs(paths, currentCard, config())
      }
      await fs.promises.rm(settingsPending)
    }
    if (existsSync(manualActionFile)) { await validatedJournal(); await resumeManualAction() }
    if (config().enabled === false) return
    let actmemPromise = null
    const prepare = () => actmemPromise ??= prepareActMem()
    if (!existsSync(biliRefreshIntent) && !existsSync(biliRefreshFile) && biliMemory?.paths?.publication && existsSync(biliMemory.paths.publication)) {
      await validatedJournal()
      atomicJson(biliRefreshIntent, { version: 1, id: randomUUID(), baseline: null, config: JSON.stringify(config()) })
    }
    if (existsSync(biliRefreshIntent)) { await validatedJournal(); const { subjectId } = await prepare(); await resumeBiliIntent(subjectId) }
    if (!existsSync(legacyMarker) && config().enabled !== false) {
      await validatedJournal() // Validate before legacy import changes the card or creates the marker.
      const { subjectId } = await prepare()
      await importLegacy(subjectId)
    }
    if (existsSync(biliRefreshFile)) { await validatedJournal(); const { subjectId } = await prepare(); await resumeBiliRefresh(subjectId) }
    const journal = await validatedJournal(), { cursor, total } = journal
    let inflight = existsSync(journalInflight) ? JSON.parse(readFileSync(journalInflight, 'utf8')) : null
    if (inflight && (!Number.isSafeInteger(inflight.start) || !Number.isSafeInteger(inflight.end) || inflight.start < 0 || inflight.end <= inflight.start || inflight.end - inflight.start > 250 || inflight.end > total || typeof inflight.digest !== 'string' || !Number.isSafeInteger(inflight.now) || typeof inflight.config !== 'string' || !inflight.archive || !Number.isSafeInteger(inflight.archive.size) || inflight.archive.size < 0 || !('identity' in inflight.archive))) throw new Error('Memory event recovery marker is invalid')
    if (inflight && inflight.end === cursor) { await fs.promises.rm(journalInflight); inflight = null }
    if (inflight && inflight.start !== cursor) throw new Error('Memory event recovery marker does not match the cursor')
    if (cursor === total) {
      if (!outputsReady) { if (existsSync(paths.json)) saveMemoryCardOutputs(paths, card(), config()); outputsReady = true }
      return
    }
    const cfg = config()
    // Bilibili ingestion caps each batch at 300. Process bounded batches and persist a cursor after each one.
    let seen = cursor, applied = cursor, batch = [], batchOffset = journal.cursorOffset
    const flush = async () => {
      if (!batch.length) return
      const inboxLines = batch.filter(e => e.platform === 'qq').map(e => JSON.stringify(e))
      const biliEntries = batch.filter(e => e.platform === 'bili').map(e => ({ ...e, type: e.kind || 'dynamic' }))
      const digest = createHash('sha256').update(JSON.stringify(batch)).digest('hex')
      let existingArchiveIds = null
      if (inflight) {
        if (inflight.end !== applied + batch.length || inflight.digest !== digest || inflight.config !== JSON.stringify(cfg)) throw new Error('Memory event journal or configuration changed during recovery')
        existingArchiveIds = await recoverArchive(inflight, inboxLines, biliEntries, cfg)
      } else {
        inflight = { start: applied, end: applied + batch.length, digest, now: Date.now(), config: JSON.stringify(cfg), archive: archiveSnapshot() }
        atomicJson(journalInflight, inflight)
      }
      if (journalFingerprint() !== journal.fingerprint) throw new Error('Memory event journal changed while reading')
      const { subjectId } = await prepare()
      maintainMemoryCard({ paths, config: cfg, fullPaths: paths,
        inboxLines, biliEntries, now: inflight.now, existingArchiveIds, actmem: { subjectId } })
      applied += batch.length
      atomicJson(cursorFile, { count: applied })
      journal.cursor = applied
      journal.cursorOffset = batchOffset
      await fs.promises.rm(journalInflight)
      inflight = null
      batch = []
    }
    for await (const { event, endOffset } of readEvents(journal.cursorOffset)) {
      seen++
      if (seen > total) break
      batch.push(event)
      batchOffset = endOffset
      if (batch.length === (inflight ? inflight.end - inflight.start : 250)) { await flush(); await yieldToLoop() }
    }
    if (seen < total) throw new Error('Memory event journal changed while reading')
    await flush()
    if (!outputsReady) { if (existsSync(paths.json)) saveMemoryCardOutputs(paths, card(), config()); outputsReady = true }
  }
  async function prepareContext() {
    if (config().enabled === false && !existsSync(settingsPending) && !existsSync(restorePending)) return
    await prepareLegacyArchive()
    await ensureFullArchiveStatsAsync(paths)
    await processPending()
  }
  function normalizeEvent(event) {
    if (!event || !['qq', 'bili'].includes(event.platform) || typeof event.id !== 'string' || !event.id.trim() || event.id.length > 200) {
      throw new Error('A platform and stable event id are required')
    }
    const platform = event.platform
    const text = redactForMemory(event.text, { scope: platform, maxChars: 600 })
    if (!text || text.startsWith('/')) throw new Error('Memory event text is empty or unsupported')
    const at = event.at === undefined ? new Date().toISOString() : new Date(event.at).toISOString()
    return { id: event.id, platform, text, at, kind: platform === 'bili' ? (['video', 'dynamic', 'comment'].includes(event.kind) ? event.kind : 'dynamic') : (event.kind === 'private' ? 'private' : 'group'),
      isOwner: event.isOwner === true, isSelf: event.isSelf === true, private: event.private === true || event.kind === 'private',
      direct: event.direct === true, sender: redactForMemory(event.sender ?? '', { scope: platform, maxChars: 100 }),
      senderId: String(event.senderId ?? '').slice(0, 80), groupId: String(event.groupId ?? '').slice(0, 80),
      conversationKey: String(event.conversationKey ?? '').slice(0, 120), title: redactForMemory(event.title ?? text, { scope: platform, maxChars: 100 }) }
  }
  function backupCard() {
    if (!existsSync(paths.json)) return
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    copyFileSync(paths.json, join(backupDir, `memory-card-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`))
  }
  function readPreview(file) {
    if (!existsSync(file)) return { ok: true, text: '', truncated: false }
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 200000))
      const bytes = readSync(fd, buffer, 0, buffer.length, 0)
      return { ok: true, text: buffer.subarray(0, bytes).toString('utf8'), truncated: size > bytes }
    } finally { closeSync(fd) }
  }
  async function refreshBiliCore() {
    if (!biliMemory) throw new Error('Bilibili memory source is unavailable')
    await processPending()
    const intent = { version: 1, id: randomUUID(), baseline: biliIndexDigest(), config: JSON.stringify(config()) }
    atomicJson(biliRefreshIntent, intent)
    const result = await biliMemory.refresh({ force: true })
    if (result?.ok === false) throw new Error(result.error || 'Bilibili memory refresh failed')
    stageBiliImport(intent.id, intent.config)
    await resumeBiliRefresh()
    await fs.promises.rm(biliRefreshIntent)
    return result
  }
  function requestStagedBiliRefresh({ automatic = false, now = Date.now() } = {}) {
    if (stagedBiliRefresh) return automatic
      ? serial(() => ({ ok: true, skipped: true }), { prepareArchive: false })
      : stagedBiliRefresh
    const preparation = serial(async () => {
      if (automatic) {
        const sync = syncConfig()
        if (!sync.enabled || config().enabled === false || !biliMemory) return { skipped: true }
        if (lastBiliAutoAttempt && now - lastBiliAutoAttempt < sync.intervalMs) return { skipped: true }
        lastBiliAutoAttempt = now
        await prepareLegacyArchive()
        await ensureFullArchiveStatsAsync(paths)
      }
      await processPending()
      return { skipped: false }
    }, { prepareArchive: !automatic })
    const operation = preparation.then(async ready => {
      if (ready.skipped) return { ok: true, skipped: true }
      shutdown.signal.throwIfAborted()
      const result = await biliMemory.refresh({ force: true, signal: shutdown.signal, commit: publish => serial(async () => {
        await processPending()
        if (automatic && (!syncConfig().enabled || config().enabled === false)) return { ok: true, skipped: true }
        const intent = { version: 1, id: randomUUID(), baseline: biliIndexDigest(), config: JSON.stringify(config()) }
        atomicJson(biliRefreshIntent, intent)
        await publish()
        stageBiliImport(intent.id, intent.config)
        await resumeBiliRefresh()
        await fs.promises.rm(biliRefreshIntent)
        return { ok: true }
      }) })
      if (result?.ok === false) throw new Error(result.error || 'Bilibili memory refresh failed')
      return result
    })
    stagedBiliRefresh = operation
    operation.finally(() => { if (stagedBiliRefresh === operation) stagedBiliRefresh = null }).catch(() => {})
    return operation
  }
  const api = {
    dispose() {
      if (!disposePromise) {
        closing = true
        shutdown.abort(new Error('记忆插件已关闭'))
        const sessionsDrained = api.sessions?.dispose?.()
        disposePromise = (async () => { await Promise.all([stagedBiliRefresh?.catch(() => {}), chain, featureChain, sessionsDrained]) })()
      }
      return disposePromise
    },
    record(event) { return serial(async () => {
      const value = normalizeEvent(event)
      mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
      if (config().enabled === false) { const error = new Error('Memory is disabled; enable it before recording events'); error.code = 'MEMORY_DISABLED'; throw error }
      const subjectId = await ensureSubject()
      if (event?.subjectId !== undefined && event.subjectId !== subjectId) {
        throw new ActMemError('ACTMEM_SUBJECT_MISMATCH', '事件属于另一个主体，拒绝写入')
      }
      await prepareActMem()
      await prepareLegacyArchive()
      await ensureFullArchiveStatsAsync(paths)
      await processPending()
      if (config().enabled === false) { const error = new Error('Memory is disabled; enable it before recording events'); error.code = 'MEMORY_DISABLED'; throw error }
      card()
      const journal = await validatedJournal()
      let exists = false
      if (bloomMaybe(journal.bits, value.platform, value.id)) {
        for await (const { event } of readEvents()) if (event.platform === value.platform && event.id === value.id) exists = true
        if (journalFingerprint() !== journal.fingerprint) { journalCache = null; throw new Error('Memory event journal changed while reading') }
      }
      if (!exists) {
        const before = journalSnapshot()
        if (before.fingerprint !== journal.fingerprint) { journalCache = null; throw new Error('Memory event journal changed while reading') }
        const line = `${JSON.stringify(value)}\n`
        try { appendFileSync(eventsFile, line, { mode: 0o600 }) } catch (error) { journalCache = null; throw error }
        const after = journalSnapshot()
        if (after.size !== before.size + Buffer.byteLength(line) || (before.identity !== null && after.identity !== before.identity)) {
          journalCache = null
        } else {
          journal.fingerprint = after.fingerprint
          journal.total++
          bloomAdd(journal.bits, value.platform, value.id)
        }
      }
      await processPending()
      return { ok: true, duplicate: exists }
    }, { prepareArchive: false }) },
    snapshot() { return serial(async () => {
      await processPending()
      const current = card()
      const firstMet = { source: current.meta?.firstMetSource || '', at: current.meta?.firstMetAt || '', recordId: current.meta?.firstMetEventId || '', mergedCount: current.meta?.firstMetRecordIds?.length || 0 }
      const cfg = config(), status = memoryCardStatus(current, cfg)
      status.alertLevel = Math.max(status.level, Number(current.alerts?.level) || 0)
      status.acknowledgedLevel = Number(current.alerts?.acknowledgedLevel) || 0
      const records = [...current.records].sort((a, b) => {
        const first = Number(b.firstMet === true) - Number(a.firstMet === true)
        if (first) return first
        const pinned = Number(b.pinned === true) - Number(a.pinned === true)
        if (pinned) return pinned
        if (a.pinned && b.pinned) {
          const seen = (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0)
          if (seen) return seen
        }
        return (Number(b.importance) || 0) - (Number(a.importance) || 0) || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
      })
      return { ok: true, records, firstMet, status, config: cfg, sync: syncConfig(), ownerAlert: ownerAlertConfig(), biliSource: biliMemory?.roleFreeStatus?.() ?? null, archiveOut: api.archiveOutStatus() }
    }) },
    maintenance(now = Date.now()) { return serial(async () => {
      if (existsSync(settingsPending) || existsSync(restorePending)) await processPending()
      if (config().enabled === false) return { ok: true, disabled: true }
      await processPending()
      const cfg = config()
      const { subjectId } = await prepareActMem()
      if (needsDailyDecay(card(), cfg, now)) backupCard()
      const result = maintainMemoryCard({ paths, config: cfg, fullPaths: paths, now, actmem: { subjectId } })
      return { ok: true, changed: result.changed }
    }) },
    updateSettings(changes) { return serial(async () => {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid memory settings')
      await processPending()
      const previous = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
      const next = normalizeMemoryCardConfig({ ...config(), ...changes, injectMaxChars: { ...config().injectMaxChars, ...changes.injectMaxChars } })
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const hadCard = existsSync(paths.json), currentCard = card(), nextConfig = { ...previous, memoryCard: next }
      const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      atomicJson(settingsPending, { version: 1, oldConfig: hash(previous), newConfig: hash(nextConfig), card: hash(currentCard), ...(!hadCard ? { initialCard: currentCard } : {}) })
      atomicJson(configFile, nextConfig)
      saveMemoryCardOutputs(paths, currentCard, next)
      await fs.promises.rm(settingsPending)
      return { ok: true, config: next }
    }) },
    updateSyncSettings(changes) { return serial(async () => {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid Bilibili sync settings')
      if (existsSync(settingsPending) || existsSync(restorePending)) await processPending()
      const old = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
      const current = syncConfig()
      const enabled = typeof changes.enabled === 'boolean' ? changes.enabled : current.enabled
      const number = Number(changes.intervalMs)
      const intervalMs = changes.intervalMs !== undefined && Number.isFinite(number) ? Math.max(60000, Math.min(86400000, Math.round(number))) : current.intervalMs
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      atomicJson(configFile, { ...old, biliSync: { enabled, intervalMs } })
      if (!enabled) lastBiliAutoAttempt = 0
      return { ok: true, sync: { enabled, intervalMs } }
    }) },
    updateOwnerAlert(changes) { return serial(async () => {
      if (!changes || typeof changes.enabled !== 'boolean') throw new Error('告警设置无效')
      if (existsSync(settingsPending) || existsSync(restorePending)) await processPending()
      const old = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      atomicJson(configFile, { ...old, ownerAlert: { enabled: changes.enabled } })
      return { ok: true, ownerAlert: { enabled: changes.enabled } }
    }) },
    notifyOwnerIfNeeded(now = Date.now()) { return serial(async () => {
      if (!ownerAlertConfig().enabled || config().enabled === false) return { ok: true, skipped: 'disabled' }
      await processPending()
      const current = card(), status = memoryCardStatus(current, config(), now)
      const level = Math.max(Number(status.level) || 0, Number(current.alerts?.level) || 0)
      if (!level) return { ok: true, skipped: 'no-alert' }
      if (!shouldNotifyOwner(current, level, now)) return { ok: true, skipped: 'cooldown' }
      if (typeof notifyOwner !== 'function') return { ok: false, error: 'QQ 桥接通知不可用' }
      const result = await notifyOwner({ level, chars: status.chars, maxChars: status.maxChars, percent: status.percent })
      if (!result?.ok) return { ok: false, error: result?.error || 'QQ 桥接通知失败' }
      markOwnerNotified(current, level, now)
      current.alerts.notifiedAt = new Date(now).toISOString()
      atomicJson(paths.json, current)
      return { ok: true, notified: true, level }
    }) },
    context(platform) { return serial(async () => {
      if (!['qq', 'bili'].includes(platform)) throw new Error('Unknown memory context platform')
      await prepareContext()
      const cardText = platformCardText(platform)
      return [cardText, platform === 'bili' ? qqSync.text() : ''].filter(Boolean).join('\n\n')
    }, { prepareArchive: false }) },
    previews() { return serial(async () => {
      await prepareContext()
      return { ok: true, qq: platformCardText('qq'), bili: [platformCardText('bili'), qqSync.text()].filter(Boolean).join('\n\n') }
    }, { prepareArchive: false }) },
    biliBriefPreview() { return serial(() => {
      const enabled = config().enabled !== false && config().includeBiliInQq !== false
      const text = biliMemory?.briefBlock?.() || ''
      const scan = scanText(text)
      const blocked = scan.hits.some(hit => hit.severe)
      return { ok: true, enabled, blocked, labels: [...new Set(scan.hits.filter(hit => hit.severe).map(hit => hit.label))], text: enabled && !blocked ? text.slice(0, 20000) : '', status: biliMemory?.status?.() ?? null }
    }, { prepareArchive: false }) },
    updateQqSync(changes) { return serial(async () => { if (existsSync(settingsPending) || existsSync(restorePending)) await prepareContext(); return { ok: true, config: qqSync.update(changes) } }, { prepareArchive: false }) },
    purgeQqSync() { return serial(() => qqSync.purge(), { prepareArchive: false }) },
    syncQqFeed() { return serial(() => qqSync.sync(), { prepareArchive: false }) },
    autoSyncQqFeed(now = Date.now()) { return serial(() => {
      const cfg = qqSync.config()
      if (!cfg.enabled || !cfg.autoSync || (lastQqAutoAttempt && now - lastQqAutoAttempt < cfg.intervalMs)) return { ok: true, skipped: true }
      lastQqAutoAttempt = now
      return qqSync.sync()
    }, { prepareArchive: false }) },
    qqSyncStatus() { return qqSync.status() },
    archiveStatus() { return serial(() => {
      let valid = false
      try {
        if (statSync(paths.fullStats).size <= 1024 * 1024) {
          const data = JSON.parse(readFileSync(paths.fullStats, 'utf8'))
          valid = Boolean(data && typeof data === 'object' && !Array.isArray(data) && Number.isFinite(Number(data.records)) && Number(data.records) >= 0)
        }
      } catch {}
      const source = existsSync(paths.fullJsonl) ? paths.fullJsonl : (existsSync(paths.fullJson) ? paths.fullJson : '')
      if (!valid && source) return { ok: true, pending: true, records: null, bytes: statSync(source).size, maxBytes: config().fullMaxBytes, archiveOut: api.archiveOutStatus() }
      return { ok: true, pending: false, ...fullMemoryCardStatus(paths, config()), archiveOut: api.archiveOutStatus() }
    }, { prepareArchive: false }) },
    drainArchives() {
      if (!archiveOutbox) return Promise.resolve({ ok: true, skipped: 'disabled' })
      return featureSerial(() => archiveOutbox.drain())
    },
    archiveOutStatus() {
      if (!archiveOutbox) return { ok: true, enabled: false, pending: 0, conflicts: 0, receipts: 0, invalid: 0, lastError: null, nextAttemptAt: null, scanOffset: 0, config: normalizeArchiveOutConfig({ enabled: false }) }
      return archiveOutbox.status()
    },
    search(query, limit = 40, { signal } = {}) { return serial(async () => { signal?.throwIfAborted(); await processPending() }).then(() => recallFullMemoryAsync(paths, query, { limit, signal })) },
    archiveRecord(location) { return readArchiveRecordPage(paths, location) },
    archivePreview() { return serial(async () => {
      await processPending()
      return readPreview(paths.fullMarkdown)
    }) },
    cardPreview() { return serial(async () => { await processPending(); return readPreview(paths.markdown) }) },
    refreshBili() { return biliMemory?.supportsStagedRefresh ? requestStagedBiliRefresh() : serial(() => refreshBiliCore()) },
    autoRefreshBili(now = Date.now()) { if (biliMemory?.supportsStagedRefresh) return requestStagedBiliRefresh({ automatic: true, now }); return serial(async () => {
      const sync = syncConfig()
      if (!sync.enabled || config().enabled === false || !biliMemory) return { ok: true, skipped: true }
      if (lastBiliAutoAttempt && now - lastBiliAutoAttempt < sync.intervalMs) return { ok: true, skipped: true }
      lastBiliAutoAttempt = now
      await prepareLegacyArchive()
      await ensureFullArchiveStatsAsync(paths)
      return refreshBiliCore()
    }, { prepareArchive: false }) },
    biliStatus() { return serial(() => {
      if (!biliMemory) throw new Error('Bilibili memory source is unavailable')
      return biliMemory.status()
    }, { prepareArchive: false }) },
    recordBiliShare(id, slot) { return serial(() => {
      if (!biliMemory) throw new Error('Bilibili memory source is unavailable')
      biliMemory.recordShare(id, slot)
      return { ok: true }
    }, { prepareArchive: false }) },
    biliShareHistoryBackups() { return serial(() => {
      if (!biliMemory) throw new Error('Bilibili memory source is unavailable')
      return { ok: true, backups: biliMemory.historyBackups() }
    }, { prepareArchive: false }) },
    restoreBiliShareHistory(name) { return serial(() => {
      if (!biliMemory) throw new Error('Bilibili memory source is unavailable')
      return withBridgeMaintenance(qqFeedFile, () => biliMemory.restoreHistory(name))
    }, { prepareArchive: false }) },
    backups() { return serial(() => existsSync(backupDir) ? readdirSync(backupDir).filter(name => /^memory-card-[a-zA-Z0-9._-]+\.json$/.test(name)).sort().reverse() : [], { prepareArchive: false }) },
    restore(name) { return serial(async () => {
      if (!/^memory-card-[a-zA-Z0-9._-]+\.json$/.test(String(name))) throw new Error('Invalid backup name')
      const source = join(backupDir, name)
      if (!existsSync(source)) throw new Error('Memory backup not found')
      const parsed = JSON.parse(readFileSync(source, 'utf8'))
      if (!parsed || !Array.isArray(parsed.records)) throw new Error('Memory backup is corrupt')
      await recoverRestore()
      const subjectId = await ensureSubject()
      const normalized = normalizeCard(parsed)
      const meta = normalized.meta?.actmem
      if (meta && Number(meta.schemaVersion) > ACTMEM_SCHEMA_VERSION) {
        throw new ActMemError('ACTMEM_SCHEMA_UNSUPPORTED', `备份使用了更新的 ActMem schema ${meta.schemaVersion}`)
      }
      if (meta?.subjectId && meta.subjectId !== subjectId) {
        throw new ActMemError('ACTMEM_SUBJECT_MISMATCH', `备份属于另一个主体（${meta.subjectId}），拒绝恢复`, '只恢复本安装自己的记忆备份')
      }
      for (const record of normalized.records) {
        if (record.subjectId && record.subjectId !== subjectId) throw new ActMemError('ACTMEM_SUBJECT_MISMATCH', `备份中的记忆 ${record.id} 属于另一个主体，拒绝恢复`)
      }
      anchorCard(normalized, { subjectId })
      const damaged = existsSync(paths.json) && !loadMemoryCard(paths)
      if (!damaged && existsSync(paths.json)) inspectActMem(card(), subjectId)
      if (!damaged) await processPending()
      backupCard()
      const target = `${JSON.stringify(normalized, null, 2)}\n`
      atomicJson(restorePending, { version: 1, before: restoreDigest(), after: createHash('sha256').update(target).digest('hex'), config: JSON.stringify(config()) })
      outputsReady = false
      atomicJson(paths.json, normalized)
      try {
        if (damaged) await processPending()
        const restored = card()
        saveMemoryCardOutputs(paths, restored, config())
        if (existsSync(restorePending)) await fs.promises.rm(restorePending)
        outputsReady = true
      } catch (error) {
        const failure = new Error(`记忆卡已替换，但后续处理未完成：${String(error?.message ?? error)}；请检查后刷新状态`)
        failure.code = 'MEMORY_RESTORE_PENDING'
        throw failure
      }
      return { ok: true }
    }) },
    action(action, payload = {}) { return serial(async () => {
      await processPending()
      mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
      const cfg = config(), now = Date.now()
      if (action === 'maintain' && cfg.enabled === false) return { ok: true, disabled: true }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid memory action payload')
      payload = safeManualPayload(action, payload)
      const { card: current } = await prepareActMem()
      if (action !== 'maintain') applyManualAction(current, action, payload, cfg, now)
      backupCard()
      const pending = { version: 1, id: randomUUID(), action, payload, now, config: JSON.stringify(cfg), archive: archiveSnapshot() }
      atomicJson(manualActionFile, pending)
      return resumeManualAction({ fresh: true })
    }) },
    updateModuleSettings(section, changes) { return serial(async () => {
      if (!['closure', 'slang', 'history'].includes(section)) throw new Error('Unknown memory module settings')
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid memory module settings')
      const current = readConfigFile()
      const next = section === 'closure'
        ? normalizeClosureConfig({ ...normalizeClosureConfig(current.closure ?? {}), ...changes })
        : section === 'history'
          ? normalizeHistoryConfig({ ...normalizeHistoryConfig(current.history ?? {}), ...changes })
          : normalizeSlangConfig({ ...normalizeSlangConfig(current.slang ?? {}), ...changes })
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      atomicJson(configFile, { ...current, [section]: next })
      return { ok: true, section, config: next }
    }, { prepareArchive: false }) },
    dedupeSessions(mappings) { return dedupeSessionMappings(mappings) },
    moduleStatus() { return featureSerial(() => ({ ok: true, closure: closureConfig(), slang: slangConfig(), history: historyConfig() })) },
    assessClosure(input = {}) {
      return assessConversationClosure({ ...input, config: input.config ?? closureConfig() })
    },
    closureGate(assessment, config = null) {
      return closeGate(assessment, config ?? closureConfig())
    },
    saveClosure({ key, kind, assessment, body = {}, now = Date.now() } = {}) { return featureSerial(() => {
      const cfg = closureConfig()
      if (!cfg.enabled) { const error = new Error('对话收尾判断已关闭'); error.code = 'CLOSURE_DISABLED'; throw error }
      if (typeof key !== 'string' || !key.trim()) throw new Error('A conversation key is required for closure records')
      const record = makeClosureRecord({ key: key.trim(), kind, assessment, body, now, config: cfg })
      const data = loadClosures()
      data.records[record.key] = record
      saveClosures(data)
      return { ok: true, record, status: closureStatus(record, now) }
    }) },
    closureStatus(key) { return featureSerial(() => {
      const record = key ? loadClosures().records[String(key)] ?? null : null
      return { ok: true, record, status: closureStatus(record) }
    }) },
    reopenClosure({ key, reason = 'new-message', now = Date.now() } = {}) { return featureSerial(() => {
      if (typeof key !== 'string' || !key.trim()) throw new Error('A conversation key is required for closure records')
      const data = loadClosures(), current = data.records[key] ?? null
      if (!current) return { ok: true, record: null }
      const record = reopenClosure(current, { reason, now })
      data.records[key] = record
      saveClosures(data)
      return { ok: true, record }
    }) },
    closurePrompt({ key, assessment, now = Date.now() } = {}) { return featureSerial(() => {
      const cfg = closureConfig()
      const record = key ? loadClosures().records[String(key)] ?? null : null
      return { ok: true, text: closurePromptBlock(assessment, { record, now, config: cfg }), record }
    }) },
    closureSuppress({ key, reason, now = Date.now() } = {}) { return featureSerial(() => {
      const record = key ? loadClosures().records[String(key)] ?? null : null
      return { ok: true, suppressed: closureSuppressesWake(record, reason, now), record }
    }) },
    slangList({ status = null } = {}) { return featureSerial(() => {
      const entries = readSlangState().filter(entry => !status || entry.status === status)
      const { entries: capped, dropped } = capSlangEntries(entries, slangConfig().maxEntries)
      return { ok: true, entries: capped, dropped, status: status || 'all', config: slangConfig() }
    }) },
    slangUpsert({ content, patch = {} } = {}) { return featureSerial(() => {
      const cfg = slangConfig()
      if (!cfg.enabled) { const error = new Error('黑话学习已关闭'); error.code = 'SLANG_DISABLED'; throw error }
      const entries = readSlangState()
      const result = upsertSlangEntry(entries, content, patch)
      if (!result.entry) throw new Error('A slang term is required')
      const saved = writeSlangState(result.entries)
      return { ok: true, entry: result.entry, created: result.created, dropped: saved.dropped }
    }) },
    slangDelete(id) { return featureSerial(() => {
      const entries = readSlangState(), next = entries.filter(entry => entry.id !== String(id ?? ''))
      if (next.length === entries.length) throw new Error('Slang entry not found')
      writeSlangState(next)
      return { ok: true, deleted: entries.length - next.length }
    }) },
    slangContext({ max } = {}) { return featureSerial(() => {
      const cfg = slangConfig()
      if (!cfg.enabled) return { ok: true, text: '', enabled: false }
      return { ok: true, text: buildSlangContext(readSlangState(), max ?? cfg.injectMax), enabled: true }
    }) },
    slangExtractionPrompt(messages) { return { ok: true, text: buildExtractionPrompt(messages) } },
    slangResearchPrompt(candidates) { return { ok: true, text: buildResearchPrompt(candidates) } },
    slangApplyExtraction({ text, messages = [] } = {}) { return featureSerial(() => {
      const cfg = slangConfig()
      if (!cfg.enabled) { const error = new Error('黑话学习已关闭'); error.code = 'SLANG_DISABLED'; throw error }
      const entries = readSlangState(), applied = []
      for (const item of parseExtractionJson(text)) {
        const message = messages[Number(item.source_id) - 1]
        const evidence = message ? [{ text: String(message.text ?? '').slice(0, 80), sender: String(message.sender ?? '').slice(0, 40) }] : []
        const result = upsertSlangEntry(entries, item.content, { evidence })
        if (result.entry) applied.push(result.entry)
      }
      const saved = writeSlangState(entries)
      return { ok: true, applied, dropped: saved.dropped, maxEntries: cfg.maxEntries }
    }) },
    slangApplyResearch({ text, autoConfirm = true } = {}) { return featureSerial(() => {
      const cfg = slangConfig()
      if (!cfg.enabled) { const error = new Error('黑话学习已关闭'); error.code = 'SLANG_DISABLED'; throw error }
      const entries = readSlangState(), applied = []
      for (const item of parseResearchJson(text)) {
        const confirmed = autoConfirm && item.confirmed === true
        const patch = {
          meaning: item.meaning, usage: item.usage, example: item.example, risk: item.risk,
          sources: item.sources, ...(confirmed ? { status: SLANG_STATUS.CONFIRMED } : {}),
        }
        const result = upsertSlangEntry(entries, item.content, patch)
        if (result.entry) applied.push(result.entry)
      }
      const saved = writeSlangState(entries)
      return { ok: true, applied, dropped: saved.dropped, maxEntries: cfg.maxEntries }
    }) },
    historyCatchup({ key = '', state = {}, candidates = [], existingIds = [], blockedUsers = [], limit = null, now = Date.now(), persist = false } = {}) { return featureSerial(() => {
      const cfg = historyConfig()
      if (!cfg.enabled) return { ok: true, enabled: false, picked: [], summary: { incoming: 0, self: 0, total: 0 }, line: '', watermark: 0, nextWatermark: 0 }
      const maxAgeMs = cfg.maxAgeMinutes * 60_000
      const watermark = historyWatermark(state, { now, maxAgeMs })
      const picked = selectMissedHistory(candidates, {
        now, watermark, maxAgeMs, limit: limit ?? cfg.limit, existingIds, blockedUsers,
      })
      const summary = summarizeHistoryCatchup(picked)
      const nextWatermark = picked.length ? Math.max(watermark, ...picked.map(message => Number(message.time) || 0)) : watermark
      if (persist && key) {
        const data = loadHistoryState()
        data.keys[String(key)] = { at: nextWatermark, updatedAt: now }
        mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
        atomicJson(historyStateFile, data)
      }
      return { ok: true, enabled: true, watermark, nextWatermark, picked, summary, line: buildHistoryCatchupLine(summary), config: cfg }
    }) },
    historyStatus(key) { return featureSerial(() => {
      const record = key ? loadHistoryState().keys[String(key)] ?? null : null
      return { ok: true, record }
    }) },
    contextSnapshot(input = {}) { return buildContextSnapshot(input) },
    // 常驻卡注入（card-prompt.mjs）：同步取配置、卡文本与廉价指纹。
    cardInjectionConfig() { return injectionConfig() },
    cardPromptText(platform = 'qq') { return platformCardText(platform) },
    cardPromptFingerprint(platform = 'qq') { return platformCardFingerprint(platform) },
    actmemStatus() { return serial(async () => {
      const exists = existsSync(paths.json)
      const loaded = exists ? loadMemoryCard(paths) : null
      let subjectId = subjectCache, degraded = null
      if (!subjectId) {
        try { subjectId = await ensureSubject() } catch (error) { degraded = String(error?.message ?? error) }
      }
      const meta = loaded?.meta?.actmem ?? null
      return { ok: true, subjectId: subjectId ?? null, subjectAvailable: Boolean(subjectId),
        cardSubjectId: meta?.subjectId ?? null, schemaVersion: meta?.schemaVersion ?? null,
        migratedAt: meta?.migratedAt ?? null, records: loaded?.records?.length ?? 0,
        revisionMax: Math.max(0, ...(loaded?.records ?? []).map(record => Number(record.revision) || 0)),
        damaged: exists && !loaded, degraded }
    }, { prepareArchive: false }) },
    classifyMessage,
  }
  api.actmem = Object.freeze({
    status: () => api.actmemStatus(),
    record: event => api.record(event),
    add: payload => api.action('add', payload),
    update: payload => api.action('update', payload),
    pin: payload => api.action('pin', payload),
    forget: payload => api.action('forget', payload),
    merge: payload => api.action('merge-memories', payload),
    snapshot: () => api.snapshot(),
  })
  return api
}
