/**
 * RoadmapInput（前提10問 + 大目標）→ Gemini へ渡すプロンプト文字列。
 * -------------------------------------------------------------
 * 設計: docs/goal-roadmap-design.md §4
 * 値のままだと AI が意味を取りにくいので、10問のラベル（日本語）に変換して渡す。
 * ラベルは constants/goal-questions.ts を単一の出典とする。
 */

import { GOAL_QUESTIONS, type OptionValue } from '@/constants/goal-questions';
import { formatMenuTagsForPrompt } from '@/constants/workout-menu-tags';
import type { RoadmapInput } from '@/types/goal';

/** 質問フィールド + 値 → 表示ラベル。見つからなければ値をそのまま文字列化。 */
function labelFor(field: keyof RoadmapInput, value: OptionValue): string {
  const q = GOAL_QUESTIONS.find((x) => x.field === field);
  const opt = q?.options.find((o) => o.value === value);
  return opt?.label ?? String(value);
}

const DAYS_PER_WEEK_CAP: Record<string, number> = {
  '2': 2,
  '3_4': 4,
  '5plus': 6,
  unsure: 3,
};

/** days_per_week から frequency_per_week の上限を求める（安全上限は常に6）。 */
export function weeklyFrequencyCap(daysPerWeek: string): number {
  return Math.min(6, DAYS_PER_WEEK_CAP[daysPerWeek] ?? 3);
}

export interface RoadmapPrompt {
  system: string;
  user: string;
}

export function buildRoadmapPrompt(input: RoadmapInput): RoadmapPrompt {
  const equipmentLabels =
    input.equipment_list.length > 0
      ? input.equipment_list.map((e) => labelFor('equipment_list', e)).join('、')
      : '特になし（自重のみ）';

  const periodLabel =
    input.target_period_weeks == null
      ? '未定（あなたが8〜16週の範囲で決める）'
      : `${input.target_period_weeks}週`;

  const cap = weeklyFrequencyCap(input.days_per_week);

  const system = `あなたは「ずぼら（面倒くさがり）な人でも続けられる」ことを最優先にする、
やさしい運動コーチです。ユーザーの大目標と前提条件から、達成までの
「目標ツリー」を一度だけ生成します。チャットのやり取りはありません。

# 絶対ルール
- 出力は指定された JSON スキーマに厳密に従う。スキーマ外のキーや自然文の前置きは一切出さない。
- 医療・栄養の助言はしない。痛み・持病・妊娠等がありうる前提で、無理をさせない表現にする。
- 「毎日」「限界まで」「絶対に」等のプレッシャー語を避ける。休んでもよいと織り込む。
- ユーザー入力が不適切・危険・目的外（例: 極端な減量、他者への加害）の場合は、
  安全で穏当な内容に読み替えてツリーを作る（拒否や空配列は返さない）。

# 生成方針
- milestones は 3〜5 個。最初は「習慣化」、中盤で「少し負荷」、終盤で「仕上げ」。
- 各 milestone の period_weeks の合計は target_period_weeks に必ず一致させる。
- tasks は各 milestone 1〜3 個。frequency_per_week は ${cap} を超えない（安全上限 6）。
- 器具はユーザーが持っているものだけ使う。「自重のみ」のときは器具不要のメニューだけ。
- 環境が「狭いスペースで静かに」のときは、ジャンプや大きな音の出る動作を避ける。
- きつさの好み・大事にしたいことを description の語り口に反映する。
- title は 20 字前後の前向きな日本語。description はずぼら向けの短い励まし＋具体。
- task.week_number はプラン開始からの通し週（1 始まり・昇順）。milestone の区切りと整合させる。
- 前半の milestone ほど負荷を低く。過去に挫折経験があるなら最初の2週は特に軽く。
- workout_menu_tag は下記の一覧から最も近いものを選ぶ。該当なしは null。

# workout_menu_tag 一覧
${formatMenuTagsForPrompt()}`;

  const user = `# ユーザー入力
大目標: ${input.goal_text || '（未入力。無理なく体を動かす習慣づくりを目標にする）'}
今の運動頻度: ${labelFor('frequency_level', input.frequency_level)}
過去の挫折経験: ${input.past_failure_experience ? 'ある' : '特にない'}
狙い: ${labelFor('goal_focus', input.goal_focus)}
1回にかけられる時間: ${labelFor('time_per_session_minutes', input.time_per_session_minutes)}
週に割ける日数: ${labelFor('days_per_week', input.days_per_week)}
使える器具: ${equipmentLabels}
運動できる環境: ${labelFor('environment_constraint', input.environment_constraint)}
きつさの感じ方: ${labelFor('intensity_preference', input.intensity_preference)}
続けるうえで大事にしたいこと: ${labelFor('motivation_style', input.motivation_style)}
目標までの期間: ${periodLabel}

上記から目標ツリーを JSON で生成してください。`;

  return { system, user };
}
