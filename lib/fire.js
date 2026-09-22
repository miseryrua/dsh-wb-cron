// dsh-wb-cron — 开火路径：在 web profile 进程内创建全新 root agent 并驱动一次
// 完整任务（配方逐行对齐 @deepseek-ai/dsh-headless run()，已核实）：
//   agents.create → whenIdle → followup(任务指令) → whenIdle → sessions.flush
// 全栈继承由此而来：agentrouter 路由、wb-memory 记忆注入、skills、hooks
// 都在宿主进程内原生生效，无需 spawn 子进程、无需单独凭据。
//
// 已知边界（设计 §6.3）：agents 服务是 developer-preview，接口变动时只改本文件。

import { randomUUID } from 'node:crypto';
import { brandString } from '@deepseek-ai/dsh-brand';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';

const SUMMARY_MAX_CHARS = 200;

/**
 * 任务指定的预设不可用时的降级目标（用户 2026-09-22 明确指定"降级用标准模式跑"）。
 * 定时任务无人值守，中断的代价高于用标准模式跑完的偏差——故这里选择
 * "响亮记录 + 继续执行"，而不是插件其他处"响亮失败"的纪律。
 */
export const FALLBACK_PRESET_ID = 'standard';

/** 任务头：无人值守声明 + 环境信息（防 agent 调 ask_user 挂到看门狗超时）。 */
export function buildTaskText(job, { nowMs = Date.now(), plannedMs = null } = {}) {
  const now = new Date(nowMs).toLocaleString('zh-CN');
  const planned = plannedMs ? new Date(plannedMs).toLocaleString('zh-CN') : '手动触发';
  const memoryLine = job.appendMemoryLog
    ? '\n收尾时请把本次执行摘要追加到当前工作区 .workbuddy/memory/ 的当日日志。'
    : '';
  return [
    `【定时任务】${job.title}`,
    `触发时间：${now}（计划 ${planned}）`,
    `工作区：${job.workspace}`,
    '这是无人值守的定时执行，没有任何用户在线。请直接开始执行任务，',
    '不要向用户提问；遇到不确定处自主做出保守决策，并在结果中说明。',
    '完成后用一小段文字总结做了什么、结果如何。',
    '',
    job.prompt,
  ].join('\n') + memoryLine;
}

/**
 * 汇总一次运行的助手产出与结束原因（对齐 dsh-headless summarize）：
 * 遍历 [firstSeq, session.seq) 的事件流，取最后一条非空 assistant 文本
 * 与最后一个 turn/end 的 reason。
 */
export function summarizeSession(session, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  const length = session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) break;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data?.reason;
  }
  return { text, reason };
}

function tryStopAgent(agent) {
  // 宿主未见公开 stop/abort 接口（设计 §6.1 第 5 步）：有则调用，无则标记放弃。
  for (const name of ['stop', 'abort', 'dispose']) {
    try {
      if (typeof agent?.[name] === 'function') agent[name]();
    } catch { /* 尽力而为 */ }
  }
}

/**
 * @param {object} ctx 宿主上下文（经 ctx.get 取服务）
 * @param {object} config 插件配置（defaultTimeoutMinutes 等）
 * @returns {{ fireJob: (job, opts) => Promise<object> }}
 */
export function createFire(ctx, config = {}) {
  const getService = (key) => {
    try { return ctx.get(key); } catch { return undefined; }
  };

  /**
   * 执行一个任务。
   * @returns {Promise<{status:string, summary:string, error:string|null,
   *   sessionId:string, durationMs:number}>}
   * status: completed | error | timeout | cancelled
   */
  async function fireJob(job, { requestCancel = () => false, plannedMs = null } = {}) {
    const startedAt = Date.now();
    const agents = getService('agents');
    const defaultModel = getService('agentDefaultModel');
    const sessions = getService('sessions');
    if (!agents || !defaultModel || !sessions) {
      throw new Error('核心服务缺失（agents / agentDefaultModel / sessions）——宿主尚未就绪或 profile 不支持');
    }
    // 对齐 dsh-headless：等插件树装配完成再取服务。
    try { await getService('loader')?.await?.(); } catch { /* loader 不存在或失败都放行 */ }

    const selection = job.model ?? defaultModel.currentSelection();
    // agent preset：web profile 的工具集/系统提示/skill 全部挂在 preset（默认
    // standard）的组合里，不 join preset 的 agent 只能看到空全局层的工具
    // （dsh-agent-presets 警告 "resolve against the empty global layer"）。
    // 2026-09-07 真机踩坑：任务 agent 无 write/pwsh 工具，被迫拿 univer 工具
    // 写 .md 而报错。对齐 api-session-controller 的 composeAgent：resolve →
    // meta 记录 agentPreset（续聊时恢复同一组合）→ setup 内 mount。
    // Agent 预设解析：任务指定优先，不可用时沿降级链落到 standard，再落到全局默认。
    // resolve(undefined) 才是"全局默认"（服务内部走 defaultId，受 modeSelectionEnabled 影响）。
    const presets = getService('agentPresets');
    let presetId;
    let presetNote = null;
    if (presets) {
      const wanted = job.preset ?? undefined;
      try {
        presetId = (await presets.resolve(wanted)).id;
      } catch (e) {
        // 任务钉的预设没了/坏了：不中断任务，降级并留痕。
        const why = e?.message ?? e;
        try {
          presetId = (await presets.resolve(FALLBACK_PRESET_ID)).id;
          presetNote = `预设 "${job.preset}" 不可用，已降级为 ${presetId}（${why}）`;
        } catch {
          try {
            presetId = (await presets.resolve(undefined)).id;
            presetNote = `预设 "${job.preset}" 不可用且 ${FALLBACK_PRESET_ID} 亦不可用，已降级为全局默认 ${presetId}（${why}）`;
          } catch {
            presetId = undefined; // 无预设可挂：按宿主裸上下文创建（工具集为空，与 v0.1.1 前的降级同款）
            presetNote = `预设 "${job.preset}" 不可用，且无任何可用预设（${why}）`;
          }
        }
      }
      if (presetNote) config.logger?.warn?.(`[dsh-wb-cron] 「${job.title}」${presetNote}`);
    } else {
      presetId = undefined;
    }
    const sessionId = brandString(`session-${randomUUID()}`);
    const { agent } = await agents.create({
      sessionId,
      meta: {
        cwd: job.workspace,
        ...(presetId ? { agentPreset: presetId } : {}),
      },
      agentOptions: { provider: selection.provider, model: selection.model },
      // 注意：必须用块体（不返回值）。dsh-agent-loop 对 setup 的约定是
      // 返回 undefined 或带 .commit() 的句柄（L1330 `(await ...)?.commit()`），
      // 而 installModelSelection 返回 disposer 函数——表达式体会隐式返回它，
      // 函数上无 .commit → `(intermediate value)?.commit is not a function`
      // （2026-09-07 真机实测踩坑；dsh-headless 官方即块体写法）。
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
        if (presets && presetId) await presets.mount(agentCtx, presetId);
      },
    });
    await agent.whenIdle();

    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildTaskText(job, { nowMs: startedAt, plannedMs }) }],
      source: { kind: 'user' },
    }));

    const timeoutMs = (job.timeoutMinutes ?? config.defaultTimeoutMinutes ?? 30) * 60_000;
    let verdict = 'idle';
    let cancelTimer = null;
    try {
      verdict = await Promise.race([
        agent.whenIdle().then(() => 'idle', () => 'idle-error'),
        new Promise((resolve) => { cancelTimer = setTimeout(() => resolve('timeout'), timeoutMs); }),
        new Promise((resolve) => {
          const iv = setInterval(() => {
            if (requestCancel()) {
              clearInterval(iv);
              resolve('cancelled');
            }
          }, 3000);
          // 取消轮询自身不阻止退出；watchdog 兜底。
          if (iv.unref) iv.unref();
        }),
      ]);
    } catch (e) {
      verdict = 'error';
      cancelTimer = null;
      config.logger?.warn?.(`[dsh-wb-cron] 等待 idle 异常：${e?.message ?? e}`);
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
    }

    let status;
    let errorText = null;
    if (verdict === 'timeout') {
      status = 'timeout';
      errorText = `看门狗超时（${job.timeoutMinutes ?? config.defaultTimeoutMinutes ?? 30} 分钟未回到 idle）`;
      tryStopAgent(agent);
    } else if (verdict === 'cancelled') {
      status = 'cancelled';
      errorText = '被用户停止';
      tryStopAgent(agent);
    } else if (verdict === 'error') {
      status = 'error';
      errorText = '等待 agent idle 时抛出异常';
    }

    try { await sessions.flush(agent.session); } catch { /* 落盘失败不掩盖运行结果 */ }

    // 把会话挂进对应工作区：侧边栏归组靠 workspace.sessionIds，web UI 走
    // session.create 时由宿主 attachSession；直连 agents.create 不会 attach，
    // 会话会落在「未分组」（2026-09-07 真机踩坑）。attach 内部会校验会话
    // header.cwd 与工作区 path 一致（realpath 归一），失败仅降级为未分组、
    // 不影响任务结果。
    try {
      const registry = getService('workspaceRegistry');
      const ws = registry?.list?.().find((w) => w.path === job.workspace)
        ?? registry?.list?.().find((w) => String(w.path).toLowerCase() === String(job.workspace).toLowerCase());
      if (ws) await ws.attachSession(sessionId);
    } catch { /* 找不到工作区/attach 失败 → 会话留在未分组，不影响任务 */ }

    let summary = '';
    if (verdict === 'idle') {
      try {
        const s = summarizeSession(agent.session, firstSeq);
        summary = s.text;
        if (s.reason?.kind === 'completed') status = 'completed';
        else {
          status = 'error';
          errorText = s.reason?.kind === 'error'
            ? `${s.reason?.error?.code ?? 'error'}: ${s.reason?.error?.message ?? '未知错误'}`
            : `turn 未正常完成（${s.reason?.kind ?? 'no turn/end'}）`;
        }
      } catch (e) {
        status = 'error';
        errorText = `汇总失败：${e?.message ?? e}`;
      }
    } else {
      // 超时/取消也尽力带出已有产出
      try { summary = summarizeSession(agent.session, firstSeq).text; } catch { /* 忽略 */ }
    }

    // 降级说明并入 error 字段：任务成功但发生了降级时，用户必须能在面板/历史里看见。
    const errorFinal = presetNote
      ? (errorText ? `${presetNote}；${errorText}` : presetNote)
      : errorText;

    return {
      status,
      summary: summary.length > SUMMARY_MAX_CHARS ? summary.slice(0, SUMMARY_MAX_CHARS) + '…' : summary,
      error: errorFinal,
      sessionId: String(sessionId ?? ''),
      durationMs: Date.now() - startedAt,
    };
  }

  return { fireJob };
}
