import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const validKey = /^(?:group|private):\d{1,24}$/
const empty = () => ({ activeTopics: [], pendingThoughts: [], memberImpressions: {} })

function canonicalKey(key) {
  const match = /^(group|private):(\d+)$/.exec(key)
  if (!match) return key
  const number = Number(match[2])
  return Number.isSafeInteger(number) && number > 0 ? `${match[1]}:${number}` : key
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session memory')
  const impressions = value.memberImpressions ?? {}
  if (!Array.isArray(value.activeTopics ?? []) || !Array.isArray(value.pendingThoughts ?? []) || !impressions || typeof impressions !== 'object' || Array.isArray(impressions)) throw new Error('Invalid session memory')
  const clean = Object.create(null)
  for (const [name, item] of Object.entries(impressions)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) continue
    clean[name] = item
  }
  const result = { activeTopics: value.activeTopics ?? [], pendingThoughts: value.pendingThoughts ?? [], memberImpressions: clean }
  const encoded = JSON.stringify(result)
  if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('Session memory is too large')
  return JSON.parse(encoded)
}

function validateDatabase(data) {
  if (data?.version !== 1 || !data.conversations || typeof data.conversations !== 'object' || Array.isArray(data.conversations)) throw new Error('Session memory is corrupt')
  const aliases = new Map()
  for (const [key, entry] of Object.entries(data.conversations)) {
    if (!validKey.test(key) || !Number.isSafeInteger(entry?.revision) || entry.revision < 0) throw new Error('Session memory is corrupt')
    try { normalize(entry.value) } catch { throw new Error('Session memory is corrupt') }
    const canonical = canonicalKey(key), previous = aliases.get(canonical)
    if (previous && JSON.stringify(previous.value) !== JSON.stringify(entry.value)) throw new Error(`会话记忆别名冲突：${canonical}；原文件已保留`)
    aliases.set(canonical, entry)
  }
  return data
}

function canonicalizeDatabase(data) {
  validateDatabase(data)
  const conversations = Object.create(null)
  let changed = false
  for (const [key, entry] of Object.entries(data.conversations)) {
    const canonical = canonicalKey(key), previous = conversations[canonical]
    if (!previous || entry.revision > previous.revision) conversations[canonical] = entry
    if (canonical !== key || previous) changed = true
  }
  return { data: changed ? { ...data, conversations } : data, changed }
}

/** A bridge may discard legacy fields only after startup has repaired all aliases. */
export function assertSessionDatabaseReady(data) {
  validateDatabase(data)
  if (Object.keys(data.conversations).some(key => canonicalKey(key) !== key)) throw new Error('会话记忆别名尚未修复，请重启独立记忆插件')
  return data
}

/** Single writer for QQ session memory; legacy conversation traffic stays with SurfCore. */
export function createSessionMemoryStore({ stateDir, legacyFile }) {
  if (!stateDir) throw new Error('Memory state directory is required')
  const file = join(stateDir, 'session-memory.json')
  const backupDir = join(stateDir, 'backups', 'sessions')
  let chain = Promise.resolve()
  let closing = false
  const serial = fn => { if (closing) return Promise.reject(new Error('会话记忆已关闭')); const next = chain.then(fn, fn); chain = next.catch(() => {}); return next }
  function atomic(value, initial = false) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (initial) { writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); return }
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  }
  function load() {
    if (!existsSync(file)) {
      const conversations = Object.create(null)
      if (legacyFile && existsSync(legacyFile)) {
        let legacy
        try { legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) } catch { throw new Error('Legacy QQ state is corrupt') }
        if (!legacy || typeof legacy !== 'object' || (legacy.conversations != null && (typeof legacy.conversations !== 'object' || Array.isArray(legacy.conversations)))) throw new Error('Legacy QQ state is corrupt')
        for (const [key, value] of Object.entries(legacy.conversations ?? {})) {
          if (!validKey.test(key) || !value || typeof value !== 'object') continue
          const canonical = canonicalKey(key)
          const normalized = normalize(value)
          if (conversations[canonical] && JSON.stringify(conversations[canonical].value) !== JSON.stringify(normalized)) throw new Error(`旧会话记忆别名冲突：${canonical}；原文件已保留`)
          conversations[canonical] = { revision: 0, value: normalized }
        }
      }
      try { atomic({ version: 1, conversations }, true) } catch (e) { if (e.code !== 'EEXIST') throw e }
    }
    let data
    try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('Session memory is corrupt') }
    return validateDatabase(data)
  }
  function check(key) {
    if (typeof key !== 'string' || !validKey.test(key)) throw new Error('Invalid session key')
    const canonical = canonicalKey(key), digits = canonical.split(':')[1]
    if (!/[1-9]/.test(digits)) throw new Error('Invalid session key')
    return canonical
  }
  function loadReady() { return assertSessionDatabaseReady(load()) }
  function backup(key, entry) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    const name = `session-${Date.now()}-${randomUUID()}.json`
    writeFileSync(join(backupDir, name), `${JSON.stringify({ key, value: entry.value })}\n`, { flag: 'wx', mode: 0o600 })
  }
  function backupDatabase(data, { ifChanged = false } = {}) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    const text = `${JSON.stringify(data, null, 2)}\n`
    if (ifChanged) {
      const names = readdirSync(backupDir).filter(name => /^session-db-\d+-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse()
      const newest = names[0]?.match(/^session-db-(\d+)-/)?.[1]
      for (const name of names) {
        if (!name.startsWith(`session-db-${newest}-`)) break
        try {
          const prior = join(backupDir, name)
          if (lstatSync(prior).isFile() && readFileSync(prior, 'utf8') === text) return
        } catch { /* A missing or unreadable backup is not a substitute for a new one. */ }
      }
    }
    const name = `session-db-${Date.now()}-${randomUUID()}.json`
    writeFileSync(join(backupDir, name), text, { flag: 'wx', mode: 0o600 })
  }
  function readBackup(name) {
    if (!/^session-\d+-[a-f0-9-]+\.json$/.test(String(name))) throw new Error('Invalid session backup')
    const path = join(backupDir, name)
    if (!lstatSync(path).isFile()) throw new Error('Invalid session backup')
    const entry = JSON.parse(readFileSync(path, 'utf8'))
    return { key: check(entry.key), value: normalize(entry.value) }
  }
  return {
    dispose() { closing = true; return chain },
    initialize() {
      if (closing) throw new Error('会话记忆已关闭')
      const data = load(), normalized = canonicalizeDatabase(data)
      backupDatabase(data, { ifChanged: true })
      if (normalized.changed) atomic(normalized.data)
    },
    list() { return serial(() => Object.keys(loadReady().conversations).sort()) },
    read(key) { return serial(() => { key = check(key); const data = loadReady(); return data.conversations[key] ?? { revision: 0, value: empty() } }) },
    write(key, value, revision, { backup: keepBackup = false } = {}) { return serial(() => {
      key = check(key)
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid session revision')
      const data = loadReady(), current = data.conversations[key] ?? { revision: 0, value: empty() }
      if (current.revision !== revision) throw new Error('Session memory conflict; refresh and retry')
      const next = { revision: current.revision + 1, value: normalize(value) }
      if (keepBackup) { backupDatabase(data); backup(key, current) }
      data.conversations[key] = next
      atomic(data)
      return next
    }) },
    touchTopics(key, topics, at, { hashed = false } = {}) { return serial(() => {
      key = check(key)
      if (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string' || (hashed && !/^[a-f0-9]{64}$/.test(topic))) || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid topic mention')
      const data = loadReady(), current = data.conversations[key]
      if (!current || !topics.length) return current ?? { revision: 0, value: empty() }
      const names = new Set(topics)
      let changed = false
      const activeTopics = current.value.activeTopics.map(topic => {
        const text = String(topic?.text || ''), match = hashed ? createHash('sha256').update(text).digest('hex') : text
        if (!topic || typeof topic !== 'object' || !names.has(match) || (Number(topic.lastMentionAt) || 0) >= at) return topic
        changed = true
        return { ...topic, lastMentionAt: at }
      })
      if (!changed) return current
      const next = { revision: current.revision + 1, value: normalize({ ...current.value, activeTopics }) }
      data.conversations[key] = next
      atomic(data)
      return next
    }) },
    backups(key) { return serial(() => {
      key = check(key)
      if (!existsSync(backupDir)) return []
      return readdirSync(backupDir).filter(name => {
        try { return readBackup(name).key === key } catch { return false }
      }).sort().reverse()
    }) },
    restore(key, name, revision) { return serial(() => {
      key = check(key)
      const saved = readBackup(name)
      if (saved.key !== key) throw new Error('Invalid session backup')
      const data = loadReady(), current = data.conversations[key] ?? { revision: 0, value: empty() }
      if (current.revision !== revision) throw new Error('Session memory conflict; refresh and retry')
      backupDatabase(data)
      backup(key, current)
      const next = { revision: current.revision + 1, value: saved.value }
      data.conversations[key] = next
      atomic(data)
      return next
    }) },
    databaseBackups() { return serial(() => existsSync(backupDir) ? readdirSync(backupDir).filter(name => /^session-db-\d+-[a-f0-9-]{36}\.json$/.test(name) && lstatSync(join(backupDir, name)).isFile()).sort().reverse() : []) },
    recoverDatabase(name) { return serial(() => {
      if (!/^session-db-\d+-[a-f0-9-]{36}\.json$/.test(String(name))) throw new Error('Invalid session database backup')
      const source = join(backupDir, name)
      if (!lstatSync(source).isFile()) throw new Error('Invalid session database backup')
      let saved
      try { saved = canonicalizeDatabase(JSON.parse(readFileSync(source, 'utf8'))).data } catch { throw new Error('Session database backup is corrupt') }
      if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error('Session database is not corrupt')
      let healthy = false
      try { load(); healthy = true } catch {}
      if (healthy) throw new Error('Session database is not corrupt')
      const damaged = join(backupDir, `session-db-damaged-${Date.now()}-${randomUUID()}.json`)
      copyFileSync(file, damaged, constants.COPYFILE_EXCL)
      atomic(saved)
      return { ok: true, damaged: damaged.split(/[\\/]/).pop(), sessions: Object.keys(saved.conversations).length }
    }) },
  }
}
