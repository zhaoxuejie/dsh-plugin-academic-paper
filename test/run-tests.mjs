// dsh-plugin-academic-paper 测试套件
// 用法：node test/run-tests.mjs
// 覆盖：
//   单测（无网络）：XML 解析 / 引用格式 / 期刊解析 / 文献库去重与导出 / paperId 解析
//                 配置归一化 / arXiv 查询构造 / 限流防护（请求闸、冷却、退避、single-flight）
//   集成冒烟（有网络）：arXiv 搜索与详情 / Semantic Scholar 搜索与详情（429 或冷却时自动跳过，不失败）
// 断言用 node:assert，用例失败 exit 1。

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = await import('../lib/index.js')

const {
  parseXml,
  findChild,
  findAllChildren,
  textOfCollapsed,
  formatCitation,
  formatGbT7714,
  formatApa,
  formatBibtex,
  bibtexKey,
  splitName,
  escapeLatex,
  parseJournalRef,
  AcademicStore,
  AcademicSourceError,
  cacheKeyOf,
  buildFilter,
  buildArxivQuery,
  normalizeKeyword,
  searchArxiv,
  arxivDetail,
  searchSemanticScholar,
  semanticScholarDetail,
  resolveConfig,
  gateFor,
  cooldownGuard,
  resetCooldown,
  setCooldown,
  upstreamOf,
  retryWaitOf,
} = plugin

/* ------------------------------------------------------------------ */
/* XML 解析                                                            */
/* ------------------------------------------------------------------ */

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: all:"attention is all you need"</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <updated>2017-12-06T13:18:07Z</updated>
    <published>2017-06-12T00:00:00Z</published>
    <title>Attention Is All You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or\nconvolutional neural networks. &lt;i&gt;italic&lt;/i&gt; &amp; entities &#8212; test.  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
    <link href="http://arxiv.org/abs/1706.03762v5" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v5" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" xmlns:atom="http://www.w3.org/2005/Atom"/>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">Accepted at NeurIPS 2017</arxiv:comment>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.48550/arXiv.1706.03762</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">NeurIPS 2017</arxiv:journal_ref>
  </entry>
</feed>`

describe('XML 解析器', () => {
  test('解析 Atom feed 结构', () => {
    const root = parseXml(SAMPLE_FEED)
    assert.equal(root.tag, '')
    assert.equal(root.children.length, 1) // 伪根下只有一个 <feed> 文档元素
    const feed = root.children[0]
    assert.equal(feed.tag, 'feed')
    const entries = findAllChildren(feed, 'entry')
    assert.equal(entries.length, 1)
    const entry = entries[0]
    assert.equal(textOfCollapsed(findChild(entry, 'id')), 'http://arxiv.org/abs/1706.03762v5')
    assert.equal(textOfCollapsed(findChild(entry, 'title')), 'Attention Is All You Need')
    assert.equal(findAllChildren(entry, 'author').length, 3)
  })

  test('实体转义与空白折叠', () => {
    const root = parseXml(SAMPLE_FEED)
    const entry = findAllChildren(root.children[0], 'entry')[0]
    const summary = textOfCollapsed(findChild(entry, 'summary'))
    assert.ok(summary.includes('<i>italic</i>'))
    assert.ok(summary.includes('& entities — test'))
  })

  test('命名空间标签 arxiv:doi 与属性解析', () => {
    const root = parseXml(SAMPLE_FEED)
    const entry = findAllChildren(root.children[0], 'entry')[0]
    assert.equal(textOfCollapsed(findChild(entry, 'arxiv:doi')), '10.48550/arXiv.1706.03762')
    const links = entry.children.filter((child) => child.tag === 'link')
    const alternate = links.find((link) => link.attrs.rel === 'alternate')
    assert.equal(alternate.attrs.href, 'http://arxiv.org/abs/1706.03762v5')
  })

  test('CDATA 保留原始内容', () => {
    const root = parseXml('<root><a><![CDATA[<b>raw & text</b>]]></a></root>')
    assert.equal(textOfCollapsed(findChild(root.children[0], 'a')), '<b>raw & text</b>')
  })

  test('未闭合标签抛错', () => {
    assert.throws(() => parseXml('<feed><entry></feed>'))
    assert.throws(() => parseXml('<feed><entry>'))
  })

  test('自闭合标签', () => {
    const root = parseXml('<feed><link href="x"/><link href="y"/></feed>')
    assert.equal(findAllChildren(root.children[0], 'link').length, 2)
  })
})

/* ------------------------------------------------------------------ */
/* 引用格式                                                            */
/* ------------------------------------------------------------------ */

const VASWANI = {
  id: 'arxiv:1706.03762',
  source: 'arxiv',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Łukasz Kaiser', 'Illia Polosukhin'],
  abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
  year: 2017,
  doi: '10.48550/arXiv.1706.03762',
  arxivId: '1706.03762',
  journal: 'NeurIPS 2017',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
  officialUrl: 'https://arxiv.org/abs/1706.03762',
}

const PAPER_NO_META = {
  id: 'arxiv:9999.00001',
  source: 'arxiv',
  title: 'A Paper Without Metadata',
  authors: [],
  abstract: '',
  year: 0,
}

describe('引用格式', () => {
  test('GB/T 7714：期刊条目（>3 作者取前 3 + 等）', () => {
    const out = formatGbT7714(VASWANI, '2026-09-06')
    assert.ok(out.startsWith('Vaswani A, Shazeer N, Parmar N, 等. Attention Is All You Need[J]. NeurIPS 2017, 2017.'))
    assert.ok(out.includes('DOI: 10.48550/arXiv.1706.03762'))
  })

  test('GB/T 7714：无期刊退化为电子文献 [EB/OL]', () => {
    const paper = { ...VASWANI, journal: undefined }
    const out = formatGbT7714(paper, '2026-09-06')
    assert.ok(out.includes('[EB/OL]. (2017)[2026-09-06].'))
    assert.ok(out.includes('https://arxiv.org/abs/1706.03762'))
  })

  test('GB/T 7714：中文姓名不拆分、缺元数据兜底', () => {
    const paper = { ...PAPER_NO_META, authors: ['张三', '李四'], year: 2020 }
    const out = formatGbT7714(paper)
    assert.ok(out.startsWith('张三, 李四.'))
    assert.ok(out.includes('[EB/OL]. (2020)'))
  })

  test('APA：作者 ≤20 全列 & 连接', () => {
    const out = formatApa({ ...VASWANI, journal: undefined })
    assert.ok(out.startsWith('Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł., & Polosukhin, I. (2017).'))
    assert.ok(out.includes('arXiv preprint arXiv:1706.03762'))
    assert.ok(out.includes('https://doi.org/10.48550/arXiv.1706.03762'))
  })

  test('APA：无作者无年份', () => {
    const out = formatApa(PAPER_NO_META)
    assert.ok(out.includes('(n.d.)'))
  })

  test('BibTeX：key 生成与字段', () => {
    assert.equal(bibtexKey(VASWANI), 'vaswani2017attention')
    const out = formatBibtex(VASWANI)
    assert.ok(out.startsWith('@article{vaswani2017attention,'))
    assert.ok(out.includes('author = {Vaswani, Ashish and Shazeer, Noam'))
    assert.ok(out.includes('eprint = 1706.03762'))
    assert.ok(out.includes('archivePrefix = {arXiv}'))
    assert.ok(out.includes('doi = 10.48550/arXiv.1706.03762'))
  })

  test('BibTeX：LaTeX 特殊字符转义', () => {
    assert.equal(escapeLatex('A&B #1_{x}'), 'A\\&B \\#1\\_\\{x\\}')
  })

  test('BibTeX：数字开头的 key 自动加前缀', () => {
    const paper = { ...PAPER_NO_META, title: '3D Point Clouds', authors: ['2pac'], year: 2021 }
    assert.match(bibtexKey(paper), /^p[a-z0-9]+$/)
  })

  test('formatCitation 统一入口 + 缺元数据回退', () => {
    assert.ok(formatCitation(VASWANI, 'gb_t_7714').includes('[J]'))
    assert.ok(formatCitation(VASWANI, 'apa').startsWith('Vaswani'))
    assert.ok(formatCitation(VASWANI, 'bibtex').startsWith('@article'))
    const broken = { id: 'x', source: 'arxiv', title: '', authors: [], abstract: '', year: 0 }
    // 无任何元数据 → 电子文献格式 + 占位，不抛错
    const out = formatCitation(broken, 'gb_t_7714')
    assert.ok(out.includes('[佚名]'))
    assert.ok(out.includes('[EB/OL]'))
  })

  test('splitName 处理 "Family, Given" 与 "Given Family"', () => {
    assert.deepEqual(splitName('Vaswani, Ashish'), { surname: 'Vaswani', given: 'Ashish' })
    assert.deepEqual(splitName('Ashish Vaswani'), { surname: 'Vaswani', given: 'Ashish' })
    assert.deepEqual(splitName('张三'), { surname: '张三', given: '' })
  })

  test('parseJournalRef：arXiv journal_ref 结构化，年份取刊年', () => {
    const parsed = parseJournalRef('Physical Review Research vol. 4, no. 2, page 023066, April 2022')
    assert.equal(parsed.name, 'Physical Review Research')
    assert.equal(parsed.volume, '4')
    assert.equal(parsed.issue, '2')
    assert.equal(parsed.pages, '023066')
    assert.equal(parsed.year, '2022')
  })

  test('GB/T 7714：期刊卷期页码规范化，且不出现两个年份', () => {
    // 原始缺陷：journal_ref 被整串塞进 [J] 段，输出「… vol. 4, no. 2, page 023066, April 2022, 2020」
    const paper = {
      ...VASWANI,
      year: 2020,
      journal: 'Physical Review Research vol. 4, no. 2, page 023066, April 2022',
      doi: '10.1103/PhysRevResearch.4.023066',
    }
    const out = formatGbT7714(paper, '2026-09-06')
    assert.ok(out.includes('[J]. Physical Review Research, 2022, 4(2): 023066.'), out)
    // 刊年优先：预印本年 2020 不应再出现在 [J] 段
    assert.ok(!out.includes('2022, 2020'), out)
    assert.ok(!out.includes('vol.'), out)
  })

  test('parseJournalRef：无法解析时回退原文，不丢信息', () => {
    const raw = 'Some Unusual Venue That Defies Parsing'
    const parsed = parseJournalRef(raw)
    assert.equal(parsed.raw, raw)
    const out = formatGbT7714({ ...VASWANI, journal: raw }, '2026-09-06')
    assert.ok(out.includes(raw), out)
  })

  test('BibTeX：期刊拆成 journal / volume / number / pages', () => {
    const out = formatBibtex({
      ...VASWANI,
      journal: 'IEEE Transactions on Information Theory, vol. 45, no. 3, pp. 1-15, 2023',
    })
    assert.ok(out.includes('journal = {IEEE Transactions on Information Theory}'), out)
    assert.ok(out.includes('volume = 45'), out)
    assert.ok(out.includes('number = 3'), out)
    assert.ok(out.includes('pages = 1-15'), out)
  })
})

/* ------------------------------------------------------------------ */
/* 文献库                                                              */
/* ------------------------------------------------------------------ */

function makePaper(overrides) {
  return {
    id: 's2:p_' + Math.random().toString(36).slice(2, 10),
    source: 'semantic_scholar',
    title: 'Default Title',
    authors: ['Author A'],
    abstract: 'abstract',
    year: 2020,
    ...overrides,
  }
}

describe('文献库（会话隔离/去重/导出）', () => {
  let store
  beforeEach(() => {
    store = new AcademicStore()
  })

  test('按会话隔离：不同会话互不影响', () => {
    const a = store.addPaper('session-a', makePaper({ title: 'Paper A' }), 500)
    const b = store.addPaper('session-b', makePaper({ title: 'Paper B' }), 500)
    assert.equal(a.success, true)
    assert.equal(b.success, true)
    assert.equal(store.list('session-a').length, 1)
    assert.equal(store.list('session-b').length, 1)
    assert.equal(store.list('session-a')[0].title, 'Paper A')
  })

  test('DOI 去重（忽略大小写）', () => {
    store.addPaper('s', makePaper({ doi: '10.1000/XYZ' }), 500)
    const dup = store.addPaper('s', makePaper({ doi: '10.1000/xyz' }), 500)
    assert.equal(dup.success, false)
    assert.ok(dup.msg.includes('已在文献库'))
    assert.equal(store.list('s').length, 1)
  })

  test('arXiv ID 去重', () => {
    store.addPaper('s', makePaper({ arxivId: '1706.03762' }), 500)
    const dup = store.addPaper('s', makePaper({ arxivId: '1706.03762' }), 500)
    assert.equal(dup.success, false)
    assert.equal(store.list('s').length, 1)
  })

  test('标题去重（忽略大小写与空白）', () => {
    store.addPaper('s', makePaper({ title: 'Attention Is All You Need' }), 500)
    const dup = store.addPaper('s', makePaper({ title: '  attention is all you need ' }), 500)
    assert.equal(dup.success, false)
    assert.equal(store.list('s').length, 1)
  })

  test('上限保护', () => {
    store.addPaper('s', makePaper({ title: 'Only' }), 1)
    const reject = store.addPaper('s', makePaper({ title: 'Second' }), 1)
    assert.equal(reject.success, false)
    assert.ok(reject.msg.includes('上限'))
  })

  test('remove / clear', () => {
    const p = makePaper({})
    store.addPaper('s', p, 500)
    const removed = store.removePaper('s', p.id)
    assert.equal(removed.success, true)
    assert.equal(store.list('s').length, 0)
    assert.equal(store.removePaper('s', 'nonexistent').success, false)
    store.addPaper('s', makePaper({ title: 'X' }), 500)
    const cleared = store.clear('s')
    assert.equal(cleared.success, true)
    assert.equal(store.list('s').length, 0)
  })

  test('remember / findKnown 解析别名', () => {
    const p = makePaper({ doi: '10.1000/ABC', arxivId: '1706.03762' })
    store.remember('s', p)
    assert.equal(store.findKnown('s', p.id).id, p.id)
    assert.equal(store.findKnown('s', undefined, '10.1000/abc').id, p.id)
    assert.equal(store.findKnown('s', undefined, undefined, '1706.03762').id, p.id)
  })

  test('导出 BibTeX 与 Markdown', () => {
    store.addPaper('s', VASWANI, 500)
    const bib = store.exportBibtex('s')
    assert.ok(bib.startsWith('@article{vaswani2017attention,'))
    const md = store.exportMarkdown('s')
    assert.ok(md.includes('1.'))
    assert.ok(md.includes('Attention Is All You Need'))
    assert.ok(md.includes('https://doi.org/10.48550/arXiv.1706.03762'))
    assert.ok(store.exportBibtex('empty-session').includes('文献库为空'))
  })

  test('缓存 TTL 与上限淘汰', () => {
    const filter = buildFilter({ keyword: 'transformer' }, resolveConfig({}))
    const key = cacheKeyOf({ source: 'arxiv', filter })
    store.cacheSet('s', key, [makePaper({})], 2)
    assert.equal(store.cacheGet('s', key, 300).length, 1)
    assert.equal(store.cacheGet('s', key, 0), undefined)
    // 上限淘汰：插入超过上限的条目，最旧被淘汰
    store.cacheSet('s', 'k1', [makePaper({})], 2)
    store.cacheSet('s', 'k2', [makePaper({})], 2)
    store.cacheSet('s', 'k3', [makePaper({})], 2)
    assert.equal(store.cacheGet('s', 'k1', 300), undefined)
    assert.ok(store.cacheGet('s', 'k3', 300))
  })

  test('clearAll 清空全部会话', () => {
    store.addPaper('a', makePaper({ title: 'A' }), 500)
    store.addPaper('b', makePaper({ title: 'B' }), 500)
    store.clearAll()
    assert.equal(store.list('a').length, 0)
    assert.equal(store.list('b').length, 0)
  })

  test('sessionKeyOf 缺省回退', () => {
    assert.equal(AcademicStore.sessionKeyOf(undefined), 'default')
    assert.equal(AcademicStore.sessionKeyOf({ agent: { id: 's1' } }), 's1')
  })
})

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

describe('配置归一化', () => {
  test('默认值', () => {
    const cfg = resolveConfig({})
    assert.equal(cfg.enable, true)
    // 默认源为 arXiv：S2 未鉴权时是共享限流池，实测连续 429，不适合做默认。
    assert.equal(cfg.default_source, 'arxiv')
    assert.equal(cfg.max_results, 10)
    assert.equal(cfg.default_cite_format, 'gb_t_7714')
    // 15 秒对复杂短语查询不够（实测 15–45 秒），默认放宽到 30 秒。
    assert.equal(cfg.request_timeout, 30)
    assert.equal(cfg.enable_cache, true)
    assert.equal(cfg.max_cache_entries, 50)
    assert.equal(cfg.cache_ttl_seconds, 300)
    assert.equal(cfg.max_library_size, 500)
  })

  test('非法输入回退 + 越界夹取', () => {
    const cfg = resolveConfig({
      enable: 'yes',
      default_source: 'hack',
      max_results: 9999,
      request_timeout: -5,
      default_cite_format: 'chicago',
      max_library_size: 3,
    })
    assert.equal(cfg.enable, true)
    assert.equal(cfg.default_source, 'arxiv')
    assert.equal(cfg.max_results, 50)
    assert.equal(cfg.request_timeout, 1)
    assert.equal(cfg.default_cite_format, 'gb_t_7714')
    assert.equal(cfg.max_library_size, 10)
  })

  test('buildFilter 校验', () => {
    const cfg = resolveConfig({})
    const filter = buildFilter({ keyword: '  transformer  ', yearFrom: 2020, yearTo: 2024 }, cfg)
    assert.equal(filter.keyword, 'transformer')
    assert.equal(filter.yearFrom, 2020)
    assert.equal(filter.yearTo, 2024)
    assert.throws(() => buildFilter({ keyword: 'x', yearFrom: 2021, yearTo: 2020 }, cfg))
  })

  test('buildFilter 透传 matchMode，非法值丢弃', () => {
    const cfg = resolveConfig({})
    assert.equal(buildFilter({ keyword: 'x', matchMode: 'phrase' }, cfg).matchMode, 'phrase')
    assert.equal(buildFilter({ keyword: 'x', matchMode: 'all' }, cfg).matchMode, 'all')
    assert.equal(buildFilter({ keyword: 'x', matchMode: 'fuzzy' }, cfg).matchMode, undefined)
  })

  test('S2 API Key 可由配置项或环境变量提供', () => {
    assert.equal(resolveConfig({ semantic_scholar_api_key: 'abc123' }).semantic_scholar_api_key, 'abc123')
    const prev = process.env.S2_API_KEY
    try {
      process.env.S2_API_KEY = 'from-env'
      assert.equal(resolveConfig({}).semantic_scholar_api_key, 'from-env')
      // 配置项优先于环境变量
      assert.equal(
        resolveConfig({ semantic_scholar_api_key: 'from-config' }).semantic_scholar_api_key,
        'from-config',
      )
    } finally {
      if (prev === undefined) delete process.env.S2_API_KEY
      else process.env.S2_API_KEY = prev
    }
  })
})

/* ------------------------------------------------------------------ */
/* arXiv 查询构造（无网络）                                            */
/* ------------------------------------------------------------------ */

describe('arXiv 查询构造', () => {
  const mk = (keyword, extra = {}) => buildArxivQuery({ keyword, maxResults: 10, sort: 'relevance', ...extra })

  test('多词默认拆成 AND，而不是整串精确短语', () => {
    // 原始缺陷：整串包成短语 → 5 词查询实测 totalResults=0；拆词后同查询 602 篇。
    assert.equal(
      mk('retrieval augmented generation long context'),
      'all:"retrieval" AND all:"augmented" AND all:"generation" AND all:"long" AND all:"context"',
    )
  })

  test('单词与原先行为一致', () => {
    assert.equal(mk('transformer'), 'all:"transformer"')
  })

  test('整串加引号 → 尊重为用户要精确短语', () => {
    assert.equal(mk('"retrieval augmented generation"'), 'all:"retrieval augmented generation"')
  })

  test('局部引号 → 引号内作短语，引号外仍拆词', () => {
    assert.equal(
      mk('retrieval "augmented generation" long'),
      'all:"retrieval" AND all:"long" AND all:"augmented generation"',
    )
  })

  test('中文引号同样被识别，不进入 search_query 造成 HTTP 400', () => {
    assert.equal(mk('“attention mechanism”'), 'all:"attention mechanism"')
    assert.ok(!mk('retrieval “augmented generation” long').includes('“'))
  })

  test('matchMode 覆盖自动推断', () => {
    assert.equal(mk('a b c', { matchMode: 'phrase' }), 'all:"a b c"')
    assert.equal(mk('"a b"', { matchMode: 'all' }), 'all:"a" AND all:"b"')
  })

  test('作者与年份过滤仍然拼接', () => {
    const q = mk('transformer', { author: 'Vaswani', yearFrom: 2017, yearTo: 2020 })
    assert.ok(q.includes('AND au:"Vaswani"'))
    assert.ok(q.includes('AND submittedDate:[20170101 TO 20201231]'))
  })

  test('normalizeKeyword 三种形态', () => {
    assert.deepEqual(normalizeKeyword('"a b c"'), { keyword: 'a b c', phrase: true, quoted: [] })
    assert.deepEqual(normalizeKeyword('a "b c" d'), { keyword: 'a d', phrase: false, quoted: ['b c'] })
    assert.deepEqual(normalizeKeyword('a b c'), { keyword: 'a b c', phrase: false, quoted: [] })
  })

  test('空关键词抛 INVALID_ARG', () => {
    assert.throws(() => mk('   '), (error) => error.code === 'INVALID_ARG')
  })
})

/* ------------------------------------------------------------------ */
/* 限流防护（无网络）                                                  */
/* ------------------------------------------------------------------ */

describe('限流防护', () => {
  test('请求闸串行执行并保持最小间隔', async () => {
    const gate = gateFor('other', 120)
    const events = []
    const job = (id) => async () => {
      events.push(`start${id}`)
      await new Promise((r) => setTimeout(r, 10))
      events.push(`end${id}`)
      return id
    }
    const t0 = Date.now()
    const results = await Promise.all([gate(job(1)), gate(job(2)), gate(job(3))])
    const elapsed = Date.now() - t0
    assert.deepEqual(results, [1, 2, 3])
    // 严格串行：没有交叠
    assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'])
    // 3 个请求至少 2 个间隔
    assert.ok(elapsed >= 240, `elapsed=${elapsed}`)
  })

  test('冷却守卫在窗口内直接抛 COOLDOWN，不发请求', () => {
    resetCooldown()
    setCooldown('semantic_scholar', 5)
    assert.throws(() => cooldownGuard('semantic_scholar', 'Semantic Scholar'), (error) => error.code === 'COOLDOWN')
    // 另一个来源不受影响
    assert.doesNotThrow(() => cooldownGuard('arxiv', 'arXiv'))
    resetCooldown()
  })

  test('upstreamOf 按域名归类', () => {
    assert.equal(upstreamOf('https://export.arxiv.org/api/query'), 'arxiv')
    assert.equal(upstreamOf('https://api.semanticscholar.org/graph/v1/paper/search'), 'semantic_scholar')
    assert.equal(upstreamOf('https://example.com/x'), 'other')
  })

  test('退避等待带抖动，且落在基准与 1.5 倍之间', () => {
    const error = new AcademicSourceError('HTTP_500', 'boom', true)
    for (let i = 0; i < 20; i++) {
      const wait = retryWaitOf(error, 4000)
      assert.ok(wait >= 4000 && wait <= 6000, `wait=${wait}`)
    }
  })

  test('Retry-After 超出上限时不重试，直接抛不可重试错误', () => {
    const error = new AcademicSourceError('HTTP_429', 'slow down', true, { retryAfterSeconds: 120 })
    assert.throws(() => retryWaitOf(error, 4000), (thrown) => thrown.retriable === false)
  })

  test('缓存键区分 matchMode（避免 all / phrase 串味）', () => {
    const cfg = resolveConfig({})
    const base = buildFilter({ keyword: 'rag' }, cfg)
    const keyAll = cacheKeyOf({ source: 'arxiv', filter: { ...base, matchMode: 'all' } })
    const keyPhrase = cacheKeyOf({ source: 'arxiv', filter: { ...base, matchMode: 'phrase' } })
    assert.notEqual(keyAll, keyPhrase)
  })

  test('singleFlight 让并发同名检索只执行一次', async () => {
    const store = new AcademicStore()
    let calls = 0
    const factory = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return ['p']
    }
    const [a, b] = await Promise.all([
      store.singleFlight('s', 'k', factory),
      store.singleFlight('s', 'k', factory),
    ])
    assert.equal(calls, 1)
    assert.deepEqual(a, ['p'])
    assert.deepEqual(b, ['p'])
    // 前一轮结束后再调用会重新执行
    await store.singleFlight('s', 'k', factory)
    assert.equal(calls, 2)
  })
})

/* ------------------------------------------------------------------ */
/* 插件入口挂载（无网络）                                              */
/* ------------------------------------------------------------------ */

describe('插件入口挂载', () => {
  test('apply 注册 7 个工具 + systemPrompt + 卸载清理', async () => {
    const registered = []
    let sectionText = ''
    let cleanupRan = false
    const ctx = {
      tools: {
        register(def) {
          registered.push(def)
          return () => {}
        },
      },
      get(service) {
        if (service === 'systemPrompt') {
          return {
            section(section) {
              sectionText = section.text
              return () => {}
            },
          }
        }
        return undefined
      },
      effect(callback) {
        const cleanup = callback()
        cleanupRan = typeof cleanup === 'function'
        return cleanup
      },
      logger: { warn() {} },
    }

    plugin.apply(ctx, {})
    const names = registered.map((def) => def.name)
    assert.deepEqual(names, [
      'academic_search',
      'academic_paper_detail',
      'academic_cite',
      'academic_library_add',
      'academic_library_list',
      'academic_library_remove',
      'academic_library_export',
    ])
    assert.ok(sectionText.includes('禁止编造'))
    assert.ok(sectionText.includes('academic_cite'))
    assert.equal(cleanupRan, true)

    const exec = { agent: { id: 't1' } }
    const byName = (name) => registered.find((def) => def.name === name)

    // 空文献库列表
    const list = await byName('academic_library_list').execute({}, exec)
    assert.equal(list.papers.length, 0)
    assert.equal(list.session, 't1')

    // 空导出
    const exportEmpty = await byName('academic_library_export').execute({}, exec)
    assert.equal(exportEmpty.count, 0)
    assert.ok(exportEmpty.content.includes('文献库为空'))

    // 非法入参校验
    await assert.rejects(() => byName('academic_search').execute({ keyword: '   ' }, exec), (error) => {
      assert.equal(error.code, 'INVALID_ARG')
      return true
    })
    await assert.rejects(() => byName('academic_paper_detail').execute({}, exec), (error) => {
      assert.equal(error.code, 'INVALID_ARG')
      return true
    })

    // 删除不存在的文献 → 友好失败
    const removed = await byName('academic_library_remove').execute({ paperId: 'nope' }, exec)
    assert.equal(removed.success, false)

    // 未启用时全部拒绝
    const registeredDisabled = []
    plugin.apply({ ...ctx, tools: { register(def) { registeredDisabled.push(def); return () => {} } } }, { enable: false })
    const disabledList = registeredDisabled.find((def) => def.name === 'academic_library_list')
    await assert.rejects(() => disabledList.execute({}, exec), (error) => error.code === 'DISABLED')
  })
})


describe('数据源集成冒烟（网络）', () => {
  test('arXiv 搜索返回真实数据', { skip: false, timeout: 40000 }, async () => {
    const papers = await searchArxiv(
      { keyword: 'attention is all you need', maxResults: 3, sort: 'relevance' },
      { timeoutMs: 20000 },
    )
    assert.ok(papers.length >= 1)
    const first = papers[0]
    assert.ok(first.title.length > 0)
    assert.ok(first.arxivId)
    assert.ok(first.id.startsWith('arxiv:'))
    assert.ok(first.pdfUrl.includes('arxiv.org/pdf'))
    assert.ok(first.year > 0)
  })

  test('arXiv 详情按 ID 返回', { timeout: 40000 }, async () => {
    const paper = await arxivDetail('1706.03762', { timeoutMs: 20000 })
    assert.ok(paper)
    assert.equal(paper.arxivId, '1706.03762')
    assert.ok(paper.authors.length > 0)
    assert.ok(paper.abstract.length > 0)
  })

  test('Semantic Scholar 搜索（429 / 冷却时跳过）', { timeout: 60000 }, async () => {
    let papers
    try {
      papers = await searchSemanticScholar(
        { keyword: 'attention', maxResults: 3, sort: 'relevance' },
        { timeoutMs: 20000 },
      )
    } catch (error) {
      // 无 API Key 时 S2 稳定 429；冷却期内的 COOLDOWN 是同一件事的后续表现。
      if (error && (error.code === 'HTTP_429' || error.code === 'COOLDOWN')) {
        console.log('  ↳ S2 搜索限流，跳过（错误：', error.message, '）')
        return
      }
      throw error
    }
    assert.ok(papers.length >= 1)
    assert.ok(papers[0].id.startsWith('s2:'))
    assert.ok(papers[0].citationCount !== undefined)
  })

  test('Semantic Scholar 详情（DOI / arXiv，404 / 429 / 冷却时跳过）', { timeout: 60000 }, async () => {
    let paper
    try {
      paper = await semanticScholarDetail({ arxivId: '1706.03762' }, { timeoutMs: 20000 })
    } catch (error) {
      if (error && (error.code === 'HTTP_429' || error.code === 'HTTP_404' || error.code === 'COOLDOWN')) {
        console.log('  ↳ S2 详情不可用，跳过（错误：', error.message, '）')
        return
      }
      throw error
    }
    assert.ok(paper)
    assert.ok(paper.id.startsWith('s2:'))
    assert.equal(paper.arxivId, '1706.03762')
  })
})
