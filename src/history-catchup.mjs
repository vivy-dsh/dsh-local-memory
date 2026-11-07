export const DEFAULT_HISTORY_CATCHUP = Object.freeze({
  enabled: true,
  limit: 30,
  maxAgeMinutes: 720,
  wake: true,
  includePrivate: true,
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeHistoryConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: boolOr(source.enabled, DEFAULT_HISTORY_CATCHUP.enabled),
    limit: clampInt(source.limit, DEFAULT_HISTORY_CATCHUP.limit, 1, 100),
    maxAgeMinutes: clampInt(source.maxAgeMinutes, DEFAULT_HISTORY_CATCHUP.maxAgeMinutes, 1, 10080),
    wake: boolOr(source.wake, DEFAULT_HISTORY_CATCHUP.wake),
    includePrivate: boolOr(source.includePrivate, DEFAULT_HISTORY_CATCHUP.includePrivate),
  };
}

export function historyWatermark(state, { now = Date.now(), maxAgeMs, toleranceMs = 5000 } = {}) {
  const windowMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_HISTORY_CATCHUP.maxAgeMinutes * 60_000;
  const floor = now - windowMs;
  let watermark = floor;
  const consider = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > watermark) watermark = n;
  };
  consider(state?.lastIncomingAt);
  consider(state?.lastHistoryMessageTime);
  for (const message of Array.isArray(state?.recentMessages) ? state.recentMessages : []) {
    if (message && typeof message === 'object') consider(message.time);
  }
  return Math.max(floor, watermark - Math.max(0, Number(toleranceMs) || 0));
}

export function selectMissedHistory(candidates, {
  watermark = 0,
  now = Date.now(),
  maxAgeMs,
  limit = DEFAULT_HISTORY_CATCHUP.limit,
  existingIds = [],
  blockedUsers = [],
  futureToleranceMs = 120000,
} = {}) {
  const windowMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_HISTORY_CATCHUP.maxAgeMinutes * 60_000;
  const floor = Math.max(Number(watermark) || 0, now - windowMs);
  const ceiling = now + Math.max(0, Number(futureToleranceMs) || 0);
  const seen = new Set(existingIds instanceof Set ? existingIds : Array.isArray(existingIds) ? existingIds : []);
  const blocked = new Set((Array.isArray(blockedUsers) ? blockedUsers : []).map((value) => String(value)));
  const picked = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = String(candidate.messageId ?? '').trim();
    if (!id || seen.has(id)) continue;
    const time = Number(candidate.time);
    if (!Number.isFinite(time) || time <= 0 || time < floor || time > ceiling) continue;
    if (candidate.userId && blocked.has(String(candidate.userId))) continue;
    seen.add(id);
    picked.push(candidate);
  }
  picked.sort((a, b) => Number(a.time) - Number(b.time));
  const cap = clampInt(limit, DEFAULT_HISTORY_CATCHUP.limit, 1, 100);
  if (picked.length > cap) picked.splice(0, picked.length - cap);
  return picked;
}

export function summarizeHistoryCatchup(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let incoming = 0;
  let self = 0;
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    if (message.isSelf) self += 1;
    else incoming += 1;
  }
  return { incoming, self, total: incoming + self };
}

export function buildHistoryCatchupLine(summary) {
  const incoming = Math.max(0, Number(summary?.incoming) || 0);
  const self = Math.max(0, Number(summary?.self) || 0);
  if (!incoming && !self) return '';
  const parts = [];
  if (incoming) parts.push(`${incoming} 条群友/好友消息`);
  if (self) parts.push(`${self} 条你自己以前发过的消息`);
  return `【上线补历史】桥接从 QQ 历史记录补回 ${parts.join('、')}。`;
}

export const HISTORY_MESSAGE_FLAG = 'history';
