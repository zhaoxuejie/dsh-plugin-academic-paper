/**
 * Semantic Scholar 数据源封装。
 *
 * 接口：https://api.semanticscholar.org/graph/v1（公开 API，无需鉴权，有共享限流）。
 * - searchSemanticScholar：搜索（作者/年份在本地过滤，排序在本地完成 —— S2 搜索仅支持相关性排序）。
 * - semanticScholarDetail：按 paperId / DOI / arXiv ID / CorpusId 获取单篇详情。
 *
 * 限流策略（PRD §6.2.2 / §8）：
 * - 有 API Key 时携带 x-api-key 走独立配额（官方入门 1 RPS）。无 key 时吃全体未鉴权用户
 *   共享的池子，实测稳定 429 且退避无解 —— 因此 429 不重试，直接提示配置 key 或换时间。
 * - 所有请求经 gateS2 排队（默认 1.2 秒间隔），冷却期内直接拒绝，不发上游请求。
 * - 5xx 仍按单次退避重试；429 由 http.ts 统一记为不可重试。
 */

import { cooldownGuard, gateS2, httpJson, httpJsonWithRetry } from '../http'
import { AcademicSourceError } from '../types'
import type { HttpOptions, Paper, PaperSource, SearchFilter } from '../types'

const S2_BASE = 'https://api.semanticscholar.org/graph/v1'

/**
 * 搜索阶段字段：不含 abstract。
 * 单条摘要有几百字，默认拉 50 条就是几百 KB 的响应体；搜索结果渲染只截 280 字，
 * 完整摘要留给 academic_paper_detail 再取。
 */
const S2_SEARCH_FIELDS = [
  'title',
  'authors',
  'year',
  'publicationDate',
  'venue',
  'citationCount',
  'externalIds',
  'url',
  'journal',
  'isOpenAccess',
  'openAccessPdf',
  'publicationTypes',
].join(',')

/** 详情阶段字段：保留 abstract。 */
const S2_FIELDS = [
  'title',
  'abstract',
  'authors',
  'year',
  'publicationDate',
  'venue',
  'citationCount',
  'externalIds',
  'url',
  'journal',
  'isOpenAccess',
  'openAccessPdf',
  'publicationTypes',
].join(',')

/** S2 请求头：配置了 API Key 就带上，没配则由服务端按共享池限流。 */
function s2Headers(opts: HttpOptions): Record<string, string> {
  return opts.s2ApiKey ? { 'x-api-key': opts.s2ApiKey } : {}
}

interface S2Author {
  authorId?: string
  name: string
}

interface S2ExternalIds {
  DOI?: string
  ArXiv?: string
  CorpusId?: number
  MAG?: string
  DBLP?: string
}

interface S2Journal {
  name?: string
  volume?: string
  pages?: string
}

interface S2OpenAccessPdf {
  url?: string | null
  status?: string | null
}

interface S2Paper {
  paperId: string
  title?: string | null
  abstract?: string | null
  authors?: S2Author[]
  year?: number | null
  publicationDate?: string | null
  venue?: string | null
  citationCount?: number | null
  externalIds?: S2ExternalIds
  url?: string | null
  journal?: S2Journal | null
  isOpenAccess?: boolean | null
  openAccessPdf?: S2OpenAccessPdf | null
}

interface S2SearchResponse {
  total?: number
  offset?: number
  data: S2Paper[]
}

/** 将 S2 论文对象映射为统一 Paper 结构。 */
export function s2PaperToPaper(raw: S2Paper, fallbackSource: PaperSource = 'semantic_scholar'): Paper | null {
  if (!raw || typeof raw.paperId !== 'string') return null
  const arxivId = raw.externalIds?.ArXiv
  const paper: Paper = {
    id: `s2:${raw.paperId}`,
    source: fallbackSource,
    title: raw.title?.trim() || '(无标题)',
    authors: (raw.authors ?? []).map((author) => author.name).filter((name) => name !== ''),
    abstract: raw.abstract?.trim() ?? '',
    year: raw.year ?? 0,
    doi: raw.externalIds?.DOI || undefined,
    arxivId: arxivId || undefined,
    journal: raw.journal?.name?.trim() || raw.venue?.trim() || undefined,
    citationCount: raw.citationCount ?? undefined,
    pdfUrl: raw.openAccessPdf?.url?.trim() || undefined,
    officialUrl: raw.url?.trim() || undefined,
  }
  return paper
}

/** 作者本地过滤：任一作者名包含关键词（不区分大小写）。 */
function matchesAuthor(paper: S2Paper, author: string): boolean {
  const needle = author.trim().toLowerCase()
  if (!needle) return true
  return (paper.authors ?? []).some((a) => a.name.toLowerCase().includes(needle))
}

/** 年份本地过滤。 */
function matchesYear(paper: S2Paper, yearFrom?: number, yearTo?: number): boolean {
  const year = paper.year ?? 0
  if (!year) return yearFrom === undefined && yearTo === undefined
  if (yearFrom !== undefined && year < yearFrom) return false
  if (yearTo !== undefined && year > yearTo) return false
  return true
}

function compareForSort(a: Paper, b: Paper, sort: SearchFilter['sort']): number {
  if (sort === 'date') return (b.year || 0) - (a.year || 0)
  if (sort === 'citations') return (b.citationCount || 0) - (a.citationCount || 0)
  return 0
}

/**
 * S2 搜索。作者/年份为本地过滤（S2 搜索接口无对应参数），
 * 因此先取较大上限再过滤，保证过滤后仍能凑满 maxResults。
 */
export async function searchSemanticScholar(filter: SearchFilter, opts: HttpOptions): Promise<Paper[]> {
  const keyword = filter.keyword.trim()
  if (!keyword) {
    throw new AcademicSourceError('INVALID_ARG', 'academic_search: keyword 不能为空')
  }
  cooldownGuard('semantic_scholar', 'Semantic Scholar')
  const maxResults = Math.min(Math.max(1, filter.maxResults), 50)
  // S2 单页 limit 上限 100；过滤损耗按 2 倍放大即可（原先固定 50 起会让「要 1 条」也拉 50 条）。
  const fetchLimit = Math.min(Math.max(maxResults * 2, 20), 100)
  const url = `${S2_BASE}/paper/search?query=${encodeURIComponent(keyword)}&limit=${fetchLimit}&fields=${encodeURIComponent(S2_SEARCH_FIELDS)}&sort=relevance:desc`
  const response = await httpJsonWithRetry<S2SearchResponse>(
    () => gateS2(() => httpJson<S2SearchResponse>(url, opts, s2Headers(opts))),
    4000,
  )
  const filtered = (response.data ?? [])
    .filter((raw) => matchesAuthor(raw, filter.author ?? ''))
    .filter((raw) => matchesYear(raw, filter.yearFrom, filter.yearTo))
  const papers = filtered
    .map((raw) => s2PaperToPaper(raw))
    .filter((paper): paper is Paper => paper !== null)
  if (filter.sort !== 'relevance') papers.sort((a, b) => compareForSort(a, b, filter.sort))
  return papers.slice(0, maxResults)
}

/**
 * S2 单篇详情。identifier 支持：paperId（S2 的 40 位十六进制 id 或 CorpusId 数字）、
 * DOI（自动加 "DOI:" 前缀）、arXiv ID（自动加 "arXiv:" 前缀）。
 * 不存在的论文返回 null。
 */
export async function semanticScholarDetail(
  identifier: { paperId?: string; doi?: string; arxivId?: string },
  opts: HttpOptions,
): Promise<Paper | null> {
  cooldownGuard('semantic_scholar', 'Semantic Scholar')
  let path: string
  if (identifier.doi && identifier.doi.trim() !== '') {
    const doi = identifier.doi.trim()
    if (!/^10\.\S+$/i.test(doi)) {
      throw new AcademicSourceError('INVALID_ARG', `无效的 DOI：${doi}`)
    }
    path = `DOI:${doi}`
  } else if (identifier.arxivId && identifier.arxivId.trim() !== '') {
    path = `arXiv:${identifier.arxivId.trim().replace(/^arXiv:/i, '')}`
  } else if (identifier.paperId && identifier.paperId.trim() !== '') {
    path = identifier.paperId.trim().replace(/^s2:/, '')
  } else {
    throw new AcademicSourceError('INVALID_ARG', 'academic_paper_detail: 需提供 paperId / doi / arxivId 之一')
  }

  const url = `${S2_BASE}/paper/${encodeURIComponent(path)}?fields=${encodeURIComponent(S2_FIELDS)}`
  const response = await httpJsonWithRetry<S2Paper>(
    () => gateS2(() => httpJson<S2Paper>(url, opts, s2Headers(opts))),
    4000,
  )
  if (!response || typeof response.paperId !== 'string') return null
  return s2PaperToPaper(response)
}
