/**
 * 本地文献库管理 —— 按会话隔离，全部保存在内存（PRD §3.2 功能4 / §4.1）。
 *
 * - 会话隔离：以 session id 为 key，每个 session 独立维护文献库、检索历史与缓存。
 * - 去重：同一 DOI / arXiv ID / 标题不重复加入。
 * - 缓存：检索结果按「源|关键词|作者|年份|排序|条数」缓存，TTL + 上限防止内存膨胀（PRD §6.1）。
 * - 导出：BibTeX / Markdown 参考文献列表（PRD §3.2 功能5）。
 * - 卸载清理：clearAll() 清空全部会话状态。
 */

import { formatBibtex } from './citation'
import type { Paper, ResolvedConfig, SearchFilter, SessionState } from './types'

/** 默认会话 key（无 agent 上下文的调用，如部分 PTC 场景）。 */
const DEFAULT_SESSION = 'default'

function emptySession(): SessionState {
  return {
    library: [],
    searchHistory: [],
    papersById: new Map(),
    cache: new Map(),
    updatedAt: 0,
  }
}

export interface CacheKey {
  source: string
  filter: SearchFilter
}

/** 检索缓存 key 序列化（同一请求短期内不重复请求，PRD §3.3 enable_cache）。 */
export function cacheKeyOf(key: CacheKey): string {
  const f = key.filter
  return [
    key.source,
    f.keyword.trim().toLowerCase(),
    f.author?.trim().toLowerCase() ?? '',
    f.yearFrom ?? '',
    f.yearTo ?? '',
    f.sort,
    // matchMode 会改变 arXiv 查询构造，必须进 key，否则 phrase / all 互相串味。
    f.matchMode ?? '',
    f.maxResults,
  ].join('|')
}

/** 归一化标题用于去重（小写 + 空白折叠）。 */
function normTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

export class AcademicStore {
  private readonly sessions = new Map<string, SessionState>()

  /**
   * 同 key 的并发检索去重（single-flight）。
   * 缓存写点在请求之后（cacheSet 在网络返回后），两次相同查询并发进来都会 cache miss，
   * 于是各发一次上游请求。这里让后来的调用直接复用第一个调用的结果。
   */
  private readonly inflight = new Map<string, Promise<unknown>>()

  state(sessionKey = DEFAULT_SESSION): SessionState {
    let state = this.sessions.get(sessionKey)
    if (!state) {
      state = emptySession()
      this.sessions.set(sessionKey, state)
    }
    return state
  }

  /** 记录一次活动（检索/加入/删除/导出都刷新时间戳，供 UI 默认选中）。 */
  private touch(state: SessionState): void {
    state.updatedAt = Date.now()
  }

  /** 把一篇论文记入会话索引（搜索结果/详情回填后调用，供 paperId 后续引用）。 */
  remember(sessionKey: string, paper: Paper, state?: SessionState): void {
    const s = state ?? this.state(sessionKey)
    s.papersById.set(paper.id, paper)
    if (paper.arxivId) s.papersById.set(paper.arxivId, paper)
    if (paper.doi) s.papersById.set(`doi:${paper.doi.toLowerCase()}`, paper)
    this.touch(s)
  }

  /** 按 id / DOI / arXiv ID 在会话索引中查找已见过的论文。 */
  findKnown(sessionKey: string, paperId?: string, doi?: string, arxivId?: string): Paper | undefined {
    const s = this.state(sessionKey)
    if (paperId && paperId.trim() !== '') {
      const direct = s.papersById.get(paperId.trim())
      if (direct) return direct
      const byId = s.papersById.get(paperId.trim().replace(/^arxiv:/i, '').replace(/^s2:/, ''))
      if (byId) return byId
    }
    if (doi && doi.trim() !== '') {
      const hit = s.papersById.get(`doi:${doi.trim().toLowerCase()}`)
      if (hit) return hit
    }
    if (arxivId && arxivId.trim() !== '') {
      const hit = s.papersById.get(arxivId.trim())
      if (hit) return hit
    }
    return undefined
  }

  /** 加入文献库，按 DOI / arXiv ID / 标题去重。返回 {success, msg}。 */
  addPaper(sessionKey: string, paper: Paper, maxLibrarySize: number): { success: boolean; msg: string } {
    const s = this.state(sessionKey)
    const doi = paper.doi?.trim().toLowerCase()
    const arxivId = paper.arxivId?.trim().toLowerCase()
    const title = normTitle(paper.title)
    const duplicated = s.library.find((existing) => {
      if (doi && existing.doi?.trim().toLowerCase() === doi) return true
      if (arxivId && existing.arxivId?.trim().toLowerCase() === arxivId) return true
      return normTitle(existing.title) === title
    })
    if (duplicated) {
      return { success: false, msg: `该文献已在文献库中（${duplicated.id}），未重复加入。` }
    }
    if (s.library.length >= maxLibrarySize) {
      return { success: false, msg: `文献库已达上限（${maxLibrarySize} 篇），请先删除部分文献再添加。` }
    }
    const entry: Paper = { ...paper, addedAt: Date.now() }
    s.library.push(entry)
    this.remember(sessionKey, entry, s)
    this.touch(s)
    return { success: true, msg: `已加入文献库（${entry.id}），当前共 ${s.library.length} 篇。` }
  }

  /** 从文献库删除单篇。 */
  removePaper(sessionKey: string, paperId: string): { success: boolean; msg: string } {
    const s = this.state(sessionKey)
    const target = paperId.trim()
    const index = s.library.findIndex((paper) => paper.id === target)
    if (index === -1) {
      return { success: false, msg: `文献库中不存在 ${target}。` }
    }
    s.library.splice(index, 1)
    this.touch(s)
    return { success: true, msg: `已从文献库删除 ${target}，剩余 ${s.library.length} 篇。` }
  }

  /** 清空某会话文献库。 */
  clear(sessionKey: string): { success: boolean; msg: string } {
    const s = this.state(sessionKey)
    const count = s.library.length
    s.library = []
    s.papersById.clear()
    this.touch(s)
    return { success: true, msg: `已清空文献库（${count} 篇）。` }
  }

  list(sessionKey: string): Paper[] {
    return this.state(sessionKey).library
  }

  /** 追加检索历史（成功后记录）。 */
  recordSearch(sessionKey: string, keyword: string, resultCount: number): void {
    const s = this.state(sessionKey)
    s.searchHistory.push({ keyword, timestamp: Date.now(), resultCount })
    if (s.searchHistory.length > 100) s.searchHistory.shift()
    this.touch(s)
  }

  /** 读取检索缓存（TTL 内命中；过期视为未命中）。 */
  cacheGet(sessionKey: string, key: string, ttlSeconds: number): Paper[] | undefined {
    if (!ttlSeconds) return undefined
    const s = this.state(sessionKey)
    const hit = s.cache.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.ts > ttlSeconds * 1000) {
      s.cache.delete(key)
      return undefined
    }
    return hit.papers
  }

  /**
   * 同 key 并发去重：已有在飞的同名检索就复用它的 Promise。
   * @param factory - 真正发起检索的函数；只在没有在飞请求时调用。
   */
  singleFlight<T>(sessionKey: string, key: string, factory: () => Promise<T>): Promise<T> {
    const flightKey = `${sessionKey}|${key}`
    const running = this.inflight.get(flightKey)
    if (running) return running as Promise<T>
    const task = factory().finally(() => {
      this.inflight.delete(flightKey)
    })
    this.inflight.set(flightKey, task)
    return task
  }

  /** 写入检索缓存（超上限时淘汰最旧条目）。 */
  cacheSet(sessionKey: string, key: string, papers: Paper[], maxEntries: number): void {
    const s = this.state(sessionKey)
    s.cache.set(key, { papers, ts: Date.now() })
    if (s.cache.size > maxEntries) {
      let oldestKey: string | undefined
      let oldestTs = Infinity
      for (const [k, v] of s.cache) {
        if (v.ts < oldestTs) {
          oldestTs = v.ts
          oldestKey = k
        }
      }
      if (oldestKey !== undefined) s.cache.delete(oldestKey)
    }
  }

  /** 导出文献库为 BibTeX 文本。 */
  exportBibtex(sessionKey: string): string {
    const papers = this.list(sessionKey)
    if (papers.length === 0) return '% 文献库为空'
    return papers.map((paper) => formatBibtex(paper)).join('\n\n')
  }

  /** 导出文献库为 Markdown 参考文献列表（带编号，可直接粘贴到论文）。 */
  exportMarkdown(sessionKey: string): string {
    const papers = this.list(sessionKey)
    if (papers.length === 0) return '文献库为空，暂无参考文献可导出。'
    const lines = papers.map((paper, index) => {
      const authors = paper.authors.length > 0 ? `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' 等' : ''}` : ''
      const year = paper.year > 0 ? `(${paper.year})` : ''
      const source = paper.journal ? `*${paper.journal}*` : ''
      const link = paper.doi ? `https://doi.org/${paper.doi}` : (paper.officialUrl || paper.pdfUrl)
      const parts = [`${index + 1}.`, authors, year, `"${paper.title}"`, source, link].filter(Boolean)
      return parts.join(' ')
    })
    return lines.join('\n')
  }

  /** 全部会话概览（UI 面板：id + 文献数 + 历史数 + 最近活动）。 */
  overview(): Array<{ id: string; paperCount: number; historyCount: number; updatedAt: number }> {
    const out: Array<{ id: string; paperCount: number; historyCount: number; updatedAt: number }> = []
    for (const [id, s] of this.sessions) {
      out.push({ id, paperCount: s.library.length, historyCount: s.searchHistory.length, updatedAt: s.updatedAt })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  /** 会话详情（UI 面板数据，序列化为普通对象）。 */
  snapshot(sessionKey: string): { library: Paper[]; history: Array<{ keyword: string; timestamp: number; resultCount: number }> } {
    const s = this.state(sessionKey)
    return {
      library: s.library.map((paper) => ({ ...paper })),
      history: s.searchHistory.map((entry) => ({ ...entry })),
    }
  }

  /** 会话 key 解析：无 agent 上下文时回退 default。 */
  static sessionKeyOf(exec: { agent?: { id?: unknown } } | undefined): string {
    const id = exec?.agent?.id
    return id === undefined || id === null ? DEFAULT_SESSION : String(id)
  }

  /** 卸载清理：清空全部会话状态（PRD §4.2）。 */
  clearAll(): void {
    this.sessions.clear()
    this.inflight.clear()
  }
}

/** 把 ResolvedConfig 与工具入参合并为 SearchFilter。入参为宽松对象，逐字段校验取值。 */
export function buildFilter(args: Record<string, unknown>, config: ResolvedConfig): SearchFilter {
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const num = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
    return undefined
  }
  const yearFrom = num(args.yearFrom)
  const yearTo = num(args.yearTo)
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw new Error(`academic_search: 年份范围无效（${yearFrom} > ${yearTo}）`)
  }
  const sort = args.sort === 'date' || args.sort === 'citations' ? args.sort : 'relevance'
  const matchMode = args.matchMode === 'phrase' || args.matchMode === 'all' ? args.matchMode : undefined
  const maxResults = num(args.maxResults) !== undefined
    ? Math.min(Math.max(1, num(args.maxResults)!), 50)
    : config.max_results
  return {
    keyword: str(args.keyword) ?? '',
    author: str(args.author),
    yearFrom,
    yearTo,
    maxResults,
    sort,
    matchMode,
  }
}
