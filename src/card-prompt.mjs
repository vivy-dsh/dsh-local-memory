/**
 * 常驻记忆卡投递（card prompt context）—— 由卡的写者自己注册。
 *
 * 为什么放在本插件：记忆卡只有一个写者（本插件，单进程串行写），文本在进程内
 * 就能同步渲染，所以投递不需要跨进程文件契约、也不需要第二个插件。
 *
 * 为什么是 runtime context 而不是 system section：带 `complete: true` section
 * 的 agent（Superagent 主 Session）在装配时只保留那一段，其余 section 全丢；
 * runtime context 不受影响。而且 context 以 user 角色的快照追加在尾部，旧前缀
 * 不动，对前缀缓存更友好。persona 与规则归 Laputa 的 section，记忆属于状态，
 * 这里只做投递。
 *
 * 成本控制：provider 每次装配都会跑一次，所以渲染结果做内容 hash 缓存；卡的写者
 * 每轮维护都会无条件重写文件，用 mtime 当缓存键会变成「每 10 分钟打掉一次
 * provider 前缀缓存」，因此**判据是内容，不是时间**。
 *
 * 投递范围：默认关；开启后进所有 agent 会话，但排除工具型子 agent
 * （见 {@link cardInjectionAllowed}）。
 *
 * @module dsh-local-memory/card-prompt
 */

import { createHash } from 'node:crypto'

/** 稳定的 context 名；同名的 scoped context 会遮蔽它。 */
export const CARD_CONTEXT_NAME = 'actmem:card'

/**
 * context 落点：CONTEXT_ORDERS 里 TEAM_IDENTITY 是 125、HARNESS_SOURCE 是 200，
 * 卡片排在团队身份之后、路径与端点之前。
 */
export const CARD_CONTEXT_ORDER = 130

const DEFAULTS = Object.freeze({
  enabled: false,
  platform: 'qq',
  excludeSubagents: true,
})

const PLATFORMS = new Set(['qq', 'bili'])

/**
 * 归一化 `config.json` 的 `cardInjection` 段。未知键忽略，缺省即关闭。
 * @param raw - 原始配置片段。
 * @returns `{ enabled, platform, excludeSubagents }`。
 */
export function normalizeCardInjectionConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: source.enabled === true,
    platform: PLATFORMS.has(source.platform) ? source.platform : DEFAULTS.platform,
    excludeSubagents: source.excludeSubagents !== false,
  }
}

/**
 * 本次装配的 agent 是否该拿到卡片。
 *
 * 只排除「工具型子 agent」（短命，且会把上下文写进工具输出）。执行器
 * （`dsh-superagent-worker`）与主 Session（`dsh-superagent-router`）都要卡：
 * 主 Session 的提示词是 complete 的，只剩 runtime context 这一条投递面。
 *
 * @param agent - `AssembleContext.agent`；诊断装配时可能是 undefined。
 * @param config - {@link normalizeCardInjectionConfig} 的结果。
 * @returns 是否投递。
 */
export function cardInjectionAllowed(agent, config) {
  if (agent === undefined || agent === null || typeof agent !== 'object') return false
  const header = agent.session?.header ?? {}
  if (config.excludeSubagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return false
  return true
}

const digest = text => createHash('sha256').update(text).digest('hex')

/**
 * 造一个 context 文本 provider：同步、按需、失败不炸装配。
 *
 * @param options.read - 同步取卡文本：`platform => string`。
 * @param options.config - 同步取当前配置：`() => normalized`。
 * @param options.fingerprint - 可选的廉价指纹（如源文件 size:mtime）；命中即跳过 read。
 * @param options.warn - 读取失败时的告警出口。
 * @returns `{ text(agent) }`。
 */
export function createCardPromptProvider({ read, config, fingerprint = null, warn = () => {} }) {
  let cached = { key: null, hash: null, text: '' }
  return {
    text(agent) {
      const current = config()
      if (!current.enabled) {
        cached = { key: null, hash: null, text: '' }
        return ''
      }
      if (!cardInjectionAllowed(agent, current)) return ''
      let key = null
      if (fingerprint !== null) {
        // 指纹必须带平台：换变体时即使源文件没动，也要重新渲染。
        try { key = `${current.platform}:${fingerprint(current.platform)}` } catch { key = null }
      }
      if (key !== null && key === cached.key) return cached.text
      let text
      try {
        text = String(read(current.platform) ?? '').trim()
      } catch (error) {
        warn(`记忆卡注入读取失败：${error?.message ?? error}`)
        cached = { key: null, hash: null, text: '' }
        return ''
      }
      const hash = digest(text)
      // 内容没变就复用上一份字符串：卡被无条件重写时提示词不跟着抖。
      const stable = hash === cached.hash ? cached.text : text
      cached = { key, hash, text: stable }
      return stable
    },
  }
}

/**
 * 把卡片挂成 runtime context 的一段。`systemPrompt` 不存在时只是没有投递，
 * 不影响插件其余部分。
 *
 * @param ctx - Cordis 上下文。
 * @param service - 记忆服务（需要 `cardInjectionConfig` / `cardPromptText` / `cardPromptFingerprint`）。
 * @param options.warn - 告警出口。
 * @returns `ctx.inject` 的 fiber（随插件卸载释放）；缺能力时返回 undefined。
 */
export function registerCardPrompt(ctx, service, { warn = message => console.warn(message) } = {}) {
  // 没有 systemPrompt 能力就只是没有投递：与插件里「会话记忆暂不可用」同样的降级方式，
  // 不因为可选能力缺失让整个记忆插件启动失败。
  if (typeof ctx?.inject !== 'function') {
    warn('记忆卡注入不可用（缺少 systemPrompt 能力），插件其余部分继续')
    return undefined
  }
  const provider = createCardPromptProvider({
    read: platform => service.cardPromptText(platform),
    fingerprint: platform => service.cardPromptFingerprint(platform),
    config: () => normalizeCardInjectionConfig(service.cardInjectionConfig()),
    warn,
  })
  return ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: CARD_CONTEXT_NAME,
      order: CARD_CONTEXT_ORDER,
      text: context => provider.text(context?.agent),
      // 卡里可能出现 {{...}}（措辞、模板），不要当提示词变量去插值。
      interpolate: false,
    })
  })
}
