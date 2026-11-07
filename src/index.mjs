import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createMemoryService } from './service.mjs'
import { registerMemoryHttp } from './http.mjs'
import { registerMemoryInternal } from './internal.mjs'
import { createBiliMemory } from './bili-memory.mjs'
import { createSessionMemoryStore } from './session-memory.mjs'
import { startMemoryMaintenance } from './maintenance.mjs'
import { createOwnerBridgeNotifier } from './owner-bridge.mjs'
import { registerCardPrompt } from './card-prompt.mjs'
import { prepareStateDir, projectHome, resolveComponentPath } from '../../_shared/paths.mjs'
import { resolveSubject } from '../../_shared/subject.mjs'
import { callComponent } from '../../_shared/ipc.mjs'

export const name = 'dsh-local-memory'
export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const env = process.env
  const home = projectHome(env)
  const stateDir = prepareStateDir(resolveComponentPath(env, 'DSH_MEMORY_STATE_DIR', join(home, 'memory'), { label: '记忆状态目录' }), '记忆状态目录')
  const dataDir = join(stateDir, 'data'), inboxDir = resolveComponentPath(env, 'DSH_MEMORY_INBOX_DIR', join(stateDir, 'inbox'), { label: '记忆收件目录' })
  const qqFeedFile = resolveComponentPath(env, 'DSH_QQ_PUBLIC_FEED', join(inboxDir, 'qq-public-feed.jsonl'), { label: 'QQ 公开消息流' })
  const biliDynamicsCache = resolveComponentPath(env, 'DSH_BILI_DYNAMICS_CACHE', join(dataDir, 'bili-dynamics-cache.json'), { label: 'B站动态缓存' })
  const alignmentFile = resolveComponentPath(env, 'DSH_ALIGNMENTS_FILE', join(inboxDir, 'alignments.json'), { label: '身份对齐文件' })
  const qqConfigFile = resolveComponentPath(env, 'SURFCORE_CONFIG_FILE', join(home, 'surfcore', 'config.json'), { label: 'QQ 桥接配置' })
  const tokenFile = resolveComponentPath(env, 'SURFCORE_CONSOLE_TOKEN_FILE', join(home, 'surfcore', 'state', 'console-token'), { label: 'QQ 桥接令牌' })
  const legacySessionFile = resolveComponentPath(env, 'DSH_SESSION_LEGACY_FILE', join(inboxDir, 'social-v2.json'), { label: '旧会话记忆文件' })
  const biliMemory = createBiliMemory({ stateDir: dataDir, dshHome: home, qqDynamicsCacheFile: biliDynamicsCache })
  if (!existsSync(biliMemory.paths.publication)) biliMemory.ensureRoleFreeOutputs()
  const service = createMemoryService({ stateDir, biliMemory, qqFeedFile, qqConfigFile, alignmentFile,
    subject: () => resolveSubject({ env, webServer: ctx.webServer }),
    archiveSend: (path, body) => callComponent({ home, name: 'mempalace', path, body }),
    notifyOwner: createOwnerBridgeNotifier({ qqConfigFile, tokenFile }) })
  service.sessions = createSessionMemoryStore({ stateDir, legacyFile: legacySessionFile })
  try { service.sessions.initialize() }
  catch (error) { console.warn(`会话记忆暂不可用，原始数据已保留：${String(error?.message ?? error)}`) }
  const dispose = registerMemoryHttp(ctx, service)
  let disposeInternal
  try { disposeInternal = registerMemoryInternal(ctx, home, service) } catch (error) { dispose(); throw error }
  const cardPrompt = registerCardPrompt(ctx, service)
  const stopMaintenance = startMemoryMaintenance(service)
  ctx.effect(() => async () => { stopMaintenance(); disposeInternal(); dispose(); await cardPrompt?.dispose?.(); await service.dispose() })
}

export default { name, inject, apply }
