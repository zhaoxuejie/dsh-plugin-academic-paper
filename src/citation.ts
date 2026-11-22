/**
 * 引用格式生成器 —— 本地确定性生成，不依赖大模型，保证格式准确（PRD §3.2 功能3 / §6.2.5）。
 *
 * 支持三种格式：
 * - GB/T 7714（2015）：中文论文常用。作者（>3 人取前 3 + "等"）＋题名[J]/[EB/OL]。
 * - APA（第 7 版）：社科常用。作者（≤20 全列，>20 前 19 + "…" + 末位）。
 * - BibTeX：LaTeX 用户常用。@article 条目，key 由「姓氏+年份+题名首词」生成。
 *
 * 字段容错：缺失作者用占位/省略，缺失年份用 (n.d.)/省略，缺失来源退化为电子文献格式；
 * 任意意外错误回退到「作者. 题名. 年份.」基础格式。
 */

import type { CitationFormat, Paper } from './types'

/** 是否全为 CJK 字符（中文姓名不做 "姓 名" 拆分）。 */
const CJK_RE = /^[\u3400-\u9fff]+$/
/** 形如 "1706.03762v3" 的 arXiv ID。 */
const ARXIV_RE = /^\d{4}\.\d{4,5}(?:v\d+)?$/

export interface SplitName {
  surname: string
  given: string
}

/** 把 "Given Family" 或 "Family, Given" 拆为 { surname, given }。 */
export function splitName(full: string): SplitName {
  const name = full.trim()
  if (name === '') return { surname: '', given: '' }
  if (CJK_RE.test(name)) return { surname: name, given: '' }
  const comma = name.indexOf(',')
  if (comma !== -1) {
    const surname = name.slice(0, comma).trim()
    const given = name.slice(comma + 1).trim()
    return { surname, given }
  }
  const parts = name.split(/\s+/)
  const surname = parts.pop() ?? ''
  return { surname, given: parts.join(' ') }
}

/** GB/T 7714 作者段：Vaswani A, Shazeer N, Parmar N, 等 */
function gbAuthorPart(authors: string[]): string {
  const names = authors.map((name) => {
    const { surname, given } = splitName(name)
    if (CJK_RE.test(surname)) return surname
    if (!surname) return name
    const initials = given
      .replace(/\./g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('')
    return initials ? `${surname} ${initials}` : surname
  }).filter(Boolean)
  if (names.length === 0) return '[佚名]'
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')}, 等`
}

/** APA 作者段：Vaswani, A., Shazeer, N., & Parmar, N. */
function apaAuthorPart(authors: string[]): string {
  const names = authors.map((name) => {
    const { surname, given } = splitName(name)
    if (CJK_RE.test(surname)) return surname
    if (!surname) return name
    const initials = given
      .replace(/\./g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => `${word[0]?.toUpperCase() ?? ''}.`)
      .join(' ')
    return initials ? `${surname}, ${initials}` : surname
  }).filter(Boolean)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]}, & ${names[1]}`
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}`
  return `${names.slice(0, 19).join(', ')}, … ${names.at(-1)}`
}

/** BibTeX 作者段：Vaswani, Ashish and Shazeer, Noam */
function bibAuthorPart(authors: string[]): string {
  const names = authors.map((name) => {
    const { surname, given } = splitName(name)
    if (CJK_RE.test(surname)) return surname
    if (!surname) return name
    return given ? `${surname}, ${given}` : surname
  }).filter(Boolean)
  return names.join(' and ')
}

/** 转义 LaTeX/BibTeX 特殊字符。 */
export function escapeLatex(value: string): string {
  return value.replace(/([%&#_{}])/g, (char) => `\\${char}`)
}

/** BibTeX 引用键：姓氏+年份+题名首词，全部小写字母数字。 */
export function bibtexKey(paper: Paper): string {
  const surname = splitName(paper.authors[0] ?? '').surname.toLowerCase().replace(/[^a-z0-9]/g, '') || 'anon'
  const year = paper.year > 0 ? String(paper.year) : ''
  const firstWord = (paper.title.match(/[A-Za-z][A-Za-z0-9]*/) ?? ['paper'])[0]!.toLowerCase()
  const key = `${surname}${year}${firstWord}`
  return /^[a-z]/.test(key) ? key : `p${key}`
}

/** 今天日期（本地时区，YYYY-MM-DD），用于 [EB/OL] 的引用日期。 */
export function todayString(): string {
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** 期刊引用串的结构化解析结果。raw 总是保留原始串，供解析失败时回退。 */
export interface ParsedJournalRef {
  name?: string
  volume?: string
  issue?: string
  pages?: string
  year?: string
  /** 原始 journal 串（arXiv 的 arxiv:journal_ref 或 S2 的 venue）。 */
  raw?: string
}

/**
 * 解析期刊引用串。
 *
 * arXiv 的 arxiv:journal_ref 是自由文本，各刊各年代格式不统一，典型形如
 * `Physical Review Research vol. 4, no. 2, page 023066, April 2022`。
 * 之前这个串被原样拼进 GB/T 7714 的 [J] 段，输出成
 * `Physical Review Research vol. 4, no. 2, page 023066, April 2022, 2020` —— 卷期页码成了自由文本，
 * 年份还出现两次且互相矛盾（刊年 2022 vs arXiv 预印本年 2020）。
 *
 * 解析失败时返回仅含 raw 的对象，由调用方回退原文，绝不丢信息。
 */
export function parseJournalRef(raw?: string): ParsedJournalRef {
  if (typeof raw !== 'string') return {}
  const text = raw.trim()
  if (text === '') return {}
  try {
    const volume = /\bvol\.?\s*([\w.]+)/iu.exec(text)?.[1]
    const issue = /\b(?:no\.?|issue|number)\.?\s*([\w.]+)/iu.exec(text)?.[1]
    const pages = /\b(?:pages?|pp)\.?\s*([\w–—-]+)/iu.exec(text)?.[1]
    const year = /\b(?:19|20)\d{2}\b/u.exec(text)?.[0]
    // 刊名 = 到第一个分隔符（逗号/分号）或卷期页码标记为止的那一段。
    const head = text.split(/[,;]|\bvol\.?|\bno\.?|\bpages?\b|\bpp\.?\b/iu)[0]
    const name = head && head.trim() !== '' ? head.trim().replace(/\.$/u, '') : undefined
    const parsed: ParsedJournalRef = { name, volume, issue, pages, year, raw: text }
    // 只有真的解析出刊名或卷期才算成功，否则交给调用方回退原文。
    if (!parsed.name && !parsed.volume && !parsed.issue) return { raw: text }
    return parsed
  } catch {
    return { raw: text }
  }
}

/** GB/T 7714-2015 引用。 */
export function formatGbT7714(paper: Paper, citedDate = todayString()): string {
  const authorPart = gbAuthorPart(paper.authors)
  const title = paper.title.trim() || '(无题名)'
  const journal = paper.journal?.trim()
  if (journal) {
    const j = parseJournalRef(journal)
    // 期刊正式出版年优先于 arXiv 预印本年，避免「2022, 2020」这类矛盾。
    const year = j.year ?? (paper.year > 0 ? String(paper.year) : '出版年不详')
    let cite: string
    if (j.name) {
      const volPart = j.volume ? `, ${j.volume}` : ''
      const issuePart = j.issue ? `(${j.issue})` : ''
      const pagePart = j.pages ? `: ${j.pages}` : ''
      cite = `${j.name}, ${year}${volPart}${issuePart}${pagePart}`
    } else {
      // 解析失败：保留原始串，只补年份，不丢信息。
      cite = `${journal}${/\b(?:19|20)\d{2}\b/u.test(journal) ? '' : `, ${year}`}`
    }
    const base = `${authorPart}. ${title}[J]. ${cite}.`
    return paper.doi ? `${base} DOI: ${paper.doi}.` : base
  }
  // 电子文献（arXiv 预印本等）
  const pubDate = paper.year > 0 ? String(paper.year) : ''
  const datePart = pubDate ? `(${pubDate})[${citedDate}]` : `[${citedDate}]`
  const url = paper.officialUrl || paper.pdfUrl
  const doiPart = paper.doi ? ` DOI: ${paper.doi}.` : ''
  const urlPart = url ? ` ${url}.` : ''
  return `${authorPart}. ${title}[EB/OL]. ${datePart}.${doiPart}${urlPart}`
}

/** APA（第 7 版）引用。 */
export function formatApa(paper: Paper): string {
  const authorPart = apaAuthorPart(paper.authors)
  const yearPart = paper.year > 0 ? String(paper.year) : 'n.d.'
  const title = paper.title.trim() || '(Untitled)'
  const journalRaw = paper.journal?.trim()
  const journalParsed: ParsedJournalRef = journalRaw ? parseJournalRef(journalRaw) : {}
  // 期刊正式出版年优先于 arXiv 预印本年。
  const apaYear = journalParsed.year ?? yearPart
  let source = ''
  if (journalParsed.name) {
    const volPart = journalParsed.volume ? `, ${journalParsed.volume}` : ''
    const issuePart = journalParsed.issue ? `(${journalParsed.issue})` : ''
    const pagePart = journalParsed.pages ? `, ${journalParsed.pages}` : ''
    source = `${journalParsed.name}${volPart}${issuePart}${pagePart}`
  } else if (journalRaw) {
    source = journalRaw
  } else if (paper.arxivId && ARXIV_RE.test(paper.arxivId)) {
    source = `arXiv preprint arXiv:${paper.arxivId}`
  }
  const location = paper.doi
    ? `https://doi.org/${paper.doi}`
    : (paper.pdfUrl || paper.officialUrl)
  const head = authorPart ? `${authorPart} (${apaYear}). ${title}.` : `${title}. (${apaYear}).`
  const sourcePart = source ? ` ${source}.` : ''
  return `${head}${sourcePart}${location ? ` ${location}` : ''}`
}

/** BibTeX 引用。 */
export function formatBibtex(paper: Paper): string {
  const key = bibtexKey(paper)
  const fields: Array<[string, string]> = []
  fields.push(['title', `{${escapeLatex(paper.title.trim() || '(Untitled)')}}`])
  if (paper.authors.length > 0) fields.push(['author', `{${bibAuthorPart(paper.authors)}}`])
  if (paper.year > 0) fields.push(['year', String(paper.year)])
  const journal = paper.journal?.trim()
  if (journal) {
    const parsed = parseJournalRef(journal)
    fields.push(['journal', `{${escapeLatex(parsed.name ?? journal)}}`])
    if (parsed.volume) fields.push(['volume', parsed.volume])
    if (parsed.issue) fields.push(['number', parsed.issue])
    if (parsed.pages) fields.push(['pages', parsed.pages])
  }
  if (paper.doi) fields.push(['doi', paper.doi])
  if (paper.arxivId && ARXIV_RE.test(paper.arxivId)) {
    fields.push(['eprint', paper.arxivId])
    fields.push(['archivePrefix', '{arXiv}'])
  }
  const url = paper.pdfUrl || paper.officialUrl
  if (url) fields.push(['url', `{${url}}`])
  const lines = fields.map(([name, value]) => `  ${name} = ${value},`).join('\n')
  return `@article{${key},\n${lines}\n}`
}

/** 统一入口：按格式生成引用，异常时回退基础格式（PRD §6.2.5）。 */
export function formatCitation(paper: Paper, format: CitationFormat): string {
  try {
    switch (format) {
      case 'apa':
        return formatApa(paper)
      case 'bibtex':
        return formatBibtex(paper)
      case 'gb_t_7714':
      default:
        return formatGbT7714(paper)
    }
  } catch {
    const parts = [paper.authors?.join(', '), paper.title, paper.year > 0 ? String(paper.year) : '']
      .filter((part) => part !== undefined && part !== '')
    return parts.join('. ') + '.'
  }
}
