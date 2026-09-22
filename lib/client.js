// dsh-wb-cron — browser half（手写 __ModuleLoader__ bundle，无构建步骤）。
//
// 两级入口：
// 1. sidebar.footer.action（左下角，一级）：入口按钮 + 状态角标 + portal 浮层
//    （只读速览 + 试跑/停止两个轻操作）；
// 2. settings.section（二级）：完整 CRUD + 新建/编辑对话框 + 运行历史。
//
// 宿主权威原则：调度与执行状态以宿主为准，前端只是异步视图——写后立即
// refetch，绝不在前端推算 nextFire。浮层 portal 到 document.body（避开
// 侧边栏作用域主题 token 泄漏，usage-stats issue #17 同款教训）。

window.__ModuleLoader__.load({
  id: "dsh-wb-cron",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const react_dom = require("react-dom");
    const h = react.createElement;
    const { useState, useEffect, useRef, useCallback } = react;

    //#region css
    const CSS = [
      ".crn_layer{flex:none;align-items:center;width:100%;height:49px;margin:8px 0 0;display:flex;position:relative}",
      ".crn_badge{width:100%;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}",
      ".crn_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
      ".crn_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}",
      ".crn_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
      ".crn_dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;margin-left:auto}",
      ".crn_dotCount{font-size:11px;font-weight:600;line-height:14px;border-radius:8px;padding:0 5px;color:#fff;background:#22a06b;flex:none}",
      // 主题纪律：宿主设计系统没有 --dsw-alias-bg-primary 这个变量（猜错名
      // → 走 #fff fallback，深色主题下白底+浅字不可读，2026-09-07 真机踩坑）。
      // 浮层/对话框背景用 --dsw-alias-bg-overlay（官方语义就是 overlay/popover），
      // 文字用 --dsw-alias-label-primary，描边用 --dsw-alias-border-l2；alias 变量
      // 挂在 body 上（body[data-ds-dark-theme] 分支切深色），portal 到 body 仍继承。
      ".crn_panel{position:fixed;left:12px;bottom:60px;width:380px;max-height:64vh;overflow:auto;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:10000;padding:12px;font-size:13px}",
      ".crn_panelHead{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;margin-bottom:6px}",
      ".crn_subtle{opacity:.65;font-size:12px}",
      ".crn_row{display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid rgba(128,128,128,.14)}",
      ".crn_row:last-child{border-bottom:none}",
      ".crn_rowMain{min-width:0;flex:1}",
      ".crn_rowTitle{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".crn_btn{cursor:pointer;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;border-radius:8px;padding:3px 10px;font-size:12px;font-family:inherit;flex:none}",
      ".crn_btn:hover{background:rgba(128,128,128,.12)}",
      ".crn_btn:disabled{opacity:.45;cursor:default}",
      ".crn_btnPrimary{background:#2563eb;border-color:#2563eb;color:#fff}",
      ".crn_btnPrimary:hover{background:#1d4fd8}",
      ".crn_btnDanger{color:#d33}",
      ".crn_tag{font-size:11px;border-radius:6px;padding:1px 6px;flex:none;font-weight:600}",
      ".crn_statusbar{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(128,128,128,.2);border-radius:10px;margin-bottom:10px;font-size:12px;flex-wrap:wrap}",
      ".crn_card{border:1px solid rgba(128,128,128,.2);border-radius:12px;padding:10px 12px;margin-bottom:12px}",
      ".crn_h3{font-weight:600;font-size:13px;margin:0 0 8px;display:flex;align-items:center;gap:8px}",
      ".crn_overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:10001;display:flex;align-items:flex-start;justify-content:center;padding:8vh 16px}",
      ".crn_dialog{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;width:520px;max-width:96vw;max-height:82vh;overflow:auto;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.25)}",
      ".crn_label{display:block;font-size:12px;font-weight:600;margin:12px 0 4px}",
      ".crn_input,.crn_select,.crn_textarea{width:100%;box-sizing:border-box;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:6px 8px;font-size:13px;font-family:inherit;background:transparent;color:inherit}",
      ".crn_textarea{min-height:88px;resize:vertical}",
      ".crn_hint{opacity:.6;font-size:11px;margin-top:4px;line-height:1.5}",
      ".crn_err{color:#d33;font-size:12px;margin-top:6px;white-space:pre-wrap}",
      ".crn_tabs{display:flex;gap:6px;margin-bottom:4px}",
      ".crn_tab{cursor:pointer;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;border-radius:8px;padding:4px 12px;font-size:12px;font-family:inherit}",
      ".crn_tab[data-on]{background:#2563eb;border-color:#2563eb;color:#fff}",
      ".crn_histRow{display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:12px;border-bottom:1px solid rgba(128,128,128,.1)}",
      ".crn_spin{display:inline-block;animation:crnspin 1s linear infinite}",
      "@keyframes crnspin{to{transform:rotate(360deg)}}",
    ].join("");
    function injectCssOnce() {
      if (document.getElementById("dsh-wb-cron-css")) return;
      const el = document.createElement("style");
      el.id = "dsh-wb-cron-css";
      el.textContent = CSS;
      document.head.appendChild(el);
    }
    //#endregion

    //#region api + helpers
    const genId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) + "-crn";

    async function apiGet(path) {
      const r = await fetch(path, { cache: "no-store" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      return b;
    }
    async function apiWrite(path, method, body) {
      const r = await fetch(path, {
        method,
        headers: { "content-type": "application/json", "x-dsh-request-id": genId() },
        body: JSON.stringify(body ?? {}),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      return b;
    }

    function useCronState(intervalMs) {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const refresh = useCallback(async () => {
        try { setState(await apiGet("/dsh-wb-cron/state")); setError(null); }
        catch (e) { setError(String(e?.message ?? e)); }
      }, []);
      useEffect(() => {
        refresh();
        const iv = setInterval(refresh, intervalMs);
        return () => clearInterval(iv);
      }, [refresh, intervalMs]);
      return { state, error, refresh };
    }

    const two = (n) => String(n).padStart(2, "0");
    const fmtLocal = (isoS) => {
      const d = new Date(isoS);
      if (Number.isNaN(d.getTime())) return "—";
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    };
    const fmtClock = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
    function fmtDuration(ms) {
      if (ms == null || ms < 0) return "—";
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s} 秒`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m} 分 ${s % 60} 秒`;
      return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
    }
    function fmtCountdown(isoS) {
      const t = new Date(isoS).getTime();
      if (Number.isNaN(t)) return "—";
      const diff = t - Date.now();
      if (diff <= 0) return "即将触发";
      if (diff < 60_000) return "1 分钟内";
      if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟后`;
      if (diff < 86_400_000) {
        const d = new Date(t);
        const now = new Date();
        const isTomorrow = d.getDate() !== now.getDate() && (t - now.getTime()) < 86_400_000 * 1.2;
        return `${isTomorrow ? "明天 " : ""}${Math.floor(diff / 3600_000)} 小时后（${fmtClock(d)}）`.replace("（）", "");
      }
      return `${Math.floor(diff / 86_400_000)} 天后（${fmtLocal(isoS).slice(5)}）`;
    }
    const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];
    /** 轻量人话化（与后端 describeCron 口径一致，覆盖常用形态，复杂表达式原样展示）。 */
    function describeCron(expr) {
      const f = String(expr || "").trim().split(/\s+/);
      if (f.length !== 5) return expr;
      const expand = (s, lo, hi) => {
        const out = new Set();
        const slash = s.indexOf("/");
        const step = slash >= 0 ? Number(s.slice(slash + 1)) || 1 : 1;
        const body = slash >= 0 ? s.slice(0, slash) : s;
        if (body === "*") { for (let v = lo; v <= hi; v += step) out.add(v); return out; }
        if (body.includes("-")) {
          const [a, b] = body.split("-").map(Number);
          for (let v = a; v <= b; v += step) out.add(v);
          return out;
        }
        out.add(Number(body));
        return out;
      };
      try {
        const min = expand(f[0], 0, 59), hour = expand(f[1], 0, 23), dom = f[2], mon = f[3], dow = f[4];
        if (mon !== "*") return expr;
        const hh = [...hour], mm = [...min];
        if (hh.length === 1 && mm.length === 1 && dom === "*" && dow === "*") return `每天 ${fmtClock(new Date(2000, 0, 1, hh[0], mm[0]))}`;
        if (hh.length === 1 && mm.length === 1 && dom === "*" && dow !== "*") {
          const days = [...expand(dow, 0, 7)].map((v) => (v === 7 ? 0 : v)).sort();
          if (days.join(",") === "1,2,3,4,5") return `工作日 ${fmtClock(new Date(2000, 0, 1, hh[0], mm[0]))}`;
          if (days.length <= 3) return `每周${days.map((d) => WEEK_ZH[d]).join("、")} ${fmtClock(new Date(2000, 0, 1, hh[0], mm[0]))}`;
        }
        if (hh.length === 1 && mm.length === 1 && dom !== "*" && dow === "*") return `每月${Number(dom)}日 ${fmtClock(new Date(2000, 0, 1, hh[0], mm[0]))}`;
        if (hh.length === 24 && mm.length > 1 && dom === "*" && dow === "*") return `每 ${mm.length > 1 ? (mm[1] - mm[0]) || 1 : 1} 分钟`;
      } catch { return expr; }
      return expr;
    }
    function scheduleText(schedule) {
      if (!schedule) return "—";
      if (schedule.kind === "cron") return describeCron(schedule.expr) + (schedule.tz ? `（${schedule.tz}）` : "");
      if (schedule.kind === "interval") return `每 ${schedule.everyMinutes} 分钟`;
      if (schedule.kind === "once") return `一次性 · ${fmtLocal(schedule.at)}`;
      return JSON.stringify(schedule);
    }
    const STATUS_META = {
      completed: { text: "✓ 完成", color: "#22a06b" },
      running: { text: "⟳ 运行中", color: "#2563eb" },
      error: { text: "✗ 出错", color: "#d33" },
      timeout: { text: "✗ 超时", color: "#d33" },
      cancelled: { text: "⊘ 已停止", color: "#888" },
      "skipped-missed": { text: "– 错过跳过", color: "#888" },
      "skipped-overlap": { text: "– 重叠跳过", color: "#888" },
    };
    const statusMeta = (s) => STATUS_META[s] ?? { text: s ?? "—", color: "#888" };
    const StatusTag = ({ s }) => {
      const m = statusMeta(s);
      return h("span", { className: "crn_tag", style: { color: m.color, border: `1px solid ${m.color}44` } }, m.text);
    };
    const ClockIcon = () => h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
      h("circle", { cx: 8, cy: 8, r: 6.4, stroke: "currentColor", strokeWidth: 1.3 }),
      h("path", { d: "M8 4.7V8l2.3 1.7", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }));
    const Spinner = () => h("span", { className: "crn_spin", style: { display: "inline-block" } }, "⟳");

    function shouldDismissPanel(path, target, panel) {
      const inside = (root) => root != null && (path.includes(root) || (target != null && typeof root.contains === "function" && root.contains(target)));
      return !inside(panel);
    }
    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); ta.remove(); return true;
        } catch { return false; }
      }
    }
    //#endregion

    //#region 主界面左下角入口（sidebar.footer.action）
    function CronFooterPanel(props) {
      const wide = props?.wide !== false;
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const panelRef = useRef(null);
      const btnRef = useRef(null);
      const { state, error, refresh } = useCronState(open ? 2000 : 5000);

      const jobs = state?.jobs ?? [];
      const running = state?.running ?? [];
      const enabledJobs = jobs.filter((j) => j.enabled && j.nextFire)
        .sort((a, b) => new Date(a.nextFire) - new Date(b.nextFire));

      // 角标：运行中(绿)>未读错误(红)>1小时内到期(灰)
      const errSeenAt = Number(localStorage.getItem("dsh-wb-cron.errSeenAt") ?? 0);
      const lastErrAt = Math.max(0, ...jobs.filter((j) => j.lastStatus === "error" || j.lastStatus === "timeout")
        .map((j) => new Date(j.lastFire ?? 0).getTime()));
      const upcomingSoon = enabledJobs.some((j) => new Date(j.nextFire).getTime() - Date.now() < 3600_000);
      const dot = running.length > 0 ? { kind: "run", n: running.length }
        : lastErrAt > errSeenAt ? { kind: "err" }
        : upcomingSoon ? { kind: "soon" } : null;
      useEffect(() => { if (open) localStorage.setItem("dsh-wb-cron.errSeenAt", String(Date.now())); }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const path = typeof event.composedPath === "function" ? event.composedPath() : [];
          if (shouldDismissPanel(path, event.target, panelRef.current)
            && shouldDismissPanel(path, event.target, btnRef.current)) setOpen(false);
        };
        const onKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open]);

      const act = async (fn, okMsg) => {
        setBusy(true); setNote(null);
        try { await fn(); if (okMsg) setNote(okMsg); await refresh(); }
        catch (e) { setNote(`❌ ${e?.message ?? e}`); }
        finally { setBusy(false); }
      };

      const elapsed = (startedAt) => fmtDuration(Date.now() - new Date(startedAt).getTime());
      const runningTitle = (jobId) => jobs.find((j) => j.id === jobId)?.title ?? jobId;

      return h("section", { className: "crn_layer" },
        h("button", {
          ref: btnRef, className: "crn_badge", "data-active": open ? "" : undefined,
          title: "定时任务", onClick: () => setOpen((v) => !v),
        },
          ClockIcon(),
          wide ? h("span", { className: "crn_badgeLabel" }, "定时任务") : null,
          dot?.kind === "run" ? h("span", { className: "crn_dotCount" }, String(dot.n))
            : dot ? h("span", { className: "crn_dot", style: { background: dot.kind === "err" ? "#d33" : "#98a1ad" } }) : null,
        ),
        open && react_dom.createPortal(
          h("div", { ref: panelRef, className: "crn_panel" },
            h("div", { className: "crn_panelHead" }, ClockIcon(), "定时任务",
              h("span", { className: "crn_subtle", style: { marginLeft: "auto", fontWeight: 400 } },
                state?.scheduler?.alive ? "调度器 ● 运行中" : "调度器 ○ 未运行")),
            note ? h("div", { className: "crn_subtle", style: { marginBottom: "6px" } }, note) : null,
            error ? h("div", { className: "crn_err" }, `后端不可达：${error}`) : null,
            running.map((r) => h("div", { className: "crn_row", key: r.jobId },
              h("span", { style: { color: "#2563eb" } }, Spinner()),
              h("div", { className: "crn_rowMain" },
                h("div", { className: "crn_rowTitle" }, r.title ?? runningTitle(r.jobId)),
                h("div", { className: "crn_subtle" }, `已运行 ${elapsed(r.startedAt)}`)),
              h("button", {
                className: "crn_btn crn_btnDanger", disabled: busy,
                onClick: () => act(() => apiWrite("/dsh-wb-cron/job/stop", "POST", { id: r.jobId }), "已请求停止，稍候收尾"),
              }, "停止"))),
            enabledJobs.slice(0, 5).map((j) => h("div", { className: "crn_row", key: j.id },
              h("div", { className: "crn_rowMain" },
                h("div", { className: "crn_rowTitle" }, j.title),
                h("div", { className: "crn_subtle" },
                  `${scheduleText(j.schedule)} · 下次 ${fmtCountdown(j.nextFire)}${j.lastStatus ? ` · 上次 ${statusMeta(j.lastStatus).text}` : ""}`)),
              h("button", {
                className: "crn_btn", disabled: busy,
                onClick: () => act(() => apiWrite("/dsh-wb-cron/job/run", "POST", { id: j.id }), "已入队试跑"),
              }, "试跑"))),
            jobs.length === 0 && !error
              ? h("div", { className: "crn_subtle", style: { padding: "8px 0" } }, "暂无任务：在对话里说“每天早上9点帮我跑 X”即可创建。")
              : null,
            h("div", { className: "crn_subtle", style: { marginTop: "8px", display: "flex", justifyContent: "space-between", gap: "8px" } },
              h("span", null, `共 ${jobs.length} 个任务`),
              h("span", null, "完整管理：设置 → 定时任务")),
          ),
          document.body,
        ),
      );
    }
    //#endregion

    //#region 新建/编辑对话框
    // 下拉里"跟随全局默认"项的哨兵值。与 "default" 区分开，避免与真实预设 id 撞名；
    // 提交时映射为 null（见 save）。
    const DEFAULT_PRESET_KEY = "__default__";
    const CRON_PRESETS = [
      ["工作日早9点", "0 9 * * 1-5"],
      ["每天早9点", "0 9 * * *"],
      ["每小时整点", "0 * * * *"],
      ["每周一早9点", "0 9 * * 1"],
    ];

    function toLocalInput(isoS) {
      const d = new Date(isoS);
      if (Number.isNaN(d.getTime())) return "";
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
    }

    function JobDialog({ initial, onClose, onSaved }) {
      const editing = initial?.id != null;
      const sched = initial?.schedule ?? {};
      const [form, setForm] = useState({
        title: initial?.title ?? "",
        workspace: initial?.workspace ?? "",
        kind: sched.kind ?? "cron",
        expr: sched.expr ?? "0 9 * * 1-5",
        everyMinutes: sched.everyMinutes ?? 20,
        at: sched.at ? toLocalInput(sched.at) : "",
        prompt: initial?.prompt ?? "",
        modelKey: initial?.model ? `${initial.model.provider}|${initial.model.model}` : "default",
        preset: initial?.preset ?? DEFAULT_PRESET_KEY,
        timeoutMinutes: initial?.timeoutMinutes ?? 30,
        maxRuns: initial?.maxRuns ?? "",
        missedPolicy: initial?.missedPolicy ?? "skip",
        appendMemoryLog: initial?.appendMemoryLog ?? true,
      });
      const [workspaces, setWorkspaces] = useState([]);
      const [modelProviders, setModelProviders] = useState([]);
      const [presetInfo, setPresetInfo] = useState({ presets: [], defaultId: null, available: true, loaded: false });
      const [preview, setPreview] = useState(null);
      const [previewErr, setPreviewErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const [formErr, setFormErr] = useState(null);
      const [advanced, setAdvanced] = useState(false);
      const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

      useEffect(() => {
        apiGet("/dsh-wb-cron/workspaces").then((b) => {
          setWorkspaces(b.workspaces ?? []);
          setForm((f) => (f.workspace ? f : { ...f, workspace: b.workspaces?.[0]?.path ?? f.workspace }));
        }).catch(() => {});
        apiGet("/dsh-wb-cron/models").then((b) => setModelProviders(b.providers ?? [])).catch(() => {});
        // 预设服务非记忆化，每次开对话框都重读根目录 —— 新建的预设刷新即见。
        apiGet("/dsh-wb-cron/presets")
          .then((b) => setPresetInfo({ presets: b.presets ?? [], defaultId: b.defaultId ?? null, available: b.available !== false, loaded: true }))
          .catch(() => setPresetInfo((p) => ({ ...p, available: false, loaded: false })));
      }, []);
      useEffect(() => {
        if (form.kind !== "cron" || !form.expr.trim()) { setPreview(null); setPreviewErr(null); return undefined; }
        const t = setTimeout(() => {
          apiGet(`/dsh-wb-cron/preview?expr=${encodeURIComponent(form.expr)}&count=3`)
            .then((b) => { setPreview(b); setPreviewErr(null); })
            .catch((e) => { setPreview(null); setPreviewErr(String(e?.message ?? e)); });
        }, 400);
        return () => clearTimeout(t);
      }, [form.kind, form.expr]);

      const buildSchedule = () => {
        if (form.kind === "cron") {
          const s = { kind: "cron", expr: form.expr.trim() };
          return s;
        }
        if (form.kind === "interval") return { kind: "interval", everyMinutes: Number(form.everyMinutes) };
        const atMs = form.at ? new Date(form.at).getTime() : NaN;
        if (Number.isNaN(atMs)) throw new Error("一次性任务需要有效的时间");
        return { kind: "once", at: new Date(atMs).toISOString() };
      };
      const save = async () => {
        setBusy(true); setFormErr(null);
        try {
          const body = {
            title: form.title.trim(),
            prompt: form.prompt.trim(),
            workspace: form.workspace.trim(),
            schedule: buildSchedule(),
          };
          if (!body.title) throw new Error("标题不能为空");
          if (!body.prompt) throw new Error("任务指令不能为空");
          if (!body.workspace) throw new Error("工作区不能为空");
          if (form.modelKey !== "default") {
            const [provider, model] = form.modelKey.split("|");
            body.model = { provider, model };
          }
          // 恒发 preset：显式 null 才能让 PATCH 把任务重置回「跟随全局默认」
          // （store.update 判的是 !== undefined，故 null 是有效载荷）。
          // 但要等 /presets 成功（= 宿主 node 半边已是新版）才发：旧版 store 的
          // 白名单没有 preset，发了会被 400「不允许修改字段 "preset"」。
          if (presetInfo.loaded) body.preset = form.preset === DEFAULT_PRESET_KEY ? null : form.preset;
          if (advanced) {
            body.timeoutMinutes = Number(form.timeoutMinutes) || 30;
            body.maxRuns = form.maxRuns === "" ? null : Number(form.maxRuns);
            body.missedPolicy = form.missedPolicy;
            body.appendMemoryLog = Boolean(form.appendMemoryLog);
          }
          if (editing) await apiWrite("/dsh-wb-cron/job", "PATCH", { id: initial.id, ...body });
          else await apiWrite("/dsh-wb-cron/job", "POST", body);
          await onSaved();
          onClose();
        } catch (e) {
          setFormErr(String(e?.message ?? e));
        } finally { setBusy(false); }
      };

      return h("div", { className: "crn_overlay", onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h("div", { className: "crn_dialog" },
          h("h3", { className: "crn_h3", style: { fontSize: "15px" } }, editing ? "编辑定时任务" : "新建定时任务"),
          h("label", { className: "crn_label" }, "标题"),
          h("input", { className: "crn_input", value: form.title, onChange: (e) => set("title", e.target.value), placeholder: "如：工作日早9点整理昨日日志" }),
          h("label", { className: "crn_label" }, "工作区"),
          h("select", { className: "crn_select", value: form.workspace, onChange: (e) => set("workspace", e.target.value) },
            workspaces.length === 0 ? h("option", { value: form.workspace }, form.workspace || "（后端未返回工作区列表）") : null,
            workspaces.map((w) => h("option", { key: w.path, value: w.path }, w.name))),
          h("label", { className: "crn_label" }, "调度方式"),
          h("div", { className: "crn_tabs" },
            ["cron", "interval", "once"].map((k) => h("button", {
              key: k, className: "crn_tab", "data-on": form.kind === k ? "" : undefined,
              onClick: () => set("kind", k),
            }, k === "cron" ? "按计划" : k === "interval" ? "固定间隔" : "一次性"))),
          form.kind === "cron" ? [
            h("div", { key: "presets", style: { display: "flex", gap: "6px", flexWrap: "wrap", margin: "6px 0" } },
              CRON_PRESETS.map(([name2, expr]) => h("button", {
                key: expr, className: "crn_btn", style: form.expr === expr ? { borderColor: "#2563eb", color: "#2563eb" } : null,
                onClick: () => set("expr", expr),
              }, name2))),
            h("input", { className: "crn_input", value: form.expr, onChange: (e) => set("expr", e.target.value), placeholder: "5 字段：分 时 日 月 周，如 0 9 * * 1-5" }),
            preview ? h("div", { className: "crn_hint" }, `解析：${preview.describe}；未来触发：${preview.times.map((t) => fmtLocal(t)).join("、")}`)
              : previewErr ? h("div", { className: "crn_err" }, `表达式有误：${previewErr}`) : null,
          ] : null,
          form.kind === "interval" ? h("div", { style: { display: "flex", gap: "8px", alignItems: "center", margin: "6px 0" } },
            h("input", { className: "crn_input", style: { width: "110px" }, type: "number", min: 5, value: form.everyMinutes, onChange: (e) => set("everyMinutes", e.target.value) }),
            h("span", { className: "crn_subtle" }, "分钟（≥5；首次触发 = 保存时刻 + 间隔）")) : null,
          form.kind === "once" ? h("div", { style: { margin: "6px 0" } },
            h("input", { className: "crn_input", type: "datetime-local", value: form.at, onChange: (e) => set("at", e.target.value) }),
            h("div", { className: "crn_hint" }, `时区：宿主本地（${Intl.DateTimeFormat().resolvedOptions().timeZone}）。相对说法已在保存时换算为绝对时间，此后不再漂移。`)) : null,
          h("label", { className: "crn_label" }, "任务指令"),
          h("textarea", { className: "crn_textarea", value: form.prompt, onChange: (e) => set("prompt", e.target.value), placeholder: "要做什么、输入在哪、结果写到哪" }),
          h("div", { className: "crn_hint" }, "指令必须自包含：无人值守执行，看不到当前对话。"),
          h("label", { className: "crn_label" }, "模型"),
          h("select", { className: "crn_select", value: form.modelKey, onChange: (e) => set("modelKey", e.target.value) },
            h("option", { value: "default" }, "跟随全局默认"),
            modelProviders.flatMap((p) => (p.models ?? []).map((m) => h("option", { key: `${p.id}|${m.id}`, value: `${p.id}|${m.id}` }, `${p.id} / ${m.id}`)))),
          h("label", { className: "crn_label" }, "Agent 预设"),
          h("select", {
            className: "crn_select",
            value: form.preset,
            disabled: !presetInfo.loaded,
            onChange: (e) => set("preset", e.target.value),
          },
            h("option", { value: DEFAULT_PRESET_KEY },
              presetInfo.defaultId ? `跟随全局默认（${presetInfo.defaultId}）` : "跟随全局默认"),
            // 任务钉了一个已不存在的预设时，value 无对应 option 会让下拉显示空白、
            // 用户看不出任务原来钉的是什么。补一条占位项把原值显式呈现出来。
            form.preset !== DEFAULT_PRESET_KEY && !presetInfo.presets.some((p) => p.id === form.preset)
              ? h("option", { value: form.preset }, `${form.preset}（已不存在 — 执行时降级为标准模式）`)
              : null,
            presetInfo.presets.map((p) => h("option", {
              key: p.id, value: p.id,
              disabled: p.broken !== undefined,
            }, `${p.name ? `${p.name}（${p.id}）` : p.id}${p.broken !== undefined ? " — 已损坏，不可用" : ""}${p.id === presetInfo.defaultId ? " ★默认" : ""}`))),
          !presetInfo.loaded
            ? h("div", { className: "crn_err" }, "预设服务不可用（宿主尚未加载新版插件，或 agentPresets 未注入）：本项已禁用，保存时不会写入预设字段；重启 DSH 宿主后可用。")
            : presetInfo.available
              ? h("div", { className: "crn_hint" }, "到点执行时按此预设挂载 Agent；指定的预设若不可用，会降级为标准模式跑完并在运行历史里记下原因。")
              : h("div", { className: "crn_err" }, "agentPresets 未注入：任务将按宿主裸上下文执行。"),
          h("div", { style: { marginTop: "10px" } },
            h("button", { className: "crn_btn", onClick: () => setAdvanced((v) => !v) }, advanced ? "▾ 高级" : "▸ 高级")),
          advanced ? [
            h("label", { key: "t1", className: "crn_label" }, "看门狗超时（分钟）"),
            h("input", { key: "t2", className: "crn_input", type: "number", min: 1, max: 1440, value: form.timeoutMinutes, onChange: (e) => set("timeoutMinutes", e.target.value) }),
            h("label", { key: "t3", className: "crn_label" }, "最多执行次数（留空 = 无限）"),
            h("input", { key: "t4", className: "crn_input", type: "number", min: 1, value: form.maxRuns, onChange: (e) => set("maxRuns", e.target.value) }),
            h("label", { key: "t5", className: "crn_label" }, "错过策略（宿主未运行时）"),
            h("select", { key: "t6", className: "crn_select", value: form.missedPolicy, onChange: (e) => set("missedPolicy", e.target.value) },
              h("option", { value: "skip" }, "跳过（推荐：错过的补跑往往有害）"),
              h("option", { value: "runOnce" }, "补跑一次（幂等任务用）")),
            h("label", { key: "t7", className: "crn_label", style: { display: "flex", gap: "6px", alignItems: "center" } },
              h("input", { type: "checkbox", checked: Boolean(form.appendMemoryLog), onChange: (e) => set("appendMemoryLog", e.target.checked) }),
              "收尾把执行摘要追加到 wb-memory 当日日志"),
          ] : null,
          formErr ? h("div", { className: "crn_err" }, formErr) : null,
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" } },
            h("button", { className: "crn_btn", onClick: onClose, disabled: busy }, "取消"),
            h("button", { className: "crn_btn crn_btnPrimary", onClick: save, disabled: busy }, busy ? "保存中…" : editing ? "保存修改" : "创建任务")),
        ));
    }
    //#endregion

    //#region 设置页完整管理卡片
    function CronSettingsSection() {
      const { state, error, refresh } = useCronState(5000);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [dialog, setDialog] = useState(null); // null | {} | job
      const [confirmDel, setConfirmDel] = useState(null);
      const [histJob, setHistJob] = useState("");
      const [history, setHistory] = useState([]);
      const [copied, setCopied] = useState(null);

      const jobs = state?.jobs ?? [];
      const running = state?.running ?? [];
      const runningTitle = (jobId) => jobs.find((j) => j.id === jobId)?.title ?? jobId;

      const loadHistory = useCallback(async (jobId) => {
        try {
          const q = jobId ? `?jobId=${encodeURIComponent(jobId)}&limit=20` : "?limit=20";
          const b = await apiGet(`/dsh-wb-cron/history${q}`);
          setHistory(b.runs ?? []);
        } catch { /* 状态区已有错误展示 */ }
      }, []);
      useEffect(() => { loadHistory(histJob); }, [histJob, loadHistory]);

      const act = async (fn, okMsg) => {
        setBusy(true); setNote(null);
        try { await fn(); if (okMsg) setNote(okMsg); await refresh(); await loadHistory(histJob); }
        catch (e) { setNote(`❌ ${e?.message ?? e}`); }
        finally { setBusy(false); }
      };

      if (state === null && error) {
        return h("div", { className: "crn_card" },
          h("h3", { className: "crn_h3" }, "定时任务"),
          h("div", { className: "crn_err" }, `后端不可达：${error}`));
      }

      return h("div", null,
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", margin: "2px 0 10px" } },
          h("h3", { className: "crn_h3", style: { margin: 0 } }, "定时任务"),
          h("div", { style: { flex: 1 } }),
          h("button", { className: "crn_btn crn_btnPrimary", onClick: () => setDialog({}), disabled: busy }, "+ 新建任务")),
        h("div", { className: "crn_statusbar" },
          h("span", null, state?.scheduler?.alive ? "调度器 ● 运行中" : "调度器 ○ 未运行"),
          state?.scheduler?.lastTick ? h("span", { className: "crn_subtle" }, `上次检查 ${fmtLocal(state.scheduler.lastTick)}`) : null,
          h("span", { className: "crn_subtle" }, `运行中 ${running.length} · 任务 ${jobs.length}`)),
        note ? h("div", { className: "crn_subtle", style: { marginBottom: "8px" } }, note) : null,
        error ? h("div", { className: "crn_err", style: { marginBottom: "8px" } }, error) : null,

        running.length > 0 ? h("div", { className: "crn_card" },
          h("h3", { className: "crn_h3" }, "运行中"),
          running.map((r) => h("div", { className: "crn_row", key: r.jobId },
            h("span", { style: { color: "#2563eb" } }, Spinner()),
            h("div", { className: "crn_rowMain" },
              h("div", { className: "crn_rowTitle" }, r.title ?? runningTitle(r.jobId)),
              h("div", { className: "crn_subtle" }, `已运行 ${fmtDuration(Date.now() - new Date(r.startedAt).getTime())}`)),
            h("button", {
              className: "crn_btn crn_btnDanger", disabled: busy,
              onClick: () => act(() => apiWrite("/dsh-wb-cron/job/stop", "POST", { id: r.jobId }), "已请求停止，稍候收尾"),
            }, "停止")))) : null,

        h("div", { className: "crn_card" },
          h("h3", { className: "crn_h3" }, "任务列表"),
          jobs.length === 0 ? h("div", { className: "crn_subtle" }, "暂无任务。点右上角「+ 新建任务」，或直接在对话里说“每天早上9点帮我跑 X”。") : null,
          jobs.map((j) => {
            const isRunning = running.some((r) => r.jobId === j.id);
            return h("div", { className: "crn_row", key: j.id },
              h("span", { style: { color: isRunning ? "#2563eb" : j.enabled ? "#22a06b" : "#98a1ad", flex: "none" } },
                isRunning ? Spinner() : j.enabled ? "●" : "○"),
              h("div", { className: "crn_rowMain" },
                h("div", { className: "crn_rowTitle" }, j.title, j.enabled ? null : h("span", { className: "crn_subtle" }, "（已暂停）")),
                h("div", { className: "crn_subtle" },
                  `${scheduleText(j.schedule)} · ${j.workspace.split(/[\\/]/).pop() || j.workspace} · 预设 ${j.preset ?? "全局默认"} · 下次 ${j.nextFire ? fmtCountdown(j.nextFire) : "—"} · 已跑 ${j.runCount} 次${j.lastStatus ? ` · 上次 ${statusMeta(j.lastStatus).text}` : ""}`)),
              h("button", { className: "crn_btn", disabled: busy || isRunning, onClick: () => act(() => apiWrite("/dsh-wb-cron/job/run", "POST", { id: j.id }), "已入队试跑"), title: "立即试跑" }, "试跑"),
              h("button", {
                className: "crn_btn", disabled: busy,
                onClick: () => act(() => apiWrite("/dsh-wb-cron/job", "PATCH", { id: j.id, enabled: !j.enabled }), j.enabled ? "已暂停" : "已恢复"),
              }, j.enabled ? "暂停" : "恢复"),
              h("button", { className: "crn_btn", disabled: busy || isRunning, onClick: () => setDialog(j) }, "编辑"),
              confirmDel === j.id
                ? h("button", { className: "crn_btn crn_btnDanger", disabled: busy, onClick: () => act(() => apiWrite(`/dsh-wb-cron/job?id=${encodeURIComponent(j.id)}`, "DELETE"), "已删除") }, "确认删?")
                : h("button", { className: "crn_btn crn_btnDanger", disabled: busy, onClick: () => { setConfirmDel(j.id); setTimeout(() => setConfirmDel((c) => (c === j.id ? null : c)), 3000); } }, "删"));
          })),

        h("div", { className: "crn_card" },
          h("h3", { className: "crn_h3" }, "运行历史",
            h("select", {
              className: "crn_select", style: { width: "auto", marginLeft: "8px", fontWeight: 400 },
              value: histJob, onChange: (e) => setHistJob(e.target.value),
            },
              h("option", { value: "" }, "全部任务"),
              jobs.map((j) => h("option", { key: j.id, value: j.id }, j.title)))),
          history.length === 0 ? h("div", { className: "crn_subtle" }, "暂无运行记录") : null,
          history.map((r) => h("div", { className: "crn_histRow", key: r.runId },
            h(StatusTag, { s: r.status }),
            h("span", { style: { flex: "none" } }, fmtLocal(r.startedAt)),
            h("span", { className: "crn_rowTitle", style: { flex: 1, minWidth: 0 } }, r.title),
            r.durationMs != null ? h("span", { className: "crn_subtle", style: { flex: "none" } }, fmtDuration(r.durationMs)) : null,
            r.sessionId ? h("button", {
              className: "crn_btn", style: { padding: "1px 6px" },
              title: "复制会话 ID（到侧边栏搜索定位该会话）",
              onClick: async () => { if (await copyText(r.sessionId)) { setCopied(r.runId); setTimeout(() => setCopied(null), 1500); } },
            }, copied === r.runId ? "已复制" : "复制会话ID") : null,
            r.error ? h("span", { className: "crn_err", style: { margin: 0, maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: r.error }, r.error) : null)),
          h("div", { className: "crn_hint" }, "v1 通过复制会话 ID 在侧边栏定位会话；会话深链待宿主路由开放后接入。")),

        dialog !== null
          ? h(JobDialog, {
              initial: dialog, onClose: () => setDialog(null),
              onSaved: async () => { await refresh(); await loadHistory(histJob); },
            })
          : null);
    }
    //#endregion

    function apply(ctx) {
      injectCssOnce();
      // 设置页完整管理卡片（二级，order 40 紧跟 WorkBuddy 记忆的 30）
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-wb-cron",
        order: 40,
        label: () => "定时任务",
      }, () => h(CronSettingsSection, null)));
      // 主界面左下角入口（一级，order 20：用量=10 之后、设置按钮之前）
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-wb-cron",
        order: 20,
      }, CronFooterPanel));
    }

    exports.name = "dsh-wb-cron";
    exports.inject = ["slots"];
    exports.apply = apply;
    exports.CronFooterPanel = CronFooterPanel;
    exports.CronSettingsSection = CronSettingsSection;
    return module.exports;
  },
});
