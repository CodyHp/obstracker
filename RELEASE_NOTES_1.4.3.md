## What's new in 1.4.3

A bug-fix release: two charts were showing stale or misattributed data.

### Fixed: "Word growth" was frozen on old notes
The per-note word-growth card ranked documents by their **total** accumulated
growth over the whole retained history. Documents you had written heavily weeks
ago kept a large frozen total, so they permanently occupied the card while notes
you were writing right now never showed up.

- Ranking is now based on **growth over the last 7 days**, with a mild decay by
  time since last edit — the list slides forward as you write, so the notes you
  are actually working on float to the front.
- Removed a `points.length > 1` filter that silently dropped **brand-new notes
  written in a single sitting** (they only had one sample).
- A document with a single sample point now renders a visible dot instead of an
  empty chart.
- If there is no writing activity in the last 7 days, the card falls back to the
  most recently edited documents instead of going blank.

### Fixed: historical time was all counted as "Uncategorized"
Settled daily summaries store their time keyed by **top-level folder**
(e.g. `01-日记与反思|9`). When those summaries were deserialized back into
sessions, the reconstructed path contained no `/`, so the folder classifier
treated every one of them as a root-level file and bucketed them all under
**Uncategorized**.

In a real vault this put **83% of all tracked time** into Uncategorized and
pushed it to the top of the topic ranking.

- Historical summary time is now attributed to its real top-level folder.
- This corrects every view built on topic classification: **topic duration
  ranking**, **hour × topic matrix**, **folder tree**, today's topics, and the
  insights card.

### Improved: clickable note names
Note names in the **Document Performance** table (all five leaderboards) are now
links that open the note, matching the behavior already present in the
**Document Profile** card. Long paths wrap inside the cell instead of stretching
the table.

---

## 1.4.3 更新内容

这是一个修 bug 的版本：两张图表此前显示的是过期或被错误归类的数据。

### 修复：「单篇字数增长」一直卡在旧文档上
这张卡片原先按**保留期内累计总增长**给文档排序。几周前写得多的文档会留下一个
很大的固定总量，于是长期霸占卡片；而你此刻正在写的笔记永远挤不进来。

- 排序改为按**最近 7 天的增长**，并对「距最后编辑的时间」做温和衰减——列表会
  随着你的写作自然向前滑动，正在写的文档自动浮到前面。
- 去掉了一个 `points.length > 1` 过滤：它会把**一次写完的新笔记**整条丢弃
  （这类文档只有一次采样）。
- 只有单个采样点的文档现在会画出一个可见的点，而不是显示空白图表。
- 最近 7 天没有任何写作时，改为按最后编辑时间展示，而不是让卡片空着。

### 修复：历史时长被全部算进了「未分类」
已结算的每日摘要以**顶级目录**为 key 存储时长（例如 `01-日记与反思|9`）。
这些摘要被反序列化回会话时，重建出的路径里不含 `/`，于是目录分类器把它们统统
当成根目录文件，全部丢进了**未分类**。

在真实库中，这导致 **83% 的追踪时长**都落在「未分类」上，并让它排到了主题
排行的第一名。

- 现在历史摘要时长会归属到它真正的顶级目录。
- 所有依赖主题分类的视图一并修正：**主题时长排行**、**时段 × 主题矩阵**、
  **目录树**、今日主题、洞察卡片。

### 改进：文档名可点击
**文档表现**表格（全部五个榜单）中的文档名现在是可点击的链接，点击即打开该
笔记，与**文档画像**卡片的行为保持一致。长路径会在单元格内换行，不再把表格撑宽。
