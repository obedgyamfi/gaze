// ── Scheduler — the single owner of all outbound work ─────────────────────────
// Per-host token bucket (politeness) + per-host and global concurrency caps +
// priority queue + cancellation. Every collector/oracle submits here; nothing else
// decides when a request goes out. Clock/sleep are injectable for deterministic tests.

import { type Bucket, newBucket, take } from "./token-bucket.js"

export interface HostBudget {
  rps: number
  concurrency: number
}

export interface TaskOpts {
  host: string
  /** 0 = highest. Defaults to 1. */
  priority?: 0 | 1 | 2
  signal?: AbortSignal
}

export interface Scheduler {
  submit<T>(task: (signal: AbortSignal) => Promise<T>, opts: TaskOpts): Promise<T>
  /** Fire tasks as simultaneously as the runtime allows, bypassing the rate limiter
   *  (the point of a race is concurrency). Returns settled results. */
  burst<T>(tasks: ((signal: AbortSignal) => Promise<T>)[], opts?: { signal?: AbortSignal }): Promise<PromiseSettledResult<T>[]>
  budget(host: string): HostBudget
}

export interface SchedulerConfig {
  defaultRps?: number
  hostConcurrency?: number
  globalConcurrency?: number
  perHost?: Record<string, Partial<HostBudget>>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface QItem {
  task: (signal: AbortSignal) => Promise<unknown>
  opts: TaskOpts
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export function createScheduler(cfg: SchedulerConfig = {}): Scheduler {
  const now = cfg.now ?? (() => Date.now())
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const defaultRps = cfg.defaultRps ?? 8
  const hostConcurrency = cfg.hostConcurrency ?? 4
  const globalConcurrency = cfg.globalConcurrency ?? 16

  const budget = (host: string): HostBudget => ({
    rps: cfg.perHost?.[host]?.rps ?? defaultRps,
    concurrency: cfg.perHost?.[host]?.concurrency ?? hostConcurrency,
  })

  const buckets = new Map<string, Bucket>()
  const hostRunning = new Map<string, number>()
  let globalRunning = 0
  const queues: QItem[][] = [[], [], []] // by priority (0 highest)
  let pumping = false

  const run = (item: QItem) => {
    globalRunning++
    hostRunning.set(item.opts.host, (hostRunning.get(item.opts.host) ?? 0) + 1)
    const ac = new AbortController()
    if (item.opts.signal) {
      if (item.opts.signal.aborted) ac.abort()
      else item.opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
    }
    Promise.resolve()
      .then(() => item.task(ac.signal))
      .then(item.resolve, item.reject)
      .finally(() => {
        globalRunning--
        hostRunning.set(item.opts.host, (hostRunning.get(item.opts.host) ?? 1) - 1)
        void pump()
      })
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (globalRunning >= globalConcurrency) return
        let picked: QItem | undefined
        let minWait = Number.POSITIVE_INFINITY
        outer: for (const q of queues) {
          for (let i = 0; i < q.length; i++) {
            const it = q[i]
            if (!it) continue
            const b = budget(it.opts.host)
            if ((hostRunning.get(it.opts.host) ?? 0) >= b.concurrency) continue
            const cur = buckets.get(it.opts.host) ?? newBucket(b.rps, now())
            const t = take(cur, now(), b.rps, b.rps, 1)
            buckets.set(it.opts.host, t.bucket)
            if (t.ok) {
              picked = it
              q.splice(i, 1)
              break outer
            }
            minWait = Math.min(minWait, t.waitMs)
          }
        }
        if (!picked) {
          // Blocked only by rate → wake after the shortest wait. Blocked by
          // concurrency → a completing task will re-pump.
          if (Number.isFinite(minWait)) {
            pumping = false
            await sleep(minWait)
            void pump()
          }
          return
        }
        run(picked)
      }
    } finally {
      pumping = false
    }
  }

  return {
    budget,
    burst<T>(
      tasks: ((signal: AbortSignal) => Promise<T>)[],
      opts?: { signal?: AbortSignal },
    ): Promise<PromiseSettledResult<T>[]> {
      const ac = new AbortController()
      if (opts?.signal) {
        if (opts.signal.aborted) ac.abort()
        else opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
      }
      return Promise.allSettled(tasks.map((t) => t(ac.signal)))
    },
    submit<T>(task: (signal: AbortSignal) => Promise<T>, opts: TaskOpts): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const q = queues[opts.priority ?? 1] ?? queues[1]!
        q.push({
          task: task as (s: AbortSignal) => Promise<unknown>,
          opts,
          resolve: resolve as (v: unknown) => void,
          reject,
        })
        void pump()
      })
    },
  }
}
