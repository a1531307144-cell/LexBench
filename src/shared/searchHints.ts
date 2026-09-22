// 搜索建议池：顶栏快捷检索 / 专题内检索 / 结果页空态三处的示例文案
// 每次启动随机取样（渲染层 setup 时调一次），避免示例常年只有一组显死板

/** 顶栏快捷检索 placeholder 候选 */
export const TOPBAR_HINTS: string[] = [
  '法条定位（如：民法典 1077）或关键词检索（如：离婚 冷静期）',
  '试试：公司法 第二十三条 —— 条文直达',
  '试试：劳动争议 仲裁时效 —— 全文检索',
  '试试：生态环境法典 排污许可 —— 全文检索',
  '试试：民事诉讼法 管辖 —— 全文检索',
  '试试：民法典 合同编违约金 —— 全文检索'
]

/** 专题内中栏检索 placeholder 候选（实为全库搜索——搜到即可 ＋ 收进专题） */
export const MID_HINTS: string[] = [
  '搜全库法条：「民法典 1077」或「离婚 冷静期」',
  '搜全库：「公司法 第二十三条」直达，＋ 收进专题',
  '搜全库：「违约金调整」全文检索，＋ 收进专题',
  '搜全库：「仲裁时效」全文检索，＋ 收进专题',
  '搜全库：「管辖权异议」全文检索，＋ 收进专题'
]

/** 结果页空态「试试」行的示例对（定位例 + 全文例） */
export interface ResultHint {
  locate: string
  full: string
}

export const RESULT_HINTS: ResultHint[] = [
  { locate: '民法典 1077', full: '离婚 冷静期' },
  { locate: '公司法 第二十三条', full: '劳动争议 仲裁时效' },
  { locate: '民事诉讼法 第二十二条', full: '生态环境法典 排污许可' },
  { locate: '民法典 第一千零四十二条', full: '违约金 调整' }
]

/**
 * 从池中随机取 count 个互不相同的元素（洗牌后截取）。
 * rng 可注入以便单测确定性复现。
 */
export function pickDistinct<T>(pool: readonly T[], count: number, rng: () => number = Math.random): T[] {
  if (count <= 0 || pool.length === 0) return []
  const arr = [...pool]
  const take = Math.min(count, arr.length)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr.slice(0, take)
}
