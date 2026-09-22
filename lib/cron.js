// dsh-wb-cron — 零依赖 5 字段 cron 解析与下次触发计算。
//
// 支持字段：分 时 日 月 周。写法：`*`、步长 `*/n`、区间 `a-b`、区间步长 `a-b/n`、
// 列表 `a,b,c`；月份/星期支持英文名（JAN/SUN，大小写不敏感）；周日 0/7 等价。
// dom 与 dow 同时受限时按 Vixie cron 语义（任一匹配即触发）。
// 年字段、秒字段（6 段表达式）明确报错，绝不静默截断。
//
// 时区：job.tz 为 IANA 名称（如 Asia/Shanghai）时按该时区的墙钟匹配；
// 缺省时用进程本地时区。nextFire 统一返回 UTC 毫秒，落盘为 ISO 字符串。

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** 搜索上限：一年内没有匹配点即视为永不匹配（如 2 月 30 日）。 */
const SEARCH_CAP_MS = 366 * DAY_MS;
const LOOP_CAP = 200_000;

function mapName(token, names, lo, hi, what) {
  const key = token.toLowerCase();
  if (names && key in names) {
    const v = names[key];
    if (v < lo || v > hi) throw new Error(`字段值越界：${what} "${token}"`);
    return v;
  }
  return null;
}

function parseNumber(token, lo, hi, what) {
  if (!/^\d{1,4}$/.test(token)) throw new Error(`字段值非法：${what} "${token}"`);
  const v = Number(token);
  if (v < lo || v > hi) throw new Error(`字段值越界：${what} ${v}（允许 ${lo}-${hi}）`);
  return v;
}

/** 解析单个字段（已按逗号切分的一段），返回升序 Set。 */
function parsePart(part, lo, hi, names, what) {
  const out = new Set();
  const push = (v) => {
    if (v < lo || v > hi) throw new Error(`字段值越界：${what} ${v}（允许 ${lo}-${hi}）`);
    out.add(v);
  };
  let body = part;
  let step = 1;
  const slash = part.indexOf('/');
  if (slash !== -1) {
    body = part.slice(0, slash);
    const stepRaw = part.slice(slash + 1);
    if (!/^\d{1,4}$/.test(stepRaw) || Number(stepRaw) < 1) throw new Error(`步长非法：${what} "${part}"`);
    step = Number(stepRaw);
  }
  if (body === '*') {
    for (let v = lo; v <= hi; v += step) push(v);
    return out;
  }
  const dash = body.indexOf('-');
  if (dash !== -1) {
    let a = mapName(body.slice(0, dash), names, lo, hi, what);
    if (a === null) a = parseNumber(body.slice(0, dash), lo, hi, what);
    let b = mapName(body.slice(dash + 1), names, lo, hi, what);
    if (b === null) b = parseNumber(body.slice(dash + 1), lo, hi, what);
    if (a > b) throw new Error(`区间反序：${what} "${part}"`);
    for (let v = a; v <= b; v += step) push(v);
    return out;
  }
  if (slash !== -1) throw new Error(`步长只能搭配 * 或区间：${what} "${part}"`);
  const v = mapName(body, names, lo, hi, what);
  if (v === null) push(parseNumber(body, lo, hi, what));
  else push(v);
  return out;
}

function parseField(raw, lo, hi, names, what) {
  const out = new Set();
  for (const part of raw.split(',')) {
    if (part === '') throw new Error(`字段含空段：${what} "${raw}"`);
    for (const v of parsePart(part, lo, hi, names, what)) out.add(v);
  }
  if (out.size === 0) throw new Error(`字段为空：${what} "${raw}"`);
  return out;
}

/**
 * 解析 5 字段 cron 表达式。
 * @returns {{min:Set<number>, hour:Set<number>, dom:Set<number>, mon:Set<number>,
 *   dow:Set<number>, domRestricted:boolean, dowRestricted:boolean, expr:string}}
 */
export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') throw new Error('cron 表达式不能为空');
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 6) {
    throw new Error('不支持 6 段表达式（秒或年字段）：本插件只用 5 字段 分 时 日 月 周');
  }
  if (fields.length !== 5) {
    throw new Error(`cron 表达式必须是 5 个字段（分 时 日 月 周），收到 ${fields.length} 个："${expr}"`);
  }
  const min = parseField(fields[0], 0, 59, null, '分');
  const hour = parseField(fields[1], 0, 23, null, '时');
  const dom = parseField(fields[2], 1, 31, null, '日');
  const mon = parseField(fields[3], 1, 12, MONTH_NAMES, '月');
  // 周日 0/7 等价：解析时把 7 归一为 0。
  const dowRaw = parseField(fields[4], 0, 7, DOW_NAMES, '周');
  const dow = new Set();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);
  return {
    min, hour, dom, mon, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
    expr: expr.trim(),
  };
}

// ---------- 时区工具：墙钟部件 ↔ UTC 毫秒 ----------

function makeTzKit(tz) {
  if (!tz) {
    return {
      name: 'local',
      partsOf(ms) {
        const d = new Date(ms);
        return {
          y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(),
          h: d.getHours(), mi: d.getMinutes(), dow: d.getDay(),
        };
      },
      utcOf(y, mo, d, h, mi) {
        return new Date(y, mo - 1, d, h, mi).getTime();
      },
    };
  }
  let dtf;
  try {
    dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    });
  } catch {
    throw new Error(`未知时区："${tz}"（需 IANA 名称，如 Asia/Shanghai）`);
  }
  const DOW_SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const partsOf = (ms) => {
    const parts = dtf.formatToParts(new Date(ms));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    let h = Number(get('hour'));
    if (h === 24) h = 0; // en-GB h23 循环在部分平台输出 24:00
    return {
      y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
      h, mi: Number(get('minute')), dow: DOW_SHORT[get('weekday')] ?? 0,
    };
  };
  const offsetMs = (ms) => {
    const p = partsOf(Math.floor(ms / MINUTE_MS) * MINUTE_MS);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  };
  return {
    name: tz,
    partsOf,
    // 墙钟 → UTC：两遍逼近，天然处理 DST。
    utcOf(y, mo, d, h, mi) {
      const guess = Date.UTC(y, mo - 1, d, h, mi);
      const off1 = offsetMs(guess);
      let ts = guess - off1;
      const off2 = offsetMs(ts);
      if (off2 !== off1) ts = guess - off2;
      return ts;
    },
  };
}

function domDowMatch(parsed, day, dow) {
  if (parsed.domRestricted && parsed.dowRestricted) {
    return parsed.dom.has(day) || parsed.dow.has(dow);
  }
  if (parsed.domRestricted) return parsed.dom.has(day);
  if (parsed.dowRestricted) return parsed.dow.has(dow);
  return true;
}

/**
 * 严格晚于 fromMs 的下一个匹配时刻（UTC 毫秒）；一年内无匹配返回 null。
 * 墙钟逐段跳跃：月不匹配跳到下月 1 号 0 点，日不匹配跳到次日 0 点，
 * 时不匹配跳到下一个整点，分不匹配跳到下一个匹配分。
 */
export function nextFireAfter(expr, fromMs, tz) {
  const parsed = parseCron(expr);
  const kit = makeTzKit(tz);
  const deadline = fromMs + SEARCH_CAP_MS;
  let t = kit.utcOf(
    kit.partsOf(fromMs).y, kit.partsOf(fromMs).mo, kit.partsOf(fromMs).d,
    kit.partsOf(fromMs).h, kit.partsOf(fromMs).mi + 1,
  );
  for (let i = 0; i < LOOP_CAP; i++) {
    if (t > deadline) return null;
    const p = kit.partsOf(t);
    if (!parsed.mon.has(p.mo)) {
      t = kit.utcOf(p.y, p.mo + 1, 1, 0, 0);
      continue;
    }
    if (!domDowMatch(parsed, p.d, p.dow)) {
      t = kit.utcOf(p.y, p.mo, p.d + 1, 0, 0);
      continue;
    }
    if (!parsed.hour.has(p.h)) {
      t = kit.utcOf(p.y, p.mo, p.d, p.h + 1, 0);
      continue;
    }
    if (!parsed.min.has(p.mi)) {
      t = kit.utcOf(p.y, p.mo, p.d, p.h, p.mi + 1);
      continue;
    }
    return t;
  }
  throw new Error(`cron 搜索迭代超限："${expr}"`);
}

// ---------- 三种调度形态 ----------

/**
 * 校验并规范化 schedule，返回 { schedule, nextFireMs }。
 * kind=cron: { expr, tz? }；kind=interval: { everyMinutes(≥5), anchorAt(ms) }；
 * kind=once: { at(ISO，必须晚于 nowMs) }。
 */
export function validateSchedule(schedule, { nowMs = Date.now(), anchorAt = nowMs } = {}) {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule 必须是对象');
  const allow = ['kind', 'expr', 'tz', 'everyMinutes', 'at', 'anchorAt'];
  for (const k of Object.keys(schedule)) {
    if (!allow.includes(k)) throw new Error(`schedule 含未知字段 "${k}"`);
  }
  if (typeof schedule.kind !== 'string') throw new Error('schedule.kind 必须是字符串');
  if (schedule.kind === 'cron') {
    if (typeof schedule.expr !== 'string') throw new Error('kind=cron 需要 expr 字段');
    parseCron(schedule.expr); // 语法当场校验，错误信息具体到字段
    if (schedule.tz !== undefined && (typeof schedule.tz !== 'string' || schedule.tz === '')) {
      throw new Error('schedule.tz 必须是非空字符串（IANA 名称）');
    }
    if (schedule.tz) makeTzKit(schedule.tz); // 提前暴露未知时区
    const tz = schedule.tz;
    return { schedule: { kind: 'cron', expr: schedule.expr, ...(tz ? { tz } : {}) }, nextFireMs: nextFireAfter(schedule.expr, nowMs, tz) };
  }
  if (schedule.kind === 'interval') {
    const n = schedule.everyMinutes;
    if (!Number.isInteger(n) || n < 5) throw new Error('everyMinutes 必须是 ≥5 的整数（对齐宿主 dsh-schedule 下限）');
    return { schedule: { kind: 'interval', everyMinutes: n, anchorAt }, nextFireMs: anchorAt + n * MINUTE_MS };
  }
  if (schedule.kind === 'once') {
    if (typeof schedule.at !== 'string') throw new Error('kind=once 需要 at 字段（ISO 时间）');
    const atMs = Date.parse(schedule.at);
    if (Number.isNaN(atMs)) throw new Error(`at 不是合法时间："${schedule.at}"`);
    if (atMs <= nowMs) throw new Error('once 任务的时间必须在未来（相对时间应在创建时换算为绝对时间并持久化）');
    return { schedule: { kind: 'once', at: new Date(atMs).toISOString() }, nextFireMs: atMs };
  }
  throw new Error(`schedule.kind 必须是 cron | interval | once，收到 "${schedule.kind}"`);
}

/**
 * 触发后前移 nextFire。纪律：一次性任务绝不重新换算（终结即 null）；
 * interval 锚定 anchorAt 的整数倍序列，错过的间隔合并为一次、不补发积压；
 * cron 从 max(prev, now - 1min) 起找下一个匹配点（防同一分钟重复触发）。
 * @returns {number|null} 新的 nextFire（UTC 毫秒）
 */
export function advanceSchedule(schedule, prevNextFireMs, nowMs) {
  if (schedule.kind === 'once') return null;
  if (schedule.kind === 'interval') {
    const step = schedule.everyMinutes * MINUTE_MS;
    const anchor = schedule.anchorAt ?? nowMs;
    // 严格晚于 max(prev, now) 的第一个锚点倍数：不重复、不积压。
    const base = Math.max(prevNextFireMs ?? anchor, nowMs);
    const n = Math.floor((base - anchor) / step) + 1;
    return anchor + n * step;
  }
  // cron
  const from = Math.max(prevNextFireMs ?? nowMs, nowMs - MINUTE_MS);
  return nextFireAfter(schedule.expr, from, schedule.tz);
}

/** 预览未来 count 次触发点（含首次 = 下一次触发）。 */
export function previewSchedule(schedule, count = 5, fromMs = Date.now()) {
  const out = [];
  if (schedule.kind === 'once') {
    const atMs = Date.parse(schedule.at);
    return atMs > fromMs ? [atMs] : [];
  }
  if (schedule.kind === 'interval') {
    const step = schedule.everyMinutes * MINUTE_MS;
    const anchor = schedule.anchorAt ?? fromMs;
    const n = Math.floor((fromMs - anchor) / step) + 1;
    for (let i = 0; i < count; i++) out.push(anchor + (n + i) * step);
    return out;
  }
  let cursor = fromMs;
  for (let i = 0; i < count; i++) {
    const next = nextFireAfter(schedule.expr, cursor, schedule.tz);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// ---------- 人话化（面板/工具渲染用，中文） ----------

const two = (n) => String(n).padStart(2, '0');

/**
 * 把 cron 表达式翻成人话；覆盖常用形态，复杂表达式原样返回。
 * 直接格式化字段数值（与具体时区无关；时区后缀由 describeSchedule 附加）。
 */
export function describeCron(expr) {
  let p;
  try { p = parseCron(expr); } catch { return expr; }
  const clockStr = (h, m) => `${two(h)}:${two(m)}`;
  const arr = (s) => [...s].sort((a, b) => a - b);
  const mins = arr(p.min);
  const hours = arr(p.hour);
  const dows = arr(p.dow).filter((v) => v !== 7);
  const doms = arr(p.dom);
  const uniform = (a) => (a.length > 1 ? a[1] - a[0] : null);
  if (p.mon.size !== 12) return expr;
  // 每天 / 每 N 分钟 / 每 N 小时（dom 与 dow 均不受限）
  if (!p.domRestricted && !p.dowRestricted) {
    if (hours.length === 1 && mins.length === 1) return `每天 ${clockStr(hours[0], mins[0])}`;
    const mg = uniform(mins);
    if (hours.length === 24 && mg !== null && mins.every((v, i) => i === 0 || v - mins[i - 1] === mg)) {
      return mg === 1 ? '每分钟' : `每 ${mg} 分钟`;
    }
    const hg = uniform(hours);
    if (mins.length === 1 && mins[0] === 0 && hg !== null && hours.every((v, i) => i === 0 || v - hours[i - 1] === hg)) {
      return hg === 1 ? '每小时整点' : `每 ${hg} 小时`;
    }
    return expr;
  }
  // 工作日 / 每周X（dom 不受限）
  if (!p.domRestricted && p.dowRestricted) {
    if (hours.length === 1 && mins.length === 1) {
      if (dows.length === 5 && dows.join(',') === '1,2,3,4,5') return `工作日 ${clockStr(hours[0], mins[0])}`;
      if (dows.length === 1) return `每周${WEEKDAY_ZH[dows[0]]} ${clockStr(hours[0], mins[0])}`;
      if (dows.length === 2 && dows.join(',') === '0,6') return `周末 ${clockStr(hours[0], mins[0])}`;
      if (dows.length <= 3) return `每周${dows.map((d) => WEEKDAY_ZH[d]).join('、')} ${clockStr(hours[0], mins[0])}`;
    }
    return expr;
  }
  // 每月D日（dow 不受限）
  if (p.domRestricted && !p.dowRestricted && hours.length === 1 && mins.length === 1) {
    if (doms.length === 1) return `每月${doms[0]}日 ${clockStr(hours[0], mins[0])}`;
    return expr;
  }
  return expr;
}

export function describeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return '(无)';
  if (schedule.kind === 'cron') return describeCron(schedule.expr, schedule.tz) + (schedule.tz ? `（${schedule.tz}）` : '');
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`;
  if (schedule.kind === 'once') {
    const ms = Date.parse(schedule.at);
    return Number.isNaN(ms) ? schedule.at : `一次性 ${new Date(ms).toLocaleString('zh-CN')}`;
  }
  return JSON.stringify(schedule);
}
