import type { Repo } from './db.js';
import { localHHMM } from './status.js';

export interface Stats {
  today: { answered: number; manual: number; avgWaitSeconds: number | null };
  week: { answered: number; avgWaitSeconds: number | null };
}

/** Inicio del día local (00:00) en segundos unix. Suficiente para zonas sin cambio de hora. */
export function startOfLocalDay(now: Date, timezone: string): number {
  const [h, m] = localHHMM(now, timezone).split(':').map(Number);
  const seconds = now.getSeconds();
  return Math.floor(now.getTime() / 1000) - (h * 3600 + m * 60 + seconds);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function computeStats(repo: Repo, now: Date, timezone: string): Stats {
  const dayStart = startOfLocalDay(now, timezone);
  const weekStart = dayStart - 6 * 86400;
  const rows = repo.responsesSince(weekStart);

  const todayRows = rows.filter((r) => r.answered_at >= dayStart);
  const todayReplies = todayRows.filter((r) => r.resolved_by === 'reply');
  const weekReplies = rows.filter((r) => r.resolved_by === 'reply');

  return {
    today: {
      answered: todayReplies.length,
      manual: todayRows.length - todayReplies.length,
      avgWaitSeconds: average(todayReplies.map((r) => r.wait_seconds)),
    },
    week: {
      answered: weekReplies.length,
      avgWaitSeconds: average(weekReplies.map((r) => r.wait_seconds)),
    },
  };
}
