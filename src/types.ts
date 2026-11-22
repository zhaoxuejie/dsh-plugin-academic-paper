/**
 * 类型定义 —— dsh-plugin-academic-paper 的统一数据契约。
 * 检索/详情/文献库/引用/UI 路由共享同一套类型，避免各模块自行定义漂移。
 */

/** 数据源标识。 */
export type PaperSource = 'arxiv' | 'semantic_scholar'

/** 支持的数据源选择（含 both = arXiv + Semantic Scholar 合并去重）。 */
export type SourceSelection = PaperSource | 'both'

/** 引用格式。 */
export type CitationFormat = 'gb_t_7714' | 'apa' | 'bibtex'

/** 检索排序方式。 */
export type SortOrder = 'relevance' | 'date' | 'citations'

/**
 * 关键词匹配方式（仅 arXiv 生效）。
 * - all：每个词都要出现（默认，召回高）
 * - phrase：连续完整短语（精度高，召回低）
 * 关键词自带引号时自动按 phrase 处理。
 */
export type MatchMode = 'all' | 'phrase'

/**
 * 单篇论文统一结构（对应 PRD §4.1 Paper）。
 * - id：内部唯一 ID，`arxiv:<arxivId>` 或 `s2:<semanticScholarPaperId>`，
 *   供 detail / add / cite / remove 工具引用。
 * - source：论文实际来源数据源。
 */
export interface Paper {
  id: string
  source: PaperSource
  title: string
  authors: string[]
  abstract: string
  year: number
  doi?: string
  arxivId?: string
  journal?: string
  citationCount?: number
  pdfUrl?: string
  officialUrl?: string
  /** 加入文献库时间戳（仅文献库中的条目有值）。 */
  addedAt?: number
}

/** 检索历史条目（对应 PRD §4.1 SessionState.searchHistory）。 */
export interface SearchHistoryEntry {
  keyword: string
  timestamp: number
  resultCount: number
}

/** 单会话状态（对应 PRD §4.1 SessionState），全部保存在内存。 */
export interface SessionState {
  library: Paper[]
  searchHistory: SearchHistoryEntry[]
  /** id / arxivId / doi 别名 → Paper 的索引，用于 paperId 解析与详情回填。 */
  papersById: Map<string, Paper>
  /** 检索结果缓存，key = 源|关键词|作者|年份|排序|条数，value = 结果 + 时间戳。 */
  cache: Map<string, { papers: Paper[]; ts: number }>
  /** 会话最近活动时间戳（UI 面板用于默认选中最近活跃会话）。 */
  updatedAt: number
}

/** 归一化后的运行配置（对应 PRD §3.3 配置项 + §6.1 缓存上限约束）。 */
export interface ResolvedConfig {
  enable: boolean
  default_source: SourceSelection
  max_results: number
  default_cite_format: CitationFormat
  request_timeout: number
  enable_cache: boolean
  /** 单会话检索结果缓存最大条目数（防止内存膨胀，PRD §6.1）。 */
  max_cache_entries: number
  /** 检索缓存有效期（秒）。 */
  cache_ttl_seconds: number
  /** 单会话文献库最大条目数。 */
  max_library_size: number
  /**
   * Semantic Scholar API Key。
   * 配置项优先，缺省回退环境变量 S2_API_KEY（只读环境变量即可，密钥不必落盘）。
   */
  semantic_scholar_api_key: string
}

/** 统一检索过滤条件。 */
export interface SearchFilter {
  keyword: string
  author?: string
  yearFrom?: number
  yearTo?: number
  maxResults: number
  sort: SortOrder
  /** 关键词匹配方式；缺省按 all 处理（关键词自带引号时按 phrase）。 */
  matchMode?: MatchMode
}

/** HTTP 请求通用选项。 */
export interface HttpOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** Semantic Scholar API Key；缺省时按共享池限流处理。 */
  s2ApiKey?: string
}

/** 数据源层抛出的可读错误（含友好 message 与可选 code）。 */
export class AcademicSourceError extends Error {
  readonly code: string
  readonly retriable: boolean
  /** 429 响应携带的 Retry-After 秒数（缺省 undefined → 用默认退避）。 */
  readonly retryAfterSeconds?: number

  constructor(
    code: string,
    message: string,
    retriable = false,
    options?: ErrorOptions & { retryAfterSeconds?: number },
  ) {
    super(message, options)
    this.name = 'AcademicSourceError'
    this.code = code
    this.retriable = retriable
    this.retryAfterSeconds = options?.retryAfterSeconds
  }
}

/** 工具执行上下文的最小结构（仅取本插件需要的字段，避免依赖 cordis 类型）。 */
export interface ExecLike {
  signal: AbortSignal
  agent?: { id?: unknown }
}

/** 工具 JSON Schema 属性（本插件用到的子集）。 */
export interface JsonSchemaProp {
  type: string
  description?: string
  enum?: string[]
  min?: number
  max?: number
  default?: unknown
}

/** 工具注册定义（与 ctx.tools.register 的裸 JSON Schema 形态一致）。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, JsonSchemaProp>
    required?: string[]
    additionalProperties?: boolean
  }
  timeoutMs?: number
  output?: {
    schema: unknown
    render?: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>, exec: ExecLike) => Promise<unknown> | unknown
}
