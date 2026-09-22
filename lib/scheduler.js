// dsh-wb-cron — 调度器：tick 循环、到期判定、串行队列、错过处理、看门狗协同。
//
// 纪律（设计 §5）：
// - tick 用墙钟判定，不信任定时器精度；
// - 任何触发决策（fire/skip）先落 history 再动作，nextFire 前移先写盘再放行；
// - 补跑纪律：唤醒后最多补跑一次，绝不回放积压；
// - 单个任务的任何异常都 catch 在本层：调度循环永不因单个任务崩溃；
// - 同一任务上一次还在跑 → skipped-overlap；全局并发默认串行。

import { randomUUID } from 'node:crypto';

const MISSED_TOLERANCE_MS = 2 * 60_000;

function iso(ms) { return new Date(ms).toISOString(); }

/**
 * @param {object} deps
 * @param {object} deps.store   createStore() 的存储
 * @param {function} deps.fireJob createFire() 的 fireJob
 * @param {object} [deps.logger] { log, warn }
 * @param {object} deps.config  { tickMs, maxConcurrentJobs }
 */
export function createScheduler({ store, fireJob, logger = console, config = {} }) {
  const tickMs = config.tickMs ?? 30_000;
  const maxConcurrent = config.maxConcurrentJobs ?? 1;
  /** jobId → { runId, startedAt, title } */
  const running = new Map();
  const cancelRequested = new Set();
  let timer = null;
  let lastTickMs = 0;

  const state = () => ({
    alive: timer !== null,
    lastTick: lastTickMs ? iso(lastTickMs) : null,
    running: [...running.entries()].map(([jobId, r]) => ({ jobId, ...r })),
  });

  // ---------- 历史记录 ----------

  function openRunRecord(job, runId, atMs, plannedMs) {
    const rec = {
      runId, jobId: job.id, title: job.title,
      startedAt: iso(atMs), endedAt: null,
      sessionId: null, status: 'running',
      durationMs: null, error: null,
      summary: null, plannedFor: plannedMs ? iso(plannedMs) : null,
    };
    store.appendRun(rec);
    return rec;
  }

  function closeRunRecord(runId, fields) {
    store.finalizeRun(runId, fields);
  }

  // ---------- 发射 ----------

  function launch(job, { plannedMs = null, manual = false } = {}) {
    const atMs = Date.now();
    const runId = `run-${randomUUID().slice(0, 8)}`;
    openRunRecord(job, runId, atMs, plannedMs);
    running.set(job.id, { runId, startedAt: atMs, title: job.title });
    logger.log?.(`[dsh-wb-cron] 触发「${job.title}」（${job.id}${manual ? '，手动' : ''}）`);

    const promise = (async () => {
      let result;
      try {
        result = await fireJob(job, {
          requestCancel: () => cancelRequested.has(job.id),
          plannedMs,
        });
      } catch (e) {
        result = {
          status: 'error', summary: '', sessionId: '',
          error: String(e?.message ?? e), durationMs: 0,
        };
        logger.warn?.(`[dsh-wb-cron] 任务「${job.title}」抛出异常：${result.error}`);
      } finally {
        running.delete(job.id);
        cancelRequested.delete(job.id);
      }
      try {
        const atEnd = Date.now();
        closeRunRecord(runId, {
          endedAt: iso(atEnd),
          status: result.status,
          sessionId: result.sessionId || null,
          durationMs: result.durationMs ?? atEnd - atMs,
          error: result.error ?? null,
          summary: result.summary || null,
        });
        // 手动试跑不前移 nextFire，但计入 lastFire/lastStatus/runCount。
        store.markFired(job.id, { status: result.status, atMs: atEnd, bumpRun: true });
        store.trimHistory(config.historyLimit ?? 500);
        logger.log?.(`[dsh-wb-cron] 「${job.title}」完成：${result.status}${result.error ? '（' + result.error + '）' : ''}`);
      } catch (e) {
        logger.warn?.(`[dsh-wb-cron] 收尾记录失败：${e?.message ?? e}`);
      }
    })();
    return { runId, promise };
  }

  // ---------- tick ----------

  /**
   * 一次调度判定。返回本次 tick 发动的全部 fire 的 promise 聚合
   * （测试可 await；生产中 setInterval 忽略返回值，行为不变）。
   */
  function tick() {
    lastTickMs = Date.now();
    const inFlight = [];
    try {
      const now = lastTickMs;
      if (running.size >= maxConcurrent) return Promise.resolve([]);
      const due = store
        .all()
        .filter((j) => j.enabled && j.nextFire !== null && Date.parse(j.nextFire) <= now)
        .sort((a, b) => Date.parse(a.nextFire) - Date.parse(b.nextFire));
      if (due.length === 0) return Promise.resolve([]);
      const job = due[0];

      if (running.has(job.id)) {
        // 重叠（maxConcurrentJobs ≥2 时可能同帧多任务）：跳过本次触发并前移。
        store.appendRun({
          runId: `run-${randomUUID().slice(0, 8)}`, jobId: job.id, title: job.title,
          startedAt: iso(now), endedAt: iso(now), sessionId: null,
          status: 'skipped-overlap', durationMs: 0, error: '上一次运行尚未结束',
          summary: null, plannedFor: job.nextFire,
        });
        store.advanceNextFire(job, now);
        return Promise.resolve([]);
      }

      const plannedMs = Date.parse(job.nextFire);
      const missed = now - plannedMs > MISSED_TOLERANCE_MS;
      if (missed && job.missedPolicy === 'skip') {
        // 错过不补跑（默认）：记一条 skipped-missed，前移 nextFire。
        store.appendRun({
          runId: `run-${randomUUID().slice(0, 8)}`, jobId: job.id, title: job.title,
          startedAt: iso(now), endedAt: iso(now), sessionId: null,
          status: 'skipped-missed', durationMs: 0,
          error: `计划 ${job.nextFire} 未能在容差内触发（宿主未运行/睡眠）`,
          summary: null, plannedFor: job.nextFire,
        });
        store.advanceNextFire(job, now);
        logger.warn?.(`[dsh-wb-cron] 「${job.title}」错过触发（missedPolicy=skip，已跳过）`);
        return Promise.resolve([]);
      }
      // 到点（或 missedPolicy=runOnce 补跑一次）：先落盘前移，再放行队列。
      store.advanceNextFire(job, now);
      inFlight.push(launch(job, { plannedMs, manual: false }).promise);
    } catch (e) {
      logger.warn?.(`[dsh-wb-cron] tick 异常（不影响后续调度）：${e?.message ?? e}`);
    }
    return Promise.allSettled(inFlight);
  }

  // ---------- 对外操作 ----------

  /** 立即试跑：与计划触发同路径（同一队列/历史/收尾），但不前移 nextFire。 */
  function runNow(jobId) {
    const job = store.get(jobId);
    if (running.has(jobId)) throw new Error('该任务正在运行中（skipped-overlap）');
    if (running.size >= maxConcurrent) throw new Error(`全局并发队列已满（maxConcurrentJobs=${maxConcurrent}）`);
    return launch(job, { manual: true });
  }

  /** 停止运行中的任务：置取消标志，看门狗路径统一收尾。 */
  function stop(jobId) {
    if (!running.has(jobId)) return false;
    cancelRequested.add(jobId);
    return true;
  }

  function start() {
    if (timer !== null) return;
    // 启动后缓 10s 首 tick，让宿主服务先就绪。
    const t0 = setTimeout(tick, 10_000);
    timer = setInterval(tick, tickMs);
    if (timer.unref) timer.unref();
    logger.log?.(`[dsh-wb-cron] 调度器启动（tick=${tickMs}ms，maxConcurrent=${maxConcurrent}，任务 ${store.all().length} 条）`);
    // 把首 tick 的定时器也纳入停止清理
    timer._t0 = t0;
  }

  function stopAll() {
    if (timer) {
      if (timer._t0) clearTimeout(timer._t0);
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stopAll, runNow, stop, state, isRunning: (id) => running.has(id) };
}
