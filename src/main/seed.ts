// 预置法条：首次启动把随包附带的常用法律/司法解释导入资料库（「下载即用」）
// 说明：种子文件在 seed/（打包后位于 resources/seed），只含公开法条文本，且已清洗文档元数据；
//       仅在从未预置过（settings 无 seed_version）时执行一次；用户删除后不会被重新塞回。

import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting, setSetting } from './db'
import { importFiles, markSeedApplied } from './library'

/** 预置数据版本号：将来更新种子包时递增（旧用户不会重复导入） */
const SEED_VERSION = '1'

/** 种子目录：打包版在 resources/seed；开发版在仓库根 seed/ */
function seedDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'seed')
  return join(__dirname, '../../seed')
}

/** 种子包里的分类顺序（order.json 的 statute 数组）；缺失或损坏时退回目录顺序 */
function readSeedOrder(dir: string): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const orderFile = join(dir, 'order.json')
  if (existsSync(orderFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(orderFile, 'utf-8'))
      const list = (parsed as { statute?: unknown }).statute
      if (Array.isArray(list)) {
        const valid = list.filter((x): x is string => typeof x === 'string' && names.includes(x))
        const rest = names.filter((n) => !valid.includes(n))
        return [...valid, ...rest]
      }
    } catch (e) {
      console.warn('seed/order.json 解析失败，按目录顺序预置：', e)
    }
  }
  return names
}

/**
 * 首次启动预置法条。返回本次导入成功的部数（0 表示跳过或无需预置）。
 * 失败不阻断启动：种子缺失/单个文件出错都只记日志。
 */
export async function applySeedIfNeeded(): Promise<number> {
  try {
    if (getSetting('seed_version')) return 0 // 已预置过
    const dir = seedDir()
    if (!existsSync(dir)) {
      console.warn('预置法条目录不存在，跳过：', dir)
      return 0
    }
    // 分类文件夹的展示顺序：优先按 seed/order.json（用户排定的顺序），缺省退回目录顺序
    const ordered = readSeedOrder(dir)
    let imported = 0
    for (const category of ordered) {
      const categoryDir = join(dir, category)
      if (!existsSync(categoryDir)) continue
      const files = readdirSync(categoryDir)
        .filter((f) => f.toLowerCase().endsWith('.docx'))
        .map((f) => join(categoryDir, f))
      if (files.length === 0) continue
      const results = await importFiles(files, category, 'statute')
      imported += results.filter((r) => r.status === 'imported').length
    }
    setSetting('seed_version', SEED_VERSION)
    setSetting('seed_applied_at', new Date().toISOString())
    if (imported > 0) {
      markSeedApplied(imported)
      console.log(`已预置常用法条 ${imported} 部`)
    }
    return imported
  } catch (e) {
    console.warn('预置法条失败（不影响使用）：', e)
    return 0
  }
}
