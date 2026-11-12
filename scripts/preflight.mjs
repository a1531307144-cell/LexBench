// 发版前预检（2026-11-12 制定，替代「凭记忆逐步核对」）
//
// 用法：
//   npm run preflight               静态检查 + 风险分级 + 机械闸门（tsc / 单测 / 构建 / 隐私）
//   npm run preflight -- --no-gate  只做静态检查与分级建议（闸门另外单跑）
//
// 它负责回答四个问题：
//   1. 版本号三处是否一致（package.json / CHANGELOG / RELEASE_NOTES.md），远端是否已经发过
//   2. 这次改动属于什么风险等级，CDP 自测该跑哪几套、要不要做定向复核
//   3. 机械闸门是否全绿
//   4. 接下来的手工发布步骤是什么
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const runGate = !process.argv.slice(2).includes('--no-gate')
const say = (s = '') => console.log(s)
let failed = false

const fail = (msg) => {
  failed = true
  console.log(`  ✗ ${msg}`)
}
const ok = (msg) => console.log(`  ✓ ${msg}`)
const warn = (msg) => console.log(`  ! ${msg}`)

function git(cmd, { silent = false } = {}) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    if (!silent) throw e
    return ''
  }
}

const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8')
const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)

// ───────────────────────── 1. 版本与发布说明一致性 ─────────────────────────
say('\n=== 1. 版本与发布说明 ===')

const pkg = JSON.parse(read('package.json'))
const ver = pkg.version
const tag = `v${ver}`
console.log(`  当前 package.json 版本：${ver}`)

const changelog = read('CHANGELOG.md')
if (new RegExp(`^##\\s*\\[${ver.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
  ok(`CHANGELOG.md 有 [${ver}] 段`)
} else {
  fail(`CHANGELOG.md 缺少 [${ver}] 段（发版前必须补）`)
}

if (!existsSync(resolve(ROOT, 'RELEASE_NOTES.md'))) {
  fail('缺少 RELEASE_NOTES.md（发布说明的唯一来源）')
} else if (read('RELEASE_NOTES.md').includes(`v${ver}`)) {
  ok(`RELEASE_NOTES.md 版本号匹配 v${ver}`)
} else {
  fail(`RELEASE_NOTES.md 里找不到 v${ver}（很可能忘了更新）`)
}

// 本地 / 远端标签查重（防「把已发布的版本再发一遍」）
if (lines(git('tag --list')).includes(tag)) {
  fail(`本地已存在标签 ${tag}`)
} else {
  ok(`本地无标签 ${tag}`)
}

let remoteTags = null
try {
  remoteTags = git('ls-remote --tags origin')
} catch {
  warn('读不到远端标签（网络？），请手动确认没有重复发布：git ls-remote --tags origin')
}
if (remoteTags !== null) {
  if (remoteTags.includes(`refs/tags/${tag}`)) {
    fail(`远端已存在标签 ${tag} —— 这个版本已经发过了`)
  } else {
    ok(`远端无标签 ${tag}`)
  }
}

// ───────────────────────── 2. 改动面与风险分级 ─────────────────────────
say('\n=== 2. 改动面与风险分级 ===')

const lastTag = git('describe --tags --abbrev=0', { silent: true })
const changed = new Set()
if (lastTag) {
  for (const f of lines(git(`diff --name-only ${lastTag}..HEAD`, { silent: true }))) changed.add(f)
}
for (const f of lines(git('diff --name-only HEAD', { silent: true }))) changed.add(f)
for (const f of lines(git('ls-files --others --exclude-standard', { silent: true }))) changed.add(f)

const files = [...changed].map((f) => f.split('\\').join('/'))
// 风险与自测只由应用代码决定；文档 / 脚本 / 工作流改动不该触发 CDP 套件
const srcFiles = files.filter((f) => f.startsWith('src/'))
if (lastTag) console.log(`  自 ${lastTag} 以来改动 ${files.length} 个文件（其中 src/ ${srcFiles.length} 个）`)
else console.log(`  没有可用标签作基线，按工作区改动 ${files.length} 个文件（其中 src/ ${srcFiles.length} 个）`)

// 高风险：数据持久化 / 迁移 / 保存链 / 多窗并发 / 启动流程
const HIGH = [
  /^src\/main\/(db|database|migrations|backup|seed|notes|outlines|parallelViews|library|reading)\.ts$/,
  /^src\/main\/migrations\//,
  /^src\/main\/index\.ts$/,
  /^src\/shared\/(types|outlineTree|parallelLayout|noteHistory|aiPrompts|aiProtocol)\./,
  /^src\/renderer\/.*\/(OutlineEditor|OutlineTextEditor|MindMapView|ParallelWorkspace|ParallelPaneFrame|ParallelDocPane)\.vue$/
]
// 中风险：主进程 / IPC / 共享纯函数 / 跨组件状态
const MEDIUM = [
  /^src\/main\//,
  /^src\/preload\//,
  /^src\/shared\//,
  /^src\/renderer\/.*\/(composables|stores)\//
]

let tier = '低'
if (srcFiles.some((f) => HIGH.some((re) => re.test(f))) || srcFiles.length > 25) tier = '高'
else if (srcFiles.some((f) => MEDIUM.some((re) => re.test(f)))) tier = '中'

const ALL_SUITES = ['core', 'reading', 'notes', 'groups', 'ai', 'backup', 'update', 'guide', 'parallel']
const SUITE_RULES = [
  { suite: 'notes', re: /(notes|outline|MindMap)/i },
  { suite: 'parallel', re: /parallel/i },
  { suite: 'reading', re: /(reading|StatuteReading|pdf)/i },
  { suite: 'core', re: /(library|search|splitter|import|documents|articles|fts|reindex|ResultList|ImportDialog)/i },
  { suite: 'groups', re: /(groups|folders)/i },
  { suite: 'ai', re: /(src\/main\/ai|AiPanel|AiSettings|aiWindow|aiPrompts|aiProtocol)/i },
  { suite: 'backup', re: /(backup|seed)/i },
  { suite: 'update', re: /updater/i },
  { suite: 'guide', re: /(guide|GuideOverlay)/i }
]

let suites
if (srcFiles.length === 0) {
  suites = []
} else if (tier === '高') {
  suites = [...ALL_SUITES]
} else {
  suites = new Set(['core']) // core 是冒烟底线，每次必跑
  if (tier === '中') suites.add('notes') // 数据丢失高发区
  for (const f of srcFiles) {
    for (const r of SUITE_RULES) if (r.re.test(f)) suites.add(r.suite)
  }
  suites = [...ALL_SUITES].filter((s) => suites.has(s))
}

console.log(`  风险等级：${tier}`)
if (suites.length === 0) {
  console.log('  建议 CDP 自测：无应用代码改动，可跳过（只跑了文档 / 脚本 / 工作流）')
} else {
  console.log(`  建议 CDP 自测：${suites.map((s) => `selftest-${s}`).join(' + ')}`)
  if (suites.includes('guide')) console.log('  （guide 需要 LEXBENCH_FORCE_ONBOARDING=1）')
}

const REVIEW = {
  低: '可跳过独立复核（机械闸门 + 用户 dev 试用兜底）',
  中: '做一次定向复核：只看 diff 里的保存/冲刷时序、IPC 顺序、异常路径',
  高: '定向复核 + dev 实测重点项：数据丢失（save/flush/卸载顺序）、迁移与 CASCADE、多窗并发写'
}
console.log(`  复核范围：${REVIEW[tier]}`)

// ───────────────────────── 3. 机械闸门 ─────────────────────────
if (runGate) {
  say('\n=== 3. 机械闸门 ===')
  const steps = [
    ['类型检查', 'npx tsc --noEmit'],
    ['单元测试', 'npm test'],
    ['构建', 'npm run build'],
    ['隐私扫描', 'node scripts/privacy-check.mjs']
  ]
  for (const [name, cmd] of steps) {
    say(`\n▶ ${name}：${cmd}`)
    const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' })
    if (r.status !== 0) {
      fail(`${name} 失败`)
      break
    }
    ok(`${name} 通过`)
  }
} else {
  say('\n=== 3. 机械闸门（已跳过 --no-gate）===')
  say('  npx tsc --noEmit && npm test && npm run build && node scripts/privacy-check.mjs')
}

// ───────────────────────── 4. 手工发布清单 ─────────────────────────
say('\n=== 4. 发布清单 ===')
if (files.length === 0) {
  console.log('  （当前没有相对上个标签的改动，先做改动再发版）')
} else {
  say(`  1. 用户 dev 试用通过（npm run dev）——未经用户明确同意不得发布`)
  say(`  2. git add -A && git commit -m "release: ${tag}——…"`)
  say(`  3. git push origin main   →   gh run watch（等 CI 绿）`)
  say(`  4. git tag ${tag} && git push origin ${tag}`)
  say(`  5. gh run watch   →   gh release view ${tag}`)
  say(`  6. 核对附件：exe / blockmap / latest.yml / SHA256SUMS，且标记为 Latest`)
}

say('')
if (failed) {
  console.log('预检未通过：先处理上面的 ✗ 项。')
  process.exit(1)
}
console.log('预检通过。')
