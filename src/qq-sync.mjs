import { appendFileSync, closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withBridgeMaintenance } from './bridge-maintenance.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { assertSafeOutput, isPublicGroupMessage, sanitizeText } from './privacy.mjs'
import { scanQqFeedSnapshot } from '../../_shared/qq-feed.mjs'

const TOPICS = [
  ['AI/DSH', /AI|DeepSeek|DSH|大模型|模型|插件|提示词|agent|智能体/i], ['B站', /B站|bilibili|视频|UP主|番剧|弹幕|直播/i],
  ['游戏', /游戏|原神|崩铁|星铁|绝区零|Steam|手游|联机|开黑/i], ['技术', /代码|编程|前端|后端|Python|接口|部署|报错/i],
  ['猫/动物', /猫|狗|宠物|小动物/], ['音乐/二次元', /音乐|歌|翻唱|初音|二次元|动漫|动画/i],
  ['学习/工作', /学习|考试|作业|上班|工作|加班|论文|学校/], ['吃喝日常', /吃|饭|奶茶|咖啡|外卖|睡|困/],
  ['情绪/吐槽', /笑死|难绷|离谱|无语|开心|难受|生气|可爱/],
]
const MEME_RE = /(?:梗|笑死|难绷|绷不住|离谱|草|乐|典|急了|破防|抽象|整活|好活)/
const BOUNDARIES = '## 使用边界\n- 这些是公开群聊的脱敏摘要，不是私信，也不是群友的完整原话。\n- 不要公开提及 QQ 群号、群昵称或个人 QQ 号，也不要追问或验证任何人的身份。\n- 不要传播财务、精确位置、联系方式、账号凭据或家庭等敏感信息；身份对齐仅用于认人。'

export function createQqSync({ stateDir, feedFile, alignmentFile, qqConfigFile }) {
  const dir = join(stateDir, 'data'), configFile = join(stateDir, 'config.json')
  const output = join(dir, 'qq-public-summary.json'), auditFile = join(dir, 'qq-sync-audit.jsonl')
  const readAlignment = cfg => cfg.includeIdentityLinks && alignmentFile && existsSync(alignmentFile) ? readFileSync(alignmentFile, 'utf8') : ''
  const ownerId = () => qqConfigFile && existsSync(qqConfigFile) ? String(JSON.parse(readFileSync(qqConfigFile, 'utf8')).ownerQQ ?? '') : ''
  const fingerprint = (cfg, alignment = readAlignment(cfg), owner = ownerId()) => createHash('sha256').update(JSON.stringify([cfg, alignment, owner])).digest('hex')
  function config() {
    const root = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
    let saved = root.qqSync
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      const legacy = root.memory?.qqToBili || {}
      const qq = qqConfigFile && existsSync(qqConfigFile) ? JSON.parse(readFileSync(qqConfigFile, 'utf8')) : {}
      const groups = Array.isArray(legacy.includeGroups) && legacy.includeGroups.length ? legacy.includeGroups : (qq.allow?.groups ?? [])
      const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback
      saved = { enabled: false, autoSync: false, includeIdentityLinks: false,
        includeGroups: Array.isArray(groups) ? [...new Set(groups.map(String).filter(id => /^\d{4,15}$/.test(id)))].slice(0, 500) : [],
        includeOwner: legacy.includeOwner === true, useNicknames: legacy.useNicknames === true,
        lookbackDays: bounded(legacy.lookbackDays, 7, 1, 90), maxMessages: bounded(legacy.maxMessages, 300, 1, 5000),
        maxChars: bounded(legacy.maxChars, 6000, 1200, 20000), intervalMs: bounded(legacy.intervalMs, 1800000, 300000, 86400000) }
    }
    return { enabled: saved.enabled === true, autoSync: saved.autoSync === true, intervalMs: Number.isInteger(saved.intervalMs) ? Math.max(300000, Math.min(86400000, saved.intervalMs)) : 1800000, revision: typeof saved.revision === 'string' ? saved.revision : '', includeGroups: Array.isArray(saved.includeGroups) ? saved.includeGroups : [], includeOwner: saved.includeOwner === true, useNicknames: saved.useNicknames === true, includeIdentityLinks: saved.includeIdentityLinks === true,
      lookbackDays: saved.lookbackDays ?? 7, maxMessages: saved.maxMessages ?? 300, maxChars: saved.maxChars ?? 6000 }
  }
  function atomic(file, value) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, value, { flag: 'wx', mode: 0o600 }); renameSync(tmp, file)
  }
  function update(changes) {
    const current = config(), next = { ...current }
    if (typeof changes.enabled === 'boolean') next.enabled = changes.enabled
    if (typeof changes.autoSync === 'boolean') next.autoSync = changes.autoSync
    if (typeof changes.includeOwner === 'boolean') next.includeOwner = changes.includeOwner
    if (typeof changes.useNicknames === 'boolean') next.useNicknames = changes.useNicknames
    if (typeof changes.includeIdentityLinks === 'boolean') next.includeIdentityLinks = changes.includeIdentityLinks
    if (changes.includeGroups !== undefined) {
      if (!Array.isArray(changes.includeGroups) || changes.includeGroups.some(id => !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) || !/^\d{4,15}$/.test(String(id)))) throw new Error('群白名单必须是有效群号')
      next.includeGroups = [...new Set(changes.includeGroups.map(String))]
      if (next.includeGroups.length > 500) throw new Error('群白名单最多 500 个群号')
    }
    for (const [key, min, max] of [['lookbackDays', 1, 90], ['maxMessages', 1, 5000], ['maxChars', 1200, 20000], ['intervalMs', 300000, 86400000]]) {
      if (changes[key] !== undefined) { const n = Number(changes[key]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`无效同步参数：${key}`); next[key] = n }
    }
    next.revision = randomUUID()
    const root = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
    atomic(configFile, `${JSON.stringify({ ...root, qqSync: next }, null, 2)}\n`)
    return next
  }
  async function sync() {
    const cfg = config()
    if (!cfg.enabled) throw new Error('QQ 公开群同步未启用')
    if (!cfg.includeGroups.length) throw new Error('请先设置允许同步的群白名单')
    const cutoff = Date.now() - cfg.lookbackDays * 86400000
    const alignment = readAlignment(cfg)
    const owner = ownerId()
    const links = alignment ? JSON.parse(alignment).links || [] : []
    const scanned = await scanQqFeedSnapshot(feedFile, () => {
      const kept = []; let invalidLines = 0, validLines = 0, recentCount = 0
      return { line(line) {
      if (line === null) { invalidLines++; return }
      if (!line.trim()) return
      let row
      try { row = JSON.parse(line) } catch { invalidLines++; return }
      if (!row || typeof row !== 'object' || Array.isArray(row)) { invalidLines++; return }
      validLines++
      if (!(Date.parse(row.at) >= cutoff)) return
      recentCount++
      if (!cfg.includeGroups.includes(String(row.groupId ?? '')) || (!cfg.includeOwner && (row.isOwner === true || (owner && String(row.senderId ?? '') === owner)))) return
      if (row.private === true || row.isPrivate === true || (row.kind != null && row.kind !== 'group') || (row.message_type != null && row.message_type !== 'group')) return
      const conversationKey = row.conversationKey ?? row.key
      if (conversationKey != null && String(conversationKey) !== `group:${row.groupId}`) return
      const gate = isPublicGroupMessage({ key: `group:${row.groupId}`, groupIds: cfg.includeGroups, text: row.text, senderId: row.senderId })
      if (!gate.ok) return
      const clean = sanitizeText(row.text, { dropUnsafeLines: true, keepNumbers: false, maxChars: 220 })
      if (clean.ok && clean.text) {
        const nickname = cfg.useNicknames ? sanitizeText(row.senderName ?? '', { dropUnsafeLines: true, keepNumbers: false, maxChars: 24 }) : null
        const link = links.find(item => item.verified === true && String(item.identities?.qq?.id ?? '') === String(row.senderId ?? ''))
        const name = link ? sanitizeText(link.identities?.bili?.name ?? '', { dropUnsafeLines: true, keepNumbers: false, maxChars: 24 }) : null
        kept.push({ group: String(row.groupId), senderKey: String(row.senderId ?? ''), sender: nickname?.ok && nickname.text ? nickname.text : '群友', biliName: name?.ok ? name.text : '', text: clean.text })
        if (kept.length > cfg.maxMessages) kept.shift()
      }
      }, result: () => ({ kept, invalidLines, validLines, recentCount }) }
    })
    if (!scanned) throw new Error('QQ 公开群消息记录不存在，请先启动 QQ 桥接')
    const { kept, invalidLines, validLines, recentCount } = scanned
    if (invalidLines && !validLines) throw new Error('QQ 消息记录没有可读取的有效记录，原摘要未覆盖')
    const topicCounts = TOPICS.map(([label, re]) => [label, kept.filter(item => re.test(item.text)).length]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
    const aliases = new Map([...new Set(kept.map(item => item.group))].sort().map((id, index) => [id, `群${index + 1}`]))
    const people = new Map()
    for (const item of kept) {
      const key = JSON.stringify([item.group, item.senderKey])
      if (!people.has(key)) people.set(key, { ...item, messages: [] })
      people.get(key).messages.push(item.text)
    }
    const peopleText = [...people.values()].slice(0, 20).map(person => {
      const topics = TOPICS.filter(([, re]) => person.messages.some(message => re.test(message))).map(([label]) => label).slice(0, 3)
      return `- ${aliases.get(person.group)} · ${person.sender}${person.biliName ? `（B站：${person.biliName}）` : ''}：${topics.length ? `最近常聊 ${topics.join('、')}` : '最近聊得比较杂'}；说过「${person.messages[0].slice(0, 60)}」`
    }).join('\n') || '- 暂无公开群消息'
    const topicText = topicCounts.length ? topicCounts.map(([label, count]) => `- ${label}：${count} 条`).join('\n') : '- 暂无明显话题'
    const recentText = kept.slice(-80).map(item => `- ${aliases.get(item.group)} · ${item.sender}${item.biliName ? `（B站：${item.biliName}）` : ''}：${item.text}`).join('\n') || '- 暂无公开群消息'
    const memeText = kept.filter(item => MEME_RE.test(item.text)).slice(-8).map(item => `- ${aliases.get(item.group)} · ${item.sender}：${item.text.slice(0, 80)}`).join('\n') || '- 这段时间没有明显的梗'
    const intro = '# QQ 公开群近况\n\n仅包含允许的公开群消息，私聊与敏感内容不跨平台。\n\n'
    const memes = `\n\n## 最近的梗 / 口头禅\n${memeText.slice(0, 450)}`
    const tail = `\n\n${BOUNDARIES}`
    const body = `## 群友近况\n${peopleText}\n\n## 最近话题\n${topicText}\n\n## 群聊摘录\n${recentText}`
    const text = `${intro}${body.slice(0, Math.max(0, cfg.maxChars - intro.length - memes.length - tail.length))}${memes}${tail}`
    assertSafeOutput(text, 'QQ 公开群摘要')
    if (fingerprint(config()) !== fingerprint(cfg, alignment, owner)) throw new Error('QQ 同步配置在扫描期间发生变化，请重新同步；原摘要已保留')
    atomic(output, `${JSON.stringify({ revision: cfg.revision, fingerprint: fingerprint(cfg, alignment, owner), text })}\n`)
    const stats = { at: new Date().toISOString(), scanned: recentCount, kept: kept.length, dropped: recentCount - kept.length, invalidLines, chars: text.length }
    try {
      let separator = ''
      try {
        const fd = openSync(auditFile, 'r')
        try { const size = fstatSync(fd).size; if (size) { const byte = Buffer.alloc(1); if (readSync(fd, byte, 0, 1, size - 1) !== 1) throw new Error('读取审计日志末尾失败'); if (byte[0] !== 10) separator = '\n' } } finally { closeSync(fd) }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      appendFileSync(auditFile, `${separator}${JSON.stringify(stats)}\n`, { mode: 0o600 })
    } catch (error) {
      return { ok: true, stats, auditWarning: `审计日志写入失败：${String(error?.message ?? error)}` }
    }
    return { ok: true, stats }
  }
  function summaryView() {
    const cfg = config()
    if (!cfg.enabled || !existsSync(output)) return { text: '', blocked: false, labels: [] }
    const saved = JSON.parse(readFileSync(output, 'utf8'))
    if (saved.revision !== cfg.revision || saved.fingerprint !== fingerprint(cfg)) return { text: '', blocked: false, labels: [] }
    const value = String(saved.text || '')
    try { assertSafeOutput(value, 'QQ 公开群摘要') } catch (error) {
      if (error.code === 'PRIVACY_BLOCKED') return { text: '', blocked: true, labels: [...new Set((error.hits || []).map(hit => hit.label))] }
      throw error
    }
    return { text: value, blocked: false, labels: [] }
  }
  function text() { return summaryView().text }
  async function status() {
    const audit = []; let invalidAuditLines = 0, auditError = ''
    let parts = [], size = 0, oversized = false
    const append = part => {
      if (oversized || !part.length) return
      size += part.length
      if (size > 1024 * 1024) { oversized = true; parts = []; return }
      parts.push(part)
    }
    const finish = () => {
      if (oversized) { invalidAuditLines++; parts = []; size = 0; oversized = false; return }
      const line = Buffer.concat(parts, size).toString('utf8'); parts = []; size = 0
      if (!line.trim()) return
      try {
        const item = JSON.parse(line)
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid audit entry')
        audit.push(item)
        if (audit.length > 40) audit.shift()
      } catch { invalidAuditLines++ }
    }
    try {
      for await (const chunk of createReadStream(auditFile, { highWaterMark: 64 * 1024 })) {
        let start = 0, end
        while ((end = chunk.indexOf(10, start)) !== -1) { append(chunk.subarray(start, end)); finish(); start = end + 1 }
        append(chunk.subarray(start))
      }
      if (size || oversized) finish()
    } catch (error) { if (error.code !== 'ENOENT') auditError = '同步审计无法读取，显示的记录可能不完整；原文件已保留。' }
    const current = config()
    let summary = { text: '', blocked: false, labels: [] }, summaryError = ''
    try { summary = summaryView() } catch { summaryError = '同步摘要无法读取，原文件已保留；可检查后重新同步或关闭同步。' }
    return { ok: true, config: current, text: summary.text, summaryBlocked: summary.blocked, summaryLabels: summary.labels, audit, invalidAuditLines, ...(summaryError ? { summaryError } : {}), ...(auditError ? { auditError } : {}) }
  }
  function purge() {
    if (!feedFile) throw new Error('QQ 公开群记录路径不可用')
    return withBridgeMaintenance(feedFile, () => {
    const moved = [], backup = randomUUID()
    const folder = join(stateDir, 'backups', 'qq-sync-purge', backup)
    try {
      const sources = [[feedFile, 'qq-public-feed.jsonl'], [`${feedFile}.1`, 'qq-public-feed.jsonl.1'], [output, 'qq-public-summary.json']]
      for (const [source] of sources) {
        try { if (!lstatSync(source).isFile()) throw new Error('公开群同步文件不是普通文件，已停止清空') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      for (const [source, name] of sources) {
        if (!existsSync(source)) continue
        const target = join(folder, name)
        renameSync(source, target)
        moved.push([source, target])
      }
      return { ok: true, backup, files: moved.map(([, target]) => target.slice(folder.length + 1)) }
    } catch (error) {
      let rollbackFailed = false
      for (const [source, target] of moved.reverse()) {
        try { if (existsSync(source)) rollbackFailed = true; else renameSync(target, source) } catch { rollbackFailed = true }
      }
      if (rollbackFailed) throw new Error(`清空未完成，部分原文件保留在项目内备份 ${backup}；请核对后恢复`)
      throw error
    }
    })
  }
  return { config, update, sync, text, status, purge }
}
