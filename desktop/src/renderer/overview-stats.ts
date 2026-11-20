// Home-page numbers (主页 B1, user's choice 2026-10-29): this week = the last 7 days, compared with the 7 before.
// Every input is what an existing renderer API already returns; anything unreadable counts as nothing.
export type WeekCount = { now: number; before: number };
export type OverviewStats = {
  finished: WeekCount; leads: WeekCount; reached: WeekCount; details: WeekCount;
  publishedToday: number; platformsToday: number; materials: number | null; tutorials: number | null;
};
type Dated = Record<string, unknown>;

const DAY = 86_400_000;
const time = (value: unknown) => { const ms = Date.parse(String(value ?? "")); return Number.isFinite(ms) ? ms : NaN; };
const sameDay = (ms: number, now: number) => new Date(ms).toDateString() === new Date(now).toDateString();

// How many items fall in the last 7 days and in the 7 days before, by the first date field present.
export function weekCount(items: Dated[], fields: string[], now: number, weight: (item: Dated) => number = () => 1): WeekCount {
  const result = { now: 0, before: 0 };
  for (const item of items) {
    const ms = fields.map((field) => time(item[field])).find((value) => Number.isFinite(value));
    if (ms === undefined || ms > now) continue;
    if (ms > now - 7 * DAY) result.now += weight(item);
    else if (ms > now - 14 * DAY) result.before += weight(item);
  }
  return result;
}

// What WeChat tasks of one type have done, one entry per run: every completed run (runs, kept since
// 1.2.29; a task saved before that only has its latest completion) plus the run still under way —
// people reached count as soon as they are sent, not when the whole task ends (user 2026-11-19:
// 别人一直触达显示 0 个，实际已经发了很多). A run already in runs is not counted twice.
export function taskRuns(tasks: Dated[], type: string): Dated[] {
  return tasks.filter((task) => task.type === type).flatMap((task) => {
    const progress = task.progress as Dated | undefined;
    const runs = Array.isArray(task.runs) && task.runs.length
      ? (task.runs as Dated[]).map((run) => ({ completedAt: run.completedAt, done: run.done, occurrence: run.occurrence }))
      : task.completedAt || task.lastCompletedDate
        ? [{ completedAt: task.completedAt ?? task.lastCompletedDate, done: Number.isFinite(Number(task.sent_verified_count)) ? task.sent_verified_count : progress?.done }]
        : [];
    const recorded = task.status === "completed" || runs.some((run) => !("occurrence" in run) || (task.occurrenceDate !== undefined && run.occurrence === task.occurrenceDate));
    const live = !recorded && runDone(progress || {}) > 0
      ? [{ completedAt: task.startedAt ?? task.updatedAt ?? task.occurrenceDate ?? task.createdAt, done: progress?.done }] : [];
    return [...runs, ...live];
  });
}
export const runDone = (run: Dated) => { const done = Number(run.done); return Number.isFinite(done) && done > 0 ? done : 0; };

export function overviewStats(input: {
  finished?: Dated[]; acquisitionLeads?: Dated[]; mapLeads?: Dated[]; workflowTasks?: Dated[]; publishJobs?: Dated[]; detailSaves?: Dated[];
  materials?: number | null; tutorials?: number | null;
}, now = Date.now()): OverviewStats {
  const finished = weekCount((input.finished || []).filter((item) => item.available !== false), ["createdAt"], now);
  const keyword = weekCount(input.acquisitionLeads || [], ["createdAt"], now);
  const map = weekCount(input.mapLeads || [], ["collectedAt", "createdAt"], now);
  const reached = weekCount(taskRuns(input.workflowTasks || [], "touch"), ["completedAt"], now, runDone);
  const today = (input.publishJobs || []).filter((job) => job.status === "published" && sameDay(time(job.finishedAt ?? job.updatedAt), now));
  return {
    finished, leads: { now: keyword.now + map.now, before: keyword.before + map.before }, reached,
    // Detail images saved from 产品详情图 (one entry per saved image).
    details: weekCount(input.detailSaves || [], ["at"], now),
    publishedToday: today.length, platformsToday: new Set(today.map((job) => job.platform)).size,
    materials: input.materials ?? null, tutorials: input.tutorials ?? null
  };
}

// "比上周多 N" only when this week is ahead; nothing to show otherwise.
export function gain(count: WeekCount): number { return Math.max(0, count.now - count.before); }
