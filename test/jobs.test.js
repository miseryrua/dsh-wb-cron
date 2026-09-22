// dsh-wb-cron 单元测试：存储（严格解码/原子写/损坏备份）、CRUD、幂等去重、历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, createDedupe } from '../lib/jobs.js';

const makeStore = () => createStore(mkdtempSync(join(tmpdir(), 'dsh-wb-cron-test-')));

const goodJob = (over = {}) => ({
  title: '测试任务', prompt: '做点事', workspace: 'D:\\ws',
  schedule: { kind: 'interval', everyMinutes: 20 }, ...over,
});

test('create：默认值与 nextFire 计算', () => {
  const s = makeStore();
  const job = s.create(goodJob());
  assert.match(job.id, /^cron-[0-9a-f]{8}$/);
  assert.equal(job.enabled, true);
  assert.equal(job.timeoutMinutes, 30);
  assert.equal(job.missedPolicy, 'skip');
  assert.equal(job.appendMemoryLog, true);
  assert.ok(job.nextFire);
  // enabled=false → 不排期
  const off = s.create(goodJob({ enabled: false }));
  assert.equal(off.nextFire, null);
});

test('create：校验失败当场报错', () => {
  const s = makeStore();
  assert.throws(() => s.create(goodJob({ schedule: { kind: 'interval', everyMinutes: 2 } })), /≥5/);
  assert.throws(() => s.create(goodJob({ schedule: { kind: 'cron', expr: '99 * * * *' } })), /越界/);
  assert.throws(() => s.create(goodJob({ schedule: { kind: 'once', at: '2020-01-01T00:00:00Z' } })), /未来/);
  assert.throws(() => s.create(goodJob({ title: '' })), /title/);
  assert.throws(() => s.create(goodJob({ maxRuns: 0 })), /maxRuns/);
});

test('严格解码：未知字段/重复 id/坏 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-cron-test-'));
  const file = join(dir, 'jobs.json');
  const s = createStore(dir);

  writeFileSync(file, JSON.stringify({
    version: 1,
    jobs: [{ ...goodJob(), id: 'cron-aaaaaaaa', createdAt: new Date().toISOString(), evil: 1 }],
  }));
  assert.throws(() => s.load(), /未知字段 "evil"/);

  const base = { ...goodJob(), createdAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify({
    version: 1,
    jobs: [{ ...base, id: 'cron-aaaaaaaa' }, { ...base, id: 'cron-aaaaaaaa' }],
  }));
  assert.throws(() => s.load(), /重复/);

  // 坏 JSON：改名备份（原始字节保留），从空开始
  writeFileSync(file, '{oops');
  const { jobs, error } = s.load();
  assert.equal(jobs.length, 0);
  assert.match(error, /已备份/);
  const backups = readdirSync(dir);
  assert.ok(backups.some((n) => n.startsWith('jobs.json.corrupt-')));
});

test('update：改 schedule 重算 nextFire，暂停/恢复', () => {
  const s = makeStore();
  const job = s.create(goodJob({ schedule: { kind: 'cron', expr: '0 9 * * *' } }));
  const before = Date.parse(job.nextFire);
  const up = s.update(job.id, { schedule: { kind: 'cron', expr: '0 10 * * *' } });
  assert.equal(Date.parse(up.nextFire) > before, true);
  const paused = s.update(job.id, { enabled: false });
  assert.equal(paused.nextFire, null);
  const on = s.update(job.id, { enabled: true });
  assert.ok(on.nextFire);
  assert.throws(() => s.update(job.id, { evil: true }), /不允许修改/);
  assert.throws(() => s.update('cron-00000000', { title: 'x' }), /不存在/);
});

test('markFired：runCount/lastStatus、maxRuns 终结', () => {
  const s = makeStore();
  const job = s.create(goodJob({ maxRuns: 2 }));
  s.advanceNextFire(job);
  let j = s.markFired(job.id, { status: 'completed' });
  assert.equal(j.runCount, 1);
  assert.equal(j.enabled, true);
  j = s.markFired(job.id, { status: 'completed' });
  assert.equal(j.runCount, 2);
  assert.equal(j.enabled, false); // maxRuns 到达自动完成
  assert.equal(j.nextFire, null);
});

test('history：追加/回填/读取/截断', () => {
  const s = makeStore();
  s.setHistoryLimit(3);
  s.appendRun({ runId: 'r1', jobId: 'j1', status: 'completed', startedAt: 't1' });
  s.appendRun({ runId: 'r2', jobId: 'j1', status: 'error', startedAt: 't2' });
  s.finalizeRun('r2', { status: 'timeout', endedAt: 't3' });
  let runs = s.readHistory({ limit: 10 });
  assert.equal(runs[0].runId, 'r2');
  assert.equal(runs[0].status, 'timeout');
  assert.equal(runs.find((r) => r.runId === 'r1').status, 'completed');
  s.appendRun({ runId: 'r3', jobId: 'j2', status: 'completed', startedAt: 't4' });
  s.appendRun({ runId: 'r4', jobId: 'j2', status: 'completed', startedAt: 't5' });
  s.trimHistory(3); // 4 条 → 保留 r2/r3/r4
  runs = s.readHistory({ limit: 10 });
  assert.equal(runs.length, 3);
  assert.equal(runs.find((r) => r.runId === 'r1'), undefined);
  assert.equal(s.readHistory({ jobId: 'j2' }).length, 2);
});

test('原子写 + 重载一致性', () => {
  const s = makeStore();
  const a = s.create(goodJob({ title: 'A' }));
  const b = s.create(goodJob({ title: 'B', schedule: { kind: 'cron', expr: '*/10 * * * *' } }));
  const s2 = createStore(s.jobsFile.replace(/jobs\.json$/, ''));
  s2.load();
  const all = s2.all();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((j) => j.id).sort(), [a.id, b.id].sort());
});

test('幂等去重（request-id 账本）', () => {
  const d = createDedupe(256);
  const first = d('req-1');
  assert.equal(first.duplicate, false);
  first.remember({ ok: 1 });
  const second = d('req-1');
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.result, { ok: 1 });
  assert.equal(d('req-2').duplicate, false);
  assert.equal(d(undefined).duplicate, false); // 无 request id 不去重
});

// ─────────────────────── preset（Agent 预设）字段 ───────────────────────

test('preset：缺省为 null（跟随全局默认）', () => {
  const s = makeStore();
  assert.equal(s.create(goodJob()).preset, null);
  assert.equal(s.create(goodJob({ preset: null })).preset, null);
  assert.equal(s.create(goodJob({ preset: undefined })).preset, null);
  assert.equal(s.create(goodJob({ preset: '' })).preset, null); // 空串归一
  assert.equal(s.create(goodJob({ preset: 'minimal' })).preset, 'minimal');
});

test('preset：更新与显式重置为 null', () => {
  const s = makeStore();
  const job = s.create(goodJob({ preset: 'minimal' }));
  assert.equal(s.update(job.id, { preset: 'cordis' }).preset, 'cordis');
  // 面板选「跟随全局默认」发的就是 null —— 必须真正清空，而不是被跳过
  assert.equal(s.update(job.id, { preset: null }).preset, null);
  assert.equal(s.update(job.id, { title: '改名不动预设' }).preset, null);
});

test('preset：严格解码拒绝非法值', () => {
  const s = makeStore();
  assert.throws(() => s.create(goodJob({ preset: 42 })), /preset 必须是字符串/);
  assert.throws(() => s.create(goodJob({ preset: '../escape' })), /preset 非法/);
  assert.throws(() => s.create(goodJob({ preset: 'a/b' })), /preset 非法/);
  assert.throws(() => s.create(goodJob({ preset: '-lead' })), /preset 非法/);
  assert.throws(() => s.update(s.create(goodJob()).id, { preset: 'x y' }), /preset 非法/);
});

test('preset：存量记录（无 preset 键）向后兼容加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-cron-test-'));
  const file = join(dir, 'jobs.json');
  const s = createStore(dir);
  // 模拟 v0.1.1 落盘：不含 preset 键
  const legacy = { ...goodJob(), id: 'cron-bbbbbbbb', createdAt: new Date().toISOString() };
  delete legacy.preset;
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [legacy] }));
  const { jobs, error } = s.load();
  assert.ok(!error, `存量记录加载不应报错，实际：${error}`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].preset, null); // 解析为跟随全局默认，而非报错
  // 重新落盘后新字段就位
  s.persist();
  const reread = createStore(dir);
  reread.load();
  assert.equal(reread.all()[0].preset, null);
});
