import { describe, expect, it } from 'vitest'
import {
  collapseByLevel,
  cloneSubtree,
  collectOutlineImages,
  createOutlineNode,
  expandAncestors,
  findNode,
  flattenOutline,
  indentNode,
  insertAfter,
  insertChild,
  mergeOutlineNode,
  moveNodeDown,
  moveNodeUp,
  moveNodesRelative,
  moveNodesTo,
  nodeImages,
  normalizeOutlineTree,
  outdentNode,
  rangeNodeIds,
  sameOutlineTree,
  splitOutlineNode,
  stableStringify,
  visibleNodeIds
} from './outlineTree'
import type { OutlineNode } from './types'

function n(id: string, text = id, children: OutlineNode[] = []): OutlineNode {
  return { id, text, children }
}

function sample(): OutlineNode[] {
  return [n('a', 'A', [n('a1', 'A1'), n('a2', 'A2', [n('a2x', 'A2x')])]), n('b', 'B'), n('c', 'C')]
}

describe('outlineTree 基础查询', () => {
  it('flatten 折叠后带隐藏计数', () => {
    const tree = sample()
    tree[0]!.fold = true
    const flat = flattenOutline(tree)
    expect(flat.map((r) => r.node.id)).toEqual(['a', 'b', 'c'])
    expect(flat[0]!.hidden).toBe(3)
    expect(flattenOutline(tree, 0, false).map((r) => r.node.id)).toEqual([
      'a',
      'a1',
      'a2',
      'a2x',
      'b',
      'c'
    ])
  })

  it('findNode 返回父子与下标', () => {
    const hit = findNode(sample(), 'a2x')
    expect(hit?.parent?.id).toBe('a2')
    expect(hit?.depth).toBe(2)
    expect(hit?.index).toBe(0)
  })

  it('rangeNodeIds 按可视顺序取闭区间', () => {
    const tree = sample()
    expect(rangeNodeIds(tree, 'b', 'a1')).toEqual(['a1', 'a2', 'a2x', 'b'])
    expect(visibleNodeIds(tree)).toEqual(['a', 'a1', 'a2', 'a2x', 'b', 'c'])
  })
})

describe('outlineTree 结构操作', () => {
  it('indent/outdent 子树跟随', () => {
    const tree = sample()
    expect(indentNode(tree, 'b')).toBe(true)
    expect(findNode(tree, 'b')?.parent?.id).toBe('a')
    expect(flattenOutline(tree).map((r) => r.node.id)).toEqual(['a', 'a1', 'a2', 'a2x', 'b', 'c'])
    expect(outdentNode(tree, 'b')).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('上移/下移不越界', () => {
    const tree = sample()
    expect(moveNodeUp(tree, 'a')).toBe(false)
    expect(moveNodeUp(tree, 'b')).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['b', 'a', 'c'])
    expect(moveNodeDown(tree, 'a')).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['b', 'c', 'a'])
    expect(moveNodeDown(tree, 'a')).toBe(false)
  })

  it('split 保留标题/任务并新建同级', () => {
    const tree = [Object.assign(n('a', '内容'), { heading: 2 as const, task: 1 as const })]
    const created = splitOutlineNode(tree, 'a', { beforeText: '内', afterText: '容' })
    expect(created?.text).toBe('容')
    expect(created?.heading).toBe(2)
    expect(created?.task).toBe(1)
    expect(tree.map((x) => x.text)).toEqual(['内', '容'])
  })

  it('merge 并入上一可视行（含父级）并把子树带过去', () => {
    const tree = sample()
    const r = mergeOutlineNode(tree, 'a1')
    expect(r?.node.id).toBe('a')
    expect(r?.offset).toBe(1)
    expect(r?.node.text).toBe('AA1')
    // 首个子行并入父行后，其子树顶替原位置
    const tree2 = sample()
    const r2 = mergeOutlineNode(tree2, 'a2x')
    expect(r2?.node.id).toBe('a2')
    expect(r2?.node.text).toBe('A2A2x')
  })

  it('insertChild / insertAfter 会展开父级', () => {
    const tree = sample()
    tree[0]!.fold = true
    expect(insertChild(tree, 'a', n('x', 'X'))).toBe(true)
    expect(tree[0]!.fold).toBe(false)
    expect(tree[0]!.children.at(-1)?.id).toBe('x')
    expect(insertAfter(tree, 'b', n('y', 'Y'))).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['a', 'b', 'y', 'c'])
  })
})

describe('outlineTree 拖拽块移动', () => {
  it('放到目标子级末尾', () => {
    const tree = sample()
    expect(moveNodesRelative(tree, ['b'], 'a1', 'child')).toBe(true)
    expect(findNode(tree, 'b')?.parent?.id).toBe('a1')
  })

  it('放到目标前/后（同级）', () => {
    const tree = sample()
    expect(moveNodesRelative(tree, ['c'], 'a', 'before')).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(moveNodesRelative(tree, ['c'], 'b', 'after')).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('多节点保持顺序，且拒绝拖进自己的子树', () => {
    const tree = sample()
    expect(moveNodesRelative(tree, ['b', 'c'], 'a', 'child')).toBe(true)
    expect(tree[0]!.children.map((x) => x.id)).toEqual(['a1', 'a2', 'b', 'c'])
    expect(moveNodesRelative(tree, ['a'], 'a2x', 'child')).toBe(false)
    expect(moveNodesRelative(tree, ['a2'], 'a2x', 'child')).toBe(false)
  })

  it('moveNodesTo 下标按移除后的兄弟计算', () => {
    const tree = sample()
    expect(moveNodesTo(tree, ['a1'], null, 3)).toBe(true)
    expect(tree.map((x) => x.id)).toEqual(['a', 'b', 'c', 'a1'])
    const tree2 = sample()
    expect(moveNodesTo(tree2, ['a'], 'a2', 0)).toBe(false)
  })

  it('块根去重：父子同时在选择里只搬祖先', () => {
    const tree = sample()
    expect(moveNodesRelative(tree, ['a', 'a1'], 'b', 'child')).toBe(true)
    expect(tree.find((x) => x.id === 'b')?.children.map((x) => x.id)).toEqual(['a'])
    expect(findNode(tree, 'a')?.node.children.map((x) => x.id)).toEqual(['a1', 'a2'])
  })
})

describe('outlineTree 折叠与归一化', () => {
  it('collapseByLevel', () => {
    const tree = sample()
    collapseByLevel(tree, 2)
    expect(tree[0]!.fold).toBeFalsy()
    expect(findNode(tree, 'a2')?.node.fold).toBe(true)
    collapseByLevel(tree, 1)
    expect(tree[0]!.fold).toBe(true)
  })

  it('expandAncestors 清掉祖先折叠', () => {
    const tree = sample()
    tree[0]!.fold = true
    findNode(tree, 'a2')!.node.fold = true
    expandAncestors(tree, 'a2x')
    expect(tree[0]!.fold).toBeUndefined()
    expect(findNode(tree, 'a2')?.node.fold).toBeUndefined()
  })

  it('normalize 修复缺字段与重复 id，并补 images', () => {
    let i = 0
    const tree = normalizeOutlineTree(
      [
        { id: 'x', text: 'X', children: [{ text: '子', image: 'a.png' }] },
        { id: 'x', text: '重复', children: 'bad' }
      ],
      () => `g${++i}`
    )
    expect(tree).toHaveLength(2)
    expect(tree[0]!.children[0]!.id).toBe('g1')
    expect(tree[0]!.children[0]!.images).toEqual(['a.png'])
    expect(tree[1]!.id).toBe('g2')
    expect(tree[1]!.children).toEqual([])
  })

  it('cloneSubtree 重新生成 id 且保留元数据', () => {
    let i = 0
    const src = createOutlineNode('A', {
      heading: 1,
      task: 2,
      note: '备注',
      images: ['a.png'],
      html: '<b>A</b>',
      children: [n('c', 'C')]
    })
    const copy = cloneSubtree(src, () => `k${++i}`)
    expect(copy.id).toBe('k1')
    expect(copy.children[0]!.id).toBe('k2')
    expect(copy.heading).toBe(1)
    expect(copy.task).toBe(2)
    expect(copy.note).toBe('备注')
    expect(copy.images).toEqual(['a.png'])
    expect(copy.html).toBe('<b>A</b>')
  })

  it('图片收集兼容旧 image 字段', () => {
    const tree = sample()
    findNode(tree, 'a')!.node.image = 'old.png'
    findNode(tree, 'a1')!.node.images = ['new1.png', 'new2.png']
    expect(nodeImages(findNode(tree, 'a')!.node)).toEqual(['old.png'])
    expect(collectOutlineImages(tree).sort()).toEqual(['new1.png', 'new2.png', 'old.png'])
  })
})

describe('大纲树比较与稳定序列化', () => {
  it('stableStringify 与对象键插入顺序无关', () => {
    const a = { id: 'x', text: 'T', note: 'N', children: [{ id: 'y', text: 'Y', children: [] }] }
    const b = { children: [{ children: [], text: 'Y', id: 'y' }], note: 'N', text: 'T', id: 'x' }
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(stableStringify(a)).not.toBe(stableStringify({ ...a, text: 'U' }))
  })

  it('sameOutlineTree 覆盖全部持久化字段并递归', () => {
    const a = normalizeOutlineTree([
      { id: 'a', text: 'A', children: [{ id: 'b', text: 'B', children: [] }] }
    ])
    const b = normalizeOutlineTree([
      { id: 'a', text: 'A', children: [{ id: 'b', text: 'B', children: [] }] }
    ])
    expect(sameOutlineTree(a, b)).toBe(true)
    b[0]!.children[0]!.note = '备注'
    expect(sameOutlineTree(a, b)).toBe(false)
    b[0]!.children[0]!.note = undefined
    b[0]!.children[0]!.images = ['x.png']
    expect(sameOutlineTree(a, b)).toBe(false)
  })

  it('sameOutlineTree 把缺省备注/图片与空串视为等价', () => {
    const a: OutlineNode[] = [{ id: 'a', text: 'A', children: [] }]
    const b: OutlineNode[] = [{ id: 'a', text: 'A', children: [], note: '', image: '' }]
    expect(sameOutlineTree(a, b)).toBe(true)
  })

  it('normalize 丢弃旧 ref 元数据', () => {
    const tree = normalizeOutlineTree([
      { id: 'a', text: '《民法典》第一条', children: [], ref: { docId: 1, articleId: 2 } }
    ])
    expect('ref' in tree[0]!).toBe(false)
  })

  it('expandAncestors 返回是否真的改了折叠态', () => {
    const tree = sample()
    expect(expandAncestors(tree, 'a2x')).toBe(false)
    findNode(tree, 'a')!.node.fold = true
    findNode(tree, 'a2')!.node.fold = true
    expect(expandAncestors(tree, 'a2x')).toBe(true)
    expect(expandAncestors(tree, 'a2x')).toBe(false)
  })
})
