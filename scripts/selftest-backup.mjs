// v0.5.0 数据包 CDP 自测：导出（zip 结构）→ 变更 → 导入（覆盖恢复语义）
// 前提：npm run dev 已启动（9222）。用法：node scripts/selftest-backup.mjs
// 注意：导入会把库恢复到「导出时刻」的快照（当前数据先自动备份到 backups/），这是被测语义本身。
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const AdmZip = require_('adm-zip')

const errors = []
const tmp = mkdtempSync(join(tmpdir(), 'lexbench-backup-'))
const zipPath = join(tmp, 'selftest-backup.zip').replace(/\//g, '\\')
const markerPath = join(tmp, '迁移标记文档.txt').replace(/\//g, '\\')
writeFileSync(markerPath, '这是数据包自测的标记文档，导入恢复后应当消失。', 'utf-8')

const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
const page = pages.find((p) => p.type === 'page' && /localhost:5173/.test(p.url))
if (!page) {
  console.log('FAIL: dev 未启动')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 1200))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('CONSOLE-ERROR: ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 1200))
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    // Vue 警告（如 beforeUnmount 钩子异常）会让界面状态卡死却是 warning，必须当失败对待
    const text = m.params.args.map((a) => a.value || a.description || '').join(' ')
    if (text.includes('[Vue warn]')) errors.push('VUE-WARN: ' + text.slice(0, 1200))
  }
}
await new Promise((r) => (ws.onopen = r))
await send('Runtime.enable', {})

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || String(r.exceptionDetails) }
  return r.result.value
}
const api = (call) => evalJs(`window.lexbench.${call}`)

let mounted = false
for (let i = 0; i < 20; i++) {
  if ((await evalJs(`!!document.querySelector('#app .topbar')`)) === true) { mounted = true; break }
  await new Promise((r) => setTimeout(r, 500))
}
if (!mounted) {
  console.log('FAIL: 应用未挂载')
  process.exit(1)
}
console.log('=== 1. UI 挂载 OK ===')

const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log((ok ? '✅' : '❌'), name)
}

// 2. 导出数据包（走 __testExport 通道，跳过对话框）
const before = await api('library.listDocuments()')
const exported = await api(`backup.__testExport(${JSON.stringify(zipPath)})`)
check('导出成功（文件非空）', exported?.path === zipPath && statSync(zipPath).size > 1000)

// zip 结构：manifest + 数据库 + files/
let zipProbe = { manifest: '', entries: [] }
try {
  const zip = new AdmZip(zipPath)
  zipProbe.entries = zip.getEntries().map((e) => e.entryName)
  zipProbe.manifest = zip.readAsText('manifest.json')
} catch { /* 断言兜底 */ }
const manifestOk = (() => {
  try { return JSON.parse(zipProbe.manifest).app === 'lexbench' } catch { return false }
})()
check(
  '包结构完整（manifest + lexbench.db + files/）',
  manifestOk && zipProbe.entries.includes('lexbench.db') && zipProbe.entries.some((e) => e.startsWith('files/'))
)

// 3. 制造「导出之后」的变更：再导入一份标记文档
const marker = await api(`library.importDocuments([${JSON.stringify(markerPath)}], '', 'other')`)
check('标记文档已导入（制造待恢复差异）', marker?.[0]?.status === 'imported')
const withMarker = await api('library.listDocuments()')
check('变更生效（数量 +1）', withMarker?.length === (before?.length ?? 0) + 1)

// 4. 导入数据包 → 库恢复到导出时刻（标记文档消失）
const imported = await api(`backup.__testImport(${JSON.stringify(zipPath)})`)
check('导入完成（needsRestart=true）', imported?.needsRestart === true && imported.canceled === false)
const restored = await api('library.listDocuments()')
check('覆盖恢复语义（回到导出时刻）', restored?.length === before?.length && !restored.some((d) => d.title.includes('迁移标记文档')))

// 5. 恢复后的库仍可用（新写入正常）
const readd = await api(`library.importDocuments([${JSON.stringify(markerPath)}], '', 'other')`)
check('恢复后的库可继续使用', readd?.[0]?.status === 'imported')
await api(`library.deleteDocument(${readd?.[0]?.document_id})`)

rmSync(tmp, { recursive: true, force: true })

console.log('\n=== 结论 ===')
let pass = true
for (const [, ok] of results) if (!ok) pass = false
if (errors.length) {
  pass = false
  console.log('\n控制台错误:\n' + errors.join('\n'))
} else {
  console.log('零控制台错误')
}
console.log('（当前库已恢复到导出时刻；导入前的实时数据自动备份在 userData/backups/ 下）')
process.exit(pass ? 0 : 1)
