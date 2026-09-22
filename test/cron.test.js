// dsh-wb-cron 单元测试：cron 解析、下次触发、三种调度形态、人话化。
// 运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCron, nextFireAfter, validateSchedule, advanceSchedule,
  previewSchedule, describeCron, describeSchedule,
} from '../lib/cron.js';

// 固定基准点（本地时区）：2026-09-07 是周一。
const L = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const fromMon = L(2026, 9, 7, 10, 30); // 周一 10:30

test('parse：合法表达式与名称字段', () => {
  const p = parseCron('0 9 * * 1-5');
  assert.equal(p.min.has(0), true);
  assert.equal(p.dow.has(1) && p.dow.has(5), true);
  assert.equal(parseCron('0 12 * JAN *').mon.has(1), true);
  assert.equal(parseCron('0 9 * * MON').dow.has(1), true);
  // 周日 0/7 等价
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0]);
});

test('parse：明确拒绝年/秒字段与越界', () => {
  assert.throws(() => parseCron('0 9 * * * 2026'), /不支持 6 段/);
  assert.throws(() => parseCron('0 9 5 * * 1'), /不支持 6 段/);
  assert.throws(() => parseCron('60 9 * * *'), /越界/);
  assert.throws(() => parseCron('0 24 * * *'), /越界/);
  assert.throws(() => parseCron('0 9 32 * *'), /越界/);
  assert.throws(() => parseCron('0 9 * 13 *'), /越界/);
  assert.throws(() => parseCron('0 9 * * 8'), /越界/);
  assert.throws(() => parseCron('5-2 * * * *'), /区间反序/);
  assert.throws(() => parseCron('* * *'), /5 个字段/);
});

test('nextFire：基础推进', () => {
  // 每天 9 点：从周一 10:30 → 周二 09:00
  assert.equal(nextFireAfter('0 9 * * *', fromMon), L(2026, 9, 8, 9, 0));
  // 步长：10:30 → 10:45
  assert.equal(nextFireAfter('*/15 * * * *', fromMon), L(2026, 9, 7, 10, 45));
  // 列表：10:30 → 12:15（同小时下一个列表值）
  assert.equal(nextFireAfter('15,45 * * * *', L(2026, 9, 7, 10, 30)), L(2026, 9, 7, 10, 45));
  // 工作日：周五 10:00 → 下周一 09:00
  assert.equal(nextFireAfter('0 9 * * 1-5', L(2026, 9, 11, 10, 0)), L(2026, 9, 14, 9, 0));
  // 严格晚于 from：from 本身匹配时不返回同一时刻
  assert.equal(nextFireAfter('30 10 * * *', L(2026, 9, 7, 10, 30)), L(2026, 9, 8, 10, 30));
});

test('nextFire：dom/dow 的 Vixie OR 语义', () => {
  // 13 日或周五，任一匹配：周一 9/7 → 周五 9/11（先于 9/13）
  assert.equal(nextFireAfter('0 12 13 * 5', fromMon), L(2026, 9, 11, 12, 0));
  // 仅 dom 受限：9/7 → 9/13
  assert.equal(nextFireAfter('0 12 13 * *', fromMon), L(2026, 9, 13, 12, 0));
});

test('nextFire：月末与 2 月 29 日', () => {
  // 31 日：1/31 13:00 → 3/31 12:00（2 月无 31 日）
  assert.equal(nextFireAfter('0 12 31 * *', L(2027, 1, 31, 13, 0)), L(2027, 3, 31, 12, 0));
  // 2 月 29 日：2027-03-01 → 2028-02-29（闰年，366 天搜索上限内）
  assert.equal(nextFireAfter('0 0 29 2 *', L(2027, 3, 1, 0, 1)), L(2028, 2, 29, 0, 0));
  // 平年起点距下一个 2/29 超过一年 → null（诚实报告，不假装有匹配）
  assert.equal(nextFireAfter('0 0 29 2 *', L(2026, 3, 1, 0, 0)), null);
});

test('nextFire：IANA 时区', () => {
  // UTC 2026-09-06 20:00 = 上海 9/7 04:00 → 上海 9/7 09:00 = UTC 01:00
  const got = nextFireAfter('0 9 * * *', Date.UTC(2026, 8, 6, 20, 0), 'Asia/Shanghai');
  assert.equal(got, Date.UTC(2026, 8, 7, 1, 0));
  // 未知时区当场报错
  assert.throws(() => nextFireAfter('0 9 * * *', fromMon, 'Mars/Olympus'), /未知时区/);
});

test('validateSchedule：三种形态与边界', () => {
  const now = fromMon;
  const cron = validateSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }, { nowMs: now });
  assert.equal(cron.nextFireMs, L(2026, 9, 8, 9, 0));
  assert.equal(cron.schedule.tz, undefined);

  assert.throws(() => validateSchedule({ kind: 'interval', everyMinutes: 4 }, { nowMs: now }), /≥5/);
  assert.throws(() => validateSchedule({ kind: 'interval', everyMinutes: 5.5 }, { nowMs: now }), /≥5/);
  const iv = validateSchedule({ kind: 'interval', everyMinutes: 5 }, { nowMs: now });
  assert.equal(iv.nextFireMs, now + 5 * 60_000);
  assert.equal(iv.schedule.anchorAt, now);

  assert.throws(() => validateSchedule({ kind: 'once', at: new Date(now - 1000).toISOString() }, { nowMs: now }), /必须在未来/);
  const once = validateSchedule({ kind: 'once', at: new Date(now + 60_000).toISOString() }, { nowMs: now });
  assert.equal(once.nextFireMs, now + 60_000);
  assert.throws(() => validateSchedule({ kind: 'yearly' }, { nowMs: now }), /kind/);
  assert.throws(() => validateSchedule({ kind: 'cron', expr: '0 9 * * *', bogus: 1 }, { nowMs: now }), /未知字段/);
});

test('advanceSchedule：防同一分钟重复触发、interval 不积压、once 终结', () => {
  // cron：tick 迟到 30s（now = 计划点 +30s）→ 下一分钟起找，不得重复本分钟
  const planned = L(2026, 9, 7, 9, 0);
  const now = planned + 30_000;
  const next = advanceSchedule({ kind: 'cron', expr: '0 9 * * *' }, planned, now);
  assert.equal(next, L(2026, 9, 8, 9, 0));

  // interval：锚定 anchorAt 的倍数序列；now 远超 prev（错过）→ 合并为一次，跳到未来
  const anchor = L(2026, 9, 7, 9, 0);
  const prev2 = anchor + 5 * 60_000;
  const next2 = advanceSchedule({ kind: 'interval', everyMinutes: 5, anchorAt: anchor }, prev2, prev2 + 47 * 60_000);
  const k = Math.ceil(((prev2 + 47 * 60_000 + 1) - anchor) / (5 * 60_000));
  assert.equal(next2, anchor + k * 5 * 60_000);
  assert.ok(next2 > prev2 + 47 * 60_000);

  // once：触发后终结
  assert.equal(advanceSchedule({ kind: 'once', at: 'x' }, now, now), null);
});

test('previewSchedule：连点预览', () => {
  const times = previewSchedule({ kind: 'cron', expr: '0 9 * * *' }, 3, fromMon);
  assert.deepEqual(times, [L(2026, 9, 8, 9, 0), L(2026, 9, 9, 9, 0), L(2026, 9, 10, 9, 0)]);
});

test('describeCron：常用形态人话化', () => {
  assert.equal(describeCron('0 9 * * *'), '每天 09:00');
  assert.equal(describeCron('0 9 * * 1-5'), '工作日 09:00');
  assert.equal(describeCron('0 9 * * 1'), '每周一 09:00');
  assert.equal(describeCron('0 9 15 * *'), '每月15日 09:00');
  assert.equal(describeCron('*/20 * * * *'), '每 20 分钟');
  assert.equal(describeCron('0 */6 * * *'), '每 6 小时');
  assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 20 }), '每 20 分钟');
  assert.match(describeSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }), /工作日 09:00/);
});
