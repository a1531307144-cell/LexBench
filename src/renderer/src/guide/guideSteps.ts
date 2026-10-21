/**
 * 九步「快速上手」内容与锚点。
 * 文案与 App 的编排分开：这里只描述「讲什么、指哪里」，具体切视图/开文档/建示例笔记由 App.vue 执行。
 */
export const GUIDE_KEY = 'onboarding:guide:v1'

export type GuidePlacement = 'top' | 'bottom' | 'left' | 'right'

export interface GuideStep {
  id: 'library' | 'search' | 'reading' | 'notes' | 'editor' | 'map' | 'ai' | 'data' | 'finish'
  title: string
  body: string
  /** data-guide 锚点选择器；缺省=居中完成卡 */
  target?: string
  placement?: GuidePlacement
  /** 主按钮文案（如「创建示例笔记」）；缺省用「下一步」 */
  cta?: string
  /** 高亮区可交互（点击穿透到真实界面） */
  interactive?: boolean
  /** 点击高亮目标本身即前进（配合 interactive） */
  advanceOnTargetClick?: boolean
  /** 压暗程度：0.28 适合需要看清下方内容的步骤 */
  dim?: number
}

export interface GuideStepOptions {
  hasSampleNote: boolean
  hasStatute: boolean
}

export function buildGuideSteps(opts: GuideStepOptions): GuideStep[] {
  return [
    {
      id: 'library',
      title: '文档库：法条从这里读',
      body: '左侧竖排是文档库。首次启动已预置常用法律与司法解释，也可以导入 docx、PDF 或 txt；分类文件夹和搜索都在这个面板里。',
      target: '[data-guide="rail-library"]',
      placement: 'right',
      interactive: true,
      advanceOnTargetClick: true
    },
    {
      id: 'search',
      title: '顶栏检索：一条就到位',
      body: '可以切换检索模式，输入关键词后结果会出现在浮窗里；点法条跳到原文，点段落直达阅读位置。可以直接在这里试一下。',
      target: '[data-guide="top-search"]',
      placement: 'left',
      interactive: true,
      dim: 0.28
    },
    opts.hasStatute
      ? {
          id: 'reading',
          title: '阅读法条：目录、批注与引用',
          body: '右侧目录可以跳转；顶部能缩放、标星；选中文字右键可以添加批注，或复制带《法规名》条款的引用。',
          target: '[data-guide="reading-head"]',
          placement: 'bottom',
          dim: 0.32
        }
      : {
          id: 'reading',
          title: '先导入一篇文档',
          body: '点「导入文档」把 docx、PDF 或 txt 带进来；导入后就能在文档库里打开阅读。',
          target: '[data-guide="top-import"]',
          placement: 'bottom'
        },
    {
      id: 'notes',
      title: '笔记：把研究写下来',
      body: '笔记支持分类文件夹、搜索与星标。下一步会用一篇示例笔记，演示大纲和导图怎么协同。',
      target: '[data-guide="notes-panel"]',
      placement: 'right',
      cta: opts.hasSampleNote ? '打开示例笔记' : '创建示例笔记'
    },
    {
      id: 'editor',
      title: '大纲：Enter 新行，Tab 缩进',
      body: 'Enter 新建同级，Tab 缩进；行首输入 / 或 @ 可以插入文档库里的法条引用。行悬停还有备注、待办和图片。',
      target: '[data-guide="outline-head"]',
      placement: 'bottom'
    },
    {
      id: 'map',
      title: '同一棵树，换成导图',
      body: '拖动节点改层级；右上角第二个圆钮可以选择结构与配色；右下角控制缩放，触控板双指也能缩放和平移。',
      target: '[data-guide="map-chrome"]',
      placement: 'bottom',
      dim: 0.32
    },
    {
      id: 'ai',
      title: 'AI 助手：独立窗口随问随查',
      body: '「AI 助手」会在独立窗口打开，不打断阅读。先在「AI 设置」里填接口地址、模型和密钥；密钥只保存在本机。',
      target: '[data-guide="top-ai"]',
      placement: 'bottom'
    },
    {
      id: 'data',
      title: '数据可带走',
      body: '「数据」里可以导出或导入数据包，换电脑和备份都用它。文档、笔记与配置都保存在本机，不上传云端。',
      target: '[data-guide="top-data"]',
      placement: 'bottom'
    },
    {
      id: 'finish',
      title: '快速上手完成',
      body: '示例笔记「使用指引示例」已保留在笔记库，可以随时修改或删除。以后想再看，在「关于 → 使用指引」里重新打开。'
    }
  ]
}
