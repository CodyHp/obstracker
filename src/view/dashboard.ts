import * as echarts from "echarts/core";
import { BarChart, GraphChart, HeatmapChart, LineChart } from "echarts/charts";
import { CalendarComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { DocPerformance, FolderNode, Report, RevisitMode } from "../report/aggregate";
import { UNCATEGORIZED } from "../report/classify";
import { calendarDayLabels, getLocale, t, weekdayLabels } from "../i18n";
import { localDay } from "../utils";

echarts.use([
  BarChart,
  GraphChart,
  HeatmapChart,
  LineChart,
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

// ---------- 主题桥接 ----------
interface ThemeVars {
  accent: string;
  textNormal: string;
  textMuted: string;
  textFaint: string;
  border: string;
  bg: string;
}

let colorThemeOverride: string | null = null;

export function setColorTheme(color: string): void {
  colorThemeOverride = color === "theme" ? null : color;
  renderVersion++;
}

function readTheme(): ThemeVars {
  const css = getComputedStyle(document.body);
  const get = (name: string, fb: string): string => {
    const v = css.getPropertyValue(name).trim();
    return v || fb;
  };
  return {
    accent: colorThemeOverride ?? get("--interactive-accent", "#7c5cff"),
    textNormal: get("--text-normal", "#3d3d3d"),
    textMuted: get("--text-muted", "#8a8a8a"),
    textFaint: get("--text-faint", "#b0b0b0"),
    border: get("--background-modifier-border", "rgba(128,128,128,0.22)"),
    bg: get("--background-secondary", "#f2f2f2"),
  };
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const ch = [0, 1, 2].map((i) => Math.round(ca[i] + (cb[i] - ca[i]) * t));
  return `#${ch.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// ---------- 图表实例管理 ----------
type Chart = ReturnType<typeof echarts.init>;

/** 每个 chart 实例对应的 ResizeObserver（实例销毁时需 disconnect） */
const chartObservers = new WeakMap<Chart, ResizeObserver>();

/** 复用 DOM 上已存在的实例，没有才 init（实例随 DOM 走，避免销毁重建） */
function getOrInitChart(div: HTMLElement): Chart {
  const existing = echarts.getInstanceByDom(div);
  if (existing) return existing;
  const chart = echarts.init(div);
  const ro = new ResizeObserver(() => {
    try {
      if (!chart.isDisposed()) chart.resize();
    } catch {
      // 忽略销毁/过渡期间的 resize 异常
    }
  });
  ro.observe(div);
  chartObservers.set(chart, ro);
  return chart;
}

/** 释放某个容器下所有 chart 实例（视图卸载时调用） */
function disposeChartsIn(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".mindtrace-chart").forEach((div) => {
    const chart = echarts.getInstanceByDom(div);
    if (chart) {
      chartObservers.get(chart)?.disconnect();
      chartObservers.delete(chart);
      chart.dispose();
    }
  });
}

/** 视图卸载时清理该代码块容器内的图表实例与懒加载状态 */
export function unmountReport(el: HTMLElement): void {
  const state = rootStates.get(el);
  if (state) {
    for (const entry of state.blocks.values()) {
      entry.io?.disconnect();
    }
  }
  disposeChartsIn(el);
  rootStates.delete(el);
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function baseTooltip(theme: ThemeVars) {
  return {
    backgroundColor: theme.bg,
    borderColor: theme.border,
    textStyle: { color: theme.textNormal },
  };
}

function axisCommon(theme: ThemeVars) {
  return {
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { lineStyle: { color: theme.border } },
    splitLine: { lineStyle: { color: theme.border } },
  };
}

function displayFolder(folder: string): string {
  return folder === UNCATEGORIZED ? t("uncategorized") : folder;
}

// ---------- 块容器辅助（复用 DOM，避免每次重绘全量重建） ----------
function ensureBlock(el: HTMLElement, key: string, title: string, cls = "mindtrace-card"): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-mt-block="${key}"]`);
  if (found) {
    if (title) {
      const span = found.querySelector<HTMLElement>("h3 span");
      if (span) span.textContent = title;
    }
    return found;
  }
  const box = el.createEl("div", { cls });
  box.setAttr("data-mt-block", key);
  if (title) box.createEl("h3").createEl("span", { text: title });
  return box;
}

function ensureChartDiv(box: HTMLElement, cls = "mindtrace-chart"): HTMLElement {
  const found = box.querySelector<HTMLElement>(".mindtrace-chart");
  if (found) return found;
  return box.createEl("div", { cls });
}

/** 清空卡片内容，但保留标题栏（h3，含导出按钮），避免重绘时标题消失 */
function clearCard(box: HTMLElement): void {
  const h3 = box.querySelector("h3");
  box.empty();
  if (h3) box.appendChild(h3);
}

/** 空态切换：空则显示提示并隐藏图表容器，非空反之（实例保留，避免销毁） */
function setEmpty(box: HTMLElement, isEmpty: boolean): void {
  const chartDiv = box.querySelector<HTMLElement>(".mindtrace-chart");
  const emptyEl = box.querySelector<HTMLElement>(".mindtrace-empty");
  if (isEmpty) {
    chartDiv?.addClass("mindtrace-hidden");
    if (!emptyEl) box.createEl("div", { cls: "mindtrace-empty", text: t("empty") });
  } else {
    emptyEl?.remove();
    chartDiv?.removeClass("mindtrace-hidden");
  }
}

// ---------- 导出 ----------
function downloadUrl(url: string, filename: string): void {
  const a = document.body.createEl("a");
  a.href = url;
  a.download = filename;
  a.click();
  a.remove();
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  URL.revokeObjectURL(url);
}

function toCsv(data: unknown): string | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as Record<string, unknown>;
  const keys = Object.keys(first);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = keys.join(",");
  const rows = data.map((row) => keys.map((k) => esc((row as Record<string, unknown>)[k])).join(","));
  return [header, ...rows].join("\n");
}

/** 在卡片标题栏重建 PNG / JSON / CSV 导出按钮（按钮少，重建成本低，闭包数据始终最新） */
function ensureExportActions(box: HTMLElement, chart: Chart, data: unknown, name: string): void {
  const h3 = box.querySelector("h3");
  if (!h3) return;
  h3.querySelector(".mindtrace-card-actions")?.remove();
  const actions = h3.createEl("div", { cls: "mindtrace-card-actions" });

  const pngBtn = actions.createEl("button", { cls: "mindtrace-back", text: "PNG" });
  pngBtn.title = t("exportImage");
  pngBtn.onclick = (): void => {
    const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "transparent" });
    downloadUrl(url, `${name}.png`);
  };

  const jsonBtn = actions.createEl("button", { cls: "mindtrace-back", text: "JSON" });
  jsonBtn.title = t("exportData");
  jsonBtn.onclick = (): void => {
    downloadText(JSON.stringify(data, null, 2), `${name}.json`, "application/json");
  };

  const csv = toCsv(data);
  if (csv) {
    const csvBtn = actions.createEl("button", { cls: "mindtrace-back", text: "CSV" });
    csvBtn.title = t("exportCsv");
    csvBtn.onclick = (): void => {
      downloadText(csv, `${name}.csv`, "text/csv");
    };
  }
}

// ---------- 渲染入口 ----------
type BlockRender = (box: HTMLElement, report: Report, theme: ThemeVars, openFile?: (path: string) => void) => void;

interface BlockSpec {
  key: string;
  title: () => string;
  render: BlockRender;
}

const chartBlocks: BlockSpec[] = [
  { key: "matrix", title: () => t("timeByTopic"), render: renderMatrix },
  { key: "folder-bars", title: () => t("topicRanking"), render: renderFolderBars },
  { key: "write-peak", title: () => t("activeHours"), render: renderWritePeak },
  { key: "calendar", title: () => t("activeCalendar"), render: renderCalendar },
  { key: "doc-activity", title: () => t("docActivity"), render: renderDocActivity },
  { key: "week-compare", title: () => t("weekCompare"), render: renderWeekCompare },
  { key: "weekday", title: () => t("weekdayDist"), render: renderWeekday },
  { key: "weekday-hour", title: () => t("weekdayHour"), render: renderWeekdayHour },
  { key: "flow", title: () => t("attentionFlow"), render: renderFlow },
  { key: "doc-growth", title: () => t("docGrowth"), render: renderDocGrowth },
  { key: "read-write", title: () => t("readWriteByDay"), render: renderReadWrite },
  { key: "word-trend", title: () => t("wordTrend"), render: renderWordTrend },
  { key: "doc-performance", title: () => t("docPerformance"), render: renderDocPerformance },
  { key: "docs", title: () => t("docProfile"), render: renderDocs },
  { key: "timeline", title: () => t("timeline"), render: renderTimeline },
];

// 数据 diff：按容器（el）记录 report 引用 + 渲染版本，都没变则跳过重绘（避免多视图互相干扰）
interface RenderState {
  report: Report;
  version: number;
  openFile?: (path: string) => void;
}

const renderStateByEl = new WeakMap<HTMLElement, RenderState>();
let renderVersion = 0;

/** 主题/语言等非数据变更时调用，强制下次 renderReport 重绘 */
export function bumpRenderVersion(): void {
  renderVersion++;
}

interface BlockEntry {
  box: HTMLElement;
  io: IntersectionObserver | null;
  rendered: boolean;
}

interface RootState {
  blocks: Map<string, BlockEntry>;
}

const rootStates = new WeakMap<HTMLElement, RootState>();

let idleQueue: (() => void)[] = [];
let idleScheduled = false;

function scheduleIdle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => fn(), { timeout: 600 });
  } else {
    window.setTimeout(fn, 0);
  }
}

function enqueueRender(fn: () => void): void {
  idleQueue.push(fn);
  if (idleScheduled) return;
  idleScheduled = true;
  const run = (): void => {
    if (idleQueue.length === 0) {
      idleScheduled = false;
      return;
    }
    const next = idleQueue.shift()!;
    try {
      next();
    } catch (e) {
      console.error("MindTrace render failed:", e);
    }
    scheduleIdle(run);
  };
  scheduleIdle(run);
}

export function renderReport(el: HTMLElement, report: Report, openFile?: (path: string) => void): void {
  el.addClass("mindtrace-report");
  const theme = readTheme();

  // 数据 diff：数据引用 + 渲染版本 + openFile 都没变 → 直接跳过
  const prev = renderStateByEl.get(el);
  if (prev && prev.report === report && prev.version === renderVersion && prev.openFile === openFile) {
    return;
  }
  renderStateByEl.set(el, { report, version: renderVersion, openFile });

  // 头部（同步渲染，首屏立即可见）
  try {
    const kpis = ensureBlock(el, "kpis", "", "mindtrace-kpis");
    renderKpis(kpis, report);
  } catch (e) {
    console.error("MindTrace render failed:", e);
  }
  try {
    const today = ensureBlock(el, "today", t("today"));
    renderToday(today, report);
  } catch (e) {
    console.error("MindTrace render failed:", e);
  }
  try {
    const insights = ensureBlock(el, "insights", t("insightsTitle"));
    renderInsights(insights, report);
  } catch (e) {
    console.error("MindTrace render failed:", e);
  }
  try {
    const dq = ensureBlock(el, "data-quality", t("dataQuality"));
    renderDataQuality(dq, report);
  } catch (e) {
    console.error("MindTrace render failed:", e);
  }

  // 无数据：显示引导提示，隐藏图表块
  if (report.totalSeconds === 0) {
    for (const spec of chartBlocks) {
      el.querySelector(`[data-mt-block="${spec.key}"]`)?.addClass("mindtrace-hidden");
    }
    const hint = ensureBlock(el, "start-hint", t("startRecording"));
    hint.removeClass("mindtrace-hidden");
    setEmpty(hint, true);
    return;
  }
  el.querySelector('[data-mt-block="start-hint"]')?.addClass("mindtrace-hidden");

  scheduleBlocks(el, report, theme, openFile);
}

function scheduleBlocks(el: HTMLElement, report: Report, theme: ThemeVars, openFile?: (path: string) => void): void {
  const isFirst = !rootStates.has(el);
  let state = rootStates.get(el);
  if (!state) {
    state = { blocks: new Map() };
    rootStates.set(el, state);
  }

  for (const spec of chartBlocks) {
    let entry = state.blocks.get(spec.key);
    if (!entry) {
      const box = ensureBlock(el, spec.key, spec.title());
      box.removeClass("mindtrace-hidden");
      entry = { box, io: null, rendered: false };
      state.blocks.set(spec.key, entry);
    } else {
      entry.box.removeClass("mindtrace-hidden");
    }

    if (isFirst && !entry.rendered) {
      // 首次渲染：懒加载，进入视口才真正渲染
      if (!entry.io) {
        entry.io = new IntersectionObserver(
          (records) => {
            for (const r of records) {
              if (r.isIntersecting) {
                entry.io?.disconnect();
                entry.io = null;
                entry.rendered = true;
                enqueueRender(() => {
                  if (!entry.box.isConnected) return;
                  spec.render(entry.box, report, theme, openFile);
                });
              }
            }
          },
          { rootMargin: "240px" },
        );
        entry.io.observe(entry.box);
      }
    } else {
      // 数据更新：全部排队分片渲染（实例已复用，成本低）；停掉未触发的懒加载观察
      entry.rendered = true;
      if (entry.io) {
        entry.io.disconnect();
        entry.io = null;
      }
      enqueueRender(() => {
        if (!entry.box.isConnected) return;
        spec.render(entry.box, report, theme, openFile);
      });
    }
  }
}

function renderKpis(box: HTMLElement, report: Report): void {
  clearCard(box);
  const add = (label: string, value: string): void => {
    const k = box.createEl("div", { cls: "mindtrace-kpi" });
    k.createEl("div", { cls: "mindtrace-kpi-value", text: value });
    k.createEl("div", { cls: "mindtrace-kpi-label", text: label });
  };
  add(t("kpiToday"), fmtDuration(report.today.activeSeconds));
  add(t("kpiStreak"), t("days", { n: report.streak }));
  add(t("kpiRead"), fmtDuration(report.totalReadSeconds));
  add(t("kpiWrite"), fmtDuration(report.totalWriteSeconds));
}

function renderToday(box: HTMLElement, report: Report): void {
  clearCard(box);
  const today = report.today;

  const summary = box.createEl("div", { cls: "mindtrace-today-summary" });
  const active = summary.createEl("div", { cls: "mindtrace-today-big" });
  active.createEl("div", { cls: "mindtrace-today-value", text: fmtDuration(today.activeSeconds) });
  active.createEl("div", { cls: "mindtrace-today-label", text: t("activeTime") });
  const words = summary.createEl("div", { cls: "mindtrace-today-big" });
  words.createEl("div", { cls: "mindtrace-today-value", text: t("chars", { n: today.addedChars }) });
  words.createEl("div", { cls: "mindtrace-today-label", text: t("todayWriting") });
  if (today.netChars !== today.addedChars) {
    words.createEl("div", { cls: "mindtrace-today-net", text: `${t("net")} ${t("chars", { n: today.netChars })}` });
  }

  if (today.topFolders.length > 0) {
    const list = box.createEl("div", { cls: "mindtrace-today-folders" });
    for (const f of today.topFolders) {
      const row = list.createEl("div", { cls: "mindtrace-doc-row" });
      row.createEl("span", { cls: "mindtrace-doc-path", text: displayFolder(f.folder) });
      row.createEl("span", { cls: "mindtrace-doc-count", text: fmtDuration(f.seconds) });
    }
  } else {
    box.createEl("div", { cls: "mindtrace-empty", text: t("todayEmpty") });
  }
}

// ---------- 今日总结（自然语言洞察） ----------
/** 给片段附加基线对比（至少 3 天历史、差值 ≥10% 才显示） */
function withBaseline(text: string, value: number, avg: number, days: number): string {
  if (days < 3 || avg <= 0) return text;
  const delta = Math.round(((value - avg) / avg) * 100);
  if (Math.abs(delta) < 10) return text;
  const cmp = delta > 0 ? t("aboveAvg", { pct: delta }) : t("belowAvg", { pct: -delta });
  return `${text}（${cmp}）`;
}

function renderInsights(box: HTMLElement, report: Report): void {
  clearCard(box);
  const zh = getLocale() === "zh-CN";

  // 无任何今日数据时只显示空态引导
  if (report.today.activeSeconds === 0 && report.today.addedChars === 0) {
    box.createEl("div", { cls: "mindtrace-insight-summary", text: t("todayEmpty") });
    return;
  }

  // 今日一句：片段按数据有无动态拼接
  const parts: string[] = [];
  if (report.today.activeSeconds > 0) {
    parts.push(
      withBaseline(
        t("summaryActive", { active: fmtDuration(report.today.activeSeconds) }),
        report.today.activeSeconds,
        report.baseline.avgActiveSeconds,
        report.baseline.days,
      ),
    );
  }
  if (report.today.addedChars > 0) {
    parts.push(
      withBaseline(
        t("summaryChars", { chars: report.today.addedChars }),
        report.today.addedChars,
        report.baseline.avgAddedChars,
        report.baseline.days,
      ),
    );
  }
  if (report.today.topFolders.length > 0) {
    parts.push(t("summaryTopic", { topic: displayFolder(report.today.topFolders[0].folder) }));
  }
  if (parts.length > 0) {
    let line = t("summaryPrefix") + parts.join(zh ? "，" : ", ") + (zh ? "。" : ".");
    if (report.streak > 0) line += " " + t("summaryStreak", { n: report.streak });
    box.createEl("div", { cls: "mindtrace-insight-summary", text: line });
  }

  // 静态洞察列表
  const insights: string[] = [];
  // 注意力集中度（今日 top1 主题占比）
  const topToday = report.today.topFolders[0];
  if (topToday && report.today.activeSeconds > 0) {
    const pct = Math.round((topToday.seconds / report.today.activeSeconds) * 100);
    if (pct >= 60) {
      insights.push(t("attentionFocused", { pct, topic: displayFolder(topToday.folder) }));
    } else if (pct < 40 && report.today.topFolders.length >= 3) {
      insights.push(t("attentionScattered", { n: report.today.topFolders.length }));
    }
  }
  if (report.folderBars.length > 0) {
    const top = report.folderBars[0];
    insights.push(t("insightTopTopic", { topic: displayFolder(top.folder), dur: fmtDuration(top.seconds) }));
  }
  const peak = peakHour(report);
  if (peak !== null) insights.push(t("insightPeakHour", { hour: peak }));
  const wd = topWeekday(report);
  if (wd !== null) insights.push(t("insightTopWeekday", { weekday: weekdayLabels()[wd] }));
  if (report.bestStreak >= 2) insights.push(t("insightBestStreak", { n: report.bestStreak }));
  const wc = topWeekCompare(report);
  if (wc) {
    insights.push(
      t(wc.more ? "insightWeekMore" : "insightWeekLess", {
        topic: displayFolder(wc.folder),
        this: fmtDuration(wc.thisWeek),
        delta: fmtDuration(Math.abs(wc.delta)),
      }),
    );
  }

  if (insights.length > 0) {
    const list = box.createEl("ul", { cls: "mindtrace-insight-list" });
    for (const s of insights.slice(0, 6)) list.createEl("li", { text: s });
  }
}

// ---------- 数据质量（覆盖度进度条 / 追踪起始 / 排除异常） ----------
function renderDataQuality(box: HTMLElement, report: Report): void {
  clearCard(box);
  if (!report.trackedSince) {
    box.addClass("mindtrace-hidden");
    return;
  }
  box.removeClass("mindtrace-hidden");

  box.createEl("div", { cls: "mindtrace-dq-hint", text: t("dataQualityHint") });

  // 覆盖度（进度条 + 具体天数）
  const cov = box.createEl("div", { cls: "mindtrace-dq-row" });
  const covHead = cov.createEl("div", { cls: "mindtrace-dq-head" });
  covHead.createEl("span", { cls: "mindtrace-dq-label", text: t("dataCoverage") });
  covHead.createEl("span", { cls: "mindtrace-dq-value", text: `${report.dataCoverage}%` });
  const bar = cov.createEl("div", { cls: "mindtrace-dq-bar" });
  bar.createEl("div", { cls: "mindtrace-dq-fill", attr: { style: `width:${report.dataCoverage}%` } });
  cov.createEl("div", {
    cls: "mindtrace-dq-sub",
    text: t("coverageDetail", { active: report.activeDaysCount, total: report.trackedDays }),
  });

  // 追踪自
  const since = box.createEl("div", { cls: "mindtrace-dq-row" });
  since.createEl("span", { cls: "mindtrace-dq-label", text: t("trackedSince") });
  since.createEl("span", {
    cls: "mindtrace-dq-value",
    text: `${report.trackedSince} · ${t("days", { n: report.trackedDays })}`,
  });

  // 排除异常
  if (report.excludedSessions > 0) {
    const ex = box.createEl("div", { cls: "mindtrace-dq-row" });
    ex.createEl("span", { cls: "mindtrace-dq-label", text: t("excludedSessions") });
    ex.createEl("span", { cls: "mindtrace-dq-value", text: `${report.excludedSessions} ${t("abnormalSessions")}` });
  }
}

function peakHour(report: Report): number | null {
  let bestHour: number | null = null;
  let bestSec = 0;
  for (const b of report.writePeak) {
    const secs = b.readSeconds + b.writeSeconds;
    if (secs > bestSec) {
      bestSec = secs;
      bestHour = b.hour;
    }
  }
  return bestSec > 0 ? bestHour : null;
}

function topWeekday(report: Report): number | null {
  let best: number | null = null;
  let bestSec = 0;
  for (const w of report.weekday) {
    if (w.seconds > bestSec) {
      bestSec = w.seconds;
      best = w.weekday;
    }
  }
  return bestSec > 0 ? best : null;
}

function topWeekCompare(report: Report): { folder: string; thisWeek: number; delta: number; more: boolean } | null {
  let best: { folder: string; thisWeek: number; delta: number; more: boolean } | null = null;
  let bestDelta = 0;
  for (const w of report.weekCompare) {
    const delta = w.thisWeek - w.lastWeek;
    if (Math.abs(delta) > bestDelta) {
      bestDelta = Math.abs(delta);
      best = { folder: w.folder, thisWeek: w.thisWeek, delta, more: delta > 0 };
    }
  }
  return bestDelta > 0 ? best : null;
}

function renderMatrix(box: HTMLElement, report: Report, theme: ThemeVars): void {
  const folderTotals = new Map<string, number>();
  for (const c of report.matrix) folderTotals.set(c.folder, (folderTotals.get(c.folder) ?? 0) + c.seconds);
  const folders = [...folderTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map((x) => x[0]);
  if (folders.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);

  const cellMap = new Map<string, number>();
  for (const c of report.matrix) cellMap.set(`${c.hour}|${c.folder}`, c.seconds);
  const maxSec = Math.max(1, ...report.matrix.map((c) => c.seconds));

  const data: [number, number, number][] = [];
  for (let fi = 0; fi < folders.length; fi++) {
    for (let h = 0; h < 24; h++) {
      const secs = cellMap.get(`${h}|${folders[fi]}`) ?? 0;
      if (secs > 0) data.push([h, fi, secs]);
    }
  }

  const div = ensureChartDiv(box, "mindtrace-chart mindtrace-chart-tall");
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: {
      ...baseTooltip(theme),
      position: "top",
      formatter: (p: { value: [number, number, number] }) =>
        `${displayFolder(folders[p.value[1]])} · ${p.value[0]}:00-${p.value[0] + 1}:00 · ${fmtDuration(p.value[2])}`,
    },
    grid: { left: 150, right: 20, top: 10, bottom: 55 },
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, i) => `${i}`),
      splitArea: { show: true },
      ...axisCommon(theme),
    },
    yAxis: { type: "category", data: folders.map(displayFolder), splitArea: { show: true }, ...axisCommon(theme) },
    visualMap: {
      min: 0,
      max: maxSec,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: [mixHex(theme.accent, theme.bg, 0.88), theme.accent] },
      textStyle: { color: theme.textMuted },
    },
    series: [{ type: "heatmap", data, emphasis: { itemStyle: { borderColor: theme.textNormal, borderWidth: 1 } } }],
  } as any);
  ensureExportActions(box, chart, report.matrix, "time-topic");
}

function renderFolderBars(box: HTMLElement, report: Report, theme: ThemeVars): void {
  const tree = report.folderTree;
  if (tree.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);

  const stack: FolderNode[][] = [tree];
  const path: string[] = [];
  let toolbar = box.querySelector<HTMLElement>(".mindtrace-toolbar");
  let pathLabel: HTMLElement;
  let backBtn: HTMLButtonElement;
  if (!toolbar) {
    toolbar = box.createEl("div", { cls: "mindtrace-toolbar" });
    pathLabel = toolbar.createEl("span", { cls: "mindtrace-path" });
    backBtn = toolbar.createEl("button", { cls: "mindtrace-back" }) as HTMLButtonElement;
    backBtn.textContent = t("backUp");
  } else {
    pathLabel = toolbar.querySelector<HTMLElement>(".mindtrace-path")!;
    backBtn = toolbar.querySelector<HTMLButtonElement>("button")!;
  }
  pathLabel.textContent = t("all");
  backBtn.addClass("mindtrace-hidden");

  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);

  const draw = (): void => {
    const nodes = stack[stack.length - 1];
    const names = nodes.map((n) => n.folder);
    const values = nodes.map((n) => n.seconds);
    chart.setOption({
      tooltip: {
        ...baseTooltip(theme),
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (p: { name: string; value: number }[]) => `${displayFolder(p[0].name)}<br/>${fmtDuration(p[0].value)}`,
      },
      grid: { left: 160, right: 50, top: 10, bottom: 30 },
      xAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.textMuted, formatter: (v: number) => fmtDuration(v) } },
      yAxis: { type: "category", data: names.map(displayFolder), inverse: true, ...axisCommon(theme) },
      series: [{ type: "bar", data: values, barMaxWidth: 20, itemStyle: { color: mixHex(theme.accent, theme.bg, 0.2), borderRadius: [0, 4, 4, 0] } }],
    } as any);
    chart.off("click");
    chart.on("click", (params: { dataIndex: number }) => {
      const node = nodes[params.dataIndex];
      if (node && node.children.length > 0) {
        stack.push(node.children);
        path.push(node.folder);
        pathLabel.textContent = path.map(displayFolder).join(" / ");
        draw();
      }
    });
    if (stack.length > 1) backBtn.removeClass("mindtrace-hidden");
    else backBtn.addClass("mindtrace-hidden");
  };

  ensureExportActions(box, chart, tree, "topic-ranking");

  backBtn.onclick = (): void => {
    if (stack.length > 1) {
      stack.pop();
      path.pop();
      pathLabel.textContent = path.length ? path.map(displayFolder).join(" / ") : t("all");
      draw();
    }
  };

  draw();
}

function renderWritePeak(box: HTMLElement, report: Report, theme: ThemeVars): void {
  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: { ...baseTooltip(theme), trigger: "axis", valueFormatter: (v: number) => fmtDuration(v) },
    legend: { data: [t("readInferred"), t("writeInferred")], top: 0, textStyle: { color: theme.textMuted } },
    grid: { left: 60, right: 20, top: 34, bottom: 30 },
    xAxis: { type: "category", data: report.writePeak.map((p) => `${p.hour}`), ...axisCommon(theme) },
    yAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.textMuted, formatter: (v: number) => fmtDuration(v) } },
    series: [
      { name: t("readInferred"), type: "bar", stack: "t", data: report.writePeak.map((p) => p.readSeconds), itemStyle: { color: mixHex(theme.accent, theme.bg, 0.5) } },
      { name: t("writeInferred"), type: "bar", stack: "t", data: report.writePeak.map((p) => p.writeSeconds), itemStyle: { color: theme.accent } },
    ],
  } as any);
  ensureExportActions(box, chart, report.writePeak, "active-hours");
}

function renderCalendar(box: HTMLElement, report: Report, theme: ThemeVars): void {
  let stats = box.querySelector<HTMLElement>(".mindtrace-calendar-stats");
  if (!stats) {
    stats = box.createEl("div", { cls: "mindtrace-calendar-stats" });
    stats.createEl("span");
    stats.createEl("span");
  }
  const spans = stats.querySelectorAll<HTMLElement>("span");
  spans[0].textContent = `${t("currentStreak")} ${t("days", { n: report.streak })}`;
  spans[1].textContent = `${t("longestStreak")} ${t("days", { n: report.bestStreak })}`;

  if (report.dailyActive.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);

  const maxSec = Math.max(1, ...report.dailyActive.map((d) => d.seconds));
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 364); // 近一年

  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: {
      ...baseTooltip(theme),
      formatter: (p: { value: [string, number] }) => `${p.value[0]}<br/>${fmtDuration(p.value[1])}`,
    },
    visualMap: {
      min: 0,
      max: maxSec,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: [mixHex(theme.accent, theme.bg, 0.9), theme.accent] },
      textStyle: { color: theme.textMuted },
    },
    calendar: {
      range: [localDay(start.getTime()), localDay(now.getTime())],
      cellSize: ["auto", 13],
      yearLabel: { show: false },
      dayLabel: { nameMap: calendarDayLabels(), color: theme.textMuted },
      monthLabel: { color: theme.textMuted },
      itemStyle: { color: theme.bg, borderColor: theme.border, borderWidth: 2 },
      splitLine: { lineStyle: { color: theme.border } },
    },
    series: [
      {
        type: "heatmap",
        coordinateSystem: "calendar",
        data: report.dailyActive.map((d) => [d.day, d.seconds]),
      },
    ],
  } as any);
  ensureExportActions(box, chart, report.dailyActive, "activity-calendar");
}

function renderDocActivity(box: HTMLElement, report: Report, theme: ThemeVars): void {
  const modes = [
    { label: t("day"), data: report.docActivityDaily },
    { label: t("week"), data: report.docActivityWeekly },
    { label: t("month"), data: report.docActivityMonthly },
    { label: t("quarter"), data: report.docActivityQuarterly },
    { label: t("year"), data: report.docActivityYearly },
  ];
  let currentMode = Number(box.dataset.mode ?? 0); // 默认天，跨数据更新保留用户选择

  let switcher = box.querySelector<HTMLElement>(".mindtrace-doc-growth-switcher");
  let buttons: HTMLElement[];
  if (!switcher) {
    switcher = box.createEl("div", { cls: "mindtrace-doc-growth-switcher" });
    buttons = modes.map(() => switcher!.createEl("button", { cls: "mindtrace-back" }));
  } else {
    buttons = Array.from(switcher.querySelectorAll<HTMLElement>("button"));
  }
  buttons.forEach((btn, i) => {
    btn.textContent = modes[i].label;
    btn.removeClass("mindtrace-active");
    if (i === currentMode) btn.addClass("mindtrace-active");
    btn.onclick = (): void => {
      currentMode = i;
      box.dataset.mode = String(i);
      buttons.forEach((b) => b.removeClass("mindtrace-active"));
      btn.addClass("mindtrace-active");
      draw();
    };
  });

  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);

  const draw = (): void => {
    let data = modes[currentMode].data;
    if (currentMode === 0) data = data.slice(-90); // 天粒度只显示最近 90 天
    chart.setOption({
      tooltip: { ...baseTooltip(theme), trigger: "axis" },
      legend: { data: [t("activeDocs"), t("writeDocs")], top: 0, textStyle: { color: theme.textMuted } },
      grid: { left: 50, right: 20, top: 34, bottom: 30 },
      xAxis: { type: "category", data: data.map((d) => d.period), ...axisCommon(theme) },
      yAxis: { type: "value", ...axisCommon(theme) },
      series: [
        { name: t("activeDocs"), type: "line", data: data.map((d) => d.activeDocs), lineStyle: { color: mixHex(theme.accent, theme.bg, 0.4) }, itemStyle: { color: mixHex(theme.accent, theme.bg, 0.4) }, symbolSize: 5 },
        { name: t("writeDocs"), type: "line", data: data.map((d) => d.writeDocs), lineStyle: { color: theme.accent }, itemStyle: { color: theme.accent }, symbolSize: 5 },
      ],
    } as any);
  };
  draw();
  ensureExportActions(box, chart, report.docActivityMonthly, "doc-activity");
}

function renderWeekCompare(box: HTMLElement, report: Report, theme: ThemeVars): void {
  if (report.weekCompare.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);
  const folders = report.weekCompare.map((w) => w.folder);
  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: { ...baseTooltip(theme), trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => fmtDuration(v) },
    legend: { data: [t("thisWeek"), t("lastWeek")], top: 0, textStyle: { color: theme.textMuted } },
    grid: { left: 140, right: 30, top: 34, bottom: 30 },
    xAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.textMuted, formatter: (v: number) => fmtDuration(v) } },
    yAxis: { type: "category", data: folders.map(displayFolder), inverse: true, ...axisCommon(theme) },
    series: [
      { name: t("thisWeek"), type: "bar", data: report.weekCompare.map((w) => w.thisWeek), itemStyle: { color: theme.accent, borderRadius: [0, 4, 4, 0] } },
      { name: t("lastWeek"), type: "bar", data: report.weekCompare.map((w) => w.lastWeek), itemStyle: { color: mixHex(theme.accent, theme.bg, 0.5), borderRadius: [0, 4, 4, 0] } },
    ],
  } as any);
  ensureExportActions(box, chart, report.weekCompare, "week-compare");
}

function renderWeekday(box: HTMLElement, report: Report, theme: ThemeVars): void {
  const labels = weekdayLabels();
  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: { ...baseTooltip(theme), trigger: "axis", valueFormatter: (v: number) => fmtDuration(v) },
    grid: { left: 60, right: 20, top: 16, bottom: 30 },
    xAxis: { type: "category", data: labels, ...axisCommon(theme) },
    yAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.textMuted, formatter: (v: number) => fmtDuration(v) } },
    series: [{ type: "bar", data: report.weekday.map((w) => w.seconds), itemStyle: { color: mixHex(theme.accent, theme.bg, 0.25), borderRadius: [4, 4, 0, 0] } }],
  } as any);
  ensureExportActions(box, chart, report.weekday, "weekday-distribution");
}

function renderWeekdayHour(box: HTMLElement, report: Report, theme: ThemeVars): void {
  const labels = weekdayLabels();
  const maxSec = Math.max(1, ...report.weekdayHour.map((c) => c.seconds));

  const cellMap = new Map<string, number>();
  for (const c of report.weekdayHour) cellMap.set(`${c.weekday}|${c.hour}`, c.seconds);

  const data: [number, number, number][] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const secs = cellMap.get(`${wd}|${h}`) ?? 0;
      if (secs > 0) data.push([h, wd, secs]);
    }
  }

  const div = ensureChartDiv(box, "mindtrace-chart mindtrace-chart-tall");
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: {
      ...baseTooltip(theme),
      position: "top",
      formatter: (p: { value: [number, number, number] }) =>
        `${labels[p.value[1]]} · ${p.value[0]}:00-${p.value[0] + 1}:00 · ${fmtDuration(p.value[2])}`,
    },
    grid: { left: 90, right: 20, top: 10, bottom: 55 },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => `${i}`), splitArea: { show: true }, ...axisCommon(theme) },
    yAxis: { type: "category", data: labels, splitArea: { show: true }, ...axisCommon(theme) },
    visualMap: {
      min: 0,
      max: maxSec,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: [mixHex(theme.accent, theme.bg, 0.9), theme.accent] },
      textStyle: { color: theme.textMuted },
    },
    series: [{ type: "heatmap", data, emphasis: { itemStyle: { borderColor: theme.textNormal, borderWidth: 1 } } }],
  } as any);
  ensureExportActions(box, chart, report.weekdayHour, "weekday-hour");
}

function renderFlow(box: HTMLElement, report: Report, theme: ThemeVars): void {
  if (report.flow.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);
  // 节点度数 = 切换总次数（出度 + 入度），用于节点大小
  const degree = new Map<string, number>();
  for (const f of report.flow) {
    degree.set(f.source, (degree.get(f.source) ?? 0) + f.value);
    degree.set(f.target, (degree.get(f.target) ?? 0) + f.value);
  }
  const maxDegree = Math.max(1, ...degree.values());

  const div = ensureChartDiv(box, "mindtrace-chart mindtrace-chart-tall");
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: {
      ...baseTooltip(theme),
      trigger: "item",
      formatter: (p: { dataType?: string; name?: string; value?: number; data?: { source: string; target: string; value: number } }) => {
        if (p.dataType === "edge") return `${displayFolder(p.data?.source ?? "")} → ${displayFolder(p.data?.target ?? "")}<br/>${t("switchCount", { n: p.data?.value ?? 0 })}`;
        return `${displayFolder(p.name ?? "")}<br/>${t("switchCount", { n: p.value ?? 0 })}`;
      },
    },
    series: [
      {
        type: "graph",
        layout: "force",
        data: [...degree.entries()].map(([name, value]) => ({
          name: displayFolder(name),
          value,
          symbolSize: 22 + (value / maxDegree) * 42,
        })),
        links: report.flow.map((f) => ({ source: displayFolder(f.source), target: displayFolder(f.target), value: f.value })),
        roam: true,
        draggable: true,
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: 7,
        lineStyle: { color: mixHex(theme.accent, theme.bg, 0.3), width: 1, curveness: 0.12, opacity: 0.6 },
        itemStyle: { color: theme.accent },
        label: { show: true, color: theme.textNormal, fontSize: 12 },
        emphasis: { focus: "adjacency" },
        force: { repulsion: 280, edgeLength: 130, gravity: 0.1 },
      },
    ],
  } as any);
  ensureExportActions(box, chart, report.flow, "attention-flow");
}

function renderDocGrowth(box: HTMLElement, report: Report, theme: ThemeVars): void {
  if (report.docGrowth.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);
  const docs = report.docGrowth;
  let current = docs[0];
  let title = box.querySelector<HTMLElement>(".mindtrace-doc-growth-title");
  if (!title) title = box.createEl("div", { cls: "mindtrace-doc-growth-title" });
  title.textContent = current.notePath;
  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);

  const draw = (): void => {
    chart.setOption({
      tooltip: { ...baseTooltip(theme), trigger: "axis" },
      grid: { left: 70, right: 20, top: 16, bottom: 30 },
      xAxis: { type: "time", ...axisCommon(theme) },
      yAxis: { type: "value", name: t("cumulativeChars"), nameTextStyle: { color: theme.textFaint }, ...axisCommon(theme) },
      series: [
        {
          type: "line",
          // 只有一个采样点时折线不可见，需要显式画点（新文档常见）
          showSymbol: current.points.length <= 1,
          symbolSize: 8,
          data: current.points.map((p) => [p.ts, p.cumulative]),
          lineStyle: { color: theme.accent },
          itemStyle: { color: theme.accent },
          areaStyle: { color: mixHex(theme.accent, theme.bg, 0.85) },
        },
      ],
    } as any);
  };

  let switcher = box.querySelector<HTMLElement>(".mindtrace-doc-growth-switcher");
  if (!switcher) switcher = box.createEl("div", { cls: "mindtrace-doc-growth-switcher" });
  switcher.empty();
  const buttons: HTMLElement[] = [];
  for (const d of docs.slice(0, 6)) {
    const btn = switcher.createEl("button", { cls: "mindtrace-back", text: d.notePath.split("/").pop() ?? d.notePath });
    buttons.push(btn);
    btn.onclick = (): void => {
      current = d;
      title.textContent = d.notePath;
      buttons.forEach((b) => b.removeClass("mindtrace-active"));
      btn.addClass("mindtrace-active");
      draw();
    };
  }
  if (buttons.length > 0) buttons[0].addClass("mindtrace-active");
  draw();
  ensureExportActions(box, chart, docs, "word-growth");
}

function renderReadWrite(box: HTMLElement, report: Report, theme: ThemeVars): void {
  if (report.readWriteByDay.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);
  const days = report.readWriteByDay.slice(-14);
  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: { ...baseTooltip(theme), trigger: "axis", valueFormatter: (v: number) => fmtDuration(v) },
    legend: { data: [t("readInferred"), t("writeInferred")], top: 0, textStyle: { color: theme.textMuted } },
    grid: { left: 70, right: 20, top: 34, bottom: 30 },
    xAxis: { type: "category", data: days.map((d) => d.day), ...axisCommon(theme) },
    yAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.textMuted, formatter: (v: number) => fmtDuration(v) } },
    series: [
      { name: t("readInferred"), type: "bar", stack: "t", data: days.map((d) => d.readSeconds), itemStyle: { color: mixHex(theme.accent, theme.bg, 0.5) } },
      { name: t("writeInferred"), type: "bar", stack: "t", data: days.map((d) => d.writeSeconds), itemStyle: { color: theme.accent } },
    ],
  } as any);
  ensureExportActions(box, chart, report.readWriteByDay, "read-write");
}

function renderWordTrend(box: HTMLElement, report: Report, theme: ThemeVars): void {
  if (report.wordTrend.length === 0) {
    setEmpty(box, true);
    return;
  }
  setEmpty(box, false);
  const days = report.wordTrend.slice(-14);
  const div = ensureChartDiv(box);
  const chart = getOrInitChart(div);
  chart.setOption({
    tooltip: { ...baseTooltip(theme), trigger: "axis" },
    legend: { data: [t("added"), t("deleted"), t("net")], top: 0, textStyle: { color: theme.textMuted } },
    grid: { left: 60, right: 20, top: 34, bottom: 30 },
    xAxis: { type: "category", data: days.map((d) => d.day), ...axisCommon(theme) },
    yAxis: { type: "value", ...axisCommon(theme) },
    series: [
      { name: t("added"), type: "bar", data: days.map((d) => d.addedChars), itemStyle: { color: mixHex(theme.accent, theme.bg, 0.35), borderRadius: [2, 2, 0, 0] } },
      { name: t("deleted"), type: "bar", data: days.map((d) => -d.deletedChars), itemStyle: { color: "#dc8250", borderRadius: [0, 0, 2, 2] } },
      { name: t("net"), type: "line", data: days.map((d) => d.netChars), lineStyle: { color: theme.accent }, itemStyle: { color: theme.accent }, symbolSize: 6 },
    ],
  } as any);
  ensureExportActions(box, chart, report.wordTrend, "word-trend");
}

interface RankingMode {
  key: string;
  label: string;
  mainLabel: string;
  subLabel: string;
  sort: (a: DocPerformance, b: DocPerformance) => number;
  main: (d: DocPerformance) => string;
  sub: (d: DocPerformance) => string;
}

function rankingModes(): RankingMode[] {
  return [
    {
      key: "visited", label: t("mostVisited"), mainLabel: t("visits"), subLabel: t("activeDays"),
      sort: (a, b) => b.visits - a.visits,
      main: (d) => String(d.visits), sub: (d) => String(d.activeDays),
    },
    {
      key: "time", label: t("mostTime"), mainLabel: t("duration"), subLabel: t("visits"),
      sort: (a, b) => b.activeSeconds - a.activeSeconds,
      main: (d) => fmtDuration(d.activeSeconds), sub: (d) => String(d.visits),
    },
    {
      key: "written", label: t("mostWritten"), mainLabel: t("addedChars"), subLabel: t("duration"),
      sort: (a, b) => b.addedChars - a.addedChars,
      main: (d) => `+${d.addedChars}`, sub: (d) => fmtDuration(d.activeSeconds),
    },
    {
      key: "revisited", label: t("mostRevisited"), mainLabel: t("revisitRate"), subLabel: t("visits"),
      sort: (a, b) => b.revisitRate - a.revisitRate,
      main: (d) => d.revisitRate.toFixed(1), sub: (d) => String(d.visits),
    },
    {
      key: "trending", label: t("trending"), mainLabel: t("lastSeen"), subLabel: t("visits"),
      sort: (a, b) => b.lastTs - a.lastTs,
      main: (d) => lastText(d.lastTs), sub: (d) => String(d.visits),
    },
  ];
}

function renderDocPerformance(box: HTMLElement, report: Report): void {
  clearCard(box);
  if (report.docPerformance.length === 0) {
    box.createEl("div", { cls: "mindtrace-empty", text: t("empty") });
    return;
  }

  const modes = rankingModes();
  let current = Number(box.dataset.mode ?? 0);

  let switcher = box.querySelector<HTMLElement>(".mindtrace-doc-growth-switcher");
  let buttons: HTMLElement[];
  if (!switcher) {
    switcher = box.createEl("div", { cls: "mindtrace-doc-growth-switcher" });
    buttons = modes.map(() => switcher!.createEl("button", { cls: "mindtrace-back" }));
  } else {
    buttons = Array.from(switcher.querySelectorAll<HTMLElement>("button"));
  }

  const table = box.createEl("table", { cls: "mindtrace-table" });
  const head = table.createEl("thead").createEl("tr");
  head.createEl("th", { text: t("note") });
  const mainTh = head.createEl("th");
  const subTh = head.createEl("th");
  const body = table.createEl("tbody");

  const draw = (): void => {
    const m = modes[current];
    const list = [...report.docPerformance].sort(m.sort).slice(0, 10);
    mainTh.textContent = m.mainLabel;
    subTh.textContent = m.subLabel;
    body.empty();
    for (const d of list) {
      const tr = body.createEl("tr");
      tr.createEl("td", { text: d.notePath });
      tr.createEl("td", { text: m.main(d) });
      tr.createEl("td", { text: m.sub(d) });
    }
  };

  buttons.forEach((btn, i) => {
    btn.textContent = modes[i].label;
    btn.removeClass("mindtrace-active");
    if (i === current) btn.addClass("mindtrace-active");
    btn.onclick = (): void => {
      current = i;
      box.dataset.mode = String(i);
      buttons.forEach((b) => b.removeClass("mindtrace-active"));
      btn.addClass("mindtrace-active");
      draw();
    };
  });

  draw();
}

function renderDocs(box: HTMLElement, report: Report, theme: ThemeVars, openFile?: (path: string) => void): void {
  clearCard(box);
  const cols = box.createEl("div", { cls: "mindtrace-doc-cols" });

  const forgotBox = cols.createEl("div");
  forgotBox.createEl("h4", { text: t("forgotten") });
  if (report.forgottenDocs.length === 0) {
    forgotBox.createEl("div", { cls: "mindtrace-empty", text: t("empty") });
  } else {
    for (const d of report.forgottenDocs.slice(0, 10)) {
      const row = forgotBox.createEl("div", { cls: "mindtrace-doc-row" });
      docLink(row, d.notePath, openFile);
      row.createEl("span", { cls: "mindtrace-doc-count", text: lastText(d.lastTs) });
    }
  }

  const revisitBox = cols.createEl("div");
  revisitBox.createEl("h4", { text: t("revisitMode") });
  if (report.revisit.length === 0) {
    revisitBox.createEl("div", { cls: "mindtrace-empty", text: t("empty") });
  } else {
    for (const d of report.revisit) {
      const row = revisitBox.createEl("div", { cls: "mindtrace-doc-row" });
      docLink(row, d.notePath, openFile);
      const tag = row.createEl("span", { cls: "mindtrace-tag", text: modeLabel(d.mode) });
      tag.setCssProps({ "--tag-color": modeColor(d.mode, theme) });
    }
  }
}

function docLink(parent: HTMLElement, notePath: string, openFile?: (path: string) => void): void {
  const el = parent.createEl("span", { cls: "mindtrace-doc-path mindtrace-doc-link", text: notePath });
  if (openFile) {
    el.onclick = (): void => openFile(notePath);
  }
}

function modeColor(mode: RevisitMode, theme: ThemeVars): string {
  if (mode === "deep") return theme.accent;
  if (mode === "frequent") return "#50a078";
  return "#dc8250";
}

function modeLabel(mode: RevisitMode): string {
  if (mode === "deep") return t("deep");
  if (mode === "frequent") return t("frequent");
  return t("quick");
}

function renderTimeline(box: HTMLElement, report: Report): void {
  clearCard(box);
  if (report.timeline.length === 0) {
    box.createEl("div", { cls: "mindtrace-empty", text: t("empty") });
    return;
  }

  let expanded = false;
  const table = box.createEl("table", { cls: "mindtrace-table" });
  const head = table.createEl("thead").createEl("tr");
  head.createEl("th", { text: t("time") });
  head.createEl("th", { text: t("note") });
  head.createEl("th", { text: t("duration") });
  head.createEl("th", { text: t("readWrite") });

  const tbody = table.createEl("tbody");
  const renderRows = (): void => {
    tbody.empty();
    const list = expanded ? report.timeline.slice(0, 100) : report.timeline.slice(0, 10);
    for (const item of list) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: new Date(item.ts).toLocaleString() });
      tr.createEl("td", { text: item.noteTitle });
      tr.createEl("td", { text: fmtDuration(item.activeSeconds) });
      tr.createEl("td", { text: `${fmtDuration(item.readSeconds)} / ${fmtDuration(item.writeSeconds)}` });
    }
  };
  renderRows();

  const toggle = box.createEl("button", { cls: "mindtrace-back", text: t("expandAll") });
  toggle.addClass("mindtrace-mt8");
  toggle.onclick = (): void => {
    expanded = !expanded;
    toggle.textContent = expanded ? t("collapse") : t("expandAll");
    renderRows();
  };
}

function lastText(ts: number): string {
  if (!ts) return t("never");
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return t("today");
  if (days === 1) return t("yesterday");
  if (days < 30) return t("daysAgo", { n: days });
  return t("monthsAgo", { n: Math.floor(days / 30) });
}
