import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report/aggregate";
import { DEFAULT_SETTINGS } from "../src/settings";
import { EditEvent, SessionEvent } from "../src/types";

const settings = { ...DEFAULT_SETTINGS };

function makeSession(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    type: "session",
    ts: Date.now(),
    endTs: Date.now(),
    notePath: "哲学/康德.md",
    noteTitle: "康德",
    mode: "source",
    activeSeconds: 1800,
    endedBy: "switch",
    totalChars: 100,
    totalWords: 10,
    ...overrides,
  };
}

describe("buildReport 新增指标", () => {
  it("streak：今天有活动 → 至少 1 天", () => {
    const r = buildReport([makeSession()], settings);
    expect(r.streak).toBeGreaterThanOrEqual(1);
  });

  it("today：今天的 session 计入今日活跃", () => {
    const r = buildReport([makeSession({ activeSeconds: 300 })], settings);
    expect(r.today.activeSeconds).toBe(300);
    expect(r.today.topFolders[0].folder).toBe("哲学");
  });

  it("writePeak：固定 24 个小时桶", () => {
    const r = buildReport([makeSession()], settings);
    expect(r.writePeak).toHaveLength(24);
    const total = r.writePeak.reduce((s, b) => s + b.readSeconds + b.writeSeconds, 0);
    expect(total).toBe(1800);
  });

  it("weekCompare：今天的 session 计入本周", () => {
    const r = buildReport([makeSession()], settings);
    const philosophy = r.weekCompare.find((w) => w.folder === "哲学");
    expect(philosophy?.thisWeek).toBe(1800);
  });

  it("revisit：多次短打开 → 快速访问", () => {
    const sessions = [0, 1, 2, 3].map(() => makeSession({ activeSeconds: 30, notePath: "难产.md" }));
    const r = buildReport(sessions, settings);
    const doc = r.revisit.find((d) => d.notePath === "难产.md");
    expect(doc?.mode).toBe("quick");
  });

  it("revisit：单次长停留 → 深度使用", () => {
    const r = buildReport([makeSession({ activeSeconds: 3600 })], settings);
    const doc = r.revisit.find((d) => d.notePath === "哲学/康德.md");
    expect(doc?.mode).toBe("deep");
  });

  it("revisit：多次中等时长 → 频繁复访", () => {
    const sessions = [0, 1, 2].map(() => makeSession({ activeSeconds: 300, notePath: "复习.md" }));
    const r = buildReport(sessions, settings);
    const doc = r.revisit.find((d) => d.notePath === "复习.md");
    expect(doc?.mode).toBe("frequent");
  });

  it("weekday：7 个桶，总时长守恒", () => {
    const r = buildReport([makeSession()], settings);
    expect(r.weekday).toHaveLength(7);
    const total = r.weekday.reduce((s, w) => s + w.seconds, 0);
    expect(total).toBe(1800);
  });

  it("docGrowth：用 idle 采样的 edit 事件累计生成字数曲线", () => {
    const now = Date.now();
    const s = makeSession({ notePath: "成长.md", ts: now - 3000 });
    const e1: EditEvent = { type: "edit", ts: now - 2000, notePath: "成长.md", charDelta: 50, wordDelta: 5 };
    const e2: EditEvent = { type: "edit", ts: now - 1000, notePath: "成长.md", charDelta: 30, wordDelta: 3 };
    const r = buildReport([s, e1, e2], settings);
    const g = r.docGrowth.find((d) => d.notePath === "成长.md");
    expect(g?.points).toHaveLength(2);
    expect(g?.points[1].cumulative).toBe(80);
  });

  it("docGrowth：近期在写的新文档排在历史高产的旧文档之前（旧文档不再霸榜）", () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // 旧文档：10 天前一次性写了 10000 字，已落在最近 7 天窗口之外
    const oldEdit: EditEvent = { type: "edit", ts: now - 10 * DAY, notePath: "旧文档.md", charDelta: 10000, wordDelta: 100 };
    // 新文档：今天写了 200 字
    const newEdit: EditEvent = { type: "edit", ts: now - 1000, notePath: "新文档.md", charDelta: 200, wordDelta: 20 };
    const r = buildReport([oldEdit, newEdit], settings);
    expect(r.docGrowth[0].notePath).toBe("新文档.md");
    expect(r.docGrowth.some((d) => d.notePath === "旧文档.md")).toBe(false);
  });

  it("docGrowth：只有单个采样点的新文档也会出现（回归：此前被 points.length>1 丢弃）", () => {
    const now = Date.now();
    const e: EditEvent = { type: "edit", ts: now - 500, notePath: "刚建的新笔记.md", charDelta: 3711, wordDelta: 0 };
    const r = buildReport([e], settings);
    const g = r.docGrowth.find((d) => d.notePath === "刚建的新笔记.md");
    expect(g).toBeDefined();
    expect(g?.points).toHaveLength(1);
  });

  it("docGrowth：刚编辑过的文档比 6 天前的同类文档更靠前（时间衰减）", () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const older: EditEvent = { type: "edit", ts: now - 6 * DAY, notePath: "六天前.md", charDelta: 2000, wordDelta: 20 };
    const fresh: EditEvent = { type: "edit", ts: now - 60 * 1000, notePath: "刚刚.md", charDelta: 400, wordDelta: 4 };
    const r = buildReport([older, fresh], settings);
    expect(r.docGrowth[0].notePath).toBe("刚刚.md");
  });

  it("flow：相邻不同主题切换产生流向", () => {
    const now = Date.now();
    const s1 = makeSession({ notePath: "哲学/康德.md", ts: now - 200000, endTs: now - 190000 });
    const s2 = makeSession({ notePath: "计算机/算法.md", ts: now - 185000, endTs: now - 180000 });
    const r = buildReport([s1, s2], settings);
    const link = r.flow.find((f) => f.source === "哲学" && f.target === "计算机");
    expect(link?.value).toBe(1);
  });

  it("activeSegments：多段活跃不被压缩到连续区间", () => {
    const ts1 = new Date(2026, 0, 5, 9, 0, 0).getTime();
    const ts2 = new Date(2026, 0, 5, 11, 0, 0).getTime();
    const s = makeSession({
      ts: ts1,
      activeSeconds: 3000, // 共 50 分钟
      activeSegments: [
        [ts1, ts1 + 30 * 60 * 1000], // 9:00 - 9:30
        [ts2, ts2 + 20 * 60 * 1000], // 11:00 - 11:20
      ],
    });
    const r = buildReport([s], settings);
    const hour9 = r.matrix.find((c) => c.hour === 9);
    const hour10 = r.matrix.find((c) => c.hour === 10);
    const hour11 = r.matrix.find((c) => c.hour === 11);
    expect(hour9?.seconds).toBeCloseTo(1800);
    expect(hour10?.seconds).toBeUndefined(); // 中间 blur 断档不计入
    expect(hour11?.seconds).toBeCloseTo(1200);
  });
});
