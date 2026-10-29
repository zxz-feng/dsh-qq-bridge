/**
 * dsh-qq-bridge —— 浏览器半端（「设置」里的「QQ 小鲸鱼」那一页）
 * ============================================================================
 * ⭐ client bundle **不是 ESM，是自注册脚本**（约定来自官方包）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                        // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: [...], apply(ctx) {...} }),
 *     })
 *
 * ⭐ 进「设置」的唯一正确写法（和 dsh-bili-scroll 一致）：
 *
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'qq-bridge', order: 40, label: 'QQ 小鲸鱼' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页的形状（主人 2026-10-29 定的）：
 *   · 总开关在最上面，关掉之后下面全部收起（不是灰一片）
 *   · 群聊**一卡一群**，每卡自己一个保存按钮 —— 不要「保存全部」，误触范围太大
 *   · 数字项能自己填，但**钳位以服务端为准**（前端只显示范围，不当唯一真相）
 *   · 风格档是下拉（档位来自桥里的 persona/styles/*.md，加一档自动出现在这儿）
 *   · 会花 token 的（接话概率、每日主动）默认低，改大要点两下
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/qq-bridge'

    /* ⚠️ 不要无脑 .json()：HTTP 500 的 {ok:false} 会被当成「保存成功」，
     *    绿色提示把故障盖掉（bili 那边踩过一次）。 */
    const asJson = async (res) => {
      if (res.status === 204) return { ok: true, empty: true }
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了：非同源）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-qq-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:720px;}
[data-qq-sec]{display:flex;flex-direction:column;gap:9px;}
[data-qq-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-qq-col]{display:flex;flex-direction:column;gap:3px;min-width:0;}
[data-qq-grow]{flex:1;min-width:0;}
[data-qq-label]{font-size:13px;}
[data-qq-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-qq-sw][data-on]{background:#3b82f6;}
[data-qq-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-qq-sw][data-on] i{left:19px;}
[data-qq-sw][disabled]{opacity:.45;cursor:default;}
[data-qq-input]{box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-input]:focus{outline:none;border-color:#3b82f6;}
[data-qq-num]{width:82px;text-align:center;}
[data-qq-full]{width:100%;}
[data-qq-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-qq-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-qq-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qq-btn][data-danger]{color:#f87171;border-color:rgba(248,113,113,.4);}
[data-qq-btn][disabled]{opacity:.5;cursor:default;}
[data-qq-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-msg][data-good]{color:#22c55e;}
[data-qq-msg][data-warn]{color:#f59e0b;}
[data-qq-card]{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.22));}
[data-qq-card-h]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-qq-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-qq-badge][data-live]{color:#22c55e;}
[data-qq-badge][data-dry]{color:#f59e0b;}
[data-qq-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px 12px;}
[data-qq-pre]{margin:0;padding:8px 9px;border-radius:8px;max-height:200px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-qq-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-qq-away]{display:none !important;}
[data-qq-qr]{display:flex;gap:12px;align-items:flex-start;}
[data-qq-qr] img{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;}
[data-qq-tbl]{display:flex;flex-direction:column;gap:6px;}
[data-qq-tr]{display:flex;align-items:center;gap:8px;font-size:12px;}
[data-qq-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
`

    /* ────────────── 小组件 ────────────── */

    function Sw({ on, onChange, disabled }) {
      return h('button', {
        type: 'button', 'data-qq-sw': '', 'data-on': on ? '1' : undefined,
        disabled: Boolean(disabled),
        'aria-pressed': on ? 'true' : 'false',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function Num({ value, onChange, min, max, step = 1, width }) {
      return h('input', {
        'data-qq-input': '', 'data-qq-num': '', type: 'number',
        style: width ? { width } : undefined,
        value: value === undefined || value === null ? '' : value,
        min, max, step,
        onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      })
    }

    function Text({ value, onChange, placeholder, mono }) {
      return h('input', {
        'data-qq-input': '', 'data-qq-full': '', type: 'text',
        'data-qq-mono': mono ? '' : undefined,
        value: value ?? '', placeholder: placeholder ?? '',
        onChange: (e) => onChange(e.target.value),
      })
    }

    function Msg({ m }) {
      if (!m) return null
      return h('div', { 'data-qq-msg': '', 'data-good': m.kind === 'good' ? '' : undefined, 'data-warn': m.kind === 'warn' ? '' : undefined }, m.text)
    }

    const pct = (v) => Math.round(Number(v ?? 0) * 1000) / 10   // 0.02 → 2

    /* ────────────── 群卡片 ────────────── */

    function GroupCard({ row, styles, busy, onSave, onStyle, onDryRun }) {
      const eff = row.effective || {}
      const [d, setD] = useState({})
      const v = (k) => (d[k] !== undefined ? d[k] : eff[k])
      const set = (k, val) => setD((o) => ({ ...o, [k]: val }))
      const dirty = Object.keys(d).length > 0

      const cur = row.style?.style || 'normal'
      const curInt = row.style?.intensity || 'mid'

      return h('div', { 'data-qq-card': '' },
        h('div', { 'data-qq-card-h': '' },
          h('span', { 'data-qq-label': '' }, `${row.label || '群'} ${row.gid}`),
          h('span', { 'data-qq-badge': '', 'data-live': row.dryRun ? undefined : '', 'data-dry': row.dryRun ? '' : undefined },
            row.dryRun ? '演练（只记不发）' : '真发'),
          row.enabled ? null : h('span', { 'data-qq-badge': '', 'data-dry': '' }, '已停用'),
          h('span', { 'data-qq-grow': '' }),
          h('span', { 'data-qq-note': '' }, '启用'),
          h(Sw, { on: row.enabled, disabled: busy, onChange: (on) => onSave(row.gid, { enabled: on }) })),

        // 风格档：改完立刻生效（不需要点保存）
        h('div', { 'data-qq-row': '' },
          h('span', { 'data-qq-label': '' }, '说话风格'),
          h('select', {
            'data-qq-input': '',
            value: cur,
            disabled: busy || !styles.length,
            onChange: (e) => onStyle(row.gid, e.target.value, curInt),
          }, styles.length
            ? styles.map((s) => h('option', { key: s.id, value: s.id }, `${s.name}（${s.id}）`))
            : h('option', { value: cur }, row.style ? cur : '读不到（桥没跑？）')),
          h('select', {
            'data-qq-input': '',
            value: curInt,
            disabled: busy || !styles.length,
            onChange: (e) => onStyle(row.gid, cur, e.target.value),
          },
          h('option', { value: 'mid' }, '正常'),
          h('option', { value: 'heavy' }, '加重')),
          h('span', { 'data-qq-note': '' }, row.style ? '改完下一句就变' : '')),

        h('div', { 'data-qq-grid': '' },
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '接话概率 %'),
            h(Num, { value: pct(v('replyProb')), min: 0, max: 100, step: 0.5, onChange: (n) => set('replyProb', Number(n) / 100) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '冷场插话 %'),
            h(Num, { value: pct(v('coldProb')), min: 0, max: 100, step: 0.5, onChange: (n) => set('coldProb', Number(n) / 100) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '每日主动条数'),
            h(Num, { value: v('dailyActive'), min: 0, max: 200, onChange: (n) => set('dailyActive', n) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '每日总上限'),
            h(Num, { value: v('dailyTotal'), min: 0, max: 2000, onChange: (n) => set('dailyTotal', n) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '全局冷却 秒'),
            h(Num, { value: v('cooldownSec'), min: 0, max: 3600, onChange: (n) => set('cooldownSec', n) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '每人冷却 分'),
            h(Num, { value: v('memberCooldownMin'), min: 0, max: 1440, onChange: (n) => set('memberCooldownMin', n) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '静默 从（点）'),
            h(Num, {
              value: Array.isArray(v('quietHours')) ? v('quietHours')[0] : 2, min: 0, max: 23,
              onChange: (n) => set('quietHours', [n, (v('quietHours') || [2, 9])[1]]),
            })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '静默 到（点）'),
            h(Num, {
              value: Array.isArray(v('quietHours')) ? v('quietHours')[1] : 9, min: 0, max: 23,
              onChange: (n) => set('quietHours', [(v('quietHours') || [2, 9])[0], n]),
            })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '点歌 每天'),
            h(Num, { value: v('voicePerDay'), min: 0, max: 999, onChange: (n) => set('voicePerDay', n) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '整首 每天'),
            h(Num, { value: v('fullSongPerDay'), min: 0, max: 999, onChange: (n) => set('fullSongPerDay', n) })),
          h('label', { 'data-qq-col': '' },
            h('span', { 'data-qq-note': '' }, '整首最多几段'),
            h(Num, { value: v('fullSongMaxSeg'), min: 1, max: 60, onChange: (n) => set('fullSongMaxSeg', n) }))),

        h('div', { 'data-qq-row': '' },
          h('button', {
            'data-qq-btn': '', 'data-primary': dirty ? '' : undefined, disabled: busy || !dirty,
            onClick: () => { onSave(row.gid, d); setD({}) },
          }, dirty ? '保存这个群' : '没有改动'),
          h('span', { 'data-qq-grow': '' }),
          h('span', { 'data-qq-note': '' }, '演练开关'),
          h(Sw, { on: row.dryRun, disabled: busy, onChange: (on) => onDryRun(row.gid, on) })))
    }

    /* ────────────── 主面板 ────────────── */

    function Panel() {
      const [st, setSt] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [grp, setGrp] = useState(null)
      const [fr, setFr] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [tail, setTail] = useState('')
      const [report, setReport] = useState('')
      const [qr, setQr] = useState('')
      const [newUin, setNewUin] = useState('')
      const [newLabel, setNewLabel] = useState('')

      const load = useCallback(async () => {
        setBusy('load')
        try {
          const [s, c, g, f] = await Promise.all([jget('/status'), jget('/config'), jget('/groups'), jget('/friends')])
          setSt(s); setCfg(c.config); setGrp(g); setFr(f)
          setMsg(null)
        } catch (e) {
          setMsg({ kind: 'warn', text: '读不到配置：' + (e?.message ?? e) })
        } finally { setBusy('') }
      }, [])

      useEffect(() => { void load() }, [load])

      const run = async (tag, fn, okText) => {
        setBusy(tag)
        try { const r = await fn(); if (okText) setMsg({ kind: 'good', text: okText }); return r }
        catch (e) { setMsg({ kind: 'warn', text: '操作失败：' + (e?.message ?? e) }); return null }
        finally { setBusy('') }
      }

      const patchCfg = async (patch, okText) => {
        const r = await run('cfg', () => jpost('/config', { patch }), okText)
        if (r?.config) { setCfg(r.config); setSt((s) => (s ? { ...s, enabled: r.config.enabled } : s)) }
      }

      const saveGroup = async (gid, patch) => {
        const r = await run('grp', () => jpost('/groups', { gid, patch }), '这个群的设置已保存')
        if (r?.ok) await reloadGroups()
      }
      const reloadGroups = async () => {
        try { setGrp(await jget('/groups')) } catch { /* 桥可能正在重启 */ }
      }
      const setStyle = async (gid, style, intensity) => {
        const r = await run('style', () => jpost('/style', { gid, style, intensity }), '风格已切换')
        if (r?.ok) await reloadGroups()
      }

      if (!st || !cfg) {
        return h('div', { 'data-qq-page': '' },
          h(Msg, { m: msg || { kind: 'info', text: busy ? '读取中…' : '还没有数据' } }),
          h('button', { 'data-qq-btn': '', onClick: () => void load() }, '重新读取'))
      }

      const on = cfg.enabled !== false
      const away = (x) => (on ? undefined : '')
      const styles = grp?.available ?? []
      const groups = grp?.groups ?? []
      const friends = Object.entries(fr?.friends ?? {})
      const bridge = st.bridge || {}
      const proc = st.process || {}

      return h('div', { 'data-qq-page': '' },

        /* 状态条 */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '现在什么状态'),
          h('div', { 'data-qq-row': '' },
            h('span', { 'data-qq-badge': '', 'data-live': bridge.connected ? '' : undefined, 'data-dry': bridge.connected ? undefined : '' },
              bridge.connected ? 'OneBot 已连' : 'OneBot 没连'),
            h('span', { 'data-qq-badge': '' }, proc.state || '未知'),
            bridge.self ? h('span', { 'data-qq-badge': '' }, '号 ' + bridge.self) : null,
            bridge.today !== undefined ? h('span', { 'data-qq-badge': '' }, `今天 ${bridge.today} 条`) : null,
            bridge.stickers !== undefined ? h('span', { 'data-qq-badge': '' }, `贴纸 ${bridge.stickers}`) : null,
            h('span', { 'data-qq-grow': '' }),
            h('button', { 'data-qq-btn': '', disabled: Boolean(busy), onClick: () => void load() }, '刷新')),
          bridge.error ? h(Msg, { m: { kind: 'warn', text: '桥没响应：' + bridge.error } }) : null),

        /* 总开关 */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-row': '' },
            h('span', { 'data-qq-label': '' }, '让小鲸鱼上线'),
            h(Sw, { on, disabled: Boolean(busy), onChange: (v) => void patchCfg({ enabled: v }, v ? '已打开：正在连 OneBot' : '已关闭：桥会停下来') })),
          h('div', { 'data-qq-note': '' }, '关掉就是整只停下来（不连 OneBot、不回任何消息），不是只把界面灰掉。')),

        /* 连接 */
        h('div', { 'data-qq-sec': '', 'data-qq-away': away() },
          h('div', { 'data-qq-h': '' }, '连接'),
          h('div', { 'data-qq-row': '' },
            h('span', { 'data-qq-label': '' }, 'OneBot'),
            h('div', { 'data-qq-grow': '' }, h(Text, {
              value: cfg.onebot?.url ?? '', mono: true,
              onChange: (v) => setCfg((c) => ({ ...c, onebot: { ...(c.onebot || {}), url: v } })),
            })),
            h('button', {
              'data-qq-btn': '', disabled: Boolean(busy),
              onClick: () => void patchCfg({ onebot: { url: cfg.onebot?.url } }, '地址已保存（下次重连生效）'),
            }, '保存')),
          h('div', { 'data-qq-row': '' },
            h('span', { 'data-qq-label': '' }, '模式'),
            h('select', {
              'data-qq-input': '', value: cfg.mode || 'auto', disabled: Boolean(busy),
              onChange: (e) => void patchCfg({ mode: e.target.value }, '模式已改'),
            },
            h('option', { value: 'auto' }, 'auto 直接发'),
            h('option', { value: 'draft' }, 'draft 只写草稿'),
            h('option', { value: 'off' }, 'off 不生成')),
            h('span', { 'data-qq-grow': '' }),
            h('button', {
              'data-qq-btn': '', disabled: Boolean(busy),
              onClick: () => { setQr(API + '/qr?t=' + Date.now()); setMsg(null) },
            }, '看登录二维码')),
          qr ? h('div', { 'data-qq-qr': '' },
            h('img', { src: qr, alt: '二维码' }),
            h('div', { 'data-qq-note': '' }, '手机 QQ → 扫一扫。已经登录过就不会有码（接口返回空）。')) : null,
          cfg.napcat?.webui
            ? h('div', { 'data-qq-note': '' }, `NapCat WebUI：${cfg.napcat.webui}`)
            : h('div', { 'data-qq-note': '' }, '没配 napcat.webui —— 二维码取不到，只能自己开 NapCat 的 WebUI 扫。')),

        /* 群聊 */
        h('div', { 'data-qq-sec': '', 'data-qq-away': away() },
          h('div', { 'data-qq-h': '' }, '群聊'),
          groups.length
            ? groups.map((g) => h(GroupCard, {
              key: g.gid, row: g, styles, busy: Boolean(busy),
              onSave: (gid, patch) => void saveGroup(gid, patch),
              onStyle: (gid, s, i) => void setStyle(gid, s, i),
              onDryRun: (gid, v) => void saveGroup(gid, { dryRun: v }),
            }))
            : h('div', { 'data-qq-note': '' }, '一个群都没配。加群要写 group-allowlist.json（或用 qq_allowlist 工具）—— 这一页只改已有群。'),
          h('div', { 'data-qq-note': '' }, `默认值（新群继承）：接话 ${pct(grp?.defaults?.replyProb ?? 0.02)}% · 冷场 ${pct(grp?.defaults?.coldProb ?? 0.08)}% · 每人冷却 ${grp?.defaults?.memberCooldownMin ?? 5} 分 · 静默 ${(grp?.defaults?.quietHours || [2, 9]).join('–')} 点`)),

        /* 好友 */
        h('div', { 'data-qq-sec': '', 'data-qq-away': away() },
          h('div', { 'data-qq-h': '' }, '私聊白名单'),
          friends.length
            ? h('div', { 'data-qq-tbl': '' }, friends.map(([uin, v]) => h('div', { 'data-qq-tr': '', key: uin },
              h('span', { 'data-qq-mono': '' }, uin),
              h('span', { 'data-qq-grow': '' }, v?.label || '（没备注）'),
              v?.enabled === false ? h('span', { 'data-qq-badge': '', 'data-dry': '' }, '暂停') : null,
              h(Sw, {
                on: v?.enabled !== false, disabled: Boolean(busy),
                onChange: (x) => void run('fr', async () => {
                  const r = await jpost('/friends', { uin, enabled: x })
                  setFr(r); return r
                }, x ? '已恢复' : '已暂停'),
              }),
              h('button', {
                'data-qq-btn': '', 'data-danger': '', disabled: Boolean(busy),
                onClick: () => void run('fr', async () => {
                  const r = await jpost('/friends', { uin, remove: true })
                  setFr(r); return r
                }, '已删除'),
              }, '删'))))
            : h('div', { 'data-qq-note': '' }, '白名单是空的 —— 谁私聊都不回。'),
          h('div', { 'data-qq-row': '' },
            h('input', {
              'data-qq-input': '', 'data-qq-mono': '', placeholder: 'QQ 号', style: { width: '130px' },
              value: newUin, onChange: (e) => setNewUin(e.target.value),
            }),
            h('input', {
              'data-qq-input': '', placeholder: '备注（主人 / 朋友）', style: { width: '150px' },
              value: newLabel, onChange: (e) => setNewLabel(e.target.value),
            }),
            h('button', {
              'data-qq-btn': '', 'data-primary': '', disabled: Boolean(busy) || !newUin,
              onClick: () => void run('fr', async () => {
                const r = await jpost('/friends', { uin: newUin, label: newLabel, enabled: true })
                setFr(r); setNewUin(''); setNewLabel(''); return r
              }, '已加入白名单'),
            }, '加进白名单'))),

        /* 运维 */
        h('div', { 'data-qq-sec': '', 'data-qq-away': away() },
          h('div', { 'data-qq-h': '' }, '看护'),
          h('div', { 'data-qq-row': '' },
            h('button', {
              'data-qq-btn': '', disabled: Boolean(busy),
              onClick: () => void run('verify', async () => {
                const r = await jpost('/verify', {})
                setReport(r.report || JSON.stringify(r, null, 2)); return r
              }, '自检跑完了'),
            }, '跑一遍自检'),
            h('button', {
              'data-qq-btn': '', disabled: Boolean(busy),
              onClick: () => void run('log', async () => {
                const r = await jget('/log?lines=60'); setTail(r.tail || ''); return r
              }),
            }, '看日志'),
            h('button', {
              'data-qq-btn': '', 'data-danger': '', disabled: Boolean(busy),
              onClick: () => {
                if (!window.confirm('重启桥会中断正在生成的那一句，确定？')) return
                void run('restart', async () => {
                  const r = await jpost('/restart', {})
                  setTimeout(() => void load(), 3000)
                  return r
                }, '已请求重启，3 秒后自动刷新')
              },
            }, '重启桥')),
          report ? h('pre', { 'data-qq-pre': '' }, report) : null,
          tail ? h('pre', { 'data-qq-pre': '' }, tail) : null),

        h(Msg, { m: msg }),

        /* 页脚 */
        h('div', { 'data-qq-kv': '' },
          `家目录：${st.home || grp?.home || ''}`,
          h('br'),
          `控制口：127.0.0.1:${bridge.control?.port ?? cfg.control?.port ?? ''}　模型：${(cfg.llm?.models || []).join(' / ')}`))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-qq-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-qq-bridge: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'qq-bridge', order: 40, label: 'QQ 小鲸鱼' },
          () => h(Panel),
        ))
      },
    }
  },
})
