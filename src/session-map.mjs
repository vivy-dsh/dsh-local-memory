/**
 * 会话映射审计（纯函数）。
 *
 * 一个 sessionId 被多个 key 使用时，删除所有该 sessionId 的映射，
 * 让每个 key 在下一条消息时重新建立独立会话。
 */
export function findDuplicateSessionIds(mappings) {
  const counts = new Map();
  for (const sessionId of Object.values(mappings && typeof mappings === 'object' ? mappings : {})) {
    if (!sessionId) continue;
    counts.set(sessionId, (counts.get(sessionId) || 0) + 1);
  }
  const duplicates = new Map();
  for (const [key, sessionId] of Object.entries(mappings && typeof mappings === 'object' ? mappings : {})) {
    if (!sessionId || (counts.get(sessionId) || 0) < 2) continue;
    if (!duplicates.has(sessionId)) duplicates.set(sessionId, []);
    duplicates.get(sessionId).push(key);
  }
  return duplicates;
}

export function dedupeSessionMappings(mappings) {
  const source = mappings && typeof mappings === 'object' ? mappings : {};
  const duplicatesMap = findDuplicateSessionIds(source);
  const duplicateIds = new Set(duplicatesMap.keys());
  const next = {};
  const removed = [];
  for (const [key, sessionId] of Object.entries(source)) {
    if (!sessionId) continue;
    if (duplicateIds.has(sessionId)) { removed.push(key); continue; }
    next[key] = sessionId;
  }
  return {
    mappings: next,
    removed,
    duplicates: [...duplicatesMap.entries()].map(([sessionId, keys]) => ({ sessionId, keys })),
  };
}
