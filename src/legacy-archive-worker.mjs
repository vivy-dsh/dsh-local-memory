import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import chain from 'stream-chain'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/pick.js'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import { encodeLegacyArchiveRecord, publishLegacyArchive } from './card-engine.mjs'

async function convert(paths) {
  const staged = `${paths.fullJsonl}.migration-${randomUUID()}`
  let input, output, tokens
  try {
    input = await fs.promises.open(paths.fullJson, 'r')
    const before = await input.stat()
    output = await fs.promises.open(staged, 'wx', 0o600)
    const source = input.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })
    tokens = chain([source, parser()])
    const iterator = tokens[Symbol.asyncIterator](), first = await iterator.next()
    if (first.done || !['startArray', 'startObject'].includes(first.value?.name)) throw new Error('旧版全量归档结构无效')
    const replay = Readable.from((async function* () { yield first.value; for await (const token of iterator) yield token })(), { objectMode: true })
    let depth = 0, arrays = 0
    const verify = token => {
      if (depth === 0) {
        if (token.name !== 'startArray' || ++arrays !== 1) throw new Error('旧版全量归档 records 必须是唯一数组')
      }
      if (token.name === 'startArray' || token.name === 'startObject') depth++
      if (token.name === 'endArray' || token.name === 'endObject') depth--
      return token
    }
    const stages = [replay, ...(first.value.name === 'startObject' ? [pick({ filter: 'records' })] : []), verify, streamArray()]
    let buffered = '', now = Date.now()
    for await (const item of chain(stages)) {
      const line = encodeLegacyArchiveRecord(item.value, now)
      if (line.length > 4 * 1024 * 1024) throw new Error('旧版全量归档包含超大单条记录')
      buffered += `${line}\n`
      if (buffered.length >= 1024 * 1024) { await output.writeFile(buffered); buffered = '' }
    }
    if (arrays !== 1 || depth !== 0) throw new Error('旧版全量归档缺少有效的 records 数组')
    if (buffered) await output.writeFile(buffered)
    await output.close(); output = null
    const after = await input.stat(), current = await fs.promises.stat(paths.fullJson)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw new Error('旧版归档在转换期间发生变化，请重试')
    publishLegacyArchive(paths, staged, now)
  } finally {
    tokens?.destroy()
    await output?.close()
    await input?.close()
    try { await fs.promises.unlink(staged) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

try {
  await convert(workerData.paths)
  parentPort.postMessage({ ok: true })
} catch (error) {
  parentPort.postMessage({ ok: false, error: `旧版全量归档转换失败，原文件已保留：${String(error?.message ?? error)}` })
}
