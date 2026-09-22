// dsh-wb-cron — 任务存储：~/.dsh/wb-cron/jobs.json（原子写、严格解码）与
// ~/.dsh/wb-cron/history.jsonl（追加、保留最近 historyLimit 条）。
//
// 存储纪律（对齐 dsh-schedule 的"持久化先于决策"）：
// - jobs.json 临时文件 + rename 原子写；
// - 读取时严格解码：未知字段拒绝、id 重复拒绝——宁可响亮失败，不静默纠偏；
// - 损坏文件整体改名备份（jobs.json.corrupt-<ts>），绝不覆盖原始字节，
//   插件从空状态继续（响亮 = console.error，不炸宿主 profile）。

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { advanceSchedule, validateSchedule } from './cron.js';

export const DEFAULT_DIR = join(homedir(), '.dsh', 'wb-cron');
const JOB_ID_RE = /^cron-[0-9a-f]{8}$/;
const STATUSES = new Set([
  'completed', 'error', 'timeout', 'cancelled', 'skipped-missed', 'skipped-overlap', 'running',
]);

// ---------- 原子写 ----------

function atomicWrite(file, data) {
  const tmp = join(tmpdir(), `dsh-wb-cron-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, file); // libuv 在 Windows 上映射为 MOVEFILE_REPLACE_EXISTING
  } catch (e) {
    try { renameSync(tmp, `${file}.new`); } catch { /* 保 tmp 残留亦无害 */ }
    throw e;
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ---------- 严格解码 ----------

const JOB_FIELDS = [
  'id', 'title', 'prompt', 'workspace', 'schedule', 'model', 'preset', 'enabled', 'maxRuns',
  'runCount', 'timeoutMinutes', 'missedPolicy', 'appendMemoryLog',
  'createdAt', 'updatedAt', 'nextFire', 'lastFire', 'lastStatus',
];

// 预设 id 的形状约束：预设 id 会成为 agent-presets 根目录下的**路径段**，
// 故按官方 PRESET_ID 的精神收窄到安全字符集（字母数字与 . _ -），拒绝分隔符 /
// `..` / 绝对路径形态。语义合法性（是否真实存在）不在存储层联网校验，由开火
// 时的降级链负责——存储层只管字节形状，不管世界状态。
const PRESET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 严格解码 preset：null/undefined/空串 → null（= 跟随全局默认）。 */
function decodePreset(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error('preset 必须是字符串或 null');
  if (v === '') return null; // 空串归一为跟随全局默认（面板「跟随全局默认」项提交 null）
  if (!PRESET_ID_RE.test(v)) throw new Error(`preset 非法：${JSON.stringify(v)}（只允许字母数字与 . _ -）`);
  return v;
}

function decodeModel(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('model 必须是 {provider, model} 或 null');
  for (const k of Object.keys(v)) {
    if (k !== 'provider' && k !== 'model') throw new Error(`model 含未知字段 "${k}"`);
  }
  if (typeof v.provider !== 'string' || typeof v.model !== 'string') {
    throw new Error('model.provider / model.model 必须是字符串');
  }
  return { provider: v.provider, model: v.model };
}

/** 严格解码单个任务记录；任何未知/越界/缺字段都抛错。 */
export function decodeJob(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('任务记录必须是对象');
  for (const k of Object.keys(raw)) {
    if (!JOB_FIELDS.includes(k)) throw new Error(`任务含未知字段 "${k}"（严格解码，拒绝静默纠偏）`);
  }
  for (const k of ['id', 'title', 'prompt', 'workspace', 'schedule', 'createdAt']) {
    if (!(k in raw)) throw new Error(`任务缺少必填字段 "${k}"`);
  }
  if (typeof raw.id !== 'string' || !JOB_ID_RE.test(raw.id)) throw new Error(`任务 id 非法："${raw.id}"（应为 cron-<uuid前8位>）`);
  for (const k of ['title', 'prompt', 'workspace']) {
    if (typeof raw[k] !== 'string' || raw[k] === '') throw new Error(`任务字段 ${k} 必须是非空字符串`);
  }
  if (!('enabled' in raw) && !('runCount' in raw)) {
    // 兼容极简记录：缺 enabled/runCount 时由默认值补齐（下方 defaults）
  }
  const model = decodeModel(raw.model);
  // 缺 preset 键（v0.1.1 及更早落盘的记录）解析为 null = 跟随全局默认，
  // 这是向后兼容的唯一出口：存量 jobs.json 不因新字段而响亮失败。
  const preset = decodePreset(raw.preset);
  let enabled;
  if (raw.enabled === undefined) enabled = true;
  else if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
  else throw new Error('enabled 必须是布尔值');
  let runCount;
  if (raw.runCount === undefined) runCount = 0;
  else if (Number.isInteger(raw.runCount) && raw.runCount >= 0) runCount = raw.runCount;
  else throw new Error('runCount 必须是非负整数');
  let maxRuns = null;
  if (raw.maxRuns !== undefined && raw.maxRuns !== null) {
    if (!Number.isInteger(raw.maxRuns) || raw.maxRuns < 1) throw new Error('maxRuns 必须是正整数或 null');
    maxRuns = raw.maxRuns;
  }
  let timeoutMinutes;
  if (raw.timeoutMinutes === undefined) timeoutMinutes = 30;
  else if (Number.isInteger(raw.timeoutMinutes) && raw.timeoutMinutes >= 1 && raw.timeoutMinutes <= 24 * 60) timeoutMinutes = raw.timeoutMinutes;
  else throw new Error('timeoutMinutes 必须是 1-1440 的整数');
  let missedPolicy;
  if (raw.missedPolicy === undefined) missedPolicy = 'skip';
  else if (raw.missedPolicy === 'skip' || raw.missedPolicy === 'runOnce') missedPolicy = raw.missedPolicy;
  else throw new Error(`missedPolicy 必须是 skip | runOnce，收到 "${raw.missedPolicy}"`);
  let appendMemoryLog;
  if (raw.appendMemoryLog === undefined) appendMemoryLog = true;
  else if (typeof raw.appendMemoryLog === 'boolean') appendMemoryLog = raw.appendMemoryLog;
  else throw new Error('appendMemoryLog 必须是布尔值');
  const isoOrNull = (v, name) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${name} 必须是 ISO 时间字符串`);
    return v;
  };
  const createdAt = isoOrNull(raw.createdAt, 'createdAt');
  const updatedAt = isoOrNull(raw.updatedAt, 'updatedAt');
  const nextFire = isoOrNull(raw.nextFire, 'nextFire');
  const lastFire = isoOrNull(raw.lastFire, 'lastFire');
  let lastStatus = null;
  if (raw.lastStatus !== undefined && raw.lastStatus !== null) {
    if (typeof raw.lastStatus !== 'string' || !STATUSES.has(raw.lastStatus)) {
      throw new Error(`lastStatus 非法："${raw.lastStatus}"`);
    }
    lastStatus = raw.lastStatus;
  }
  if (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt))) {
    throw new Error('createdAt 必须是 ISO 时间字符串');
  }
  return {
    id: raw.id, title: raw.title, prompt: raw.prompt, workspace: raw.workspace,
    schedule: raw.schedule, model, preset, enabled, maxRuns, runCount, timeoutMinutes,
    missedPolicy, appendMemoryLog, createdAt, updatedAt,
    nextFire, lastFire, lastStatus,
  };
}

// ---------- 存储 ----------

/**
 * @param {string} dir 存储目录（测试注入临时目录；默认 ~/.dsh/cron）
 */
export function createStore(dir = DEFAULT_DIR) {
  const jobsFile = join(dir, 'jobs.json');
  const historyFile = join(dir, 'history.jsonl');
  let jobs = [];
  let historyLimit = 500;

  const ensureDir = () => mkdirSync(dir, { recursive: true });
  const persist = () => {
    ensureDir();
    atomicWrite(jobsFile, JSON.stringify({ version: 1, jobs }, null, 2));
  };
  const indexOf = (id) => jobs.findIndex((j) => j.id === id);

  /**
   * 读取并严格解码。文件不存在 → 空状态；
   * JSON 损坏 → 原文件改名备份（不覆盖原始字节）后从空开始；
   * 单条记录解码失败 → 抛错（调用方决定备份或报错，绝不静默丢记录）。
   */
  function load() {
    if (!existsSync(jobsFile)) {
      jobs = [];
      return { jobs, error: null };
    }
    let raw;
    try {
      raw = JSON.parse(stripBom(readFileSync(jobsFile, 'utf8')));
    } catch (e) {
      const backup = `${jobsFile}.corrupt-${Date.now()}`;
      renameSync(jobsFile, backup);
      jobs = [];
      return { jobs, error: `JSON 解析失败（已备份到 ${backup}）：${e.message}` };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('jobs.json 顶层必须是对象');
    for (const k of Object.keys(raw)) {
      if (k !== 'version' && k !== 'jobs') throw new Error(`jobs.json 含未知顶层字段 "${k}"`);
    }
    if (raw.version !== 1) throw new Error(`jobs.json version 仅支持 1，收到 ${raw.version}`);
    if (!Array.isArray(raw.jobs)) throw new Error('jobs.json 的 jobs 必须是数组');
    const seen = new Set();
    const out = raw.jobs.map((r) => {
      const job = decodeJob(r);
      if (seen.has(job.id)) throw new Error(`任务 id 重复："${job.id}"`);
      seen.add(job.id);
      return job;
    });
    jobs = out;
    return { jobs, error: null };
  }

  // ---------- CRUD ----------

  function create(input, { nowMs = Date.now(), appendMemoryLogDefault = true } = {}) {
    for (const k of ['title', 'prompt', 'workspace']) {
      if (typeof input[k] !== 'string' || input[k].trim() === '') throw new Error(`${k} 必须是非空字符串`);
    }
    const { schedule, nextFireMs } = validateSchedule(input.schedule, { nowMs });
    const model = decodeModel(input.model);
    const preset = decodePreset(input.preset);
    let maxRuns = null;
    if (input.maxRuns !== undefined && input.maxRuns !== null) {
      if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1) throw new Error('maxRuns 必须是正整数或 null');
      maxRuns = input.maxRuns;
    }
    let timeoutMinutes = 30;
    if (input.timeoutMinutes !== undefined) {
      if (!Number.isInteger(input.timeoutMinutes) || input.timeoutMinutes < 1 || input.timeoutMinutes > 24 * 60) {
        throw new Error('timeoutMinutes 必须是 1-1440 的整数');
      }
      timeoutMinutes = input.timeoutMinutes;
    }
    let missedPolicy = 'skip';
    if (input.missedPolicy !== undefined) {
      if (input.missedPolicy !== 'skip' && input.missedPolicy !== 'runOnce') throw new Error('missedPolicy 必须是 skip | runOnce');
      missedPolicy = input.missedPolicy;
    }
    const appendMemoryLog = input.appendMemoryLog === undefined ? appendMemoryLogDefault : Boolean(input.appendMemoryLog);
    const job = {
      id: `cron-${randomUUID().slice(0, 8)}`,
      title: input.title, prompt: input.prompt, workspace: input.workspace,
      schedule, model, preset, enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      maxRuns, runCount: 0, timeoutMinutes, missedPolicy, appendMemoryLog,
      createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(),
      nextFire: input.enabled === false ? null : (nextFireMs === null ? null : new Date(nextFireMs).toISOString()),
      lastFire: null, lastStatus: null,
    };
    jobs.push(job);
    persist();
    return job;
  }

  function update(id, patch, { nowMs = Date.now() } = {}) {
    const i = indexOf(id);
    if (i === -1) throw new Error(`任务不存在：${id}`);
    const job = jobs[i];
    const ALLOWED = ['title', 'prompt', 'workspace', 'schedule', 'model', 'preset', 'enabled', 'maxRuns', 'timeoutMinutes', 'missedPolicy', 'appendMemoryLog'];
    for (const k of Object.keys(patch)) {
      if (!ALLOWED.includes(k)) throw new Error(`不允许修改字段 "${k}"`);
    }
    const next = { ...job };
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string' || patch.title.trim() === '') throw new Error('title 必须是非空字符串');
      next.title = patch.title;
    }
    if (patch.prompt !== undefined) {
      if (typeof patch.prompt !== 'string' || patch.prompt.trim() === '') throw new Error('prompt 必须是非空字符串');
      next.prompt = patch.prompt;
    }
    if (patch.workspace !== undefined) {
      if (typeof patch.workspace !== 'string' || patch.workspace.trim() === '') throw new Error('workspace 必须是非空字符串');
      next.workspace = patch.workspace;
    }
    let scheduleChanged = false;
    if (patch.schedule !== undefined) {
      // once 改期允许指向未来；未改 schedule 时不动 nextFire。
      const { schedule, nextFireMs } = validateSchedule(patch.schedule, { nowMs });
      next.schedule = schedule;
      scheduleChanged = true;
      next.nextFire = next.enabled === false || nextFireMs === null ? null : new Date(nextFireMs).toISOString();
    }
    if (patch.model !== undefined) next.model = decodeModel(patch.model);
    // preset 可被显式重置为 null（面板选「跟随全局默认」），故判 undefined 而非真值。
    if (patch.preset !== undefined) next.preset = decodePreset(patch.preset);
    if (patch.maxRuns !== undefined) {
      if (patch.maxRuns !== null && (!Number.isInteger(patch.maxRuns) || patch.maxRuns < 1)) throw new Error('maxRuns 必须是正整数或 null');
      next.maxRuns = patch.maxRuns;
    }
    if (patch.timeoutMinutes !== undefined) {
      if (!Number.isInteger(patch.timeoutMinutes) || patch.timeoutMinutes < 1 || patch.timeoutMinutes > 24 * 60) {
        throw new Error('timeoutMinutes 必须是 1-1440 的整数');
      }
      next.timeoutMinutes = patch.timeoutMinutes;
    }
    if (patch.missedPolicy !== undefined) {
      if (patch.missedPolicy !== 'skip' && patch.missedPolicy !== 'runOnce') throw new Error('missedPolicy 必须是 skip | runOnce');
      next.missedPolicy = patch.missedPolicy;
    }
    if (patch.appendMemoryLog !== undefined) next.appendMemoryLog = Boolean(patch.appendMemoryLog);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
      next.enabled = patch.enabled;
      if (!next.enabled) {
        next.nextFire = null; // 暂停即清锚点，恢复时重算
      } else if (next.schedule.kind === 'once') {
        const atMs = Date.parse(next.schedule.at);
        next.nextFire = Number.isNaN(atMs) || atMs <= nowMs ? null : new Date(atMs).toISOString();
      } else {
        const { nextFireMs } = validateSchedule(next.schedule, { nowMs });
        next.nextFire = nextFireMs === null ? null : new Date(nextFireMs).toISOString();
      }
    }
    if (next.enabled && next.nextFire === null && !scheduleChanged && next.schedule.kind !== 'once') {
      // 恢复被外力清空的锚点（如手动编辑过文件）
      const { nextFireMs } = validateSchedule(next.schedule, { nowMs });
      next.nextFire = nextFireMs === null ? null : new Date(nextFireMs).toISOString();
    }
    next.updatedAt = new Date(nowMs).toISOString();
    jobs[i] = next;
    persist();
    return next;
  }

  function remove(id) {
    const i = indexOf(id);
    if (i === -1) throw new Error(`任务不存在：${id}`);
    const [gone] = jobs.splice(i, 1);
    persist();
    return gone;
  }

  function get(id) {
    const job = jobs[indexOf(id)];
    if (!job) throw new Error(`任务不存在：${id}`);
    return job;
  }

  /** 触发后前移 nextFire（持久化先于决策的"先写盘"半步）。 */
  function advanceNextFire(job, nowMs = Date.now()) {
    const prev = job.nextFire ? Date.parse(job.nextFire) : null;
    const nextMs = advanceSchedule(job.schedule, prev, nowMs);
    const i = indexOf(job.id);
    if (i !== -1) {
      jobs[i] = { ...jobs[i], nextFire: nextMs === null ? null : new Date(nextMs).toISOString() };
      persist();
      return jobs[i];
    }
    return job;
  }

  function markFired(jobId, { status, atMs = Date.now(), bumpRun = true } = {}) {
    const i = indexOf(jobId);
    if (i === -1) return null;
    const job = jobs[i];
    const runCount = bumpRun ? job.runCount + 1 : job.runCount;
    let enabled = job.enabled;
    let nextFire = job.nextFire;
    if (bumpRun && job.maxRuns !== null && runCount >= job.maxRuns) {
      enabled = false;
      nextFire = null;
    }
    jobs[i] = {
      ...job, runCount, enabled, nextFire,
      lastFire: new Date(atMs).toISOString(),
      lastStatus: status,
    };
    persist();
    return jobs[i];
  }

  function patchFields(jobId, fields) {
    const i = indexOf(jobId);
    if (i === -1) return null;
    jobs[i] = { ...jobs[i], ...fields };
    persist();
    return jobs[i];
  }

  // ---------- 运行历史（jsonl，追加 + 截断） ----------

  function appendRun(rec) {
    ensureDir();
    appendFileSync(historyFile, JSON.stringify(rec) + '\n', 'utf8');
  }

  function finalizeRun(runId, fields) {
    if (!existsSync(historyFile)) return;
    const lines = readFileSync(historyFile, 'utf8').split('\n').filter((l) => l !== '');
    let changed = false;
    const out = lines.map((l) => {
      try {
        const r = JSON.parse(l);
        if (r.runId === runId) {
          changed = true;
          return JSON.stringify({ ...r, ...fields });
        }
      } catch { /* 保留原行，响亮交给读取方 */ }
      return l;
    });
    if (changed) atomicWrite(historyFile, out.join('\n') + '\n');
  }

  function readHistory({ jobId, limit = 20 } = {}) {
    if (!existsSync(historyFile)) return [];
    const lines = readFileSync(historyFile, 'utf8').split('\n').filter((l) => l !== '');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (jobId && r.jobId !== jobId) continue;
        out.push(r);
      } catch { /* 跳过坏行 */ }
    }
    return out;
  }

  /** 历史截断：超过 historyLimit 时保留最新 N 条。 */
  function trimHistory(limit = historyLimit) {
    if (!existsSync(historyFile)) return;
    const lines = readFileSync(historyFile, 'utf8').split('\n').filter((l) => l !== '');
    if (lines.length <= limit) return;
    atomicWrite(historyFile, lines.slice(lines.length - limit).join('\n') + '\n');
  }

  return {
    load, persist,
    all: () => jobs.map((j) => ({ ...j })),
    get, create, update, remove,
    advanceNextFire, markFired, patchFields,
    appendRun, finalizeRun, readHistory, trimHistory,
    get historyFile() { return historyFile; },
    get jobsFile() { return jobsFile; },
    setHistoryLimit(n) { historyLimit = n; },
  };
}

// ---------- 写操作幂等（借鉴 dsh-task-board 账本：request id → 结果缓存） ----------

export function createDedupe(capacity = 256) {
  const seen = new Map();
  return function check(requestId) {
    if (!requestId) return { duplicate: false };
    const prev = seen.get(requestId);
    if (prev !== undefined) return { duplicate: true, result: prev };
    return {
      duplicate: false,
      remember(result) {
        seen.set(requestId, result);
        if (seen.size > capacity) {
          const first = seen.keys().next().value;
          seen.delete(first);
        }
      },
    };
  };
}
