/**
 * Gemini が返した未検証 JSON → 正規化済み Roadmap。
 * -------------------------------------------------------------
 * 構造化出力でもズレは起きうる（週数合計・不明タグ・欠損 id・回数超過）。
 * UI 契約（types/goal.ts）に合うよう軽く補正する。設計: docs §7。
 */

import { WORKOUT_MENU_TAG_VALUES } from '@/constants/workout-menu-tags';
import type { Roadmap, RoadmapInput, RoadmapMilestone, RoadmapTask } from '@/types/goal';
import { weeklyFrequencyCap } from '@/lib/goal-prompt';

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function int(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export class RoadmapShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoadmapShapeError';
  }
}

export function normalizeRoadmap(raw: unknown, input: RoadmapInput): Roadmap {
  if (!raw || typeof raw !== 'object') {
    throw new RoadmapShapeError('ロードマップがオブジェクトではありません');
  }
  const r = raw as Record<string, unknown>;

  const rawMilestones = Array.isArray(r.milestones) ? r.milestones : [];
  if (rawMilestones.length === 0) {
    throw new RoadmapShapeError('milestones が空です');
  }

  const freqCap = weeklyFrequencyCap(input.days_per_week);

  // target_period_weeks: 出力優先、無ければ入力、それも無ければ 12
  let targetWeeks = int(r.target_period_weeks, input.target_period_weeks ?? 12);
  if (targetWeeks <= 0) targetWeeks = input.target_period_weeks ?? 12;

  let taskCounter = 0;
  const milestones: RoadmapMilestone[] = rawMilestones.map((m, mi): RoadmapMilestone => {
    const mo = (m ?? {}) as Record<string, unknown>;
    const rawTasks = Array.isArray(mo.tasks) ? mo.tasks : [];

    const tasks: RoadmapTask[] = rawTasks.map((t, ti): RoadmapTask => {
      const to = (t ?? {}) as Record<string, unknown>;
      taskCounter += 1;
      const tag = str(to.workout_menu_tag) || null;
      return {
        task_id: str(to.task_id) || `t${taskCounter}`,
        order: int(to.order, ti + 1),
        week_number: clamp(int(to.week_number, 1), 1, targetWeeks),
        title: str(to.title, '運動する'),
        description: str(to.description),
        frequency_per_week: clamp(int(to.frequency_per_week, 2), 1, freqCap),
        workout_menu_tag: tag && WORKOUT_MENU_TAG_VALUES.includes(tag) ? tag : null,
      };
    });

    return {
      milestone_id: str(mo.milestone_id) || `m${mi + 1}`,
      order: int(mo.order, mi + 1),
      title: str(mo.title, `ステップ ${mi + 1}`),
      period_weeks: Math.max(1, int(mo.period_weeks, 1)),
      description: str(mo.description),
      tasks,
    };
  });

  // period_weeks の合計を target に合わせる（差分を最後の milestone で吸収）
  const sum = milestones.reduce((acc, m) => acc + m.period_weeks, 0);
  if (sum !== targetWeeks && milestones.length > 0) {
    const last = milestones[milestones.length - 1];
    last.period_weeks = Math.max(1, last.period_weeks + (targetWeeks - sum));
  }

  return {
    goal_id: str(r.goal_id) || `gen-${Math.random().toString(36).slice(2, 10)}`,
    title: str(r.title, 'あなたの目標プラン'),
    user_input_raw: str(r.user_input_raw) || input.goal_text,
    target_period_weeks: targetWeeks,
    milestones,
  };
}
