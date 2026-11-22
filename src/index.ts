/**
 * dsh-plugin-academic-paper —— 插件入口。
 *
 * 定位（PRD §1.3）：插件负责真实数据源检索与引用格式生成；大模型负责解读、综述与对比。
 * 本插件为纯工具型：不监听 user:message / turn:* / tool:* 等会话事件（PRD §5.2），
 * 仅在模型调用学术工具时介入，其余时间完全不参与会话流程。
 *
 * 注册内容：
 * - 7 个面向模型的工具（academic_search / academic_paper_detail / academic_cite /
 *   academic_library_add / academic_library_list / academic_library_remove / academic_library_export）
 * - system prompt 溯源约束段（要求文献必须经工具检索，禁止编造，PRD §8）
 * - Web UI 数据路由（侧边面板数据源，PRD §3.2 功能6）
 * - 生命周期：effect disposer 清空全部会话文献库/缓存/索引（对应 PRD §4.2 plugin:unload）
 */

import Schema from 'schemastery'
import { formatCitation } from './citation'
import { AcademicStore, buildFilter, cacheKeyOf } from './library'
import { arxivDetail, arxivSearchByDoi, ARXIV_ID_RE, searchArxiv } from './sources/arxiv'
import { searchSemanticScholar, semanticScholarDetail } from './sources/semantic-scholar'
import { AcademicSourceError } from './types'
import type { ExecLike, HttpOptions, Paper, ResolvedConfig, SourceSelection, ToolDefinition } from './types'

export const name = 'dsh-plugin-academic-paper'
// webServer 用于注册侧边面板的数据路由；缺失时面板静默不可用，因此必须显式声明依赖。
export const inject = ['tools', 'settings', 'webServer']

/* ------------------------------------------------------------------ */
/* 配置（对应 PRD §3.3 配置项）                                        */
/* ------------------------------------------------------------------ */

export interface Config {
  enable: boolean
  default_source: SourceSelection
  max_results: number
  default_cite_format: 'gb_t_7714' | 'apa' | 'bibtex'
  request_timeout: number
  enable_cache: boolean
  max_cache_entries: number
  cache_ttl_seconds: number
  max_library_size: number
  semantic_scholar_api_key: string
}

export const Config: Schema<Config> = Schema.object({
  enable: Schema.boolean().default(true),
  // 默认源改 arXiv：S2 未鉴权时是全体未鉴权用户共享的限流池，实测连续 429，不适合做默认。
  default_source: Schema.union(['arxiv', 'semantic_scholar', 'both']).default('arxiv'),
  max_results: Schema.number().min(1).max(50).default(10),
  default_cite_format: Schema.union(['gb_t_7714', 'apa', 'bibtex']).default('gb_t_7714'),
  // 15 秒对复杂短语查询不够：实测这类查询 15–45 秒，会先撞超时再白等一次重试。
  request_timeout: Schema.number().min(1).max(120).default(30),
  enable_cache: Schema.boolean().default(true),
  max_cache_entries: Schema.number().min(10).max(500).default(50),
  cache_ttl_seconds: Schema.number().min(0).max(86400).default(300),
  max_library_size: Schema.number().min(10).max(5000).default(500),
  semantic_scholar_api_key: Schema.string().default(''),
})

/** 归一化配置：容忍非法输入、回退默认值（settings 未就绪或 entryConfig 缺键时兜底）。 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const asSource = (v: unknown, fallback: SourceSelection): SourceSelection =>
    v === 'arxiv' || v === 'semantic_scholar' || v === 'both' ? v : fallback
  const asFormat = (v: unknown): ResolvedConfig['default_cite_format'] =>
    v === 'apa' || v === 'bibtex' ? v : 'gb_t_7714'
  const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
  }
  // API Key：配置项优先，缺省回退环境变量 S2_API_KEY（只读环境变量即可，密钥不必落盘）。
  const apiKeyFromEnv = typeof process !== 'undefined' && process.env ? process.env.S2_API_KEY : undefined
  const apiKey = typeof src.semantic_scholar_api_key === 'string' && src.semantic_scholar_api_key.trim() !== ''
    ? src.semantic_scholar_api_key.trim()
    : (typeof apiKeyFromEnv === 'string' && apiKeyFromEnv.trim() !== '' ? apiKeyFromEnv.trim() : '')
  return {
    enable: src.enable !== false,
    // 两处默认值必须一致：只改 Schema 不改这里，settings 缺键时会退回旧默认。
    default_source: asSource(src.default_source, 'arxiv'),
    max_results: clampInt(src.max_results, 10, 1, 50),
    default_cite_format: asFormat(src.default_cite_format),
    request_timeout: clampInt(src.request_timeout, 30, 1, 120),
    enable_cache: src.enable_cache !== false,
    max_cache_entries: clampInt(src.max_cache_entries, 50, 10, 500),
    cache_ttl_seconds: clampInt(src.cache_ttl_seconds, 300, 0, 86400),
    max_library_size: clampInt(src.max_library_size, 500, 10, 5000),
    semantic_scholar_api_key: apiKey,
  }
}

/* ------------------------------------------------------------------ */
/* 最小依赖结构（避免引入 cordis 类型，保证可独立构建）                */
/* ------------------------------------------------------------------ */

interface SettingsScopeLike {
  get(): unknown
  watch(callback: (next: unknown) => void): () => void
}

interface SettingsLike {
  register(ns: string, schema: unknown, options: { applies: string; base?: unknown }): SettingsScopeLike
}

interface RouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

interface WebServerLike {
  register(route: RouteLike): () => void
}

interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

interface ContextLike {
  tools: { register(definition: ToolDefinition): () => void }
  get<T>(service: string): T | undefined
  effect(callback: () => (() => void) | void, label?: string): void
  logger: { warn(...args: unknown[]): void }
}

/* ------------------------------------------------------------------ */
/* 工具输出 JSON Schema 片段                                           */
/* ------------------------------------------------------------------ */

const PAPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '内部唯一 ID（arxiv:xxx 或 s2:xxx），供后续工具引用' },
    source: { type: 'string', enum: ['arxiv', 'semantic_scholar'] },
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    abstract: { type: 'string' },
    year: { type: 'number' },
    doi: { type: 'string' },
    arxivId: { type: 'string' },
    journal: { type: 'string' },
    citationCount: { type: 'number' },
    pdfUrl: { type: 'string' },
    officialUrl: { type: 'string' },
    addedAt: { type: 'number' },
  },
  required: ['id', 'source', 'title', 'authors', 'abstract', 'year'],
}

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    papers: { type: 'array', items: PAPER_SCHEMA },
    query: { type: 'string' },
    source: { type: 'string' },
    total: { type: 'number' },
    errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['papers', 'query', 'source', 'total'],
}

const MSG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean' },
    msg: { type: 'string' },
  },
  required: ['success', 'msg'],
}

/* ------------------------------------------------------------------ */
/* 渲染函数（模型可见文本；规范值保持不变）                            */
/* ------------------------------------------------------------------ */

function renderPaperLine(paper: Paper): string {
  const authors = paper.authors.length > 0
    ? `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' 等' : ''}`
    : '佚名'
  const meta = [
    paper.year > 0 ? `(${paper.year})` : '',
    paper.journal ? paper.journal : '',
    paper.citationCount !== undefined ? `被引 ${paper.citationCount}` : '',
    paper.doi ? `DOI ${paper.doi}` : '',
  ].filter(Boolean).join(' · ')
  return `[${paper.id}] ${paper.title} — ${authors} ${meta ? `— ${meta}` : ''}`
}

function renderSearchResult(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { papers: Paper[]; query: string; source: string; total: number; errors?: string[] }
  const lines: string[] = []
  if (v.errors && v.errors.length > 0) {
    lines.push(`注意：${v.errors.join('；')}`)
  }
  if (v.papers.length === 0) {
    lines.push(`academic_search 未检索到与 "${v.query}" 相关的文献（来源：${v.source}）。请更换关键词、调整年份/作者过滤后重试。`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push(`academic_search 返回 ${v.papers.length} 篇文献（来源：${v.source}，关键词："${v.query}"）：`)
  v.papers.forEach((paper, index) => {
    lines.push(`${index + 1}. ${renderPaperLine(paper)}`)
    const abstract = paper.abstract ? `   摘要：${paper.abstract.slice(0, 280)}${paper.abstract.length > 280 ? '…' : ''}` : ''
    if (abstract) lines.push(abstract)
  })
  lines.push('提示：引用请使用 academic_cite 生成标准格式；将文献加入文献库可使用 academic_library_add（paperId）。')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderPaperDetail(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const paper = value as Paper
  const lines = [
    `标题：${paper.title}`,
    `作者：${paper.authors.length > 0 ? paper.authors.join(', ') : '佚名'}`,
    `年份：${paper.year > 0 ? paper.year : '未知'}`,
    `来源：${paper.source === 'arxiv' ? 'arXiv' : 'Semantic Scholar'}`,
    `ID：${paper.id}`,
  ]
  if (paper.journal) lines.push(`期刊/会议：${paper.journal}`)
  if (paper.doi) lines.push(`DOI：${paper.doi}`)
  if (paper.arxivId) lines.push(`arXiv：${paper.arxivId}`)
  if (paper.citationCount !== undefined) lines.push(`被引次数：${paper.citationCount}`)
  if (paper.pdfUrl) lines.push(`PDF：${paper.pdfUrl}`)
  if (paper.officialUrl) lines.push(`链接：${paper.officialUrl}`)
  if (paper.abstract) lines.push(`摘要：${paper.abstract}`)
  lines.push('提示：引用请使用 academic_cite（paperId 或本 ID）。')
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderCite(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { citation: string; format: string }
  return [{ type: 'text', text: `已生成引用（格式：${v.format}）：\n${v.citation}` }]
}

function renderLibraryList(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { papers: Paper[]; session: string }
  if (v.papers.length === 0) {
    return [{ type: 'text', text: '当前文献库为空。可先用 academic_search 检索，再用 academic_library_add 加入文献。' }]
  }
  const lines = [`当前文献库共 ${v.papers.length} 篇（会话 ${v.session}）：`]
  v.papers.forEach((paper, index) => {
    lines.push(`${index + 1}. ${renderPaperLine(paper)}`)
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderExport(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { content: string; format: string; count: number }
  if (v.count === 0) {
    return [{ type: 'text', text: '文献库为空，没有可导出的参考文献。' }]
  }
  if (v.format === 'bibtex') {
    return [{ type: 'text', text: `已导出 ${v.count} 条 BibTeX 引用（可直接保存为 .bib 文件）：\n\`\`\`bibtex\n${v.content}\n\`\`\`` }]
  }
  return [{ type: 'text', text: `已导出 ${v.count} 条 Markdown 参考文献列表：\n${v.content}` }]
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

/** 统一的论文解析：先查会话索引，再按 paperId/DOI/arXiv ID 启发式联网解析。 */
async function resolvePaper(
  store: AcademicStore,
  session: string,
  args: { paperId?: string; doi?: string; arxivId?: string },
  opts: HttpOptions,
): Promise<Paper> {
  const known = store.findKnown(session, args.paperId, args.doi, args.arxivId)
  if (known) return known

  const tryArxivThenS2 = async (arxivId: string): Promise<Paper | null> => {
    const paper = await arxivDetail(arxivId, opts)
    if (paper) return paper
    return semanticScholarDetail({ arxivId }, opts)
  }

  const paperId = args.paperId?.trim()
  if (paperId) {
    let paper: Paper | null = null
    if (paperId.startsWith('arxiv:')) {
      paper = await tryArxivThenS2(paperId.slice(6))
      if (paper) return paper
    } else if (paperId.startsWith('s2:')) {
      paper = await semanticScholarDetail({ paperId: paperId.slice(3) }, opts)
      if (paper) return paper
    } else if (ARXIV_ID_RE.test(paperId)) {
      paper = await tryArxivThenS2(paperId)
      if (paper) return paper
    } else if (/^10\.\S+$/i.test(paperId)) {
      paper = await semanticScholarDetail({ doi: paperId }, opts)
      if (!paper) paper = await arxivSearchByDoi(paperId, opts)
      if (paper) return paper
    } else {
      // S2 的 40 位 paperId 或 CorpusId
      paper = await semanticScholarDetail({ paperId }, opts)
      // 非标准标识（既不是 arXiv ID 也不是 DOI）在 S2 找不到就没有别的兜底路径了，
      // 继续往下跑只会用同样的字符串再打一遍上游。
      return paper ?? raiseNotFound(args)
    }
  }
  // 下面两段只在 paperId 未命中时兜底；同一个标识已在上面试过的不再重复。
  if (args.doi?.trim() && args.doi.trim() !== paperId) {
    const paper = await semanticScholarDetail({ doi: args.doi.trim() }, opts)
    if (paper) return paper
    const byArxiv = await arxivSearchByDoi(args.doi.trim(), opts)
    if (byArxiv) return byArxiv
  }
  if (args.arxivId?.trim() && args.arxivId.trim() !== paperId) {
    const paper = await tryArxivThenS2(args.arxivId.trim())
    if (paper) return paper
  }
  throw raiseNotFound(args)
}

/** 统一的「没找到」错误，避免 paperId / doi / arxivId 三处各拼一遍。 */
function raiseNotFound(args: { paperId?: string; doi?: string; arxivId?: string }): never {
  throw new AcademicSourceError(
    'NOT_FOUND',
    `未找到对应的文献（paperId=${args.paperId ?? '-'}，doi=${args.doi ?? '-'}，arxivId=${args.arxivId ?? '-'}）。请先用 academic_search 检索，或核对标识是否正确。`,
  )
}

/** 合并双源检索结果（按 arXiv ID / DOI / 标题去重，arXiv 优先）。 */
function mergePapers(arxivPapers: Paper[], s2Papers: Paper[]): Paper[] {
  const seen = new Set<string>()
  const merged: Paper[] = []
  const push = (paper: Paper): void => {
    const key = paper.arxivId
      ? `arxiv:${paper.arxivId.toLowerCase()}`
      : paper.doi
        ? `doi:${paper.doi.toLowerCase()}`
        : `title:${paper.title.trim().toLowerCase().replace(/\s+/g, ' ')}`
    if (seen.has(key)) return
    seen.add(key)
    merged.push(paper)
  }
  for (const paper of arxivPapers) push(paper)
  for (const paper of s2Papers) push(paper)
  return merged
}

/** 排序（date / citations；relevance 保持合并顺序）。 */
function sortPapers(papers: Paper[], sort: string): Paper[] {
  if (sort === 'date') papers.sort((a, b) => (b.year || 0) - (a.year || 0))
  else if (sort === 'citations') papers.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0))
  return papers
}

function assertEnabled(config: ResolvedConfig): void {
  if (!config.enable) {
    throw new AcademicSourceError('DISABLED', '学术文献插件未启用（配置 enable=false）。请在插件设置中启用后再使用。')
  }
}

function httpOpts(config: ResolvedConfig, exec: ExecLike): HttpOptions {
  return {
    timeoutMs: config.request_timeout * 1000,
    signal: exec.signal,
    s2ApiKey: config.semantic_scholar_api_key || undefined,
  }
}

function sessionKeyOf(exec: ExecLike): string {
  return AcademicStore.sessionKeyOf(exec)
}

/**
 * 去掉对象中值为 undefined 的字段。
 * 当前 Harness tools 契约要求工具输出为「无损 JSON」（snapshot 校验不允许
 * undefined 叶子），而 Paper 的可选字段（journal/citationCount/pdfUrl/...）在
 * 数据源映射时可能被赋为显式 undefined，直接返回会触发
 * "value is not lossless JSON"。仅在工具输出边界做一次清理，内部存储保持原样。
 */
function cleanPaper(paper: Paper): Paper {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(paper)) {
    const value = (paper as unknown as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = value
  }
  return out as unknown as Paper
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx: ContextLike, entryConfig: unknown): void {
  const store = new AcademicStore()
  let config = resolveConfig(entryConfig)

  // 配置热更新：settings 服务缺失或注册失败时回退 entryConfig / 默认值（不崩）。
  let unwatch: (() => void) | undefined
  const settings = ctx.get<SettingsLike>('settings')
  if (settings && typeof settings.register === 'function') {
    try {
      const scope = settings.register(name, Config, { applies: 'live', base: entryConfig })
      config = resolveConfig(scope.get())
      unwatch = scope.watch((next) => {
        config = resolveConfig(next)
      })
    } catch (error) {
      ctx.logger.warn('[dsh-plugin-academic-paper] settings 注册失败，使用入口配置：', error)
    }
  }

  const disposers: Array<() => void> = []
  const registerTool = (definition: ToolDefinition): void => {
    const dispose = ctx.tools.register(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  /* ---------- 工具 1：文献检索 ---------- */
  registerTool({
    name: 'academic_search',
    description: `按关键词检索学术文献（arXiv / Semantic Scholar 公开数据源），返回标题、作者、摘要、年份、DOI、引用数、PDF 链接等真实元数据。
支持按年份范围、作者过滤，可指定数据源（arxiv / semantic_scholar / both）与排序（相关性/日期/引用数）。
检索结果可追溯来源，禁止编造论文信息；需要引用格式时使用 academic_cite 工具。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '检索关键词（论文标题/摘要/主题词），必填' },
        source: { type: 'string', enum: ['arxiv', 'semantic_scholar', 'both'], description: '数据源；缺省使用插件配置 default_source' },
        matchMode: {
          type: 'string',
          enum: ['all', 'phrase'],
          description: '关键词匹配方式：all=每个词都出现即可（默认，召回高）；phrase=连续完整短语（精度高，召回低）。关键词自带引号时自动按 phrase 处理',
        },
        yearFrom: { type: 'number', description: '起始年份（含）' },
        yearTo: { type: 'number', description: '截止年份（含）' },
        author: { type: 'string', description: '作者姓名过滤（Semantic Scholar 源在本地过滤）' },
        maxResults: { type: 'number', min: 1, max: 50, description: '最大返回条数；缺省使用插件配置 max_results' },
        sort: { type: 'string', enum: ['relevance', 'date', 'citations'], description: '排序；缺省 relevance。arXiv 不支持按引用数排序，会自动回退相关性' },
      },
      required: ['keyword'],
    },
    timeoutMs: 90000,
    output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearchResult },
    async execute(args, exec) {
      assertEnabled(config)
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : ''
      if (!keyword) throw new AcademicSourceError('INVALID_ARG', 'academic_search: keyword 不能为空')
      const filter = buildFilter(args, config)
      const source = args.source === 'arxiv' || args.source === 'semantic_scholar' || args.source === 'both'
        ? args.source
        : config.default_source
      const session = sessionKeyOf(exec)
      const cacheKey = cacheKeyOf({ source, filter })

      if (config.enable_cache) {
        const cached = store.cacheGet(session, cacheKey, config.cache_ttl_seconds)
        if (cached) {
          store.recordSearch(session, keyword, cached.length)
          return { papers: cached.map(cleanPaper), query: keyword, source, total: cached.length, errors: [] }
        }
      }

      const opts = httpOpts(config, exec)
      const runSource = async (sel: Exclude<SourceSelection, 'both'>): Promise<Paper[]> => {
        if (sel === 'arxiv') return searchArxiv(filter, opts)
        return searchSemanticScholar(filter, opts)
      }

      /**
       * 真正打上游的一段。外层用 singleFlight 包住：缓存写点在请求之后，
       * 两条相同查询并发进来都会 cache miss，此处让后者复用前者的 Promise，
       * 不再各发一次请求。
       */
      const fetchPapers = async (): Promise<{ papers: Paper[]; errors: string[] }> => {
        const errors: string[] = []
        if (source === 'both') {
          const [arxivResult, s2Result] = await Promise.allSettled([
            runSource('arxiv'),
            runSource('semantic_scholar'),
          ])
          if (arxivResult.status === 'rejected') errors.push(`arXiv 检索失败：${messageOf(arxivResult.reason)}`)
          if (s2Result.status === 'rejected') errors.push(`Semantic Scholar 检索失败：${messageOf(s2Result.reason)}`)
          const arxivPapers = arxivResult.status === 'fulfilled' ? arxivResult.value : []
          const s2Papers = s2Result.status === 'fulfilled' ? s2Result.value : []
          const merged = mergePapers(arxivPapers, s2Papers)
          if (merged.length === 0 && errors.length > 0) {
            throw new AcademicSourceError('SEARCH_FAILED', `检索失败：${errors.join('；')}`, true)
          }
          return { papers: merged, errors }
        }
        try {
          return { papers: await runSource(source), errors }
        } catch (error) {
          throw error instanceof AcademicSourceError
            ? error
            : new AcademicSourceError('SEARCH_FAILED', `检索失败：${messageOf(error)}`, true)
        }
      }

      // 缓存命中时 errors 恒为空（缓存只存成功结果），因此复用同一条返回路径即可。
      const outcome = config.enable_cache
        ? await store.singleFlight(session, cacheKey, fetchPapers)
        : await fetchPapers()

      const papers = sortPapers(outcome.papers, filter.sort).slice(0, filter.maxResults)
      if (config.enable_cache) store.cacheSet(session, cacheKey, papers, config.max_cache_entries)
      store.recordSearch(session, keyword, papers.length)
      for (const paper of papers) store.remember(session, paper)
      return { papers: papers.map(cleanPaper), query: keyword, source, total: papers.length, errors: outcome.errors }
    },
  })

  /* ---------- 工具 2：单篇文献详情 ---------- */
  registerTool({
    name: 'academic_paper_detail',
    description: `获取单篇学术文献的完整元数据（完整摘要、全部作者、期刊/会议、发布日期、引用数、PDF 链接、官方链接）。
入参支持三种标识之一：paperId（检索结果中的内部 ID，如 arxiv:xxxx 或 s2:xxxx）、doi、arxivId。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paperId: { type: 'string', description: '内部论文 ID（arxiv:xxx 或 s2:xxx），也可直接传 arXiv ID / DOI / S2 paperId' },
        doi: { type: 'string', description: 'DOI（如 10.48550/arXiv.1706.03762）' },
        arxivId: { type: 'string', description: 'arXiv ID（如 1706.03762）' },
      },
    },
    timeoutMs: 90000,
    output: { schema: PAPER_SCHEMA, render: renderPaperDetail },
    async execute(args, exec) {
      assertEnabled(config)
      if (!args.paperId?.toString().trim() && !args.doi?.toString().trim() && !args.arxivId?.toString().trim()) {
        throw new AcademicSourceError('INVALID_ARG', 'academic_paper_detail: 需提供 paperId / doi / arxivId 之一')
      }
      const session = sessionKeyOf(exec)
      const paper = await resolvePaper(store, session, {
        paperId: args.paperId?.toString(),
        doi: args.doi?.toString(),
        arxivId: args.arxivId?.toString(),
      }, httpOpts(config, exec))
      store.remember(session, paper)
      return cleanPaper(paper)
    },
  })

  /* ---------- 工具 3：引用格式生成 ---------- */
  registerTool({
    name: 'academic_cite',
    description: `为文献生成标准引用格式（GB/T 7714 / APA / BibTeX），格式由插件本地生成、准确可靠，禁止由模型自行拼接引用格式。
入参支持 paperId（推荐，检索结果中的内部 ID），也可用 doi / arxivId。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paperId: { type: 'string', description: '内部论文 ID（arxiv:xxx 或 s2:xxx）或 arXiv ID / DOI / S2 paperId' },
        doi: { type: 'string', description: 'DOI（如 10.48550/arXiv.1706.03762）' },
        arxivId: { type: 'string', description: 'arXiv ID（如 1706.03762）' },
        format: { type: 'string', enum: ['gb_t_7714', 'apa', 'bibtex'], description: '引用格式；缺省使用插件配置 default_cite_format' },
      },
    },
    timeoutMs: 90000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          citation: { type: 'string' },
          format: { type: 'string' },
          paperId: { type: 'string' },
        },
        required: ['citation', 'format', 'paperId'],
      },
      render: renderCite,
    },
    async execute(args, exec) {
      assertEnabled(config)
      if (!args.paperId?.toString().trim() && !args.doi?.toString().trim() && !args.arxivId?.toString().trim()) {
        throw new AcademicSourceError('INVALID_ARG', 'academic_cite: 需提供 paperId / doi / arxivId 之一')
      }
      const session = sessionKeyOf(exec)
      const paper = await resolvePaper(store, session, {
        paperId: args.paperId?.toString(),
        doi: args.doi?.toString(),
        arxivId: args.arxivId?.toString(),
      }, httpOpts(config, exec))
      store.remember(session, paper)
      const format = args.format === 'apa' || args.format === 'bibtex' ? args.format : config.default_cite_format
      return { citation: formatCitation(paper, format), format, paperId: paper.id }
    },
  })

  /* ---------- 工具 4：加入文献库 ---------- */
  registerTool({
    name: 'academic_library_add',
    description: `把一篇文献加入当前会话的本地文献库。同一 DOI / arXiv ID / 标题不会重复加入。
入参 paperId 为检索结果中的内部 ID（也可直接传 arXiv ID / DOI）。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paperId: { type: 'string', description: '内部论文 ID（arxiv:xxx 或 s2:xxx）或 arXiv ID / DOI' },
        doi: { type: 'string', description: 'DOI（备选标识）' },
        arxivId: { type: 'string', description: 'arXiv ID（备选标识）' },
      },
      required: ['paperId'],
    },
    timeoutMs: 90000,
    output: { schema: MSG_SCHEMA, render: (_, value) => [{ type: 'text', text: (value as { msg: string }).msg }] },
    async execute(args, exec) {
      assertEnabled(config)
      const session = sessionKeyOf(exec)
      const paper = await resolvePaper(store, session, {
        paperId: args.paperId?.toString(),
        doi: args.doi?.toString(),
        arxivId: args.arxivId?.toString(),
      }, httpOpts(config, exec))
      store.remember(session, paper)
      return store.addPaper(session, paper, config.max_library_size)
    },
  })

  /* ---------- 工具 5：查看文献库 ---------- */
  registerTool({
    name: 'academic_library_list',
    description: '查看当前会话文献库的全部文献（标题、作者、年份、来源、加入时间）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          papers: { type: 'array', items: PAPER_SCHEMA },
          session: { type: 'string' },
        },
        required: ['papers', 'session'],
      },
      render: renderLibraryList,
    },
    async execute(_args, exec) {
      assertEnabled(config)
      const session = sessionKeyOf(exec)
      return { papers: store.list(session).map(cleanPaper), session }
    },
  })

  /* ---------- 工具 6：删除文献 ---------- */
  registerTool({
    name: 'academic_library_remove',
    description: '从当前会话文献库删除单篇文献（按内部 ID paperId）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paperId: { type: 'string', description: '要删除的文献内部 ID（见 academic_library_list 返回）' },
      },
      required: ['paperId'],
    },
    timeoutMs: 30000,
    output: { schema: MSG_SCHEMA, render: (_, value) => [{ type: 'text', text: (value as { msg: string }).msg }] },
    async execute(args, exec) {
      assertEnabled(config)
      const session = sessionKeyOf(exec)
      return store.removePaper(session, String(args.paperId ?? ''))
    },
  })

  /* ---------- 工具 7：批量导出 ---------- */
  registerTool({
    name: 'academic_library_export',
    description: '把当前会话文献库批量导出为 BibTeX 文件内容或 Markdown 参考文献列表（带编号，可直接粘贴到论文）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string', enum: ['bibtex', 'markdown'], description: '导出格式；缺省 bibtex' },
      },
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          format: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['content', 'format', 'count'],
      },
      render: renderExport,
    },
    async execute(args, exec) {
      assertEnabled(config)
      const session = sessionKeyOf(exec)
      const format = args.format === 'markdown' ? 'markdown' : 'bibtex'
      const content = format === 'markdown' ? store.exportMarkdown(session) : store.exportBibtex(session)
      return { content, format, count: store.list(session).length }
    },
  })

  /* ---------- system prompt 溯源约束（PRD §8 防幻觉） ---------- */
  const systemPrompt = ctx.get<SystemPromptLike>('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    disposers.push(systemPrompt.section({
      name: 'dsh-plugin-academic-paper/provenance',
      order: 120,
      text: `学术文献事实性约束（dsh-plugin-academic-paper）：
- 涉及论文、文献、引用信息时，必须通过 academic_search / academic_paper_detail 工具检索真实数据；禁止编造论文标题、作者、DOI、年份、期刊或摘要。
- 需要生成参考文献引用时，必须使用 academic_cite 工具输出 GB/T 7714 / APA / BibTeX 格式，不要自行拼接引用格式。
- 文献库管理使用 academic_library_add / academic_library_list / academic_library_remove；批量导出使用 academic_library_export。
- 检索无结果时如实告知用户，不要用编造的文献填补。`,
    }))
  }

  /* ---------- Web UI 数据路由（侧边面板，PRD §3.2 功能6） ---------- */
  const webServer = ctx.get<WebServerLike>('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const queryOf = (req: import('node:http').IncomingMessage): URLSearchParams => {
        return new URL(req.url ?? '/', 'http://dsh.internal').searchParams
      }

      disposers.push(webServer.register({
        kind: 'exact',
        path: '/academic/ui/state',
        handler: (_req, res) => {
          json(res, 200, { sessions: store.overview() })
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: '/academic/ui/library',
        handler: (req, res) => {
          const session = queryOf(req).get('session') ?? 'default'
          const snapshot = store.snapshot(session)
          json(res, 200, { session, ...snapshot })
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: '/academic/ui/remove',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' })
            res.end()
            return
          }
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { session?: string; paperId?: string }
              const result = store.removePaper(parsed?.session ?? 'default', parsed?.paperId ?? '')
              json(res, 200, result)
            } catch {
              json(res, 400, { success: false, msg: '请求体不是合法 JSON' })
            }
          })
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: '/academic/ui/clear',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' })
            res.end()
            return
          }
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { session?: string }
              const result = store.clear(parsed?.session ?? 'default')
              json(res, 200, result)
            } catch {
              json(res, 400, { success: false, msg: '请求体不是合法 JSON' })
            }
          })
        },
      }))

      disposers.push(webServer.register({
        kind: 'exact',
        path: '/academic/ui/export',
        handler: (req, res) => {
          const params = queryOf(req)
          const session = params.get('session') ?? 'default'
          const format = params.get('format') === 'markdown' ? 'markdown' : 'bibtex'
          const content = format === 'markdown' ? store.exportMarkdown(session) : store.exportBibtex(session)
          res.writeHead(200, {
            'content-type': format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(content)
        },
      }))
    } catch (error) {
      ctx.logger.warn('[dsh-plugin-academic-paper] UI 路由注册失败，侧边面板不可用：', error)
    }
  }

  /* ---------- 生命周期清理（对应 PRD §4.2 plugin:unload） ---------- */
  ctx.effect(() => {
    return () => {
      if (typeof unwatch === 'function') {
        try { unwatch() } catch { /* 忽略清理异常 */ }
      }
      for (const dispose of disposers) {
        try { dispose() } catch { /* 忽略清理异常 */ }
      }
      store.clearAll()
    }
  }, 'dsh-plugin-academic-paper: 工具注册 + 清理')
}

/** 提取任意错误的可读消息。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// 供测试与二次开发引用的内部导出（不参与插件加载路径）。
// 使用「模块直出」形式，避免 rolldown 将仅导出而未内部引用的符号 tree-shake 掉。
export {
  formatCitation,
  formatGbT7714,
  formatApa,
  formatBibtex,
  bibtexKey,
  splitName,
  escapeLatex,
  parseJournalRef,
} from './citation'
export { AcademicStore, cacheKeyOf, buildFilter } from './library'
export { buildArxivQuery, normalizeKeyword, searchArxiv, arxivDetail, arxivSearchByDoi } from './sources/arxiv'
export { searchSemanticScholar, semanticScholarDetail } from './sources/semantic-scholar'
export {
  cooldownGuard,
  gateArxiv,
  gateFor,
  gateS2,
  resetCooldown,
  retryWaitOf,
  setCooldown,
  upstreamOf,
} from './http'
export { parseXml, findChild, findAllChildren, findAllDescendants, textOfCollapsed } from './xml'
export { AcademicSourceError } from './types'
export type { Paper, CitationFormat, PaperSource, ResolvedConfig } from './types'
