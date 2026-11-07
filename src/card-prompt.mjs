/**
 * 常驻记忆卡提示区（card prompt section）—— 由卡的写者自己注册。
 *
 * 为什么放在本插件：记忆卡只有一个写者（本插件，单进程串行写），文本在进程内
 * 就能同步渲染，所以注入不需要跨进程文件契约、也不需要第二个插件。用的缝与当年
 * 退役掉的那条常驻注入（E2-S3）完全相同（`systemPrompt.section` +
 * `AssembleContext.agent`），只是换了 owner：归档端保持只读，活跃记忆由 ActMem
 * 这边供给。
 *
 * 成本控制：provider 每次装配都会跑一次，所以渲染结果做内容 hash 缓存；卡的写者
 * 每轮维护都会无条件重写文件，用 mtime 当缓存键会变成「每 10 分钟打掉一次
 * provider 前缀缓存」，因此**判据是内容，不是时间**。
 *
 * 注入范围：默认关；开启后进所有 agent 会话，但排除控制面（router preset）与
 * 工具型子 agent（见 {@link cardInjectionAllowed}）。
 *
 * @module dsh-local-memory/card-prompt
 */

import { createHash } from 'node:crypto'

/** 稳定的 section 名；同名的 scoped section 会遮蔽它。 */
export const CARD_SECTION_NAME = 'actmem:card'

/** 控制面 preset：不带人格、不跟大湿说话，卡片在那里只是噪声。 */
export const DEFAULT_EXCLUDED_PRESETS = Object.freeze(['dsh-superagent-router'])

/**
 * section 落点：相对 persona prefix 的偏移。laputa 用 +1（人格）与 +2（引导），
 * 卡片排在它们后面。
 */
export const CARD_SECTION_OFFSET = 3

const DEFAULTS = Object.freeze({
  enabled: false,
  platform: 'qq',
  excludePresets: DEFAULT_EXCLUDED_PRESETS,
  excludeSubagents: true,
})

const PLATFORMS = new Set(['qq', 'bili'])

/**
 * 归一化 `config.json` 的 `cardInjection` 段。未知键忽略，缺省即关闭。
 * @param raw - 原始配置片段。
 * @returns `{ enabled, platform, excludePresets, excludeSubagents }`。
 */
export function normalizeCardInjectionConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const presets = Array.isArray(source.excludePresets)
    ? source.excludePresets.filter(value => typeof value === 'string' && value.length > 0)
    : DEFAULTS.excludePresets
  return {
    enabled: source.enabled === true,
    platform: PLATFORMS.has(source.platform) ? source.platform : DEFAULTS.platform,
    excludePresets: Object.freeze([...new Set(presets)]),
    excludeSubagents: source.excludeSubagents !== false,
  }
}

/**
 * 本次装配的 agent 是否该拿到卡片。
 *
 * 排除的是「控制面」与「工具型子 agent」，**不是**整个 superagent：执行器
 * （`dsh-superagent-worker`）带自己的 persona prefix，是在替大湿干活的那一侧，
 * 它要卡；router 主 Session 只做派工，不要；子 agent 短命且会把上下文写进工具
 * 输出，不要。
 *
 * @param agent - `AssembleContext.agent`；诊断装配时可能是 undefined。
 * @param config - {@link normalizeCardInjectionConfig} 的结果。
 * @returns 是否注入。
 */
export function cardInjectionAllowed(agent, config) {
  if (agent === undefined || agent === null || typeof agent !== 'object') return false
  const header = agent.session?.header ?? {}
  if (config.excludeSubagents && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return false
  const preset = header.agentPreset
  if (typeof preset === 'string' && config.excludePresets.includes(preset)) return false
  return true
}

const digest = text => createHash('sha256').update(text).digest('hex')

/**
 * 造一个 section 文本 provider：同步、按需、失败不炸装配。
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
 * 把卡片挂成常驻 section。`systemPrompt` 不存在时只是没有注入，不影响插件其余部分。
 *
 * @param ctx - Cordis 上下文。
 * @param service - 记忆服务（需要 `cardInjectionConfig` / `cardPromptText` / `cardPromptFingerprint`）。
 * @param options.warn - 告警出口。
 * @returns `ctx.inject` 的 fiber（随插件卸载释放）；缺能力时返回 undefined。
 */
export function registerCardPrompt(ctx, service, { warn = message => console.warn(message) } = {}) {
  // 没有 systemPrompt 能力就只是没有注入：与插件里「会话记忆暂不可用」同样的降级方式，
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
    scope.systemPrompt.section({
      name: CARD_SECTION_NAME,
      order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + CARD_SECTION_OFFSET,
      text: context => provider.text(context?.agent),
      // 卡里可能出现 {{...}}（措辞、模板），不要当提示词变量去插值。
      interpolate: false,
    })
  })
}
