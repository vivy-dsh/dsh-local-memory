const prefix = '/dsh-memory/api'

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function allowedHost(host) {
  const value = String(host ?? '').toLowerCase()
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(value)
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 512 * 1024) throw new Error('请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function registerMemoryHttp(ctx, service) {
  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    const fail = (status, code, error, hint) => send(res, status, { ok: false, code, error, hint })
    if (!allowedHost(req.headers.host)) return fail(403, 'HOST_REJECTED', '只接受本机访问', '使用本地 DSH 面板打开记忆插件')
    if (req.method !== 'GET' && req.headers.origin) {
      let same = false
      try { same = new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase() } catch {}
      if (!same) return fail(403, 'ORIGIN_REJECTED', '跨站请求被拒绝', '在 DSH 面板内重试')
    }
    const conn = ctx.get('connection')
    if (!conn || typeof conn.requestRejection !== 'function') return fail(503, 'AUTH_UNAVAILABLE', '会话验证不可用', '检查 DSH 连接服务')
    const rejection = conn.requestRejection(req)
    if (rejection !== undefined && rejection !== null && rejection !== false) return fail(typeof rejection === 'number' ? rejection : 403, 'AUTH_REJECTED', '会话未通过验证', '重新打开本地面板链接')
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (url.pathname === `${prefix}/card` && req.method === 'GET') return send(res, 200, await service.snapshot())
      if (url.pathname === `${prefix}/card/preview` && req.method === 'GET') return send(res, 200, await service.cardPreview())
      if (url.pathname === `${prefix}/previews` && req.method === 'GET') return send(res, 200, await service.previews())
      if (url.pathname === `${prefix}/bili/brief` && req.method === 'GET') return send(res, 200, await service.biliBriefPreview())
      if (url.pathname === `${prefix}/bili/share-history/backups` && req.method === 'GET') return send(res, 200, await service.biliShareHistoryBackups())
      if (url.pathname === `${prefix}/qq-sync` && req.method === 'GET') return send(res, 200, await service.qqSyncStatus())
      if (url.pathname === `${prefix}/modules` && req.method === 'GET') return send(res, 200, await service.moduleStatus())
      if (url.pathname === `${prefix}/closure` && req.method === 'GET') return send(res, 200, await service.closureStatus(url.searchParams.get('key')))
      if (url.pathname === `${prefix}/slang` && req.method === 'GET') return send(res, 200, await service.slangList({ status: url.searchParams.get('status') || null }))
      if (url.pathname === `${prefix}/history` && req.method === 'GET') return send(res, 200, await service.historyStatus(url.searchParams.get('key')))
      if ([`${prefix}/qq-sync/settings`, `${prefix}/qq-sync/run`, `${prefix}/qq-sync/purge`].includes(url.pathname) && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, url.pathname.endsWith('/settings') ? await service.updateQqSync(body) : (url.pathname.endsWith('/purge') ? await service.purgeQqSync() : await service.syncQqFeed()))
      }
      if (url.pathname === `${prefix}/archive` && req.method === 'GET') {
        const controller = new AbortController()
        const cancel = () => { if (!res.writableEnded) controller.abort() }
        res.once?.('close', cancel)
        try {
          const records = await service.search(url.searchParams.get('q') || '', Number(url.searchParams.get('limit')) || 40, { signal: controller.signal })
          if (!res.destroyed) return send(res, 200, { ok: true, records })
        } finally { res.removeListener?.('close', cancel) }
        return
      }
      if (url.pathname === `${prefix}/archive/preview` && req.method === 'GET') return send(res, 200, await service.archivePreview())
      if (url.pathname === `${prefix}/archive/status` && req.method === 'GET') return send(res, 200, await service.archiveStatus())
      if (url.pathname === `${prefix}/archive/record` && req.method === 'GET') return send(res, 200, await service.archiveRecord({ offset: url.searchParams.get('offset'), length: url.searchParams.get('length'), revision: url.searchParams.get('revision'), start: url.searchParams.get('start') || 0 }))
      if (url.pathname === `${prefix}/backups` && req.method === 'GET') return send(res, 200, { ok: true, backups: await service.backups() })
      if (url.pathname === `${prefix}/sessions` && req.method === 'GET') return send(res, 200, { ok: true, sessions: await service.sessions.list() })
      if (url.pathname === `${prefix}/session` && req.method === 'GET') return send(res, 200, { ok: true, ...await service.sessions.read(url.searchParams.get('key')) })
      if (url.pathname === `${prefix}/session/backups` && req.method === 'GET') return send(res, 200, { ok: true, backups: await service.sessions.backups(url.searchParams.get('key')) })
      if (url.pathname === `${prefix}/session/database-backups` && req.method === 'GET') return send(res, 200, { ok: true, backups: await service.sessions.databaseBackups() })
      if (url.pathname === `${prefix}/bili/refresh` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        await readBody(req)
        return send(res, 200, await service.refreshBili())
      }
      if (url.pathname === `${prefix}/bili/share-history/restore` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, await service.restoreBiliShareHistory(String(body.name ?? '')))
      }
      if (url.pathname === `${prefix}/restore` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, await service.restore(String(body.name ?? '')))
      }
      if (url.pathname === `${prefix}/settings` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        return send(res, 200, await service.updateSettings(await readBody(req)))
      }
      if (url.pathname === `${prefix}/owner-alert` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        return send(res, 200, await service.updateOwnerAlert(await readBody(req)))
      }
      if (url.pathname === `${prefix}/owner-alert/check` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        await readBody(req)
        const result = await service.notifyOwnerIfNeeded()
        return send(res, result.ok ? 200 : 503, result)
      }
      if (url.pathname === `${prefix}/sync-settings` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        return send(res, 200, await service.updateSyncSettings(await readBody(req)))
      }
      if (url.pathname === `${prefix}/session` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, { ok: true, ...await service.sessions.write(body.key, body.value, body.revision, { backup: true }) })
      }
      if (url.pathname === `${prefix}/session/restore` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, { ok: true, ...await service.sessions.restore(body.key, body.name, body.revision) })
      }
      if (url.pathname === `${prefix}/session/database-restore` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, await service.sessions.recoverDatabase(String(body.name ?? '')))
      }
      if (url.pathname === `${prefix}/card` && req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        const body = await readBody(req)
        return send(res, 200, await service.action(String(body.action ?? ''), body))
      }
      const modulePosts = {
        [`${prefix}/settings/module`]: body => service.updateModuleSettings(String(body.section || ''), body.changes),
        [`${prefix}/session/dedupe`]: body => service.dedupeSessions(body.mappings),
        [`${prefix}/closure/assess`]: body => service.assessClosure(body),
        [`${prefix}/closure/save`]: body => service.saveClosure(body),
        [`${prefix}/closure/reopen`]: body => service.reopenClosure(body),
        [`${prefix}/slang/upsert`]: body => service.slangUpsert(body),
        [`${prefix}/slang/delete`]: body => service.slangDelete(body.id),
        [`${prefix}/slang/apply-extraction`]: body => service.slangApplyExtraction(body),
        [`${prefix}/slang/apply-research`]: body => service.slangApplyResearch(body),
        [`${prefix}/history/catchup`]: body => service.historyCatchup(body),
        [`${prefix}/context/snapshot`]: body => service.contextSnapshot(body),
      }
      const modulePost = modulePosts[url.pathname]
      if (req.method === 'POST' && modulePost) {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return fail(415, 'JSON_REQUIRED', '请求必须使用 JSON', '刷新页面后重试')
        return send(res, 200, await modulePost(await readBody(req)))
      }
      return fail(404, 'NOT_FOUND', '未知接口', '刷新记忆插件后重试')
    } catch (error) {
      if (res.destroyed) return
      const known = /^(?:MEMORY_|SUBJECT_|ACTMEM_)/.test(String(error?.code ?? ''))
      return fail(400, known ? error.code : 'MEMORY_OPERATION_FAILED', String(error?.message ?? error),
        error?.hint ?? '检查记忆数据和设置；必要时从备份恢复')
    }
  } })
}
