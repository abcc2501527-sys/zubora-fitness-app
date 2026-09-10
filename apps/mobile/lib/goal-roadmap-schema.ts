/**
 * Gemini の responseSchema（構造化出力）。types/goal.ts の Roadmap 構造に対応。
 * -------------------------------------------------------------
 * OpenAPI 3.0 サブセット形式（Gemini generateContent の generationConfig.responseSchema）。
 * type は大文字文字列。propertyOrdering で生成順を固定するとブレが減る。
 */

export const ROADMAP_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    goal_id: { type: 'STRING', description: '"gen-" + 短いランダム文字列' },
    title: { type: 'STRING', description: 'AI が整形した20字前後の前向きなプラン名' },
    user_input_raw: { type: 'STRING', description: 'ユーザーの大目標入力をそのまま' },
    target_period_weeks: { type: 'INTEGER', description: 'プラン全体の週数。入力が未定なら8〜16で決める' },
    milestones: {
      type: 'ARRAY',
      description: '3〜5個。period_weeks の合計が target_period_weeks と一致すること',
      items: {
        type: 'OBJECT',
        properties: {
          milestone_id: { type: 'STRING', description: '"m1","m2",...' },
          order: { type: 'INTEGER', description: '1始まりの連番' },
          title: { type: 'STRING' },
          period_weeks: { type: 'INTEGER' },
          description: { type: 'STRING', description: '60〜120字。ずぼら向けの励まし＋具体' },
          tasks: {
            type: 'ARRAY',
            description: '1〜3個',
            items: {
              type: 'OBJECT',
              properties: {
                task_id: { type: 'STRING', description: 'ツリー全体で一意。"t1","t2",...' },
                order: { type: 'INTEGER', description: 'milestone 内で1始まり' },
                week_number: { type: 'INTEGER', description: 'プラン開始からの通し週（1始まり）' },
                title: { type: 'STRING' },
                description: { type: 'STRING', description: '40〜80字' },
                frequency_per_week: { type: 'INTEGER', description: '1〜6' },
                workout_menu_tag: {
                  type: 'STRING',
                  nullable: true,
                  description: 'workout_menu_tag 一覧から。該当なしは null',
                },
              },
              required: [
                'task_id',
                'order',
                'week_number',
                'title',
                'description',
                'frequency_per_week',
                'workout_menu_tag',
              ],
              propertyOrdering: [
                'task_id',
                'order',
                'week_number',
                'title',
                'description',
                'frequency_per_week',
                'workout_menu_tag',
              ],
            },
          },
        },
        required: ['milestone_id', 'order', 'title', 'period_weeks', 'description', 'tasks'],
        propertyOrdering: ['milestone_id', 'order', 'title', 'period_weeks', 'description', 'tasks'],
      },
    },
  },
  required: ['goal_id', 'title', 'user_input_raw', 'target_period_weeks', 'milestones'],
  propertyOrdering: ['goal_id', 'title', 'user_input_raw', 'target_period_weeks', 'milestones'],
} as const;
