/**
 * 共享 HTTP 工具：超时 + 外部取消合并、友好错误、请求闸与 429 冷却。
 * 仅访问公开学术 API 域名（由各数据源模块固定 URL，不接受用户输入 URL，PRD §6.1）。
 *
 * 限流防护（对应上游 429 实测行为）：
 * - arXiv 官方条款要求「每 3 秒最多 1 次、同时只允许 1 个连接」，见
 *   https://info.arxiv.org/help/api/tou.html 。本模块用 gateFor() 提供进程级串行闸，
 *   同一上游的请求排队且强制最小间隔，多个工具调用并发时不会齐发。
 * - 上游 429 通常不带 Retry-After（arXiv 响应体为空）。此时按来源写入冷却窗口，
 *   冷却期内直接抛可读错误，不再向上游发请求，避免「报错 → 立刻重试 → 更严重」的连击。
 * - 超时（TIMEOUT）不重试：同一条复杂查询重发通常仍会超时，只会白占一次窗口配额。
 */

import { AcademicSourceError } from './types'
import type { HttpOptions } from './types'

const DEFAULT_HEADERS = {
  accept: 'application/json, application/atom+xml, text/plain, */*',
  'user-agent': 'dsh-plugin-academic-paper/0.1.0 (DeepSeek Harness plugin)',
}

/** 上游来源标识（冷却窗口按来源隔离）。 */
export type UpstreamKey = 'arxiv' | 'semantic_scholar' | 'other'

/**
 * arXiv 最小请求间隔：官方要求 3 秒，留 0.5 秒余量避免卡在边界上。
 * Semantic Scholar 无 key 时共享池很紧，有 key 是 1 RPS；统一取 1.2 秒。
 */
export const ARXIV_MIN_GAP_MS = 3500
export const S2_MIN_GAP_MS = 1200

/** 429 且服务端未给 Retry-After 时的冷却时长（秒）。 */
const DEFAULT_COOLDOWN_SECONDS: Record<UpstreamKey, number> = {
  arxiv: 30,
  semantic_scholar: 60,
  other: 30,
}

/* ------------------------------------------------------------------ */
/* 请求闸：同上游串行 + 最小间隔                                        */
/* ------------------------------------------------------------------ */

interface GateState {
  /** 队列尾部：新请求接在它后面，保证串行。 */
  tail: Promise<unknown>
  /** 上一次请求结束的时间戳。 */
  lastAt: number
}

const GATES = new Map<UpstreamKey, GateState>()

/**
 * 取某个上游的请求闸。返回的函数会把 fn 排进该上游的队列，
 * 保证「同一时间只有 1 个请求在飞」且「相邻请求间隔不小于 minGapMs」。
 */
export function gateFor(key: UpstreamKey, minGapMs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    let state = GATES.get(key)
    if (!state) {
      state = { tail: Promise.resolve(), lastAt: 0 }
      GATES.set(key, state)
    }
    const slot = state.tail.then(async () => {
      const wait = state.lastAt + minGapMs - Date.now()
      if (wait > 0) await delay(wait)
      try {
        return await fn()
      } finally {
        // 无论成败都记时：失败的那次也占用过上游配额。
        state.lastAt = Date.now()
      }
    })
    // 队列尾不允许因单个请求失败而中断后续排队。
    state.tail = slot.catch(() => undefined)
    return slot
  }
}

export const gateArxiv = gateFor('arxiv', ARXIV_MIN_GAP_MS)
export const gateS2 = gateFor('semantic_scholar', S2_MIN_GAP_MS)

/* ------------------------------------------------------------------ */
/* 冷却窗口                                                            */
/* ------------------------------------------------------------------ */

const COOLDOWN_UNTIL = new Map<UpstreamKey, number>()

/** 从请求 URL 判断所属上游（URL 由各数据源模块固定，不含用户输入）。 */
export function upstreamOf(url: string): UpstreamKey {
  if (url.includes('arxiv.org')) return 'arxiv'
  if (url.includes('semanticscholar.org')) return 'semantic_scholar'
  return 'other'
}

function cooldownLeftMs(key: UpstreamKey): number {
  const until = COOLDOWN_UNTIL.get(key) ?? 0
  return Math.max(0, until - Date.now())
}

/** 记录冷却窗口（秒）。 */
export function setCooldown(key: UpstreamKey, seconds: number): void {
  COOLDOWN_UNTIL.set(key, Date.now() + Math.max(1, Math.round(seconds)) * 1000)
}

/** 清空全部冷却窗口（测试用）。 */
export function resetCooldown(): void {
  COOLDOWN_UNTIL.clear()
}

/**
 * 冷却守卫：冷却期内直接抛错，不向上游发请求。
 * @param label - 面向用户的来源名（如 "arXiv"）。
 */
export function cooldownGuard(key: UpstreamKey, label: string): void {
  const left = cooldownLeftMs(key)
  if (left > 0) {
    throw new AcademicSourceError(
      'COOLDOWN',
      `${label} 正处于限流冷却期，还需等待约 ${Math.ceil(left / 1000)} 秒。请勿立即重试；可改用其他 source，或稍后再调用。`,
      false,
    )
  }
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

interface PendingRequest {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  timedOut: boolean
  externalAborted: boolean
}

function buildRequest(opts: HttpOptions): PendingRequest {
  const controller = new AbortController()
  const pending: PendingRequest = { controller, timer: 0 as unknown as ReturnType<typeof setTimeout>, timedOut: false, externalAborted: false }
  pending.timer = setTimeout(() => {
    pending.timedOut = true
    controller.abort()
  }, opts.timeoutMs)
  if (opts.signal) {
    if (opts.signal.aborted) {
      pending.externalAborted = true
      controller.abort()
    } else {
      opts.signal.addEventListener('abort', () => {
        pending.externalAborted = true
        controller.abort()
      }, { once: true })
    }
  }
  return pending
}

function disposeRequest(pending: PendingRequest): void {
  clearTimeout(pending.timer)
}

function toFriendlyError(pending: PendingRequest, cause: unknown): AcademicSourceError {
  if (pending.externalAborted) {
    // 工具被取消（exec.signal）：保留取消语义，不包装成源错误。
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
  if (pending.timedOut) {
    // 不标可重试：复杂短语查询实测需 15–45 秒，重发同一条通常仍会超时，只会再占一次配额。
    return new AcademicSourceError(
      'TIMEOUT',
      '学术数据源响应超时（服务端负载可能较高）。重试同一条查询通常仍会超时，请改用更短的关键词或稍后再试。',
      false,
    )
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  return new AcademicSourceError('NETWORK', `无法连接学术数据源（${message}），请检查网络后重试。`, true)
}

/**
 * 请求文本响应。非 2xx 抛出带 HTTP 状态码的 AcademicSourceError。
 * 429 会写入冷却窗口并标记为不可重试（由调用方等待冷却后再发起新请求）。
 */
export async function httpText(url: string, opts: HttpOptions, headers: Record<string, string> = {}): Promise<string> {
  const pending = buildRequest(opts)
  try {
    const res = await fetch(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      signal: pending.controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      let retryAfterSeconds: number | undefined
      const raw = res.headers.get('retry-after')
      if (raw) {
        const parsed = Number.parseInt(raw, 10)
        if (Number.isFinite(parsed)) retryAfterSeconds = parsed
      }
      // 未读取的响应体需要显式释放，否则连接无法归还连接池，后续请求要重新握手。
      try {
        await res.body?.cancel()
      } catch {
        /* 连接已关闭或已被消费：忽略 */
      }
      const key = upstreamOf(url)
      if (res.status === 429) {
        const cooldownSeconds = retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS[key]
        setCooldown(key, cooldownSeconds)
        throw new AcademicSourceError(
          'HTTP_429',
          `数据源限流（429）。已进入 ${cooldownSeconds} 秒冷却期；请等待冷却结束再调用，不要立即重试，或改用其他 source。`,
          false,
          { retryAfterSeconds: cooldownSeconds },
        )
      }
      // 5xx 可重试；4xx 属于请求本身的问题，重试无益。
      const retriable = res.status >= 500
      throw new AcademicSourceError(
        `HTTP_${res.status}`,
        `数据源返回 HTTP ${res.status}，请稍后重试或切换数据源。`,
        retriable,
        { retryAfterSeconds },
      )
    }
    return await res.text()
  } catch (error) {
    if (error instanceof AcademicSourceError) throw error
    throw toFriendlyError(pending, error)
  } finally {
    disposeRequest(pending)
  }
}

/** 请求 JSON 响应。 */
export async function httpJson<T>(url: string, opts: HttpOptions, headers: Record<string, string> = {}): Promise<T> {
  const text = await httpText(url, opts, headers)
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new AcademicSourceError(
      'BAD_RESPONSE',
      '数据源返回了无法解析的内容，请稍后重试或更换数据源。',
      true,
      { cause: error instanceof Error ? error : undefined },
    )
  }
}

/** 等待指定毫秒。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const DEFAULT_RETRY_DELAY_MS = 5000
const MAX_RETRY_DELAY_MS = 15000

/** 加 0–50% 抖动：并发调用不会在同一毫秒齐发重试。 */
function withJitter(ms: number): number {
  return Math.round(ms * (1 + Math.random() * 0.5))
}

/**
 * 计算退避等待。若服务端要求等待超过上限，则不做无效重试，
 * 直接抛出带可操作提示的错误（省掉一次必然失败的请求与等待）。
 */
export function retryWaitOf(error: AcademicSourceError, fallbackDelayMs: number): number {
  if (error.retryAfterSeconds === undefined) return withJitter(fallbackDelayMs)
  if (error.retryAfterSeconds * 1000 > MAX_RETRY_DELAY_MS) {
    throw new AcademicSourceError(
      error.code,
      `数据源要求冷却 ${error.retryAfterSeconds} 秒（超出单次重试上限），请稍后再试或切换到其他数据源。`,
      false,
    )
  }
  return withJitter(Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS))
}

/**
 * 带单次退避重试的请求：遇 5xx / 网络抖动时等待后重试一次；仍失败原样抛出。
 * 注意：429 与 TIMEOUT 均为不可重试（见 httpText / toFriendlyError），
 * 因此这里只处理真正的瞬时故障。
 */
export async function httpTextWithRetry(
  request: () => Promise<string>,
  fallbackDelayMs = DEFAULT_RETRY_DELAY_MS,
): Promise<string> {
  try {
    return await request()
  } catch (error) {
    if (!(error instanceof AcademicSourceError) || !error.retriable) throw error
    await delay(retryWaitOf(error, fallbackDelayMs))
    return request()
  }
}

/** 合并外部信号与超时的通用版本（供需要两次以上重试的调用方使用）。 */
export async function httpJsonWithRetry<T>(
  request: () => Promise<T>,
  fallbackDelayMs = DEFAULT_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (!(error instanceof AcademicSourceError) || !error.retriable) throw error
    await delay(retryWaitOf(error, fallbackDelayMs))
    return request()
  }
}
