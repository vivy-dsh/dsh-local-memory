import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Exclude the QQ bridge while synchronously changing shared state. */
export function withBridgeMaintenance(feedFile, action) {
  if (!feedFile) throw new Error('QQ 桥接状态路径不可用，无法安全执行')
  const dir = dirname(feedFile), marker = join(dir, 'bridge-maintenance.lock'), lock = join(dir, 'bridge.lock')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const owned = []
  try {
    for (const file of [marker, lock]) {
      try { writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code === 'EEXIST') throw new Error('请先停止 QQ 桥接并确认没有其他维护操作'); throw error }
      owned.push([file, lstatSync(file)])
    }
    return action()
  } finally {
    for (const [file, original] of owned.reverse()) {
      try { const current = lstatSync(file); if (current.dev === original.dev && current.ino === original.ino && readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file) } catch {}
    }
  }
}
