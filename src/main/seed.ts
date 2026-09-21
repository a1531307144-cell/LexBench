// 预置法条：首次启动把随包附带的常用法律/司法解释导入资料库（「下载即用」）
// 说明：种子文件在 seed/（打包后位于 resources/seed），只含公开法条文本，且已清洗文档元数据；
//       仅在从未预置过（settings 无 seed_version）时执行一次；用户删除后不会被重新塞回。

import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
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
    let imported = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const category = entry.name
      const categoryDir = join(dir, category)
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
