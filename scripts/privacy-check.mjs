// 发版前隐私扫描：任何命中都让脚本以退出码 1 结束。
// 接在 CI 的发布流程里 —— 扫到问题就直接构建失败，发布不出 Release。
//
// 用法：node scripts/privacy-check.mjs
//
// 注意一个悖论：不能为了「检查隐私」而把用户的真实姓名写进公开仓库，
// 所以用户专属的敏感词放在**不提交**的 scripts/.privacy-terms（每行一个，已 gitignore）。
// 只有用户本机才会跑这部分；CI 跑通用规则（手机号/邮箱/密钥/内嵌图片/本机路径）。
//
// 扫描范围（2026-11-18 加固）：
//   ① 文件内容 —— 手机号 / 身份证号 / 邮箱 / 密钥 / base64 图片 / 任意盘符本机路径 / 专属敏感词
//   ② 文件路径与文件名 —— 同一套规则（防止「张三笔记.md」这种只有名字在路径上的漏网）
//   ③ 未登记的文件类型 —— 仓库里出现 .docx/.pdf/图片/压缩包等，除白名单目录外一律报警
//   ④ 无后缀 / 点文件 —— .env、.npmrc、id_rsa 这类同样按文本扫描（此前完全漏扫）
//   ⑤ Office 文档内部 —— .docx/.xlsx/.pptx 的 XML 部件也要扫
//      （模板路径会把用户名与本机绝对路径一起带进发布包，而文件类型白名单放行后毫无察觉）
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import AdmZip from 'adm-zip'

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
/** 按相对路径跳过：本机敏感词表本身含有真实姓名，绝不能反过来把它自己报出来 */
const SKIP_PATHS = new Set(['scripts/.privacy-terms'])
const SCAN_EXT = [
  '.ts', '.tsx', '.vue', '.mjs', '.cjs', '.js', '.json', '.yml', '.yaml',
  '.md', '.html', '.css', '.txt', '.py', '.sh', '.ps1', '.bat', '.cmd'
]
/** 需要拆开扫 XML 部件的 Office 格式（OOXML = zip） */
const OFFICE_ZIP_EXT = ['.docx', '.xlsx', '.pptx']

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
const ALLOW = [
  '13900001111',
  '13812345678',
  'example.com',
  'example.org',
  // 自测脚本用的共享目录（Windows 的 Public 不属于任何个人）
  'Users\\\\Public',
  'Users/Public'
]

const RULES = [
  { name: '手机号', re: /1[3-9]\d{9}/g },
  // 18 位身份证：出生日期段校验，结尾可为 X；前后不能紧邻数字
  {
    name: '身份证号',
    re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g
  },
  { name: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: '密钥/token', re: /(?:sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g },
  { name: '内嵌图片(base64)', re: /data:image\/[a-z]+;base64,[A-Za-z0-9+/]{60,}/g },
  // 任意盘符的本机路径（原来只认 Users 目录的 C 盘路径，其它盘符与转义形式全漏），
  // 前面的字符类用于排除 URL 的协议前缀
  {
    name: '本机绝对路径',
    re: /(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]{1,2}[^\s"'<>|*?]{1,}/g
  }
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
  if (ALLOW.some((a) => hit.includes(a))) return true
  // Windows 共享目录不属于任何个人；源码里可能写成多重转义
  return /Users\\+Public|Users\/Public/.test(hit)
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

/** 可能是文本的文件：已知扩展名 / 无扩展名 / 点文件（.env、.npmrc、id_rsa） */
function isTextCandidate(rel) {
  const ext = extname(rel).toLowerCase()
  if (SCAN_EXT.includes(ext)) return true
  if (!ext) return true
  return basename(rel).startsWith('.')
}

/** Office（OOXML）内部 XML 部件扫描：模板路径 / 用户名常藏在这里 */
function scanOfficeZip(file, rel, rules) {
  const out = []
  let zip
  try {
    zip = new AdmZip(file)
  } catch {
    return out
  }
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (!/\.(xml|rels)$/i.test(entry.entryName)) continue
    let text
    try {
      text = entry.getData().toString('utf8')
    } catch {
      continue
    }
    for (const rule of rules) {
      for (const value of matches(rule, text)) {
        out.push({
          file: `${rel}#${entry.entryName}`,
          line: 0,
          rule: `${rule.name}（文档内）`,
          value: clip(value)
        })
      }
    }
  }
  return out
}

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
    if (SKIP_PATHS.has(rel)) continue

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

    // ⑤ Office 文档内部（白名单目录也要扫内容）
    if (OFFICE_ZIP_EXT.includes(ext)) {
      textFiles++
      hits.push(...scanOfficeZip(file, rel, rules))
      continue
    }

    // ①④ 内容扫描：已知文本后缀 + 无后缀/点文件（.env、.npmrc、id_rsa）
    if (!isTextCandidate(rel)) continue
    let buf
    try {
      buf = await readFile(file)
    } catch {
      continue
    }
    // 无后缀文件可能是二进制：前 8KB 出现 NUL 就当二进制跳过
    if (buf.subarray(0, 8000).includes(0)) continue
    textFiles++

    const text = buf.toString('utf8')
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
