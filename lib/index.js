// dsh-wb-cron — 插件入口：装配调度器、7 个模型工具、HTTP 路由与 settings 命名空间。
//
// 装配纪律：
// - tools/webServer/settings/llm 只在存在的 profile 里经作用域注入挂载
//   （modsearch 同款），headless profile 下插件安静降级；
// - 调度器只在长驻 profile 启动（dsh-headless 这类带 appExit 的一次性
//   launcher 里跳过——进程跑完即退，定时无意义）；
// - 工具用原生 JSON-Schema 自管校验（out-of-tree 引 @deepseek-ai/dsh-tools
//   不可靠，modsearch 同款结论）。

import { readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createStore, createDedupe } from './jobs.js';
import { createFire } from './fire.js';
import { createScheduler } from './scheduler.js';
import { describeSchedule, parseCron, previewSchedule } from './cron.js';

// 与 wb-memory 相同的工作区根判定：环境变量优先，默认本机 DSH 工作区根。
const DSH_ROOT = process.env.DSH_WORKSPACE_ROOT || 'D:\\datas\\Deepseek Harness';

export const name = 'dsh-wb-cron';
export const inject = ['agents', 'sessions', 'agentDefaultModel'];

const DEFAULTS = {
  maxConcurrentJobs: 1,
  tickMs: 30_000,
  historyLimit: 500,
  defaultTimeoutMinutes: 30,
  appendMemoryLogDefault: true,
};

function log(...args) { console.log('[dsh-wb-cron]', ...args); }
function warn(...args) { console.warn('[dsh-wb-cron]', ...args); }

const iso = (ms) => new Date(ms).toISOString();
const local = (ms) => new Date(ms).toLocaleString('zh-CN');

// ---------- 同源栅栏（照搬 modsearch isTrustedRequest：防 DNS rebinding 与跨站页） ----------

function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isTrustedRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return false; }
  if (!isLoopbackHost(hostUrl.hostname)) return false;
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

async function readJsonBody(req, cap = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) throw new Error('payload too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

function listWorkspaces() {
  try {
    return readdirSync(DSH_ROOT)
      .filter((n) => {
        if (n.startsWith('.')) return false;
        try { return statSync(join(DSH_ROOT, n)).isDirectory(); } catch { return false; }
      })
      .sort()
      .map((name) => ({ name, path: join(DSH_ROOT, name) }));
  } catch {
    return [];
  }
}

// ---------- 模型工具 ----------

function toolDefs({ store, scheduler }) {
  const jobPublic = (job) => ({ ...job });
  const renderJob = (job) => [
    `✅ ${job.title}（${job.id}）`,
    `调度：${describeSchedule(job.schedule)} · 下次：${job.nextFire ? local(Date.parse(job.nextFire)) : '—'}`,
    `工作区：${job.workspace} · 模型：${job.model ? `${job.model.provider}/${job.model.model}` : '跟随全局默认'} · 预设：${job.preset ?? '跟随全局默认'}`,
    `已跑 ${job.runCount} 次${job.lastStatus ? ` · 上次 ${job.lastStatus}` : ''}${job.enabled ? '' : ' · [已暂停]'}`,
  ].join('\n');

  return [
    {
      name: 'cron_create',
      description: [
        '创建一个无人值守定时任务：到点自动拉起一个全新的 agent 会话，在指定工作区里自主执行 prompt。',
        '与宿主内置 schedule_create 的分工：提醒当前会话用 schedule_create；跨会话、会话关闭也照常执行的定时任务用本工具。',
        '硬性要求：prompt 必须自包含——定时执行时看不到当前对话，请写清楚要做什么、输入在哪、结果写到哪。',
        '相对时间（"8分钟后"/"明天下午3点"）必须在创建时换算为绝对 ISO 时间写入 schedule.at，绝不原样传相对说法。',
        'schedule 三选一：{kind:"cron", expr:"分 时 日 月 周", tz?} | {kind:"interval", everyMinutes:>=5} | {kind:"once", at:"ISO 绝对时间"}。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务名（同时作为会话可读标题）' },
          prompt: { type: 'string', description: '任务指令，必须自包含' },
          workspace: { type: 'string', description: '工作区绝对路径，会话将归属该工作区' },
          schedule: {
            type: 'object',
            description: '调度：{kind:"cron",expr,tz?} 或 {kind:"interval",everyMinutes>=5} 或 {kind:"once",at}',
            properties: {
              kind: { type: 'string', enum: ['cron', 'interval', 'once'] },
              expr: { type: 'string', description: 'kind=cron：5 字段表达式' },
              tz: { type: 'string', description: '可选 IANA 时区，缺省用宿主本地' },
              everyMinutes: { type: 'number', description: 'kind=interval：间隔分钟 ≥5' },
              at: { type: 'string', description: 'kind=once：ISO 绝对时间，必须未来' },
            },
            required: ['kind'],
          },
          model: { type: 'object', description: '可选 {provider, model}，缺省跟随全局默认' },
          preset: { type: 'string', description: '可选 agent 预设 id（如 standard/minimal/cordis），缺省或 null 跟随全局默认。指定预设不可用时降级为 standard 继续执行并在历史中留痕' },
          maxRuns: { type: 'number', description: '可选，最多执行 N 次后自动完成；缺省无限' },
          timeoutMinutes: { type: 'number', description: '可选，单次看门狗超时（默认 30）' },
          missedPolicy: { type: 'string', enum: ['skip', 'runOnce'], description: '错过策略：跳过（默认）/ 补跑一次' },
          appendMemoryLog: { type: 'boolean', description: '收尾是否追加 wb-memory 当日日志（默认开）' },
        },
        required: ['title', 'prompt', 'workspace', 'schedule'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.error ? `❌ ${value.error}` : renderJob(value.job) }],
      },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const job = store.create(args);
        log(`工具创建任务 ${job.id}「${job.title}」`);
        return { job: jobPublic(job) };
      },
    },
    {
      name: 'cron_list',
      description: '列出全部 dsh-wb-cron 定时任务（含下次触发时间与上次状态）。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{
          type: 'text',
          text: value.jobs.length === 0
            ? '（暂无定时任务）'
            : value.jobs.map((j) => `${j.enabled ? '●' : '○'} ${j.title}（${j.id}）\n   ${describeSchedule(j.schedule)} · 下次 ${j.nextFire ? local(Date.parse(j.nextFire)) : '—'} · 已跑 ${j.runCount} 次${j.lastStatus ? ` · 上次 ${j.lastStatus}` : ''}`).join('\n'),
        }],
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute() {
        return { jobs: store.all().map(jobPublic) };
      },
    },
    {
      name: 'cron_update',
      description: '更新 dsh-wb-cron 定时任务。改 schedule 会重算下次触发时间。只传需要修改的字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id（cron_list 可查）' },
          title: { type: 'string' }, prompt: { type: 'string' }, workspace: { type: 'string' },
          schedule: { type: 'object', description: '同 cron_create 的 schedule' },
          enabled: { type: 'boolean', description: '暂停/恢复' },
          model: { type: 'object' }, preset: { type: 'string', description: 'agent 预设 id；传 null 重置为跟随全局默认' }, maxRuns: { type: 'number' },
          timeoutMinutes: { type: 'number' }, missedPolicy: { type: 'string', enum: ['skip', 'runOnce'] },
          appendMemoryLog: { type: 'boolean' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.error ? `❌ ${value.error}` : renderJob(value.job) }],
      },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const { id, ...patch } = args;
        const job = store.update(id, patch);
        return { job: jobPublic(job) };
      },
    },
    {
      name: 'cron_delete',
      description: '删除 dsh-wb-cron 定时任务（运行历史保留）。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.error ? `❌ ${value.error}` : `🗑 已删除「${value.title}」（${value.id}），历史保留` }],
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const gone = store.remove(args.id);
        return { id: gone.id, title: gone.title };
      },
    },
    {
      name: 'cron_run_now',
      description: '立即试跑一个 dsh-wb-cron 定时任务（走与计划触发完全相同的队列与收尾，不改变下次计划时间）。调试用。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{
          type: 'text',
          text: value.error ? `❌ ${value.error}` : `▶ 已入队立即执行「${value.title}」（runId ${value.runId}），结果请稍后用 cron_history 查看`,
        }],
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const job = store.get(args.id);
        const { runId } = scheduler.runNow(args.id);
        return { runId, title: job.title };
      },
    },
    {
      name: 'cron_next',
      description: '预览一个 dsh-wb-cron 调度未来 N 次触发时间点（创建前确认表达式语义用）。可传表达式或已有任务 id。',
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: '5 字段 cron 表达式（与 id 二选一）' },
          id: { type: 'string', description: '已有任务 id（与 expr 二选一）' },
          count: { type: 'number', description: '预览次数，默认 5，最多 20' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{
          type: 'text',
          text: value.error ? `❌ ${value.error}` : `${value.describe}\n${value.times.map((t, i) => `${i + 1}. ${local(t)}`).join('\n') || '（未来一年内无触发点）'}`,
        }],
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const count = Math.min(Math.max(1, args.count ?? 5), 20);
        let schedule;
        if (args.expr) {
          parseCron(args.expr); // 语法校验，错误信息具体
          schedule = { kind: 'cron', expr: args.expr };
        } else if (args.id) {
          schedule = store.get(args.id).schedule;
        } else {
          return { error: '需要 expr 或 id 其一', times: [], describe: '' };
        }
        const times = previewSchedule(schedule, count, Date.now());
        return { times, describe: describeSchedule(schedule) };
      },
    },
    {
      name: 'cron_history',
      description: '查询 dsh-wb-cron 定时任务的运行历史（状态、耗时、会话 id、结果摘要）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '可选，按任务过滤' },
          limit: { type: 'number', description: '返回条数，默认 20' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{
          type: 'text',
          text: value.runs.length === 0
            ? '（暂无运行记录）'
            : value.runs.map((r) => `${r.status === 'completed' ? '✓' : r.status === 'running' ? '⟳' : '✗'} ${local(Date.parse(r.startedAt))} · ${r.title} · ${r.status}${r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(0)}s` : ''}${r.sessionId ? ` · 会话 ${r.sessionId}` : ''}${r.error ? ` · ${r.error}` : ''}`).join('\n'),
        }],
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const runs = store.readHistory({ jobId: args.id, limit: Math.min(args.limit ?? 20, 100) });
        return { runs };
      },
    },
  ];
}

// ---------- apply ----------

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  const store = createStore();
  store.setHistoryLimit(cfg.historyLimit);
  try {
    const { jobs, error } = store.load();
    store.persist();
    if (error) warn(error);
    log(`已加载 ${jobs.length} 个定时任务（${store.jobsFile}）`);
  } catch (e) {
    // 严格解码失败：原文件改名备份（不覆盖原始字节），从空状态继续。
    const backup = `${store.jobsFile}.corrupt-${Date.now()}`;
    try {
      renameSync(store.jobsFile, backup);
      warn(`jobs.json 严格解码失败（${e.message}）；原文件已备份到 ${backup}，从空状态继续`);
    } catch (e2) {
      warn(`jobs.json 严格解码失败（${e.message}）且备份失败：${e2?.message ?? e2}`);
    }
  }

  const fire = createFire(ctx, cfg);
  const scheduler = createScheduler({ store, fireJob: fire.fireJob, logger: { log, warn }, config: cfg });

  // headless 这类一次性 launcher 里不启动调度器。判别器用 headlessStartup
  // （dsh-headless/startup 解析到任务时才 provide 的服务）：appExit 不可用
  // ——它由 dsh-cmdline 提供而 cmdline 存在于所有 profile，web 下也命中
  // （2026-09-07 真机实测踩坑：曾用 appExit 判别导致 web 下调度器被跳过）。
  let launcherProfile = false;
  try { launcherProfile = ctx.get('headlessStartup') !== undefined; } catch { launcherProfile = false; }
  if (launcherProfile) {
    log('一次性 launcher profile：调度器不启动');
  } else {
    ctx.effect(() => {
      scheduler.start();
      return () => scheduler.stopAll();
    }, 'dsh-wb-cron: scheduler');
  }

  // 模型工具（作用域注入：headless 无 tools 服务时安静跳过）
  ctx.inject(['tools'], (scope) => {
    try {
      for (const def of toolDefs({ store, scheduler })) scope.tools.register(def);
      log('已注册 7 个 cron_* 工具');
    } catch (e) {
      warn(`工具注册失败（不影响其余功能）：${e?.message ?? e}`);
    }
  });

  // HTTP 路由（web profile 限定）
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const dedupe = createDedupe(256);
      const send = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const route = (path, handler) => {
        host.webServer.register({ name: `dsh-wb-cron${path.replaceAll('/', '-')}`, kind: 'exact', path, handler });
      };
      const writeGuard = (req, res) => {
        if (!isTrustedRequest(req)) {
          send(res, 403, { error: 'request refused: this route answers same-origin loopback only' });
          return false;
        }
        return true;
      };
      const dedupeWrap = (req, res, fn) => {
        const requestId = req.headers?.['x-dsh-request-id'];
        const d = dedupe(requestId);
        if (d.duplicate) {
          send(res, 200, d.result);
          return;
        }
        d.remember(fn());
      };

      route('/dsh-wb-cron/state', async (req, res) => {
        send(res, 200, {
          now: iso(Date.now()),
          jobs: store.all(),
          running: scheduler.state().running,
          scheduler: { alive: scheduler.state().alive, lastTick: scheduler.state().lastTick },
        });
      });

      route('/dsh-wb-cron/job', async (req, res) => {
        if (!writeGuard(req, res)) return;
        try {
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const job = store.create(body);
            log(`面板创建任务 ${job.id}「${job.title}」`);
            send(res, 200, { job });
          } else if (req.method === 'PATCH') {
            const body = await readJsonBody(req);
            // body 必含 id 用于定位，但 store.update 的白名单不允许 patch 携带
            // id——剥离后传入（与 cron_update 工具层同款处理；store 对其他
            // 非法字段的严格拒绝保留）。
            const { id, ...patch } = body;
            const job = store.update(id, patch);
            send(res, 200, { job });
          } else if (req.method === 'DELETE') {
            const id = new URL(req.url, 'http://localhost').searchParams.get('id');
            const gone = store.remove(id);
            send(res, 200, { id: gone.id });
          } else {
            res.writeHead(405).end();
          }
        } catch (e) {
          send(res, 400, { error: String(e?.message ?? e) });
        }
      });

      route('/dsh-wb-cron/job/run', async (req, res) => {
        if (!writeGuard(req, res)) return;
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        try {
          const body = await readJsonBody(req);
          const job = store.get(body.id);
          const { runId } = scheduler.runNow(body.id);
          send(res, 200, { runId, title: job.title });
        } catch (e) {
          send(res, 409, { error: String(e?.message ?? e) });
        }
      });

      route('/dsh-wb-cron/job/stop', async (req, res) => {
        if (!writeGuard(req, res)) return;
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        try {
          const body = await readJsonBody(req);
          const ok = scheduler.stop(body.id);
          send(res, 200, { stopped: ok, note: ok ? '已置取消标志，由看门狗路径收尾' : '该任务未在运行' });
        } catch (e) {
          send(res, 400, { error: String(e?.message ?? e) });
        }
      });

      route('/dsh-wb-cron/preview', async (req, res) => {
        try {
          const q = new URL(req.url, 'http://localhost').searchParams;
          const count = Math.min(Math.max(1, Number(q.get('count') ?? 3) || 3), 10);
          let schedule;
          const id = q.get('id');
          if (id) schedule = store.get(id).schedule;
          else {
            const expr = q.get('expr') ?? '';
            parseCron(expr);
            const tz = q.get('tz');
            schedule = { kind: 'cron', expr, ...(tz ? { tz } : {}) };
          }
          const times = previewSchedule(schedule, count, Date.now());
          send(res, 200, { describe: describeSchedule(schedule), times });
        } catch (e) {
          send(res, 400, { error: String(e?.message ?? e) });
        }
      });

      route('/dsh-wb-cron/history', async (req, res) => {
        try {
          const q = new URL(req.url, 'http://localhost').searchParams;
          const runs = store.readHistory({
            jobId: q.get('jobId') ?? undefined,
            limit: Math.min(Number(q.get('limit') ?? 20) || 20, 100),
          });
          send(res, 200, { runs });
        } catch (e) {
          send(res, 400, { error: String(e?.message ?? e) });
        }
      });

      route('/dsh-wb-cron/workspaces', async (req, res) => {
        send(res, 200, { dshRoot: DSH_ROOT, workspaces: listWorkspaces() });
      });

      route('/dsh-wb-cron/models', async (req, res) => {
        try {
          const llm = globalThis.__dshWbCronLlm;
          const providers = [];
          if (llm) {
            for (const p of (llm.listProviders?.() ?? [])) {
              const pid = (p && (p.id || p.provider)) || p;
              let models = [];
              try { models = await llm.listModels(pid); } catch { /* 单 provider 失败不挡列表 */ }
              providers.push({
                id: pid,
                models: (models ?? []).map((m) => (m && typeof m === 'object'
                  ? { id: m.id ?? m.model ?? String(m), name: m.name ?? '' }
                  : { id: String(m), name: '' })),
              });
            }
          }
          let current = null;
          try {
            const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
            if (sel) current = { provider: sel.provider, model: sel.model };
          } catch { /* 忽略 */ }
          send(res, 200, { current, providers, note: llm ? undefined : 'llm 服务尚未注入（重启宿主或稍候）' });
        } catch (e) {
          send(res, 500, { error: String(e?.message ?? e) });
        }
      });

      // agent 预设枚举。优先走 remoteExportList()：它已剥离本地路径，且带上
      // isDefault/broken，面板无需自行推断；服务本身非记忆化，每次请求都重读
      // 预设根目录，故面板刷新即可看到新建/删除的预设。
      route('/dsh-wb-cron/presets', async (req, res) => {
        try {
          const presets = ctx.get('agentPresets');
          if (!presets) {
            send(res, 200, { presets: [], available: false, note: 'agentPresets 服务不可用' });
            return;
          }
          let list = [];
          let modeSelectionEnabled;
          if (typeof presets.remoteExportList === 'function') {
            const exported = await presets.remoteExportList();
            list = exported?.presets ?? [];
            modeSelectionEnabled = exported?.modeSelectionEnabled;
          } else {
            list = await presets.list();
          }
          // resolve(undefined) 才是「全局默认」（服务内部走 defaultId，受
          // modeSelectionEnabled 影响），不能用 '' 或 'default' 代替。
          let defaultId = null;
          try { defaultId = (await presets.resolve(undefined)).id; } catch { /* 无默认预设时保持 null */ }
          send(res, 200, { presets: list, defaultId, modeSelectionEnabled, available: true });
        } catch (e) {
          send(res, 500, { error: String(e?.message ?? e) });
        }
      });

      log('HTTP 路由已注册（/dsh-wb-cron/*）');
    }, 'dsh-wb-cron: http routes');
  });

  // settings 空命名空间（rc.7+ 设置卡片按命名空间分发；modsearch 同款）
  ctx.inject(['settings'], (scope) => {
    try {
      const passThrough = (value) => ({ ...(value ?? {}) });
      passThrough.toJSON = () => ({ uid: 0, refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } } });
      scope.settings.register('dsh-wb-cron', passThrough, { base: {} });
    } catch (e) {
      warn(`settings 命名空间注册失败（设置卡片可能不显示）：${e?.message ?? e}`);
    }
  });

  // 捕获 llm 服务供 /dsh-wb-cron/models 枚举（wb-memory 同款做法）
  ctx.inject(['llm'], (scope) => {
    try { globalThis.__dshWbCronLlm = scope.llm; } catch { /* 忽略 */ }
  });
}
