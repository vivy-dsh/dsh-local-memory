import { isSubjectId, normalizeProvenance } from '../../_shared/contracts.mjs'

export const ACTMEM_SCHEMA_VERSION = 1
export const RELATION_TYPES = ['related', 'follow-up', 'contradicts', 'merged-from']
const RELATION_LIMIT = 50

export class ActMemError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'ActMemError'
    this.code = code
    if (hint) this.hint = hint
  }
}

export function readProvenance(value) {
  if (value === undefined || value === null) return null
  try { return normalizeProvenance(value) } catch { return null }
}

export function readRelations(value, { strict = false } = {}) {
  const result = [], seen = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    const type = String(item?.type ?? '')
    const targetId = String(item?.targetId ?? '')
    if (!RELATION_TYPES.includes(type) || !targetId || targetId.length > 200) {
      if (strict) throw new ActMemError('ACTMEM_RELATION_INVALID', `关系必须是 ${RELATION_TYPES.join('|')} 且带 targetId`)
      continue
    }
    const key = `${type}:${targetId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ type, targetId })
    if (result.length >= RELATION_LIMIT) break
  }
  return result
}

export function inspectActMem(card, subjectId) {
  if (!isSubjectId(subjectId)) throw new ActMemError('SUBJECT_UNAVAILABLE', `主体 ID 无效：${String(subjectId)}`)
  const meta = card?.meta?.actmem ?? null
  if (meta) {
    if (Number(meta.schemaVersion) > ACTMEM_SCHEMA_VERSION) {
      throw new ActMemError('ACTMEM_SCHEMA_UNSUPPORTED', `记忆卡使用了更新的 ActMem schema ${meta.schemaVersion}，请升级记忆插件或从备份恢复`)
    }
    if (meta.subjectId !== undefined && !isSubjectId(meta.subjectId)) {
      throw new ActMemError('ACTMEM_CARD_INVALID', '记忆卡的 ActMem 主体记录无效，请从备份恢复')
    }
    if (meta.subjectId && meta.subjectId !== subjectId) {
      throw new ActMemError('ACTMEM_SUBJECT_MISMATCH', `记忆卡属于另一个主体（${meta.subjectId}），拒绝以 ${subjectId} 写入`, '确认 DSH_SUBJECT_ID 指向本安装的主体；不要把其他主体的记忆卡复制进来')
    }
  }
  let legacyRecords = 0
  for (const record of card?.records ?? []) {
    if (record.subjectId && record.subjectId !== subjectId) {
      throw new ActMemError('ACTMEM_SUBJECT_MISMATCH', `记忆 ${record.id} 属于另一个主体，拒绝写入`)
    }
    if (!record.subjectId) legacyRecords += 1
  }
  return { anchored: Boolean(meta), legacyRecords }
}

export function anchorCard(card, { subjectId, now = Date.now() }) {
  const inspection = inspectActMem(card, subjectId)
  if (!card.meta) card.meta = {}
  if (!card.meta.actmem) {
    card.meta.actmem = {
      schemaVersion: ACTMEM_SCHEMA_VERSION,
      subjectId,
      createdAt: new Date(now).toISOString(),
      migratedAt: inspection.legacyRecords ? new Date(now).toISOString() : null,
    }
  }
  for (const record of card.records ?? []) {
    if (!record.subjectId) record.subjectId = subjectId
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) record.revision = 1
    record.provenance = readProvenance(record.provenance)
    record.relations = readRelations(record.relations)
  }
  return inspection
}

export function bumpRevision(record) {
  record.revision = Math.min(1_000_000, (Number(record.revision) || 1) + 1)
  return record.revision
}
