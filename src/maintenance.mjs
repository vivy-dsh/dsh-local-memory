/** Local-only daily decay and archive maintenance; no platform messages or network calls. */
export function startMemoryMaintenance(service, { timers = globalThis, log = console.warn } = {}) {
  let stopped = false
  const maintain = async () => {
    if (stopped) return
    try {
      await service.maintenance()
      if (!stopped) { const result = await service.notifyOwnerIfNeeded?.(); if (result?.ok === false) log(`记忆容量通知失败：${result.error}`) }
    } catch (error) { log(`记忆整理失败：${String(error?.message ?? error)}`) }
    if (stopped) return
    try { await service.drainArchives?.() } catch (error) { log(`归档投递失败：${String(error?.message ?? error)}`) }
  }
  const refresh = async () => {
    if (stopped) return
    try { const result = await service.autoSyncQqFeed?.(); if (result?.auditWarning) log(`QQ 公开群同步已完成，但${result.auditWarning}`) } catch (error) { log(`QQ 公开群同步失败：${String(error?.message ?? error)}`) }
    if (stopped) return
    try { await service.autoRefreshBili?.() } catch (error) { log(`B站记忆刷新失败：${String(error?.message ?? error)}`) }
    if (stopped) return
    try { await service.drainArchives?.() } catch (error) { log(`归档投递失败：${String(error?.message ?? error)}`) }
  }
  const first = timers.setTimeout(async () => { await maintain(); await refresh() }, 8000)
  const interval = timers.setInterval(maintain, 10 * 60 * 1000)
  const sync = timers.setInterval(refresh, 60 * 1000)
  first?.unref?.(); interval?.unref?.(); sync?.unref?.()
  return () => { stopped = true; timers.clearTimeout(first); timers.clearInterval(interval); timers.clearInterval(sync) }
}
