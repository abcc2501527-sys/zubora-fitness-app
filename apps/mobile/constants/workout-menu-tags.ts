/**
 * workout_menu_tag の一覧（22種）。
 * -------------------------------------------------------------
 * 目標ロードマップの各タスク（RoadmapTask.workout_menu_tag）が指す、
 * 既存メニューとの紐付けタグ。AI 生成のプロンプトにもこの一覧を渡す。
 *
 * ★暫定タクソノミー★ 設計ドラフト（docs/goal-roadmap-design.md §5）の
 * たたき台。将来 CV 班の workout_menus テーブルの exercise_key と対応付ける。
 */

export interface WorkoutMenuTag {
  tag: string;
  /** AI へ渡す説明（日本語） */
  label: string;
  /** 器具が要るか（'none' なら不要） */
  equipment: 'none' | 'mat' | 'dumbbells' | 'ab_roller' | 'resistance_band' | 'step';
  /** 静かにできるか（狭い・集合住宅向け） */
  quiet: boolean;
}

export const WORKOUT_MENU_TAGS: WorkoutMenuTag[] = [
  // --- 体幹・お腹まわり ---
  { tag: 'core_basic_quiet', label: '基本の体幹（プランク・デッドバグ）', equipment: 'none', quiet: true },
  { tag: 'core_crunch', label: 'クランチ・レッグレイズ', equipment: 'mat', quiet: true },
  { tag: 'core_ab_roller', label: '腹筋ローラー', equipment: 'ab_roller', quiet: true },
  { tag: 'core_oblique', label: '腹斜筋（サイドプランク・ツイスト）', equipment: 'none', quiet: true },
  { tag: 'core_advanced', label: '高負荷体幹（V字・ホロウ）', equipment: 'mat', quiet: true },
  // --- 体力・有酸素 ---
  { tag: 'stamina_lowimpact', label: '静かな有酸素（その場もも上げ・シャドー）', equipment: 'none', quiet: true },
  { tag: 'stamina_cardio', label: '通常の有酸素（バーピー・ジャンプ）', equipment: 'none', quiet: false },
  { tag: 'stamina_interval', label: '短時間インターバル（HIIT）', equipment: 'none', quiet: false },
  { tag: 'stamina_stepper', label: '踏み台・階段', equipment: 'step', quiet: false },
  // --- 姿勢 ---
  { tag: 'posture_stretch', label: '姿勢改善ストレッチ（胸開き・肩甲骨）', equipment: 'none', quiet: true },
  { tag: 'posture_back', label: '背面強化（バックエクステンション・Y-T-W）', equipment: 'mat', quiet: true },
  { tag: 'posture_hip', label: '股関節まわり（ヒップリフト・クラム）', equipment: 'none', quiet: true },
  { tag: 'posture_neck_shoulder', label: '首肩こり向けの軽い運動', equipment: 'none', quiet: true },
  // --- ストレス発散・リラックス ---
  { tag: 'stress_flow', label: 'ゆるいフロー（ヨガ的な動き・呼吸）', equipment: 'mat', quiet: true },
  { tag: 'stress_walk', label: '散歩・軽い外出', equipment: 'none', quiet: true },
  { tag: 'stress_mobility', label: '全身モビリティ（関節をゆるめる）', equipment: 'none', quiet: true },
  // --- 部位別 ---
  { tag: 'lower_bodyweight', label: '下半身自重（スクワット・ランジ）', equipment: 'none', quiet: true },
  { tag: 'lower_weighted', label: '下半身加重（ダンベルスクワット等）', equipment: 'dumbbells', quiet: true },
  { tag: 'upper_bodyweight', label: '上半身自重（腕立て・ディップス）', equipment: 'none', quiet: true },
  { tag: 'upper_band', label: 'バンドトレ（ローイング・プレス）', equipment: 'resistance_band', quiet: true },
  // --- 全身・休養 ---
  { tag: 'fullbody_beginner', label: '全身入門サーキット（低負荷）', equipment: 'none', quiet: false },
  { tag: 'rest_active', label: 'アクティブレスト（軽い動き・休養日の推奨）', equipment: 'none', quiet: true },
];

export const WORKOUT_MENU_TAG_VALUES = WORKOUT_MENU_TAGS.map((t) => t.tag);

/** プロンプトに差し込む用の一覧文字列 */
export function formatMenuTagsForPrompt(): string {
  return WORKOUT_MENU_TAGS.map(
    (t) => `- ${t.tag}: ${t.label}${t.equipment !== 'none' ? `（要: ${t.equipment}）` : ''}${t.quiet ? '' : '（音が出る）'}`,
  ).join('\n');
}
