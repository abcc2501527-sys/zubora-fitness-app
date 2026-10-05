/**
 * ロードマップ（"/goal"）
 * -------------------------------------------------------------
 * AIが分解した目標ツリー（大目標 → 中目標 → 週次タスク）を表示。
 * 生成直後は下書きの結果を、通常は保存済みを取得して描画する。
 * モノトーン基調 ＋ 星のあしらいで認証画面とトーンを統一。
 */

import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GOAL_QUESTIONS, type OptionValue } from '@/constants/goal-questions';
import { MonoColors, MonoGlyph, MonoLayout } from '@/constants/mono-theme';
import { goalDraft } from '@/lib/goal-draft';
import { tapImpact } from '@/lib/haptics';
import { softWrapJa } from '@/lib/ja-text';
import { fetchCurrentRoadmap, fetchThisWeekFocus, saveRoadmap } from '@/services/goalService';
import { fetchHomeStats } from '@/services/workoutService';
import type { Roadmap, RoadmapTask, WeekFocus } from '@/types/goal';

type NodeStatus = 'done' | 'active' | 'upcoming';

/** 前提10問の回答一式から、質問ごとの選んだラベルを組み立てる（未回答/該当なしは除外）。 */
function buildAnswerRows(
  answers: Roadmap['input_answers'],
): { question: string; label: string }[] {
  if (!answers) return [];
  return GOAL_QUESTIONS.reduce<{ question: string; label: string }[]>((rows, q) => {
    const raw = (answers as Record<string, OptionValue | OptionValue[]>)[q.field];
    if (raw === undefined) return rows;

    if (q.kind === 'multi') {
      const values = Array.isArray(raw) ? raw : [];
      const labels = values
        .map((v) => q.options.find((o) => o.value === v)?.label)
        .filter((l): l is string => !!l);
      if (labels.length > 0) rows.push({ question: q.title, label: labels.join('・') });
      return rows;
    }

    const label = q.options.find((o) => o.value === raw)?.label;
    if (label) rows.push({ question: q.title, label });
    return rows;
  }, []);
}

// 「！」「？」「。」や絵文字の直後で改行する。
// AIが生成するタイトルは文の区切りに句読点・絵文字を使うことが多く、そこを狙って
// 明示的に改行しておくと、自動折り返しが単語の途中（例:「自重」）で起きにくくなる。
const TITLE_BREAK_PATTERN = /([！？。]|[\u{2600}-\u{27BF}\u{1F000}-\u{1FFFF}])/gu;

function withTitleBreaks(title: string): string {
  return title
    .replace(TITLE_BREAK_PATTERN, '$1\n')
    .split('\n')
    .map((line) => softWrapJa(line.trim()))
    .filter((line) => line.length > 0)
    .join('\n');
}

export default function GoalRoadmapScreen() {
  const router = useRouter();
  const [roadmap, setRoadmap] = useState<Roadmap | null>(() => goalDraft.getRoadmap());
  const [loading, setLoading] = useState(roadmap === null);
  const [starting, setStarting] = useState(false);
  // 保存済みロードマップを取得したときだけ、あわせて「今どの週か」「今週何回やったか」を取得する
  // （下書き＝未保存の段階では進捗の概念がないので null / 0 のまま）。
  const [focus, setFocus] = useState<WeekFocus | null>(null);
  const [weekWorkouts, setWeekWorkouts] = useState(0);
  const [showRawInput, setShowRawInput] = useState(false);

  useEffect(() => {
    if (roadmap) return;
    let alive = true;
    Promise.all([fetchCurrentRoadmap(), fetchThisWeekFocus(), fetchHomeStats()]).then(
      ([r, f, s]) => {
        if (!alive) return;
        setRoadmap(r);
        setFocus(f);
        setWeekWorkouts(s.weekWorkouts);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [roadmap]);

  // 下書き(goalDraft)は「保存する/作り直す」を押さずに画面を離れても消えず、
  // 次にこの画面を開いたときにまた同じ下書きが表示され続けてしまう
  // （＝保存済みデータや進捗が一切取得されず、完了表示も更新されない原因）。
  // この画面を離れるタイミングで必ず片付けて、次回は必ず最新を取り直させる。
  useEffect(() => {
    return () => {
      goalDraft.reset();
    };
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centerAll]}>
        <ActivityIndicator color={MonoColors.ink} />
      </SafeAreaView>
    );
  }

  if (!roadmap) {
    return (
      <SafeAreaView style={[styles.container, styles.centerAll]} edges={['top', 'bottom']}>
        <Text style={styles.emptyGlyph}>{MonoGlyph.ribbon}</Text>
        <Text style={styles.emptyTitle}>まだ目標がありません</Text>
        <Pressable style={styles.primaryButton} onPress={() => router.push('/goal/create')}>
          <Text style={styles.primaryText}>目標をつくる</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // milestone.period_weeks を順に積み上げて、各中目標が何週目〜何週目かを出す
  // （task.week_number はロードマップ全体を通しての絶対週数なので、これと比較する）。
  let cursorWeek = 0;
  const milestoneRanges = roadmap.milestones.map((m) => {
    const start = cursorWeek + 1;
    cursorWeek += m.period_weeks;
    return { start, end: cursorWeek };
  });

  const taskStatus = (t: RoadmapTask): NodeStatus => {
    if (!focus) return 'upcoming';
    if (focus.isComplete || t.week_number < focus.currentWeek) return 'done';
    if (t.week_number === focus.currentWeek) {
      // 今週分は、週が変わるのを待たずに実施回数が目安に達した時点で完了扱いにする
      return weekWorkouts >= t.frequency_per_week ? 'done' : 'active';
    }
    return 'upcoming';
  };

  const milestoneStatus = (
    idx: number,
    range: { start: number; end: number },
    tasks: RoadmapTask[],
  ): NodeStatus => {
    if (!focus) return idx === 0 ? 'active' : 'upcoming';
    if (focus.isComplete || focus.currentWeek > range.end) return 'done';
    if (focus.currentWeek >= range.start) {
      // 中目標の最終週なら、その週のタスクが完了した時点で中目標ごと完了扱いにする
      if (focus.currentWeek === range.end) {
        const currentTask = tasks.find((t) => t.week_number === focus.currentWeek);
        if (currentTask && taskStatus(currentTask) === 'done') return 'done';
      }
      return 'active';
    }
    return 'upcoming';
  };

  const regenerate = () => {
    tapImpact();
    goalDraft.reset();
    router.push('/goal/create');
  };

  const start = async () => {
    if (!roadmap || starting) return;
    tapImpact();
    setStarting(true);
    try {
      await saveRoadmap(roadmap);
      goalDraft.reset();
      router.replace('/(tabs)');
    } catch (err) {
      console.warn('[goal] ロードマップの保存に失敗しました:', err);
      const msg = err instanceof Error ? err.message : '';
      Alert.alert(
        '保存に失敗しました',
        msg.includes('AUTH_REQUIRED')
          ? 'ログインすると目標が保存され、他の端末でも見られるようになります。'
          : 'もう一度お試しください。',
      );
      setStarting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable hitSlop={10} onPress={() => router.back()}>
          <Feather name="chevron-left" size={24} color={MonoColors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>ロードマップ</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.title} numberOfLines={4} adjustsFontSizeToFit minimumFontScale={0.7}>
          {withTitleBreaks(roadmap.title)}
        </Text>

        <View style={styles.tree}>
          {roadmap.milestones.map((m, i) => {
            const status = milestoneStatus(i, milestoneRanges[i], m.tasks);
            return (
              <View key={m.milestone_id} style={styles.node}>
                <View
                  style={[
                    styles.dot,
                    status === 'done' && styles.dotDone,
                    status === 'active' && styles.dotActive,
                    status === 'upcoming' && styles.dotFuture,
                  ]}>
                  {status === 'done' && <Feather name="check" size={9} color={MonoColors.onInk} />}
                </View>
                <View
                  style={[
                    styles.card,
                    status === 'done' && styles.cardDone,
                    status === 'upcoming' && styles.cardFuture,
                  ]}>
                  <Text style={styles.milestoneTitle}>{withTitleBreaks(m.title)}</Text>
                  <View style={styles.metaRow}>
                    <Text style={styles.weeks}>{m.period_weeks}週</Text>
                    {status === 'done' && (
                      <View style={styles.doneBadge}>
                        <Text style={styles.doneBadgeText}>完了！</Text>
                      </View>
                    )}
                  </View>
                  {m.description ? <Text style={styles.desc}>{softWrapJa(m.description)}</Text> : null}

                  {m.tasks.map((t, ti) => {
                    const tStatus = taskStatus(t);
                    // タスクが担当する週の範囲＝次のタスクの前週まで（最後のタスクは中目標の終わりまで）。
                    // タスクは各中目標に1〜3個しかないため、間の週はこの範囲に含めて表示する。
                    const rangeEnd =
                      ti < m.tasks.length - 1
                        ? Math.max(t.week_number, m.tasks[ti + 1].week_number - 1)
                        : milestoneRanges[i].end;
                    const weekLabel =
                      rangeEnd > t.week_number
                        ? `WEEK ${t.week_number}〜${rangeEnd}`
                        : `WEEK ${t.week_number}`;
                    return (
                      <View
                        key={t.task_id}
                        style={[styles.task, tStatus === 'done' && styles.taskDone]}>
                        <View style={styles.taskTextWrap}>
                          <Text style={styles.taskWeek}>{weekLabel}</Text>
                          <Text
                            style={[
                              styles.taskTitle,
                              tStatus === 'done' && styles.taskTitleDone,
                            ]}>
                            {withTitleBreaks(t.title)}
                          </Text>
                        </View>
                        {tStatus === 'done' ? (
                          <View style={styles.taskDoneTag}>
                            <Feather name="check" size={11} color={MonoColors.success} />
                            <Text style={styles.taskDoneTagText}>達成</Text>
                          </View>
                        ) : (
                          <Text style={styles.freq}>週{t.frequency_per_week}回</Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>

        <Pressable
          style={styles.rawInputToggle}
          onPress={() => setShowRawInput((v) => !v)}
          hitSlop={8}>
          <Text style={styles.rawInputToggleText}>
            {showRawInput ? '入力した内容を閉じる' : '入力した内容を見る'}
          </Text>
          <Feather
            name={showRawInput ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={MonoColors.textMuted}
          />
        </Pressable>
        {showRawInput && (
          <View style={styles.rawInputBox}>
            <View style={styles.answerRow}>
              <Text style={styles.rawInputLabel}>大目標</Text>
              <Text style={styles.rawInput}>{roadmap.user_input_raw}</Text>
            </View>
            {buildAnswerRows(roadmap.input_answers).map((row) => (
              <View key={row.question} style={styles.answerRow}>
                <Text style={styles.rawInputLabel}>{row.question}</Text>
                <Text style={styles.rawInput}>{row.label}</Text>
              </View>
            ))}
          </View>
        )}

        <Pressable
          style={[styles.primaryButton, starting && styles.primaryButtonDisabled]}
          onPress={start}
          disabled={starting}>
          <View style={styles.primaryRow}>
            {starting ? (
              <ActivityIndicator size="small" color={MonoColors.onInk} />
            ) : (
              <Feather name="star" size={15} color={MonoColors.onInk} />
            )}
            <Text style={styles.primaryText}>
              {starting ? '保存しています…' : 'この目標ではじめる'}
            </Text>
          </View>
        </Pressable>
        <Pressable style={styles.ghostButton} onPress={regenerate} disabled={starting}>
          <Text style={styles.ghostText}>作り直す</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: MonoColors.screenBg },
  centerAll: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: MonoLayout.screenPadding,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 2,
    color: MonoColors.ink,
  },

  scroll: {
    paddingHorizontal: MonoLayout.screenPadding,
    paddingTop: 8,
    paddingBottom: 40,
  },
  eyebrow: { fontSize: 12, color: MonoColors.textSecondary },
  title: {
    fontSize: 22,
    lineHeight: 30,
    fontWeight: '700',
    color: MonoColors.ink,
    marginTop: 6,
    marginBottom: 24,
    textAlign: 'center',
  },
  rawInputToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 14,
    marginTop: 20,
  },
  rawInputToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: MonoColors.textMuted,
  },
  rawInputBox: {
    gap: 12,
    marginBottom: 4,
  },
  answerRow: {
    gap: 2,
  },
  rawInputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: MonoColors.textMuted,
  },
  rawInput: {
    fontSize: 13,
    color: MonoColors.inkSoft,
    textAlign: 'left',
  },

  tree: {
    borderLeftWidth: 1.5,
    borderLeftColor: MonoColors.border,
    paddingLeft: 18,
    marginLeft: 6,
    gap: 14,
  },
  node: { position: 'relative' },
  dot: {
    position: 'absolute',
    left: -25,
    top: 4,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 3,
    borderColor: MonoColors.screenBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotActive: { backgroundColor: MonoColors.ink },
  dotFuture: { backgroundColor: MonoColors.border },
  dotDone: { backgroundColor: MonoColors.success },

  card: {
    backgroundColor: MonoColors.surface,
    borderWidth: 1,
    borderColor: MonoColors.border,
    borderRadius: MonoLayout.radiusCard,
    padding: 16,
  },
  cardFuture: { opacity: 0.75 },
  cardDone: {
    backgroundColor: MonoColors.successTint,
    borderColor: MonoColors.success,
  },
  milestoneTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: MonoColors.ink,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  doneBadge: {
    backgroundColor: MonoColors.success,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: MonoLayout.radiusPill,
  },
  doneBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: MonoColors.onInk,
  },
  weeks: { fontSize: 11, color: MonoColors.textMuted },
  desc: {
    fontSize: 12,
    color: MonoColors.textSecondary,
    lineHeight: 20,
    marginTop: 8,
  },

  task: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: MonoColors.surfaceAlt,
    borderRadius: MonoLayout.radiusControl,
    padding: 12,
    marginTop: 12,
  },
  taskDone: {
    backgroundColor: MonoColors.successTint,
  },
  taskTextWrap: { flex: 1 },
  taskWeek: { fontSize: 11, color: MonoColors.textMuted },
  taskTitle: { fontSize: 13, color: MonoColors.ink, marginTop: 2 },
  taskTitleDone: { color: MonoColors.textSecondary },
  freq: {
    fontSize: 11,
    color: MonoColors.inkSoft,
    borderWidth: 1,
    borderColor: MonoColors.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: MonoLayout.radiusPill,
    marginLeft: 8,
  },
  taskDoneTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: MonoColors.success,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: MonoLayout.radiusPill,
    marginLeft: 8,
  },
  taskDoneTagText: {
    fontSize: 11,
    fontWeight: '700',
    color: MonoColors.success,
  },

  primaryButton: {
    backgroundColor: MonoColors.ink,
    borderRadius: MonoLayout.radiusControl,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 28,
  },
  primaryButtonDisabled: { opacity: 0.7 },
  primaryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  primaryText: {
    color: MonoColors.onInk,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  ghostButton: { paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  ghostText: { color: MonoColors.textSecondary, fontSize: 14, fontWeight: '600' },

  emptyGlyph: { fontSize: 28, marginBottom: 12 },
  emptyTitle: { fontSize: 16, color: MonoColors.ink, marginBottom: 20 },
});
