// 数据包：全量导出（数据库一致性快照 + 全部原件）与导入（校验 + 自动备份 + 覆盖换装）
// 原则：与 reading.ts / library.ts 同构但自包含；错误一律 throw new Error('中文信息')，
//       经 IPC reject 后由渲染层错误条直接展示；导入是覆盖语义（二次确认由渲染层负责），
//       换装后需重启软件生效（返回 needsRestart:true，渲染层提示后走 app:relaunch）。
// 组包：manifest.json + lexbench.db + files/（原件）；AI 配置存于 settings 表，随库快照一起带走。
// 大文件不经内存：zip 组装用 addLocalFile/addLocalFolder 直接引用磁盘文件。

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import AdmZip from 'adm-zip'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupImportOutcome } from '../shared/ipc'
import type { ExportResult } from '../shared/types'
import { closeDb, getDb, initDb } from './db'

// ---------- 内部工具 ----------

/** node:sqlite 原始行：字段值一律 unknown，经转换函数收窄成具体类型 */
type DbRow = Record<string, unknown>

/** 当前本地时间（与 DB 的 datetime('now','localtime') 同格式：YYYY-MM-DD HH:MM:SS） */
function localNow(): string {
  const row = getDb().prepare("SELECT datetime('now','localtime') AS now").get() as DbRow
  return String(row['now'])
}

/** localNow() → YYYYMMDD-HHMMSS（自动备份目录名用，可作文件名） */
function stampNow(): string {
  const digits = localNow().replace(/\D/g, '')
  return `${digits.slice(0, 8)}-${digits.slice(8)}`
}

/** 原件存储目录（userData/files；不 import db.ts 的 getFilesDir，避免共享其懒缓存语义） */
function filesDirPath(): string {
  return join(app.getPath('userData'), 'files')
}

/** app.getPath('temp') 下的一次性工作目录（用完由调用方在 finally 里清理） */
function makeTempDir(prefix: string): string {
  const dir = join(
    app.getPath('temp'),
    `lexbench-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * VACUUM INTO 一致性快照：把当前库压缩整理复制到 targetPath（目标必须不存在）。
 * 优先用绑定参数；个别 node:sqlite 版本不允许 VACUUM 绑定时退回内联路径（单引号成对转义）。
 * VACUUM INTO 自动保留 user_version，导入旧版本包后 getDb() 会按 user_version 补跑迁移。
 */
function vacuumInto(targetPath: string): void {
  if (existsSync(targetPath)) rmSync(targetPath) // VACUUM INTO 要求目标文件不存在
  const db = getDb()
  try {
    db.prepare('VACUUM INTO ?').run(targetPath)
  } catch {
    db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`)
  }
}

// ---------- 导出 ----------

/** 组包并写盘：manifest.json + lexbench.db（快照）+ files/（全部原件，流式引用不读进内存） */
function doExport(outPath: string): ExportResult {
  const tmpDir = makeTempDir('export')
  try {
    const snapshotPath = join(tmpDir, 'lexbench.db')
    vacuumInto(snapshotPath)

    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify(
          { app: 'lexbench', version: app.getVersion(), exportedAt: localNow() },
          null,
          2
        ),
        'utf8'
      )
    )
    zip.addLocalFile(snapshotPath) // 条目名 = 文件名 lexbench.db
    const filesDir = filesDirPath()
    if (existsSync(filesDir)) zip.addLocalFolder(filesDir, 'files')
    zip.writeZip(outPath)
    return { canceled: false, path: outPath }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------- 导入 ----------

/** 解包到临时目录并做静态校验：manifest 存在且 app==='lexbench'、包内库文件存在；返回包内库路径 */
function unpackAndValidate(zipPath: string, tmpDir: string): string {
  try {
    new AdmZip(zipPath).extractAllTo(tmpDir, true)
  } catch {
    throw new Error('数据包无法读取（不是有效的 zip 文件）')
  }

  // manifest.json 必须存在且归属本软件
  const manifestPath = join(tmpDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('不是本软件的数据包')
  let manifest: DbRow
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DbRow
  } catch {
    throw new Error('不是本软件的数据包')
  }
  if (manifest['app'] !== 'lexbench') throw new Error('不是本软件的数据包')

  // 包内库文件必须存在
  const dbPath = join(tmpDir, 'lexbench.db')
  if (!existsSync(dbPath)) throw new Error('数据包缺少数据库文件')
  return dbPath
}

/** 打开包内库做完整性/版本校验（开完即关：Windows 下复制前必须释放文件句柄） */
function validatePackagedDb(dbPath: string): void {
  let check: DatabaseSync | null = null
  try {
    check = new DatabaseSync(dbPath)
    const integrity = check.prepare('PRAGMA integrity_check').get() as DbRow | undefined
    if (String(integrity?.['integrity_check'] ?? '') !== 'ok') throw new Error('数据包损坏')
    const ver = check.prepare('PRAGMA user_version').get() as DbRow | undefined
    const userVersion = Number(ver?.['user_version'] ?? 0)
    if (!Number.isFinite(userVersion) || userVersion <= 0) throw new Error('数据包版本异常')
  } finally {
    if (check) {
      try {
        check.close()
      } catch {
        /* 已异常时放弃关闭 */
      }
    }
  }
}

/** 换装前自动备份当前数据：userData/backups/backup-<YYYYMMDD-HHMMSS>/（快照 + 全部原件），保证可反悔 */
function backupCurrentData(): void {
  const backupDir = join(app.getPath('userData'), 'backups', `backup-${stampNow()}`)
  rmSync(backupDir, { recursive: true, force: true }) // 同一秒内重复导入时覆盖旧备份
  mkdirSync(backupDir, { recursive: true })
  vacuumInto(join(backupDir, 'lexbench.db'))
  const filesDir = filesDirPath()
  if (existsSync(filesDir)) cpSync(filesDir, join(backupDir, 'files'), { recursive: true })
}

/** 换装：关库 → 覆盖 lexbench.db → 清空重建 files/ → 重开新库并验证能查询 documents（全程同步无 await，不给其它 handler 插队机会） */
function swapIn(packDbPath: string, tmpDir: string): void {
  closeDb()
  try {
    const dbTarget = join(app.getPath('userData'), 'lexbench.db')
    copyFileSync(packDbPath, dbTarget)
    // 旧连接的 WAL/SHM 残留文件随旧库一起作废，必须清掉
    for (const suffix of ['-wal', '-shm']) {
      const side = dbTarget + suffix
      if (existsSync(side)) rmSync(side)
    }
    // 清空并重建 files/ 后放入包内原件
    const filesDir = filesDirPath()
    rmSync(filesDir, { recursive: true, force: true })
    mkdirSync(filesDir, { recursive: true })
    const packFilesDir = join(tmpDir, 'files')
    if (existsSync(packFilesDir)) cpSync(packFilesDir, filesDir, { recursive: true })
    // 重开新库（getDb 自动按 user_version 补跑迁移），并验证能查询 documents
    getDb().prepare('SELECT id FROM documents LIMIT 1').get()
  } catch (e) {
    // 换装中途失败：连接已关，自动备份仍在 userData/backups/ 可恢复
    throw e instanceof Error ? e : new Error('导入换装失败，可从 backups 目录恢复')
  }
}

/** 完整导入流程：解包校验 → 自动备份当前数据 → 覆盖换装；成功后需重启生效 */
function doImport(zipPath: string): BackupImportOutcome {
  const tmpDir = makeTempDir('import')
  try {
    const packDbPath = unpackAndValidate(zipPath, tmpDir)
    validatePackagedDb(packDbPath)
    backupCurrentData()
    swapIn(packDbPath, tmpDir)
    return { canceled: false, needsRestart: true }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------- IPC 注册 ----------

export function registerBackupIpc(): void {
  // 启动建库/迁移（连接、迁移策略都在 ./db 内）；localNow()/VACUUM 都依赖连接
  initDb()

  // 导出数据包：保存对话框（LexBench备份_YYYY-MM-DD.zip）→ 组包写盘；取消返回 canceled:true
  ipcMain.handle('backup:exportAll', async (_e): Promise<ExportResult> => {
    const options = {
      title: '导出数据包',
      defaultPath: `LexBench备份_${localNow().slice(0, 10)}.zip`,
      filters: [{ name: '数据包', extensions: ['zip'] }]
    }
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    let outPath = result.filePath
    if (!outPath.toLowerCase().endsWith('.zip')) outPath += '.zip' // 用户手输名可能缺扩展名
    return doExport(outPath)
  })

  // 导入数据包：选择 zip → 校验 → 自动备份当前数据 → 覆盖换装；needsRestart=true 由渲染层提示重启
  ipcMain.handle('backup:importAll', async (_e): Promise<BackupImportOutcome> => {
    const options = {
      title: '选择要导入的数据包（导入将覆盖当前数据，导入前会自动备份）',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: '数据包', extensions: ['zip'] }]
    }
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, needsRestart: false }
    }
    return doImport(result.filePaths[0])
  })

  // 自测专用：跳过对话框按给定路径直接导出/导入（仅开发模式注册，通道名见 preload/index.ts）
  if (!app.isPackaged) {
    ipcMain.handle('backup:__testExport', (_e, outPath: string): ExportResult =>
      doExport(String(outPath))
    )
    ipcMain.handle(
      'backup:__testImport',
      (_e, zipPath: string): BackupImportOutcome => doImport(String(zipPath))
    )
  }
}
