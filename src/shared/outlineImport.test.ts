import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  parseHtmlOutline,
  parseMarkdownOutline,
  parseOpml,
  parseImportedFile,
  sniffFormat,
  toOutlineNodes
} from './outlineImport'

let seq = 0
const genId = (): string => `t${++seq}`

describe('decodeEntities', () => {
  it('命名/十进制/十六进制实体', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#65;&#x42;')).toBe('a & b <c> "d" AB')
  })
})

describe('sniffFormat', () => {
  it('扩展名优先', () => {
    expect(sniffFormat('a.opml', '')).toBe('opml')
    expect(sniffFormat('a.HTML', '')).toBe('html')
    expect(sniffFormat('a.md', '')).toBe('md')
  })
  it('无扩展名看内容头', () => {
    expect(sniffFormat('x', '<?xml version="1.0"?><opml version="2.0">')).toBe('opml')
    expect(sniffFormat('x', '<ul class="node-list"><li>a</li></ul>')).toBe('html')
    expect(sniffFormat('x', '# 标题\n- 一项')).toBe('md')
  })
  it('无法识别返回 null', () => {
    expect(sniffFormat('x', '随便一段没有结构的文本')).toBeNull()
  })
})

describe('parseOpml', () => {
  const xml = `<?xml version="1.0"?>
<opml version="2.0"><head><title>合同研究</title></head><body>
  <outline text="第一编 通则">
    <outline text="违约金性质" _note="以补偿为主" _complete="false"/>
    <outline text="法条引用" _complete="true"/>
  </outline>
  <outline text="第二编"/>
</body></opml>`
  it('head title + 嵌套层级 + _note 子节点 + 任务前缀', () => {
    const doc = parseOpml(xml, 'fallback')
    expect(doc.title).toBe('合同研究')
    expect(doc.nodes.length).toBe(2)
    expect(doc.nodes[0].text).toBe('第一编 通则')
    expect(doc.nodes[0].children.length).toBe(2)
    // _complete 属性存在即任务节点：false → [ ]（未完成），true → [✓]
    expect(doc.nodes[0].children[0].text).toBe('[ ] 违约金性质')
    expect(doc.nodes[0].children[0].children[0].text).toBe('以补偿为主')
    expect(doc.nodes[0].children[1].text).toBe('[✓] 法条引用')
    expect(doc.nodes[1].text).toBe('第二编')
  })
  it('实体解码与自闭合混排', () => {
    const doc = parseOpml('<opml><body><outline text="A &amp; B"><outline text="C"/></outline></body></opml>', 'fb')
    expect(doc.nodes[0].text).toBe('A & B')
    expect(doc.nodes[0].children[0].text).toBe('C')
  })
})

describe('parseHtmlOutline', () => {
  it('通用 ul/li 嵌套（不依赖 class）+ 图片抽取 + 实体', () => {
    const html = `<html><head><title>劳动争议要点</title></head><body>
      <ul><li>总论
        <ul><li>构成要件 &amp; 举证</li><li><img src="https://example.com/a.png"/>配图节点</li></ul>
      </li><li>实务</li></ul></body></html>`
    const doc = parseHtmlOutline(html, 'fb')
    expect(doc.title).toBe('劳动争议要点')
    expect(doc.nodes.length).toBe(2)
    expect(doc.nodes[0].text).toBe('总论')
    expect(doc.nodes[0].children[0].text).toBe('构成要件 & 举证')
    expect(doc.nodes[0].children[1].images).toEqual(['https://example.com/a.png'])
    expect(doc.imageCount).toBe(1)
  })
  it('无列表时段落拍平降级', () => {
    const doc = parseHtmlOutline('<body><p>甲</p><p>乙</p></body>', 'fb')
    expect(doc.nodes.map((n) => n.text)).toEqual(['甲', '乙'])
  })
  it('li 只有子列表时不产生空壳节点', () => {
    const doc = parseHtmlOutline('<ul><li><ul><li>子一</li></ul></li></ul>', 'fb')
    expect(doc.nodes.length).toBe(1)
    expect(doc.nodes[0].text).toBe('子一')
  })
})

describe('parseMarkdownOutline', () => {
  it('缩进层级 + 任务降级 + 标题加粗', () => {
    const md = `# 研究总纲
- 一级甲
  - 二级甲
- [x] 已完成项
- [ ] 待办项`
    const doc = parseMarkdownOutline(md, 'fb')
    expect(doc.title).toBe('研究总纲')
    expect(doc.nodes[0].text).toBe('**研究总纲**')
    expect(doc.nodes[1].text).toBe('一级甲')
    expect(doc.nodes[1].children[0].text).toBe('二级甲')
    expect(doc.nodes[2].text).toBe('[✓] 已完成项')
    expect(doc.nodes[3].text).toBe('[ ] 待办项')
  })
  it('图片抽出并保留其余文本', () => {
    const doc = parseMarkdownOutline('- 说明 ![示意图](https://example.com/b.jpg) 结尾', 'fb')
    expect(doc.nodes[0].images).toEqual(['https://example.com/b.jpg'])
    expect(doc.nodes[0].text).toBe('说明 结尾')
    expect(doc.imageCount).toBe(1)
  })
})

describe('parseImportedFile + toOutlineNodes', () => {
  it('统一入口按嗅探分发', () => {
    expect(parseImportedFile('a.opml', '<opml><body><outline text="X"/></body></opml>', genId).format).toBe('opml')
    expect(() => parseImportedFile('x', '无结构文本', genId)).toThrow(/不支持的格式/)
  })
  it('首图挂 image、余图转文本；空节点清理', () => {
    const nodes = toOutlineNodes(
      [
        {
          text: '双图节点',
          children: [],
          images: ['https://example.com/1.png', 'https://example.com/2.png']
        },
        { text: '', children: [], images: [] },
        { text: '', children: [{ text: '有子的空壳', children: [], images: [] }], images: [] }
      ],
      genId
    )
    expect(nodes.length).toBe(2)
    expect(nodes[0].image).toBe('https://example.com/1.png')
    expect(nodes[0].text).toContain('https://example.com/2.png')
    expect(nodes[1].text).toBe('')
    expect(nodes[1].children[0].text).toBe('有子的空壳')
  })
})
