window.__ModuleLoader__.load({
  id: 'dsh-local-memory',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React
    const API = '/dsh-memory/api'
    const MEMORY_CSS = `
      .memory-panel{--mp-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--mp-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.4));--mp-brand:var(--dsw-alias-brand-primary,#2f6fed);--mp-ok:var(--dsw-alias-state-success-primary,#1a7f4b);--mp-warn:var(--dsw-alias-state-warn-primary,#a86a00);--mp-bad:var(--dsw-alias-state-error-primary,#c43b3b);--mp-fg:var(--dsw-alias-label-primary,#1f2329);--mp-fg2:var(--dsw-alias-label-secondary,rgba(0,0,0,.64));--mp-fg3:var(--dsw-alias-label-tertiary,rgba(0,0,0,.46));--mp-bg:var(--dsw-alias-bg-base,#fff);--mp-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));--mp-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;background:var(--mp-bg);color:var(--mp-fg);font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
      .memory-panel *{box-sizing:border-box}
      .memory-panel h1,.memory-panel h2,.memory-panel h3,.memory-panel p{margin:0}
      .memory-panel a{color:var(--mp-brand)}
      .mp-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:15px 22px 13px;border-bottom:1px solid var(--mp-line);background:linear-gradient(135deg,rgba(47,111,237,.10),rgba(255,122,162,.07) 58%,transparent)}
      .mp-head-main{min-width:0}
      .mp-kicker{margin:0 0 2px;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--mp-fg3)}
      .mp-head h1{font-size:19px;font-weight:660;letter-spacing:.01em}
      .mp-sub{margin-top:3px;font-size:12px;color:var(--mp-fg2);max-width:660px}
      .mp-dots{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px 12px;padding-top:2px;max-width:54%}
      .mp-dot{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--mp-fg2);white-space:nowrap}
      .mp-dot::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mp-fg3);box-shadow:0 0 0 3px rgba(127,127,127,.12);flex:none}
      .mp-dot.ok::before{background:var(--mp-ok);box-shadow:0 0 0 3px rgba(26,127,75,.16)}
      .mp-dot.warn::before{background:var(--mp-warn);box-shadow:0 0 0 3px rgba(168,106,0,.16)}
      .mp-dot.bad::before{background:var(--mp-bad);box-shadow:0 0 0 3px rgba(196,59,59,.16)}
      .mp-alerts{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 22px 0}
      .mp-alerts:empty{padding:0}
      .mp-alert{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;border:1px solid var(--mp-line-strong);background:var(--mp-bg2);font-size:12px;color:var(--mp-fg2)}
      .mp-alert.danger{border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.08);color:var(--mp-bad)}
      .mp-alert.warn{border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.08);color:var(--mp-warn)}
      .mp-tabs{flex:none;display:flex;gap:2px;padding:0 14px;margin-top:8px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;border-bottom:1px solid var(--mp-line);background:var(--mp-bg1)}
      .mp-tabs::-webkit-scrollbar{display:none}
      .mp-tab{flex:none;appearance:none;background:none;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;margin:0;padding:9px 12px 7px;font:inherit;font-size:12.5px;font-weight:500;color:var(--mp-fg2);cursor:pointer;transition:background .15s,color .15s,border-color .15s}
      .mp-tab:hover{background:rgba(127,127,127,.08);color:var(--mp-fg)}
      .mp-tab.on{color:var(--mp-brand);border-bottom-color:var(--mp-brand);font-weight:650}
      .mp-tab:focus-visible{outline:2px solid var(--mp-brand);outline-offset:-2px}
      .mp-body{flex:1;min-height:0;overflow:auto;padding:14px 20px 26px;scrollbar-gutter:stable}
      .mp-panel{display:flex;flex-direction:column;gap:13px;width:100%;max-width:1060px;margin:0 auto;outline:0}
      .mp-card{margin:0;padding:13px 15px 15px;border:1px solid var(--mp-line);border-radius:12px;background:var(--mp-bg1);box-shadow:0 1px 2px rgba(16,24,40,.04);min-width:0}
      .mp-card-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:660;margin-bottom:6px}
      .mp-card-note{margin-bottom:8px;font-size:12px;color:var(--mp-fg2)}
      .mp-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}
      .mp-card-body>p{font-size:12px;color:var(--mp-fg2);word-break:break-word}
      .mp-card-body>h3{font-size:12.5px;font-weight:650;margin-top:4px}
      .mp-card-body>label{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:1px 0;font-size:12.5px;color:var(--mp-fg2)}
      .mp-card-body>label.mp-field{flex-direction:column;align-items:stretch;gap:4px;font-size:11.5px;color:var(--mp-fg3)}
      .mp-card-body>label.mp-check{display:inline-flex;flex-wrap:nowrap;align-items:center;gap:7px;font-size:12.5px;color:var(--mp-fg);cursor:pointer}
      .mp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px}
      .mp-stat{padding:9px 11px;border:1px solid var(--mp-line);border-radius:10px;background:var(--mp-bg);min-width:0}
      .mp-stat-value{display:block;font-size:22px;line-height:1.15;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;word-break:break-word}
      .mp-stat-unit{margin-left:3px;font-size:11px;font-weight:500;color:var(--mp-fg3)}
      .mp-stat-label{display:block;margin-top:2px;font-size:11px;color:var(--mp-fg3)}
      .mp-stat.ok .mp-stat-value{color:var(--mp-ok)}
      .mp-stat.warn .mp-stat-value{color:var(--mp-warn)}
      .mp-stat.bad .mp-stat-value{color:var(--mp-bad)}
      .mp-meter{height:9px;border-radius:999px;background:rgba(127,127,127,.18);overflow:hidden;margin:2px 0}
      .mp-meter-fill{height:100%;border-radius:999px;background:var(--mp-ok);transition:width .3s ease}
      .mp-meter-fill.warn{background:var(--mp-warn)}
      .mp-meter-fill.bad{background:var(--mp-bad)}
      .mp-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid var(--mp-line-strong);font-size:11px;line-height:1.6;color:var(--mp-fg2);background:rgba(127,127,127,.06);white-space:nowrap}
      .mp-chip.ok{color:var(--mp-ok);border-color:rgba(26,127,75,.35);background:rgba(26,127,75,.1)}
      .mp-chip.warn{color:var(--mp-warn);border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.1)}
      .mp-chip.bad{color:var(--mp-bad);border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.1)}
      .mp-chip.info{color:var(--mp-brand);border-color:rgba(47,111,237,.35);background:rgba(47,111,237,.1)}
      .mp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:9px 12px}
      .mp-grid.wide{grid-template-columns:repeat(auto-fit,minmax(258px,1fr))}
      .mp-field{display:flex;flex-direction:column;gap:4px;margin:0;font-size:11.5px;color:var(--mp-fg3);min-width:0}
      .mp-field>input,.mp-field>select,.mp-field>textarea{width:100%}
      .mp-check{display:inline-flex;align-items:center;gap:7px;margin:2px 0;font-size:12.5px;color:var(--mp-fg);cursor:pointer}
      .mp-check input{width:15px;height:15px;accent-color:var(--mp-brand);margin:0;flex:none}
      .memory-panel input[type=text],.memory-panel input[type=number],.memory-panel input[type=password],.memory-panel input:not([type]),.memory-panel select,.memory-panel textarea{font:inherit;font-size:12.5px;color:var(--mp-fg);background:var(--mp-bg);border:1px solid var(--mp-line-strong);border-radius:8px;padding:5px 9px;height:31px;outline:none;transition:border-color .15s,box-shadow .15s}
      .memory-panel textarea{height:auto;min-height:76px;padding:8px 10px;resize:vertical;line-height:1.55}
      .memory-panel input[type=checkbox]{accent-color:var(--mp-brand)}
      .memory-panel input:focus,.memory-panel select:focus,.memory-panel textarea:focus{border-color:var(--mp-brand);box-shadow:0 0 0 3px rgba(47,111,237,.16)}
      .memory-panel input:disabled,.memory-panel select:disabled,.memory-panel textarea:disabled{opacity:.55;cursor:not-allowed}
      .mp-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:31px;margin:0;padding:0 12px;border-radius:8px;border:1px solid var(--mp-line-strong);background:var(--mp-bg);color:var(--mp-fg);font:inherit;font-size:12px;font-weight:550;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
      .mp-btn:hover:not(:disabled){background:var(--mp-bg2);border-color:var(--mp-fg3)}
      .mp-btn:focus-visible{outline:2px solid var(--mp-brand);outline-offset:1px}
      .mp-btn:disabled{opacity:.45;cursor:not-allowed}
      .mp-btn-primary{background:var(--mp-brand);border-color:var(--mp-brand);color:#fff}
      .mp-btn-primary:hover:not(:disabled){background:var(--mp-brand);filter:brightness(1.07)}
      .mp-btn-danger{color:var(--mp-bad);border-color:rgba(196,59,59,.42);background:rgba(196,59,59,.07)}
      .mp-btn-danger:hover:not(:disabled){background:rgba(196,59,59,.14);border-color:var(--mp-bad)}
      .mp-btn-quiet{border-style:dashed;color:var(--mp-fg2)}
      .mp-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}
      .mp-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;min-width:0}
      .mp-rec{padding:11px 12px;border:1px solid var(--mp-line);border-radius:10px;background:var(--mp-bg);display:flex;flex-direction:column;gap:5px;min-width:0}
      .mp-rec+.mp-rec{margin-top:8px}
      .mp-rec strong{font-size:13px;font-weight:620;word-break:break-word}
      .mp-rec p{font-size:12.5px;color:var(--mp-fg2);white-space:pre-wrap;word-break:break-word}
      .mp-rec small{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11px;color:var(--mp-fg3);word-break:break-word}
      .mp-rec>.mp-actions{margin-top:2px}
      .mp-item{padding:9px 11px;border:1px solid var(--mp-line);border-radius:10px;background:var(--mp-bg);display:flex;flex-wrap:wrap;align-items:center;gap:7px;min-width:0}
      .mp-item+.mp-item{margin-top:7px}
      .mp-item>span{font-size:12.5px;color:var(--mp-fg2);word-break:break-word}
      .mp-item>.mp-actions{margin:0 0 0 auto}
      .mp-item-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--mp-line);font-size:12px;color:var(--mp-fg2);word-break:break-word}
      .mp-item-row:last-child{border-bottom:0;padding-bottom:0}
      .mp-item-row>span{flex:1 1 200px;min-width:0}
      .mp-pre{margin:0;padding:9px 11px;max-height:280px;overflow:auto;border:1px solid var(--mp-line);border-radius:9px;background:var(--mp-bg2);color:var(--mp-fg);font:11.5px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      .mp-hint{font-size:11.5px;color:var(--mp-fg3);word-break:break-word}
      .mp-empty{padding:14px;text-align:center;font-size:12px;color:var(--mp-fg3);border:1px dashed var(--mp-line-strong);border-radius:10px}
      .mp-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:8px;max-width:min(560px,92vw);padding:9px 14px;border-radius:10px;border:1px solid var(--mp-line-strong);background:var(--mp-bg);color:var(--mp-fg);font-size:12.5px;box-shadow:0 8px 28px rgba(16,24,40,.18);animation:mp-in .18s ease}
      .mp-toast::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mp-ok);flex:none}
      @keyframes mp-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}
      @media(max-width:760px){.mp-head{flex-direction:column;gap:8px;padding:13px 14px 11px}.mp-dots{max-width:100%;justify-content:flex-start}.mp-alerts{padding:7px 14px 0}.mp-tabs{padding:0 8px;margin-top:7px}.mp-body{padding:11px 12px 20px}.mp-grid,.mp-grid.wide{grid-template-columns:1fr}.mp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.mp-actions{gap:6px}.mp-btn{height:30px;padding:0 10px}}
      @media(prefers-reduced-motion:reduce){.memory-panel *{transition:none!important;animation:none!important}}
    `
    async function request(path, body, signal) {
      const res = await fetch(`${API}${path}`, body === undefined ? { signal } : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      })
      const data = await res.json()
      if (!res.ok || data.ok === false) { const error = new Error([data.error, data.hint].filter(Boolean).join('：') || `HTTP ${res.status}`); error.code = data.code || ''; throw error }
      return data
    }
    function MemoryPanel() {
      const [snapshot, setSnapshot] = useState(null)
      const [text, setText] = useState('')
      const [importance, setImportance] = useState(70)
      const [mergeTitle, setMergeTitle] = useState('')
      const [mergePinned, setMergePinned] = useState(true)
      const [scope, setScope] = useState('qq')
      const [cardPreview, setCardPreview] = useState(null)
      const [previews, setPreviews] = useState(null)
      const [biliBrief, setBiliBrief] = useState(null)
      const [qqSync, setQqSync] = useState(null)
      const [qqGroups, setQqGroups] = useState('')
      const [qqDirty, setQqDirty] = useState(false)
      const [backups, setBackups] = useState([])
      const [sessions, setSessions] = useState([])
      const [sessionKey, setSessionKey] = useState('')
      const [session, setSession] = useState(null)
      const [sessionBackups, setSessionBackups] = useState([])
      const [selected, setSelected] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [databaseBackups, setDatabaseBackups] = useState(null)
      const [shareHistoryBackups, setShareHistoryBackups] = useState(null)
      const [sessionDrafts, setSessionDrafts] = useState([])
      const [memoryPage, setMemoryPage] = useState(0)
      const [biliRefreshing, setBiliRefreshing] = useState(false)
      const [restoreNeedsRefresh, setRestoreNeedsRefresh] = useState(false)
      const [activeTab, setActiveTab] = useState('overview')
      const refreshGeneration = useRef(0)
      const qqRevision = useRef(0)
      const bodyRef = useRef(null)
      const markQqDirty = () => { qqRevision.current++; setQqDirty(true) }
      const mergeQqStatus = data => setQqSync(current => current ? { ...data, config: current.config } : data)
      const refresh = useCallback(async () => {
        const generation = ++refreshGeneration.current
        const [card, saved, known] = await Promise.allSettled([request('/card'), request('/backups'), request('/sessions')])
        if (generation !== refreshGeneration.current) return
        if (card.status === 'fulfilled') setSnapshot(card.value)
        else setSnapshot(null)
        if (saved.status === 'fulfilled') setBackups(saved.value.backups || [])
        if (known.status === 'fulfilled') setSessions(known.value.sessions || [])
        const failure = [card, saved, known].find(result => result.status === 'rejected')
        setError(failure ? failure.reason.message : '')
        return !failure
      }, [])
      useEffect(() => { void refresh() }, [refresh])
      useEffect(() => {
        if (!sessionKey) { setSession(null); setSessionBackups([]); return }
        let cancelled = false
        Promise.all([request(`/session?key=${encodeURIComponent(sessionKey)}`), request(`/session/backups?key=${encodeURIComponent(sessionKey)}`)]).then(([data, saved]) => { if (!cancelled) { setSession(data); setSessionBackups(saved.backups || []) } }).catch(e => { if (!cancelled) setError(e.message) })
        return () => { cancelled = true }
      }, [sessionKey])
      useEffect(() => {
        if (!notice) return
        const timer = setTimeout(() => setNotice(''), 4500)
        return () => clearTimeout(timer)
      }, [notice])
      useEffect(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = 0
      }, [activeTab])
      async function act(body) {
        const confirmations = {
          forget: '确定遗忘这条记忆？当前记忆卡会先备份。',
          'merge-memories': `将选中的 ${body.ids?.length || 0} 条记忆合并为一个事件？原记录会从衰减卡移除，全量归档保留。`,
          'set-first-meet': '将选中的记忆设为初次互动？多条记录会合并，全量归档保留。',
          'clear-first-meet': '取消手动指定的初次互动？取消后这个位置为空。',
        }
        if (confirmations[body.action] && !window.confirm(confirmations[body.action])) return
        setBusy(true); setNotice('')
        try {
          const result = await request('/card', body)
          if (body.action === 'add') setText(current => current === body.text ? '' : current)
          if (['merge-memories', 'set-first-meet', 'maintain', 'compact'].includes(body.action)) setSelected([])
          else if (body.action === 'forget') setSelected(current => current.filter(id => id !== body.id))
          await refresh()
          setNotice(body.action === 'merge-memories' ? `已合并 ${result.merged ?? body.ids.length} 条记忆` : body.action === 'compact' ? `已压缩，调整 ${result.steps ?? 0} 次` : body.action === 'maintain' ? (result.disabled ? '记忆已关闭，未进行整理' : result.changed ? '记忆整理完成，内容已更新' : '记忆整理完成，无需更改') : '记忆已更新')
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function restore(name) {
        if (!window.confirm('恢复这份备份？当前记忆会先保存为新备份。备份之后已处理的事件不会自动重放，恢复后相关记忆可能不在当前卡片中。')) return
        setBusy(true); setNotice('')
        try {
          await request('/restore', { name })
          setSelected([]); setMemoryPage(0); setSnapshot(null); setCardPreview(null); setPreviews(null)
          setNotice('记忆卡已恢复')
          setRestoreNeedsRefresh(!await refresh())
        } catch (e) { if (e.code === 'MEMORY_RESTORE_PENDING') { setSelected([]); setMemoryPage(0); setSnapshot(null); setCardPreview(null); setPreviews(null); setRestoreNeedsRefresh(true); setNotice('记忆卡已替换，后续处理尚未完成') }; setError(e.message) } finally { setBusy(false) }
      }
      async function settings(changes) {
        setBusy(true)
        try { const result = await request('/settings', changes); await refresh(); return result.config } catch (e) { setError(e.message); return null } finally { setBusy(false) }
      }
      async function syncSettings(changes) {
        setBusy(true)
        try { const result = await request('/sync-settings', changes); await refresh(); return result.sync } catch (e) { setError(e.message); return null } finally { setBusy(false) }
      }
      async function ownerAlert(enabled) {
        setBusy(true)
        try { await request('/owner-alert', { enabled }); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function loadQqSync() {
        if (qqDirty && !window.confirm('重新读取会放弃尚未保存的同步设置，继续吗？')) return
        const revision = qqRevision.current
        setBusy(true)
        try {
          const data = await request('/qq-sync')
          if (qqRevision.current === revision) { setQqSync(data); setQqGroups((data.config.includeGroups || []).join(', ')); setQqDirty(false) }
          else { mergeQqStatus(data); setNotice('读取期间的修改尚未保存') }
          setError('')
        }
        catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function saveQqSync() {
        const revision = qqRevision.current
        setBusy(true)
        try {
          await request('/qq-sync/settings', { ...qqSync.config, includeGroups: qqGroups.split(/[,，\s]+/).filter(Boolean) })
          setNotice(qqRevision.current === revision ? '同步设置已保存' : '同步设置已保存；之后的修改尚未保存')
          try {
            const data = await request('/qq-sync')
            if (qqRevision.current === revision) { setQqSync(data); setQqGroups((data.config.includeGroups || []).join(', ')); setQqDirty(false) }
            else { mergeQqStatus(data); setNotice('同步设置已保存；之后的修改尚未保存') }
            setError('')
          } catch (e) { if (qqRevision.current !== revision) setNotice('同步设置已保存；之后的修改尚未保存'); setError(`同步设置已保存，但状态刷新失败：${e.message}`) }
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function runQqSync() {
        const revision = qqRevision.current, hadDraft = qqDirty
        setBusy(true)
        try {
          const result = await request('/qq-sync/run', {}); setNotice(`公开群同步已完成${result.auditWarning ? `；${result.auditWarning}` : ''}`)
          try { const data = await request('/qq-sync'); if (hadDraft || qqRevision.current !== revision) mergeQqStatus(data); else { setQqSync(data); setQqGroups((data.config?.includeGroups || []).join(', ')) }; setError('') }
          catch (e) { setError(`公开群同步已完成，但状态刷新失败：${e.message}`) }
        }
        catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function purgeQqSync() {
        if (!window.confirm('清空 QQ 公开群记录和同步摘要？请先停止 QQ 桥接。原文件会移入项目内备份；对齐表和长期记忆卡不受影响。')) return
        const revision = qqRevision.current, hadDraft = qqDirty
        setBusy(true)
        try {
          const result = await request('/qq-sync/purge', {})
          setNotice(`已清空公开群同步数据。备份位于 .artifacts/dsh-home/memory/backups/qq-sync-purge/${result.backup}`)
          try { const data = await request('/qq-sync'); if (hadDraft || qqRevision.current !== revision) mergeQqStatus(data); else { setQqSync(data); setQqGroups((data.config?.includeGroups || []).join(', ')) }; setError('') }
          catch (e) { setError(`公开群数据已清空，但状态刷新失败：${e.message}`) }
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function saveSessionValue(value) {
        setBusy(true)
        try {
          setSession(await request('/session', { key: sessionKey, value, revision: session.revision }))
          try { setSessionBackups((await request(`/session/backups?key=${encodeURIComponent(sessionKey)}`)).backups || []); setError('') }
          catch (e) { setError(`会话已保存，但备份列表刷新失败：${e.message}`) }
          return true
        }
        catch (e) { setError(e.message); try { setSession(await request(`/session?key=${encodeURIComponent(sessionKey)}`)) } catch {}; return false }
        finally { setBusy(false) }
      }
      async function removeSessionItem(category, index) {
        if (!session) return
        const value = { ...session.value }
        if (category === 'memberImpressions') {
          value.memberImpressions = { ...value.memberImpressions }
          delete value.memberImpressions[index]
        } else value[category] = value[category].filter((_, i) => i !== index)
        await saveSessionValue(value)
      }
      async function editSessionItem(category, index) {
        if (!session) return
        const value = { ...session.value }
        let draft
        if (category === 'memberImpressions') {
          const item = value.memberImpressions?.[index]
          if (!item || typeof item !== 'object') return
          const input = window.prompt(`编辑对 ${index} 的印象特质（逗号分隔）：`, (Array.isArray(item.traits) ? item.traits : []).join(', '))
          if (input === null) return
          draft = input
          value.memberImpressions = { ...value.memberImpressions, [index]: { ...item, traits: input.split(/[,，、]/).map(trait => trait.trim()).filter(Boolean).slice(0, 20) } }
        } else {
          const item = value[category]?.[index]
          if (!item || typeof item !== 'object') return
          const input = window.prompt(category === 'activeTopics' ? '编辑话题内容：' : '编辑想法内容：', String(item.text ?? ''))
          if (input === null) return
          draft = input
          value[category] = value[category].map((current, i) => i === index ? { ...current, text: input.trim().slice(0, 200) } : current)
        }
        if (!await saveSessionValue(value)) setSessionDrafts(current => [...current, { key: sessionKey, text: draft }])
      }
      async function clearSession(category, label) {
        if (!session || !window.confirm(`清空${label}？当前内容会先备份。`)) return
        const value = { ...session.value }
        if (!category || category === 'activeTopics') value.activeTopics = []
        if (!category || category === 'pendingThoughts') value.pendingThoughts = []
        if (!category || category === 'memberImpressions') value.memberImpressions = {}
        await saveSessionValue(value)
      }
      async function restoreSession(name) {
        if (!session || !window.confirm('恢复这份会话记忆？当前内容会先备份。')) return
        setBusy(true)
        try {
          setSession(await request('/session/restore', { key: sessionKey, name, revision: session.revision }))
          setNotice('会话记忆已恢复')
          try { setSessionBackups((await request(`/session/backups?key=${encodeURIComponent(sessionKey)}`)).backups || []); setError('') }
          catch (e) { setError(`会话记忆已恢复，但备份列表刷新失败：${e.message}`) }
        }
        catch (e) { setError(e.message); try { setSession(await request(`/session?key=${encodeURIComponent(sessionKey)}`)) } catch {} }
        finally { setBusy(false) }
      }
      async function refreshSessions() {
        setBusy(true)
        try {
          const [known, current, saved] = await Promise.all([
            request('/sessions'),
            sessionKey ? request(`/session?key=${encodeURIComponent(sessionKey)}`) : Promise.resolve(null),
            sessionKey ? request(`/session/backups?key=${encodeURIComponent(sessionKey)}`) : Promise.resolve(null),
          ])
          setSessions(known.sessions || [])
          if (current) { setSession(current); setSessionBackups(saved.backups || []) }
          setError('')
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      const button = (label, onClick, extra = {}) => {
        const { kind = 'ghost', className, ...rest } = extra
        return h('button', { type: 'button', disabled: busy, onClick, ...rest, className: ['mp-btn', `mp-btn-${kind}`, className].filter(Boolean).join(' ') }, label)
      }
      const selectedRecords = (snapshot?.records || []).filter(record => selected.includes(record.id))
      const selectedHasNonOwner = selectedRecords.some(record => !record.tags?.includes('owner'))
      const selectedHasFirstMet = selectedRecords.some(record => record.firstMet)
      const memoryPages = Math.max(1, Math.ceil((snapshot?.records?.length || 0) / 50))
      const currentMemoryPage = Math.min(memoryPage, memoryPages - 1)
      const pageRecords = (snapshot?.records || []).slice(currentMemoryPage * 50, (currentMemoryPage + 1) * 50)
      const clarityLabels = { vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '只剩印象', forgotten: '已遗忘' }
      const cx = (...parts) => parts.filter(Boolean).join(' ')
      const flatten = children => (Array.isArray(children) ? children.flat(Infinity) : [children])
      const card = (title, children, opts = {}) => h('section', { key: opts.key, className: cx('mp-card', opts.className) },
        title ? h('h2', { className: 'mp-card-title' }, title) : null,
        opts.note ? h('p', { className: 'mp-card-note' }, opts.note) : null,
        h('div', { className: 'mp-card-body' }, ...flatten(children)))
      const grid = (children, opts = {}) => h('div', { className: cx('mp-grid', opts.wide && 'wide') }, ...children.flat(Infinity))
      const actions = children => h('div', { className: 'mp-actions' }, ...children.flat(Infinity))
      const row = children => h('div', { className: 'mp-row' }, ...children.flat(Infinity))
      const chip = (label, tone) => h('span', { className: cx('mp-chip', tone) }, label)
      const stat = (label, value, unit, tone) => h('div', { key: label, className: cx('mp-stat', tone) },
        h('span', { className: 'mp-stat-value' }, value, unit ? h('span', { className: 'mp-stat-unit' }, unit) : null),
        h('span', { className: 'mp-stat-label' }, label))
      const meter = (value, tone) => h('div', { className: 'mp-meter', role: 'progressbar', 'aria-valuenow': value, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('div', { className: cx('mp-meter-fill', tone), style: { width: `${Math.max(0, Math.min(100, value))}%` } }))
      const field = (label, control) => h('label', { className: 'mp-field' }, label, control)
      const empty = label => h('p', { className: 'mp-empty' }, label)
      const pre = value => h('pre', { className: 'mp-pre' }, value)
      const tabItems = [
        { id: 'overview', label: '概览' },
        { id: 'card', label: '记忆卡' },
        { id: 'settings', label: '设置' },
      ]
      const activeId = tabItems.some(item => item.id === activeTab) ? activeTab : 'overview'
      const goTab = id => setActiveTab(id)
      const onTabKeyDown = (event, index) => {
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : tabItems.length - 1
          setActiveTab(tabItems[next].id)
          if (typeof document !== 'undefined') document.getElementById(`mp-tab-${tabItems[next].id}`)?.focus()
          return
        }
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const next = (index + step + tabItems.length) % tabItems.length
        setActiveTab(tabItems[next].id)
        if (typeof document !== 'undefined') document.getElementById(`mp-tab-${tabItems[next].id}`)?.focus()
      }
      const tabbar = h('div', { className: 'mp-tabs', role: 'tablist', 'aria-label': '记忆视图' },
        ...tabItems.map((item, index) => h('button', {
          key: item.id, id: `mp-tab-${item.id}`, type: 'button', role: 'tab',
          'aria-selected': activeId === item.id, 'aria-controls': `mp-panel-${item.id}`, tabIndex: activeId === item.id ? 0 : -1,
          className: cx('mp-tab', activeId === item.id && 'on'),
          onClick: () => setActiveTab(item.id), onKeyDown: event => onTabKeyDown(event, index),
        }, item.label)))
      const panel = (id, children) => h('div', {
        key: id, id: `mp-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `mp-tab-${id}`, tabIndex: 0,
        className: 'mp-panel', hidden: activeId !== id, style: activeId === id ? undefined : { display: 'none' },
      }, ...children.flat(Infinity))
      const percent = Math.max(0, Math.min(100, Math.round(Number(snapshot?.status?.percent) || 0)))
      const capacityLevel = Math.max(Number(snapshot?.status?.level) || 0, Number(snapshot?.status?.alertLevel) || 0)
      const capacityTone = percent >= 90 || capacityLevel >= 3 ? 'bad' : percent >= 70 || capacityLevel >= 2 ? 'warn' : 'ok'
      const firstMetLabel = `初次互动：${snapshot?.firstMet?.source === 'manual' ? '手动指定' : '尚无'}${snapshot?.firstMet?.at ? ` · ${snapshot.firstMet.at.slice(0, 10)}` : ''}`
      const archivedCount = snapshot?.records?.length ?? 0
      const dots = [
        snapshot ? h('span', { key: 'enabled', className: cx('mp-dot', snapshot.config?.enabled === false ? 'warn' : 'ok') }, snapshot.config?.enabled === false ? '记忆已关闭' : '记忆已启用') : h('span', { key: 'enabled', className: 'mp-dot' }, '正在读取'),
        snapshot ? h('span', { key: 'capacity', className: cx('mp-dot', capacityTone) }, `容量 ${percent}%`) : null,
        snapshot ? h('span', { key: 'records', className: 'mp-dot' }, `${archivedCount} 条记忆`) : null,
        snapshot ? h('span', { key: 'bili', className: cx('mp-dot', snapshot.sync?.enabled ? 'ok' : '') }, snapshot.sync?.enabled ? 'B站定期刷新' : 'B站刷新关闭') : null,
        restoreNeedsRefresh || error ? h('span', { key: 'attention', className: 'mp-dot bad' }, restoreNeedsRefresh ? '待恢复输出' : '需要处理') : null,
      ]
      const overview = () => {
        const recent = (snapshot?.records || []).slice(0, 5)
        return [
          card('记忆状态', [
            snapshot ? h('div', { className: 'mp-stats' },
              stat('衰减卡记录', snapshot.records.length, '条'),
              stat('衰减卡字数', snapshot.status?.chars ?? 0, '字'),
              stat('会话记忆', sessions.length, '个'),
              stat('可用备份', backups.length, '份')) : h('p', { className: 'mp-hint' }, '正在读取记忆卡…'),
            snapshot?.status ? meter(percent, capacityTone) : null,
            snapshot?.status ? row([
              chip(snapshot.status.levelLabel || '正常', capacityTone),
              h('span', { className: 'mp-hint' }, `已用 ${percent}%`),
              h('span', { className: 'mp-hint' }, `上次整理：${snapshot.status.lastMaintenanceAt || '尚无'}`),
            ]) : null,
            h('p', { className: 'mp-hint' }, firstMetLabel),
            snapshot?.sync ? h('p', { className: 'mp-hint' }, `B站公开记忆定期刷新：${snapshot.sync.enabled ? '已开启' : '已关闭'}${snapshot.sync.enabled ? `，每 ${Math.round((snapshot.sync.intervalMs ?? 600000) / 60000)} 分钟` : ''}。`) : null,
          ], { key: 'status' }),
          card('归档出站', [
            snapshot?.archiveOut
              ? grid([
                ['待投递', snapshot.archiveOut.pending],
                ['冲突', snapshot.archiveOut.conflicts],
                ['已确认', snapshot.archiveOut.receipts],
                ['无效', snapshot.archiveOut.invalid],
              ].map(([label, value]) => stat(label, value ?? 0, '条')))
              : h('p', { className: 'mp-hint' }, '尚未启用归档出站。'),
            snapshot?.archiveOut?.lastError?.message ? h('p', { role: 'alert', className: 'mp-hint' }, `最近错误：${snapshot.archiveOut.lastError.message}`) : null,
          ], { key: 'archive-out' }),
          card('最近记忆', recent.length ? recent.map(record => h('div', { key: record.id, className: 'mp-rec' },
            h('strong', null, record.title || record.text),
            record.text && record.title ? h('p', null, record.text) : null,
            h('small', null, `${record.platform || ''} · ${clarityLabels[record.clarity] || record.clarity || ''}${record.importance != null ? ` · 重要度 ${record.importance}` : ''}${record.createdAt ? ` · ${String(record.createdAt).slice(0, 10)}` : ''}${record.pinned ? ' · 置顶' : ''}`))) : empty('尚无衰减记忆；在「记忆卡」页手动记录一条，或等待平台事件写入。'), { key: 'recent' }),
          card('隐私边界', [
            h('p', null, 'QQ 私聊始终不会进入 B站上下文；群聊记忆仅在显式开启且脱敏后才会跨平台使用。'),
            h('p', { className: 'mp-hint' }, `B站公开记忆进入 QQ：${snapshot?.config?.includeBiliInQq !== false ? '允许' : '关闭'}；QQ 群聊记忆进入 B站：${snapshot?.config?.includeQqInBili === true ? '允许' : '关闭'}。`),
          ], { key: 'privacy' }),
          card('快捷入口', [
            actions([
              button('打开记忆卡', () => goTab('card')),
              button('打开设置（含会话、同步与备份）', () => goTab('settings')),
            ]),
          ], { key: 'shortcuts' }),
        ]
      }
      const cardTab = () => [
        card('记忆卡', [
          h('p', null, '日常提示词使用衰减记忆卡，按平台和设置筛选。'),
          h('div', { className: 'mp-stats' },
            stat('记录', snapshot?.records?.length ?? 0, '条'),
            stat('字数', snapshot?.status?.chars ?? 0, '字'),
            stat('容量', percent, '%', capacityTone)),
          snapshot?.status ? meter(percent, capacityTone) : null,
          h('p', null, snapshot?.status ? `容量状态：${snapshot.status.levelLabel || '正常'} · ${snapshot.status.percent ?? 0}% · 最近整理：${snapshot.status.lastMaintenanceAt || '尚无'}` : '正在读取…'),
          snapshot?.status && Math.max(Number(snapshot.status.level) || 0, Number(snapshot.status.alertLevel) || 0) > (Number(snapshot.status.acknowledgedLevel) || 0) ? actions([button('确认容量提醒', () => act({ action: 'ack', level: Math.max(Number(snapshot.status.level) || 0, Number(snapshot.status.alertLevel) || 0) }), { kind: 'primary' })]) : null,
          actions([button('查看记忆卡原文', async () => { setBusy(true); try { setCardPreview(await request('/card/preview')); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) } })]),
          cardPreview ? h('div', null, cardPreview.truncated ? h('p', { className: 'mp-hint' }, '仅显示前 200 KB。') : null, pre(cardPreview.text || '（暂无记忆卡）')) : null,
        ], { key: 'card' }),
        card('记录一条记忆', [
          h('textarea', { value: text, onChange: e => setText(e.target.value), placeholder: '写下一条记忆', 'aria-label': '记忆内容' }),
          grid([
            field('重要度', h('input', { 'aria-label': '记忆重要度', type: 'number', min: 1, max: 100, value: importance, onChange: e => setImportance(Number(e.target.value)) })),
            field('记忆范围', h('select', { value: scope, onChange: e => setScope(e.target.value), 'aria-label': '记忆范围' },
              h('option', { value: 'qq' }, 'QQ'), h('option', { value: 'bili' }, 'B站'), h('option', { value: 'shared' }, '共享'))),
          ]),
          actions([
            button('添加记忆', () => act({ action: 'add', text, scope, importance }), { disabled: busy || !text.trim() || importance < 1 || importance > 100, kind: 'primary' }),
            button('整理记忆', () => act({ action: 'maintain' })),
            button('压缩记忆', () => act({ action: 'compact' })),
          ]),
        ], { key: 'add' }),
        card('初次互动与批量操作', [
          h('p', null, firstMetLabel),
          h('p', null, `已选择 ${selected.length} 条；初次互动只能选择管理员相关的记忆${selectedHasNonOwner ? '（当前包含其他记忆）' : ''}${selectedHasFirstMet ? '；初次互动记录不能直接合并' : ''}`),
          h('p', { className: 'mp-hint' }, '每次合并最多 50 条，标记初次互动最多 20 条；这个位置不会自动产生，只能手动指定。'),
          grid([
            field('合并后的事件标题', h('input', { 'aria-label': '合并后的事件标题', value: mergeTitle, placeholder: '合并后的事件标题（可选）', onChange: e => setMergeTitle(e.target.value) })),
            h('label', { className: 'mp-check' }, h('input', { 'aria-label': '合并后置顶', type: 'checkbox', checked: mergePinned, onChange: e => setMergePinned(e.target.checked) }), '合并后置顶'),
          ], { wide: true }),
          actions([
            button('合并所选', () => act({ action: 'merge-memories', ids: selected, title: mergeTitle, pinned: mergePinned }), { disabled: busy || selected.length < 2 || selected.length > 50 || selectedHasFirstMet, kind: 'primary' }),
            button('标记初次互动', () => act({ action: 'set-first-meet', ids: selected }), { disabled: busy || !selected.length || selected.length > 20 || selectedHasNonOwner }),
            button('清除初次互动', () => act({ action: 'clear-first-meet' }), { kind: 'danger' }),
            button('同步 B站公开记忆', async () => { setBiliRefreshing(true); try { await request('/bili/refresh', {}); await refresh() } catch (e) { setError(e.message) } finally { setBiliRefreshing(false) } }, { disabled: busy || biliRefreshing }),
          ]),
          biliRefreshing ? h('p', { role: 'status', className: 'mp-hint' }, 'B站公开记忆正在同步，其他记忆操作仍可使用。') : null,
        ], { key: 'batch' }),
        card(`记忆列表 · 第 ${currentMemoryPage + 1} / ${memoryPages} 页`, [
          h('p', { className: 'mp-hint' }, `每页最多 50 条；跨页选择会保留。已选择 ${selected.length} 条。`),
          actions([
            button('记忆上一页', () => setMemoryPage(Math.max(0, currentMemoryPage - 1)), { disabled: busy || currentMemoryPage === 0 }),
            button('记忆下一页', () => setMemoryPage(currentMemoryPage + 1), { disabled: busy || currentMemoryPage + 1 >= memoryPages }),
          ]),
          ...pageRecords.map(record => h('article', { key: record.id, className: 'mp-rec' },
            h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', checked: selected.includes(record.id), disabled: busy, onChange: e => setSelected(current => e.target.checked ? [...current, record.id] : current.filter(id => id !== record.id)), 'aria-label': `选择记忆：${record.title || record.text}` }), '选择'),
            h('strong', null, record.title || record.text), h('p', null, record.text),
            h('small', null, `${record.platform || ''} · ${clarityLabels[record.clarity] || record.clarity || ''}${record.importance != null ? ` · 重要度 ${record.importance}` : ''}${record.createdAt ? ` · ${String(record.createdAt).slice(0, 10)}` : ''}${record.tags?.includes('owner') ? ' · 管理员互动' : ''}${record.tags?.includes('merged') ? ' · 合并事件' : ''}${record.firstMet ? ' · 初次互动' : record.isInitial ? ' · 最初互动' : ''}${record.pinned ? ' · 置顶' : ''}`),
            record.botReply ? h('p', null, `回复：${record.botReply}`) : null,
            actions([
              button(record.pinned ? '取消置顶' : '置顶', () => act({ action: 'pin', id: record.id, pinned: !record.pinned })),
              button('遗忘', () => act({ action: 'forget', id: record.id }), { disabled: busy || record.pinned, kind: 'danger' }),
            ]))),
        ], { key: 'list' }),
      ]
      const sessionTab = () => {
        const topics = session?.value?.activeTopics || []
        const thoughts = session?.value?.pendingThoughts || []
        const impressions = Object.entries(session?.value?.memberImpressions || {})
        return [
          sessionDrafts.length ? card('未保存的会话编辑', sessionDrafts.map((draft, index) => h('div', { key: index, className: 'mp-rec' },
            h('p', null, `会话 ${draft.key} 的编辑未保存；请核对最新内容后复制草稿并重新编辑。`),
            h('textarea', { 'aria-label': '未保存的会话编辑草稿', readOnly: true, value: draft.text }),
            actions([button('清除会话编辑草稿', () => setSessionDrafts(current => current.filter((_, i) => i !== index)))]))), { key: 'drafts' }) : null,
          card('会话来源', [
            h('p', null, '选择会话后可以查看话题、想法和成员印象；所有修改都会先备份。'),
            actions([button('刷新会话', refreshSessions), button('读取会话数据库备份', async () => { setBusy(true); try { setDatabaseBackups((await request('/session/database-backups')).backups || []); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) } })]),
            databaseBackups ? h('div', null, h('p', { className: 'mp-hint' }, '启动插件及手动修改会话前保存整库备份。仅在会话数据库损坏时可恢复；所有会话会回退到备份时间，损坏文件会另存。'),
              databaseBackups.length ? databaseBackups.map(name => h('div', { key: name, className: 'mp-item-row' }, h('span', null, name), button('恢复会话数据库', async () => {
                if (!window.confirm('恢复整个会话数据库？所有会话将回退到备份时间；当前损坏文件会保留。')) return
                setBusy(true); try { await request('/session/database-restore', { name }); setSession(null); setSessionKey(''); await refresh(); setNotice('会话数据库已恢复，损坏文件已保留') } catch (e) { setError(e.message) } finally { setBusy(false) }
              }, { kind: 'danger' }))) : empty('暂无会话数据库备份')) : null,
            h('select', { value: sessionKey, disabled: busy, onChange: e => { setSession(null); setSessionBackups([]); setSessionKey(e.target.value) }, 'aria-label': '选择 QQ 会话' },
              h('option', { value: '' }, sessions.length ? '选择会话' : '暂无会话记忆'),
              ...sessions.map(key => h('option', { key, value: key }, key))),
            sessionKey && !Number.isSafeInteger(Number(sessionKey.split(':')[1])) ? h('p', { className: 'mp-alert warn', role: 'alert' }, '此旧会话号码超出安全整数范围；可在这里管理记忆，当前 QQ 桥接不支持关联此会话。') : null,
          ], { key: 'source' }),
          card('会话记忆', session ? [
            h('div', { className: 'mp-stats' },
              stat('进行中话题', topics.length, '条'),
              stat('待说的想法', thoughts.length, '条'),
              stat('成员印象', impressions.length, '人')),
            actions([button('清空全部会话记忆', () => clearSession(null, '全部会话记忆'), { kind: 'danger' })]),
            h('h3', null, '进行中的话题'),
            h('div', { className: 'mp-row' }, button('清空进行中的话题', () => clearSession('activeTopics', '进行中的话题'), { disabled: busy || !topics.length, kind: 'danger' })),
            topics.length ? topics.map((item, index) => h('article', { key: index, className: 'mp-item' },
              h('span', null, item?.text || ''),
              item?.pendingQuestion ? h('span', null, `；待追问：${item.pendingQuestion}`) : null,
              actions([button('编辑', () => editSessionItem('activeTopics', index)), button('删除', () => removeSessionItem('activeTopics', index), { kind: 'danger' })]))) : empty('暂无进行中的话题'),
            h('h3', null, '待说的想法'),
            h('div', { className: 'mp-row' }, button('清空待说的想法', () => clearSession('pendingThoughts', '待说的想法'), { disabled: busy || !thoughts.length, kind: 'danger' })),
            thoughts.length ? thoughts.map((item, index) => h('article', { key: index, className: 'mp-item' },
              h('span', null, item?.text || ''),
              item?.motivation ? h('span', null, `（${item.motivation}）`) : null,
              actions([button('编辑', () => editSessionItem('pendingThoughts', index)), button('删除', () => removeSessionItem('pendingThoughts', index), { kind: 'danger' })]))) : empty('暂无待说的想法'),
            h('h3', null, '成员印象'),
            h('div', { className: 'mp-row' }, button('清空成员印象', () => clearSession('memberImpressions', '成员印象'), { disabled: busy || !impressions.length, kind: 'danger' })),
            impressions.length ? impressions.map(([name, item]) => h('article', { key: name, className: 'mp-item' },
              h('span', null, `${name}：${(Array.isArray(item?.traits) ? item.traits : []).join('、')}`),
              h('span', null, `（互动 ${Number(item?.interactionCount) || 0} 次）`),
              actions([button('编辑', () => editSessionItem('memberImpressions', name)), button('删除', () => removeSessionItem('memberImpressions', name), { kind: 'danger' })]))) : empty('暂无成员印象'),
            h('h3', null, '会话记忆备份'),
            sessionBackups.length ? sessionBackups.map(name => h('div', { key: name, className: 'mp-item-row' }, h('span', null, name), button('恢复', () => restoreSession(name)))) : empty('暂无备份'),
          ] : [empty('选择一个会话后查看记忆。')], { key: 'content' }),
        ]
      }
      const syncTab = () => [
        card('平台注入预览', [
          h('p', null, '显示当前实际交给各平台的记忆文本；QQ 私聊不会进入 B站。'),
          actions([button('读取预览', async () => { setBusy(true); try { setPreviews(await request('/previews')); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) } })]),
          previews ? grid([
            h('div', { key: 'qq', className: 'mp-rec' }, h('h3', null, 'QQ'), pre(previews.qq || '（为空）')),
            h('div', { key: 'bili', className: 'mp-rec' }, h('h3', null, 'B站'), pre(previews.bili || '（为空）')),
          ], { wide: true }) : null,
        ], { key: 'previews' }),
        card('B站 → QQ 简报', [
          actions([button('读取 B站简报与隐私状态', async () => { setBusy(true); try { setBiliBrief(await request('/bili/brief')); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) } }), button('读取分享历史备份', async () => { setBusy(true); try { setShareHistoryBackups((await request('/bili/share-history/backups')).backups || []); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) } })]),
          shareHistoryBackups ? h('div', null, h('p', { className: 'mp-hint' }, '分享历史在更新前备份。恢复旧版本可能遗漏之后的分享记录，导致重复分享；请先停止 QQ 桥接。'),
            shareHistoryBackups.length ? shareHistoryBackups.map(name => h('div', { key: name, className: 'mp-item-row' }, h('span', null, name), button('恢复分享历史', async () => {
              if (!window.confirm('恢复分享历史备份？当前文件会先保留；备份之后的分享记录可能丢失并导致重复分享。请先停止 QQ 桥接。')) return
              setBusy(true)
              try { await request('/bili/share-history/restore', { name }); setBiliBrief(null); setNotice('分享历史已恢复，原文件已保留'); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) }
            }, { kind: 'danger' }))) : empty('暂无分享历史备份')) : null,
          biliBrief ? h('div', null, h('p', null, `${biliBrief.enabled ? '方向已启用' : '方向已关闭'} · 隐私复检${biliBrief.blocked ? '未通过' : '通过'} · ${biliBrief.status?.briefChars ?? 0} 字`), pre(biliBrief.text || '（暂无可用简报）')) : null,
        ], { key: 'brief' }),
        card('QQ 公开群同步到 B站', [
          h('p', null, '需要显式开启并指定群白名单；只处理公开群消息，私聊和敏感内容不会同步。修改设置后需重新同步。'),
          h('div', { className: 'mp-row' }, button('读取同步设置', loadQqSync), qqDirty ? chip('有尚未保存的修改', 'warn') : (qqSync ? chip('已保存', 'ok') : null)),
          qqSync ? h('div', null,
            h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', checked: qqSync.config.enabled, onChange: e => { markQqDirty(); setQqSync({ ...qqSync, config: { ...qqSync.config, enabled: e.target.checked } }) } }), '启用公开群同步'),
            field('允许的群号（最多 500 个）', h('input', { value: qqGroups, onChange: e => { markQqDirty(); setQqGroups(e.target.value) }, placeholder: '群号，逗号分隔' })),
            grid([
              ...[['autoSync', '定期同步（默认关闭）'], ['includeOwner', '包含管理员的公开群消息'], ['useNicknames', '使用脱敏后的群昵称'], ['includeIdentityLinks', '使用已确认的 B站身份名称']].map(([key, label]) => h('label', { key, className: 'mp-check' }, h('input', { type: 'checkbox', checked: qqSync.config[key], onChange: e => { markQqDirty(); setQqSync({ ...qqSync, config: { ...qqSync.config, [key]: e.target.checked } }) } }), label)),
            ], { wide: true }),
            grid([
              field('同步间隔（分钟）', h('input', { type: 'number', min: 5, max: 1440, value: qqSync.config.intervalMs / 60000, onChange: e => { markQqDirty(); setQqSync({ ...qqSync, config: { ...qqSync.config, intervalMs: Math.round(Number(e.target.value) * 60000) } }) } })),
              ...[['lookbackDays', '回看天数', 1, 90], ['maxMessages', '最多消息条数', 1, 5000], ['maxChars', '摘要最大字符', 1200, 20000]].map(([key, label, min, max]) => field(label, h('input', { type: 'number', min, max, value: qqSync.config[key], onChange: e => { markQqDirty(); setQqSync({ ...qqSync, config: { ...qqSync.config, [key]: Number(e.target.value) } }) } }))),
            ]),
            actions([button('保存同步设置', saveQqSync, { kind: 'primary' }), button('立即同步公开群消息', runQqSync, { disabled: busy || qqDirty || !qqSync.config.enabled }), button('清空公开群同步数据', purgeQqSync, { disabled: busy, kind: 'danger' })]),
            h('h3', null, '同步摘要'), qqSync.summaryError ? h('p', { role: 'alert' }, qqSync.summaryError) : null, qqSync.summaryBlocked ? h('p', { role: 'alert' }, `摘要未通过隐私检查：${(qqSync.summaryLabels || []).join('、') || '敏感内容'}；原文件已保留。`) : null, pre(qqSync.text || '（尚无有效摘要）'),
            h('h3', null, '同步审计'), qqSync.auditError ? h('p', { role: 'alert' }, qqSync.auditError) : null, qqSync.invalidAuditLines ? h('p', { role: 'alert' }, `审计日志有 ${qqSync.invalidAuditLines} 条损坏、未完成或超过 1 MiB 的记录，原文件已保留。`) : null, ...(qqSync.audit || []).slice().reverse().map((item, i) => h('p', { key: i, className: 'mp-hint' }, `${item.at} · 扫描 ${item.scanned} · 保留 ${item.kept} · 丢弃 ${item.dropped}${item.invalidLines ? ` · 损坏或未完成 ${item.invalidLines}` : ''}`))) : null,
        ], { key: 'qqsync' }),
      ]
      const numericSettings = snapshot ? [
        ['maxChars', '衰减卡字数上限', 0], ['warnChars', '容量警告字数', 0],
        ['maxRecords', '衰减卡记录上限', 100, 2000], ['minOwnerImportance', '管理员记忆保护阈值', 50, 100],
        ['fullMaxBytes', '全量卡上限（GB）', 0, 100, 1024 ** 3],
        ['qq', 'QQ 注入上限（字）', 400, 8000, 1, true], ['bili', 'B站 注入上限（字）', 400, 8000, 1, true],
        ['recentDays', '最近 N 天保持清楚', 1, 60], ['fuzzyAfterDays', '多少天后开始模糊', 0, 60],
        ['forgetAfterDays', '多少天后可以遗忘', 7, 365], ['dailyHour', '每日整理时间（点）', 0, 23],
      ].map(([key, label, min, max, factor = 1, nested = false]) => {
        const raw = nested ? snapshot.config.injectMaxChars?.[key] : snapshot.config[key]
        return h('label', { key, className: 'mp-field' }, label,
          h('input', {
            key: `${key}:${raw}`, type: 'number', min, max, step: factor > 1 ? 0.5 : 1, disabled: busy,
            'aria-label': label, defaultValue: Number(raw) / factor,
            onBlur: async e => {
              const target = e.target, original = target.value, value = Number(original)
              if (original.trim() && Number.isFinite(value) && value >= min && (max === undefined || value <= max)) {
                const saved = await settings(nested ? { injectMaxChars: { [key]: Math.round(value * factor) } } : { [key]: Math.round(value * factor) })
                const actual = nested ? saved?.injectMaxChars?.[key] : saved?.[key]
                if (actual !== undefined && target.value === original) target.value = String(Number(actual) / factor)
                return
              }
              target.value = String(Number(raw) / factor)
            },
          }))
      }) : null
      const settingsTab = () => [
        card('记忆设置', [
          h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', disabled: busy || !snapshot, checked: snapshot?.config?.enabled === true, onChange: e => settings({ enabled: e.target.checked }) }), '启用记忆'),
          h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', disabled: busy || !snapshot, checked: snapshot?.ownerAlert?.enabled === true, onChange: e => ownerAlert(e.target.checked) }), '容量达到告警阈值时私聊管理员（默认关闭）'),
          actions([button('检查并发送容量告警', async () => { if (!window.confirm('若已达到告警阈值且冷却时间已过，将向 QQ 管理员发送一条私聊。继续吗？')) return; setBusy(true); try { const r = await request('/owner-alert/check', {}); setNotice(r.notified ? '容量告警已发送' : `未发送：${({ disabled: '通知已关闭', 'no-alert': '尚未达到阈值', cooldown: '处于冷却期' })[r.skipped] || '无需通知'}`); setError('') } catch (e) { setError(e.message) } finally { setBusy(false) } }, { disabled: busy || !snapshot?.ownerAlert?.enabled })]),
          h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', disabled: busy || !snapshot, checked: snapshot?.config?.includeBiliInQq !== false, onChange: e => settings({ includeBiliInQq: e.target.checked }) }), '允许 B站公开记忆进入 QQ 上下文'),
          h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', disabled: busy || !snapshot, checked: snapshot?.config?.includeQqInBili === true, onChange: e => settings({ includeQqInBili: e.target.checked }) }), '允许脱敏后的 QQ 群聊记忆进入 B站上下文'),
          h('p', { className: 'mp-hint' }, 'QQ 私聊始终不会进入 B站上下文。'),
          h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', disabled: busy || !snapshot, checked: snapshot?.sync?.enabled === true, onChange: e => syncSettings({ enabled: e.target.checked }) }), '定期刷新 B站公开记忆（需要本机 B站凭据）'),
          h('p', { className: 'mp-hint' }, `定期刷新${snapshot?.sync?.enabled ? '已开启' : '默认关闭'}。`),
          snapshot ? field('B站公开记忆刷新间隔（分钟）', h('input', { key: `bili-interval:${snapshot.sync?.intervalMs}`, 'aria-label': 'B站公开记忆刷新间隔（分钟）', type: 'number', min: 1, max: 1440, step: 1, disabled: busy, defaultValue: (snapshot.sync?.intervalMs ?? 600000) / 60000,
            onBlur: async e => { const target = e.target, original = target.value, value = Number(original); if (original.trim() && Number.isInteger(value) && value >= 1 && value <= 1440) { const saved = await syncSettings({ intervalMs: value * 60000 }); if (saved && target.value === original) target.value = String(saved.intervalMs / 60000); return } target.value = String((snapshot.sync?.intervalMs ?? 600000) / 60000) } })) : null,
        ], { key: 'settings' }),
        snapshot ? card('容量、遗忘与注入规则', [
          h('p', { className: 'mp-hint' }, '数字在离开输入框时保存；0 字符上限表示不限制。'),
          h('p', { className: 'mp-hint' }, '衰减卡条数超限时，可移除的记录会先归档；置顶和受保护的记忆可能使条数超过上限。'),
          grid(numericSettings),
          h('label', { className: 'mp-check' }, h('input', { type: 'checkbox', disabled: busy, checked: snapshot.config.autoCompact === true, onChange: e => settings({ autoCompact: e.target.checked }) }), '满 100% 自动压缩'),
        ], { key: 'limits' }) : card('容量、遗忘与注入规则', [empty('记忆卡不可读，暂时无法调整设置。')], { key: 'limits' }),
        card('备份', [
          h('p', null, '恢复备份前会先保存当前记忆卡；备份之后已处理的事件不会自动重放。'),
          backups.length ? backups.map(name => h('div', { key: name, className: 'mp-item-row' }, h('span', null, name.startsWith('memory-card-legacy-unattributed-') ? `旧版备份（来源未标注）：${name}` : name), button('恢复', () => restore(name), { kind: 'danger' }))) : empty('暂无备份'),
        ], { key: 'backups' }),
        ...sessionTab(),
        ...syncTab(),
      ]
      return h('main', { className: 'memory-panel' },
        h('style', null, MEMORY_CSS),
        h('header', { className: 'mp-head' },
          h('div', { className: 'mp-head-main' },
            h('p', { className: 'mp-kicker' }, 'DSH · 长期记忆'),
            h('h1', null, '记忆'),
            h('p', { className: 'mp-sub' }, '维护长期记忆。QQ 私密内容不会默认进入 B 站上下文。')),
          h('div', { className: 'mp-dots' }, ...dots)),
        h('div', { className: 'mp-alerts' },
          error ? h('div', { className: 'mp-alert danger', role: 'alert' }, h('span', null, error), button('关闭提示', () => setError(''), { kind: 'quiet' })) : null,
          restoreNeedsRefresh ? h('div', { className: 'mp-alert warn', role: 'alert' }, h('span', null, '记忆卡已替换，后续处理尚未完成。'), button('重新读取记忆状态', async () => { setBusy(true); try { if (await refresh()) { setRestoreNeedsRefresh(false); setNotice('记忆状态已更新') } } finally { setBusy(false) } })) : null,
          snapshot?.biliSource?.legacyPresent ? h('div', { className: 'mp-alert warn', role: 'alert' }, h('span', null, '旧 B站简报已保留，但缺少可用的记忆索引；同步公开记忆后才能重新用于上下文。')) : null),
        tabbar,
        h('div', { className: 'mp-body', ref: bodyRef },
          panel('overview', overview()),
          panel('card', cardTab()),
          panel('settings', settingsTab())),
        notice ? h('div', { className: 'mp-toast', role: 'status' }, notice) : null)
    }
    function Icon({ size = 20 }) { return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, h('path', { d: 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5' })) }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'memory', inject: () => ({}) }, MemoryPanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'memory', order: 12, label: () => '记忆卡片' }, Icon))
    } }
  },
})
