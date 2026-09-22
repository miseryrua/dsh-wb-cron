// dsh-wb-cron 集成测试：以注入的 mock fireJob 驱动调度器
// （到期→fire、错过→skip/runOnce、重叠→skip、停止→cancelled、maxRuns 收敛、串行队列）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/jobs.js';
import { createScheduler } from '../lib/scheduler.js';

const setup = ({ fireJob, config = {} } = {}) => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'dsh-wb-cron-sched-')));
  const calls = [];
  const fakeFire = fireJob ?? (async (job) => {
    calls.push({ id: job.id, at: Date.now() });
    return { status: 'completed', summary: 'ok', sessionId: 'session-x', durationMs: 5, error: null };
  });
  const logger = { log: () => {}, warn: () => {} };
  const scheduler = createScheduler({ store, fireJob: fakeFire, logger, config: { tickMs: 30_000, ...config } });
  return { store, scheduler, calls };
};

const past = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const future = (msIn) => new Date(Date.now() + msIn).toISOString();

test('到期触发：fire、前移 nextFire、runCount、历史 completed', async () => {
  const { store, scheduler, calls } = setup();
  const job = store.create({
    title: '每20分钟', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 20 },
  });
  store.patchFields(job.id, { nextFire: past(10_000) }); // 到期 10s
  await scheduler.tick();
  assert.equal(calls.length, 1);
  const j = store.get(job.id);
  assert.equal(j.runCount, 1);
  assert.equal(j.lastStatus, 'completed');
  assert.ok(Date.parse(j.nextFire) > Date.now()); // 已前移
  const runs = store.readHistory({});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].sessionId, 'session-x');
  // 未到期不再触发
  scheduler.tick();
  assert.equal(calls.length, 1);
});

test('错过 skip（默认）：不补跑，记 skipped-missed 并前移', async () => {
  const { store, scheduler, calls } = setup();
  const job = store.create({
    title: '错过即跳', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 20 },
  });
  store.patchFields(job.id, { nextFire: past(10 * 60_000) }); // 错过 10 分钟 > 2 分钟容差
  scheduler.tick();
  assert.equal(calls.length, 0);
  const runs = store.readHistory({});
  assert.equal(runs[0].status, 'skipped-missed');
  assert.ok(Date.parse(store.get(job.id).nextFire) > Date.now());
  // 容差内（迟到 1 分钟）照常触发
  const job2 = store.create({
    title: '迟到但容差内', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 20 },
  });
  store.patchFields(job2.id, { nextFire: past(60_000) });
  scheduler.tick();
  assert.equal(calls.length, 1);
});

test('错过 runOnce：补跑一次（最多一次，绝不回放积压）', async () => {
  const { store, scheduler, calls } = setup();
  const job = store.create({
    title: '补跑日报', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 30 }, missedPolicy: 'runOnce',
  });
  store.patchFields(job.id, { nextFire: past(5 * 60_000) });
  await scheduler.tick();
  assert.equal(calls.length, 1); // 只补一次
  await scheduler.tick();
  assert.equal(calls.length, 1); // 不再积压
  const runs = store.readHistory({});
  assert.equal(runs.filter((r) => r.status === 'completed').length, 1);
});

test('同一任务重叠：skipped-overlap 不排队堆积（maxConcurrent=2 时可达）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store, scheduler } = setup({
    fireJob: async () => { await gate; return { status: 'completed', summary: '', sessionId: 's', durationMs: 1, error: null }; },
    config: { maxConcurrentJobs: 2 },
  });
  const job = store.create({
    title: '长任务', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 20 },
  });
  store.patchFields(job.id, { nextFire: past(5_000) });
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 10)); // 让 launch 异步落地
  assert.ok(scheduler.isRunning(job.id));
  // 同一任务再次到期 → skipped-overlap
  store.patchFields(job.id, { nextFire: past(1_000) });
  scheduler.tick();
  const runs = store.readHistory({});
  assert.equal(runs.filter((r) => r.status === 'skipped-overlap').length, 1);
  // 另一个任务不受影响，可并发启动（队列容量 2）
  const other = store.create({
    title: '并发第二', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 20 },
  });
  store.patchFields(other.id, { nextFire: past(1_000) });
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(scheduler.isRunning(other.id));
  release();
  await new Promise((r) => setTimeout(r, 20));
});

test('手动试跑：同路径但不动 nextFire；运行中拒绝重复入队；串行队列', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store, scheduler } = setup({
    fireJob: async () => { await gate; return { status: 'completed', summary: '', sessionId: 's', durationMs: 1, error: null }; },
  });
  const job = store.create({
    title: '手动试跑', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
  });
  const before = store.get(job.id).nextFire;
  const { runId } = scheduler.runNow(job.id);
  assert.match(runId, /^run-/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.get(job.id).nextFire, before); // 手动试跑不前移计划
  assert.throws(() => scheduler.runNow(job.id), /正在运行/);
  const other = store.create({
    title: '第二个', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'cron', expr: '0 10 * * *' },
  });
  assert.throws(() => scheduler.runNow(other.id), /队列已满/); // maxConcurrent=1
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.get(job.id).lastStatus, 'completed');
  assert.equal(store.get(job.id).runCount, 1);
});

test('停止：置取消标志 → fireJob 经 requestCancel 感知 → 记 cancelled', async () => {
  const { store, scheduler } = setup({
    fireJob: async (job, { requestCancel }) => {
      while (!requestCancel()) await new Promise((r) => setTimeout(r, 5));
      return { status: 'cancelled', summary: '', sessionId: 's', durationMs: 5, error: '被用户停止' };
    },
  });
  const job = store.create({
    title: '可停止', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
  });
  scheduler.runNow(job.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scheduler.stop(job.id), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.get(job.id).lastStatus, 'cancelled');
});

test('maxRuns 到达：enabled 置 false、nextFire 置 null', async () => {
  const { store, scheduler } = setup();
  const job = store.create({
    title: '只跑一次', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 5 }, maxRuns: 1,
  });
  store.patchFields(job.id, { nextFire: past(1_000) });
  await scheduler.tick();
  const j = store.get(job.id);
  assert.equal(j.enabled, false);
  assert.equal(j.nextFire, null);
});

test('fireJob 抛异常：记 error 历史，调度器不崩', async () => {
  const { store, scheduler } = setup({
    fireJob: async () => { throw new Error('agents 服务炸了'); },
  });
  const job = store.create({
    title: '会炸', prompt: 'x', workspace: 'D:\\ws',
    schedule: { kind: 'interval', everyMinutes: 5 },
  });
  store.patchFields(job.id, { nextFire: past(1_000) });
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.get(job.id).lastStatus, 'error');
  const runs = store.readHistory({});
  assert.equal(runs[0].status, 'error');
  assert.match(runs[0].error, /agents 服务炸了/);
  // 调度器仍活着：下一次到期照常处理
  store.patchFields(job.id, { nextFire: past(1_000), enabled: true });
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.readHistory({}).length, 2);
});
