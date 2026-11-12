// 发版前隐私扫描：任何命中都让脚本以退出码 1 结束。
// 接在 CI 的发布流程里 —— 扫到问题就直接构建失败，发布不出 Release。
//
// 用法：node scripts/privacy-check.mjs
//
// 注意一个悖论：不能为了「检查隐私」而把用户的真实姓名写进公开仓库，
// 所以用户专属的敏感词放在**不提交**的 scripts/.privacy-terms（每行一个，已 gitignore）。
// 只有用户本机才会跑这部分；CI 跑通用规则（手机号/邮箱/密钥/内嵌图片/本机路径）。
//
// 扫描范围（2026-11-12 加固）：
//   ① 文件内容 —— 手机号 / 邮箱 / 密钥 / base64 图片 / 本机绝对路径 / 专属敏感词
//   ② 文件路径与文件名 —— 同一套规则（防止「张三笔记.md」这种只有名字在路径上的漏网）
//   ③ 未登记的文件类型 —— 仓库里出现 .docx/.pdf/图片/压缩包等，除白名单目录外一律报警
//      （这些文件内容扫不了，只能靠「不该出现就别出现」把关）
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'release',
  'dist',
  '.vite',
  '.claude',
  'pdf-assets' // pdfjs 解码资源（postinstall 从 node_modules 生成；第三方文件里的长数字常量会误报手机号）
])
const SKIP_FILES = new Set(['package-lock.json'])
const SCAN_EXT = [
  '.ts', '.tsx', '.vue', '.mjs', '.cjs', '.js', '.json', '.yml', '.yaml',
  '.md', '.html', '.css', '.txt', '.py', '.sh', '.ps1', '.bat', '.cmd'
]

/** 内容无法扫描、也不该随意进仓库的文件类型 */
const BINARY_EXT = [
  '.docx', '.doc', '.pdf', '.xlsx', '.xls', '.pptx', '.ppt',
  '.db', '.sqlite', '.sqlite3', '.zip', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bmp'
]
/** 允许出现这些文件类型的目录（相对仓库根，正斜杠结尾）；新增前先想清楚里面会不会有用户数据 */
const BINARY_ALLOW_DIRS = [
  'seed/',             // 预置法条 docx：由 scripts/build-seed.py 生成，带泄露断言
  'docs/screenshots/', // README 用的应用截图（不含用户数据）
  'build/'             // 打包图标等构建资源
]

/**
 * 明确属于合成测试数据、可以放行的值（与用户真实信息无关）：
 * - 13900001111 / 13812345678：自测脚本与单测里编造的号码
 * - example.com / example.org：RFC 2606 保留域名，永远不会属于真实的人
 */
const ALLOW = ['13900001111', '13812345678', 'example.com', 'example.org']

const RULES = [
  { name: '手机号', re: /1[3-9]\d{9}/g },
  { name: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: '密钥/token', re: /(?:sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g },
  { name: '内嵌图片(base64)', re: /data:image\/[a-z]+;base64,[A-Za-z0-9+/]{60,}/g },
  { name: '本机绝对路径', re: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g }
]

/** 读取本机专属敏感词（不提交）；不存在时返回空数组 */
async function loadLocalTerms() {
  const file = join(ROOT, 'scripts', '.privacy-terms')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf-8')
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

const toPosix = (p) => p.split(sep).join('/')

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name), out)
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue
      out.push(join(dir, entry.name))
    }
  }
  return out
}

function isAllowed(hit) {
  return ALLOW.some((a) => hit.includes(a))
}

/** 收集一行里所有命中（正则需带 g） */
function matches(rule, text) {
  const found = []
  rule.re.lastIndex = 0
  let m
  while ((m = rule.re.exec(text)) !== null) {
    if (!isAllowed(m[0])) found.push(m[0])
    if (m[0].length === 0) break // 防空正则死循环
  }
  return found
}

const clip = (v) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)

async function main() {
  const terms = await loadLocalTerms()
  const rules = [...RULES]
  for (const t of terms) {
    // 敏感词按字面量整体匹配
    rules.push({ name: `本机敏感词「${t.slice(0, 1)}***」`, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') })
  }

  const files = await walk(ROOT)
  const hits = []
  let textFiles = 0

  for (const file of files) {
    const rel = toPosix(relative(ROOT, file))

    // ② 路径 / 文件名扫描
    for (const rule of rules) {
      for (const value of matches(rule, rel)) {
        hits.push({ file: rel, line: 0, rule: `${rule.name}（路径）`, value: clip(value) })
      }
    }

    // ③ 未登记的文件类型
    const ext = extname(rel).toLowerCase()
    if (BINARY_EXT.includes(ext) && !BINARY_ALLOW_DIRS.some((d) => rel.startsWith(d))) {
      hits.push({
        file: rel,
        line: 0,
        rule: '未登记的文件类型',
        value: `${ext} 不在白名单目录内（seed/ · docs/screenshots/ · build/）`
      })
    }

    // ① 内容扫描（只扫文本类型）
    if (!SCAN_EXT.some((e) => rel.endsWith(e))) continue
    textFiles++

    let text
    try {
      text = await readFile(file, 'utf-8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (const rule of rules) {
      for (let i = 0; i < lines.length; i++) {
        for (const value of matches(rule, lines[i])) {
          hits.push({ file: rel, line: i + 1, rule: rule.name, value: clip(value) })
        }
      }
    }
  }

  console.log(`隐私扫描：检查了 ${files.length} 个文件（其中文本 ${textFiles} 个；内容 + 路径 + 文件类型）`)
  if (terms.length === 0) {
    console.log('  （未发现 scripts/.privacy-terms，本次只跑通用规则；本机跑可补上专属敏感词）')
  }

  if (hits.length === 0) {
    console.log('通过：未发现手机号 / 邮箱 / 密钥 / 内嵌图片 / 本机路径 / 专属敏感词 / 未登记文件类型')
    return 0
  }

  console.log(`\n发现 ${hits.length} 处可疑内容：\n`)
  for (const h of hits.slice(0, 50)) {
    const where = h.line ? `${h.file}:${h.line}` : h.file
    console.log(`  [${h.rule}] ${where}  →  ${h.value}`)
  }
  if (hits.length > 50) console.log(`  …… 另有 ${hits.length - 50} 处`)
  console.log('\n发布已中止。请先处理上述内容；确属合成数据再把值加入脚本的 ALLOW 列表。')
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('隐私扫描异常:', err.message)
    process.exit(1)
  })
