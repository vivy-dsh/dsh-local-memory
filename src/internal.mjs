import { registerComponentInternal } from '../../_shared/ipc.mjs'

export function registerMemoryInternal(ctx, home, service) {
  return registerComponentInternal(ctx, { home, name: 'memory', handle: async ({ method, path, body }) => {
    if (method === 'GET' && path === '/health') return { ok: true }
    if (method === 'POST' && path === '/events') return service.record(body)
    if (method === 'POST' && path === '/session/read') return { ok: true, ...await service.sessions.read(body.key) }
    if (method === 'POST' && path === '/session/write') return { ok: true, ...await service.sessions.write(body.key, body.value, body.revision) }
    if (method === 'POST' && path === '/session/touch-topics') return { ok: true, ...await service.sessions.touchTopics(body.key, body.topics, body.at, { hashed: body.hashed === true }) }
    if (method === 'GET' && path === '/context/qq') return { ok: true, text: await service.context('qq') }
    if (method === 'GET' && path === '/context/bili') return { ok: true, text: await service.context('bili') }
    if (method === 'GET' && path === '/card') return service.snapshot()
    if (method === 'GET' && path === '/archive-out/status') return service.archiveOutStatus()
    if (method === 'POST' && path === '/archive-out/drain') return service.drainArchives()
    if (method === 'GET' && path === '/actmem/status') return service.actmemStatus()
    if (method === 'POST' && path === '/actmem/update') return service.action('update', body)
    if (method === 'POST' && path === '/actmem/add') return service.action('add', body)
    if (method === 'GET' && path === '/qq-sync/status') return service.qqSyncStatus()
    if (method === 'POST' && path === '/qq-sync/run') return service.syncQqFeed()
    if (method === 'GET' && path === '/bili/brief') return service.biliBriefPreview()
    if (method === 'POST' && path === '/bili/refresh') return service.refreshBili()
    if (method === 'GET' && path === '/bili/status') return { ok: true, ...await service.biliStatus() }
    if (method === 'POST' && path === '/bili/record-share') return service.recordBiliShare(String(body.id || ''), String(body.slot || ''))
    if (method === 'GET' && path === '/modules') return service.moduleStatus()
    if (method === 'POST' && path === '/settings/module') return service.updateModuleSettings(String(body.section || ''), body.changes)
    if (method === 'POST' && path === '/session/dedupe') return { ok: true, ...service.dedupeSessions(body.mappings) }
    if (method === 'POST' && path === '/closure/assess') return { ok: true, assessment: service.assessClosure(body) }
    if (method === 'POST' && path === '/closure/gate') return { ok: true, ...service.closureGate(body.assessment, body.config) }
    if (method === 'POST' && path === '/closure/save') return service.saveClosure(body)
    if (method === 'POST' && path === '/closure/status') return service.closureStatus(body.key)
    if (method === 'POST' && path === '/closure/reopen') return service.reopenClosure(body)
    if (method === 'POST' && path === '/closure/prompt') return service.closurePrompt(body)
    if (method === 'POST' && path === '/closure/suppress') return service.closureSuppress(body)
    if (method === 'POST' && path === '/slang/list') return service.slangList(body)
    if (method === 'POST' && path === '/slang/upsert') return service.slangUpsert(body)
    if (method === 'POST' && path === '/slang/delete') return service.slangDelete(body.id)
    if (method === 'POST' && path === '/slang/context') return service.slangContext(body)
    if (method === 'POST' && path === '/slang/extraction-prompt') return service.slangExtractionPrompt(body.messages)
    if (method === 'POST' && path === '/slang/research-prompt') return service.slangResearchPrompt(body.candidates)
    if (method === 'POST' && path === '/slang/apply-extraction') return service.slangApplyExtraction(body)
    if (method === 'POST' && path === '/slang/apply-research') return service.slangApplyResearch(body)
    if (method === 'POST' && path === '/history/catchup') return service.historyCatchup(body)
    if (method === 'POST' && path === '/context/snapshot') return service.contextSnapshot(body)
    throw new Error('Unknown memory component operation')
  } })
}
