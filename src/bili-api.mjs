// B 站只读接口封装（给 QQ 桥接的「B站记忆 / 动态同步」用）。
//
// 边界：
//   · 只读 B 站公开数据（自己的空间动态、视频公开信息），不评论、不点赞、不发私信。
//   · 凭据只从 ~/.dsh/surfcore/bili/credentials.json 读取，不写日志、不回显。
//   · 私信相关文件（dm-*.json / 私信正文）**一律不读**；本模块没有私信接口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function resolveBiliPaths(home = os.homedir(), dshHome = process.env.DSH_HOME) {
  if (!dshHome || !path.isAbsolute(dshHome)) throw new Error('A project-local DSH_HOME is required');
  const dsh = dshHome;
  return {
    home,
    dsh,
    bili: path.join(dsh, 'surfcore', 'bili'),
    config: path.join(dsh, 'surfcore', 'bili.config.json'),
    credentials: path.join(dsh, 'surfcore', 'bili', 'credentials.json'),
  };
}

function readJson(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid');
    return result;
  } catch { throw new Error(`B站账号配置文件损坏：${path.basename(file)}`); }
}

/**
 * 读取 B 站账号配置与凭据。
 * 这里只读 bili.config.json 和 credentials.json，绝不触碰 dm-*.json。
 */
export function loadBiliAccount({ home = os.homedir(), dshHome = process.env.DSH_HOME } = {}) {
  const p = resolveBiliPaths(home, dshHome);
  const config = readJson(p.config, {}) ?? {};
  const cred = readJson(p.credentials, {}) ?? {};
  const mid = String(config?.self?.mid ?? '').trim();
  const name = String(config?.self?.name ?? '').trim();
  const cookie = [
    cred.sessdata ? `SESSDATA=${cred.sessdata}` : '',
    cred.bili_jct ? `bili_jct=${cred.bili_jct}` : '',
    cred.buvid3 ? `buvid3=${cred.buvid3}` : '',
  ].filter(Boolean).join('; ');
  return {
    paths: p,
    config,
    cred,
    mid,
    name,
    hasCredentials: Boolean(cred.sessdata && cred.bili_jct && cred.buvid3),
    headers: {
      'user-agent': UA,
      referer: mid ? `https://space.bilibili.com/${mid}/dynamic` : 'https://www.bilibili.com/',
      ...(cookie ? { cookie } : {}),
    },
  };
}

/** 把空间动态接口的一条 item 解析成桥接能用的形状。 */
export function parseDynamicItem(item) {
  const id = String(item?.id_str ?? item?.id ?? '').trim();
  const modules = item?.modules ?? {};
  const dynamic = modules?.module_dynamic ?? {};
  const author = modules?.module_author ?? {};
  const desc = dynamic?.desc ?? {};
  const major = dynamic?.major ?? {};
  const archive = major?.archive ?? {};
  const draw = major?.draw ?? {};
  const text = String(desc?.text ?? '').trim();
  const images = (Array.isArray(draw?.items) ? draw.items : [])
    .map((it) => String(it?.src ?? it?.url ?? '').trim())
    .filter(Boolean);
  return {
    id,
    type: String(item?.type ?? ''),
    pubTs: Number(author?.pub_ts ?? 0) || 0,
    pubText: String(author?.pub_time ?? '').trim(),
    text,
    bvid: String(archive?.bvid ?? '').trim(),
    title: String(archive?.title ?? '').trim(),
    images,
    url: id ? `https://t.bilibili.com/${id}` : '',
  };
}

/**
 * 拉自己空间的最新动态（只读）。
 * @returns {Promise<{ok:boolean, items:object[], why?:string}>}
 */
export async function fetchMyDynamics({ home = os.homedir(), dshHome = process.env.DSH_HOME, timeoutMs = 15000, signal } = {}) {
  const account = loadBiliAccount({ home, dshHome });
  if (!account.mid) return { ok: false, items: [], why: '配置里没有 self.mid' };
  if (!account.hasCredentials) return { ok: false, items: [], why: '缺少 B 站凭据' };
  try {
    const r = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(account.mid)}`, {
      headers: account.headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.code !== 0) return { ok: false, items: [], why: `feed/space code=${j?.code ?? r.status}` };
    if (!Array.isArray(j?.data?.items) || j.data.items.some(item => {
      const id = item?.id_str ?? item?.id;
      return !item || typeof item !== 'object' || Array.isArray(item) || !((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0));
    })) return { ok: false, items: [], why: 'feed/space 动态数据不完整' };
    const items = j.data.items.map(parseDynamicItem);
    return { ok: true, items };
  } catch (error) {
    return { ok: false, items: [], why: String(error?.message ?? error).slice(0, 120) };
  }
}

/**
 * 拉单条视频的公开信息（标题/UP/简介）。失败返回 ok:false，不抛。
 */
export async function fetchVideoInfo(bv, { home = os.homedir(), dshHome = process.env.DSH_HOME, timeoutMs = 8000, signal } = {}) {
  const account = loadBiliAccount({ home, dshHome });
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bv ?? ''))) return { ok: false, why: 'BV 号格式不对' };
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`, {
      headers: account.headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.code !== 0) return { ok: false, why: `view code=${j?.code ?? r.status}` };
    const d = j.data ?? {};
    return {
      ok: true,
      bv,
      title: String(d.title ?? '').trim(),
      owner: String(d.owner?.name ?? '').trim(),
      desc: String(d.desc ?? '').trim(),
      pic: String(d.pic ?? '').trim(),
      duration: Number(d.duration ?? 0) || 0,
      pubdate: Number(d.pubdate ?? 0) || 0,
      stat: {
        view: Number(d.stat?.view ?? 0) || 0,
        danmaku: Number(d.stat?.danmaku ?? 0) || 0,
        reply: Number(d.stat?.reply ?? 0) || 0,
      },
    };
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error).slice(0, 120) };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
