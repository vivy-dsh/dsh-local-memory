import { readFileSync } from 'node:fs'
import { request } from 'node:http'

/** Only the already-running local QQ bridge can deliver this notification. */
export function createOwnerBridgeNotifier({ qqConfigFile, tokenFile, timeoutMs = 5000 }) {
  return async function notifyOwner(payload) {
    let config = {}
    try { config = JSON.parse(readFileSync(qqConfigFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') return { ok: false, error: 'QQ 桥接配置无效' } }
    let token = String(config.consoleToken || '').trim()
    if (!token) { try { token = readFileSync(tokenFile, 'utf8').trim() } catch {} }
    if (!token || /[\r\n]/.test(token)) return { ok: false, error: 'QQ 桥接令牌不可用' }
    const configuredPort = Number(config.consolePort || 3100)
    if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) return { ok: false, error: 'QQ 桥接端口无效' }
    const number = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || 0)))
    const body = JSON.stringify({ level: number(payload.level, 1, 3), chars: number(payload.chars, 0, 10000000), maxChars: number(payload.maxChars, 0, 10000000), percent: number(payload.percent, 0, 999) })
    return new Promise(resolve => {
      let settled = false
      const finish = value => { if (!settled) { settled = true; resolve(value) } }
      const req = request({ hostname: '127.0.0.1', port: configuredPort, method: 'POST', path: '/api/memory-card/notify',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-console-token': token } }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('响应过大')) })
        res.on('end', () => {
          try { const data = JSON.parse(text); finish(res.statusCode >= 200 && res.statusCode < 300 && data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'QQ 桥接拒绝通知' }) }
          catch { finish({ ok: false, error: 'QQ 桥接返回无效响应' }) }
        })
        res.on('error', () => finish({ ok: false, error: 'QQ 桥接响应中断' }))
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('QQ 桥接通知超时')))
      req.on('error', error => finish({ ok: false, error: `QQ 桥接不可用：${error.message}` }))
      req.end(body)
    })
  }
}
