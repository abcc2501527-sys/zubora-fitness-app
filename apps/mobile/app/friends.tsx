/**
 * フレンド一覧ダッシュボード（"/friends"）
 * -------------------------------------------------------------
 * ・オンライン状況（Supabase Realtime Presence）
 * ・継続日数ランキング ＋ 継続度に応じた応援メッセージ
 * ・フレンド申請の送信（フレンドコード）／届いた申請の承認・拒否
 * ・フレンドカードを長押しで解除
 *
 * モノトーン基調 ＋ 大人カワイイ（枠線のあしらい・連続達成の星）。
 * グラフ類は追加ライブラリ不要で動くよう Reanimated + View で実装。
 * アイコンは同梱の @expo/vector-icons（Feather）。
 */

import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MonoColors, MonoGlyph, MonoLayout } from '@/constants/mono-theme';
import { useAuthSession } from '@/hooks/use-auth-session';
import { notifySuccess, tapImpact, tapLight } from '@/lib/haptics';
import { fetchMyFriendCode } from '@/services/authService';
import {
  addFriendComment,
  deleteFriendComment,
  getFriendComments,
  getFriendCommentSummary,
} from '@/services/friendCommentService';
import {
  getMyNudgesSentToday,
  getMyReceivedNudges,
  sendFriendNudge,
} from '@/services/friendNudgeService';
import {
  acceptFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  subscribeToFriendRequests,
  subscribeToPresence,
} from '@/services/friendsService';
import type { FriendCommentRow, FriendCommentSummaryRow, ReceivedNudgeRow } from '@/types/db';
import type { Friend, FriendRequest, OnlineMap } from '@/types/friends';

/** オンライン枠の発光カラー（ピンク／ゴールド） */
const GLOW_PINK = '#E4A7B7';
const GLOW_GOLD = '#D8B45C';
/** この日数ごとに星をひとつ灯す */
const STAR_PER_DAYS = 7;
/** フレンドへ送れるリアクションの絵文字（1日1回まで）。連続中は称賛系、お休み中は応援系 */
const REACTION_EMOJIS_CHEER = ['🔥', '👏', '✨', '💪'];
const REACTION_EMOJIS_SUPPORT = ['😭', '📣', '💪', '👋'];

export default function FriendsScreen() {
  const router = useRouter();
  const { session, loading } = useAuthSession();

  // 初回のセッション確認中
  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={MonoColors.ink} />
      </SafeAreaView>
    );
  }

  // 未ログイン：フレンド系 RPC は authenticated 限定なのでログイン導線を表示
  if (!session) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Pressable hitSlop={10} onPress={() => router.back()}>
            <Feather name="chevron-left" size={24} color={MonoColors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>フレンド</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.gate}>
          <Text style={styles.gateGlyph}>{MonoGlyph.ribbon}</Text>
          <Text style={styles.gateTitle}>ログインが必要です</Text>
          <Text style={styles.gateSub}>
            フレンドの継続状況やフレンド申請は{'\n'}ログインすると見られます
          </Text>
          <Pressable
            style={styles.gateBtn}
            onPress={() => {
              tapLight();
              router.push('/auth');
            }}>
            <Feather name="star" size={15} color={MonoColors.onInk} />
            <Text style={styles.gateBtnText}>ログイン / 新規登録</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return <FriendsDashboard />;
}

function FriendsDashboard() {
  const router = useRouter();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [online, setOnline] = useState<OnlineMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** 今日すでに応援ナッジを送った相手（userId→送った絵文字） */
  const [nudgedToday, setNudgedToday] = useState<Record<string, string>>({});
  /** フレンドカードへの「ひと言コメント」件数＋最新1件（userId→summary） */
  const [commentSummary, setCommentSummary] = useState<Record<string, FriendCommentSummaryRow>>({});
  /** コメント一覧モーダルを開いている相手。null なら閉じている */
  const [commentTarget, setCommentTarget] = useState<Friend | null>(null);
  /** 自分が受け取ったリアクション一覧（新しい順）。コメントモーダルの上部に表示する */
  const [receivedNudges, setReceivedNudges] = useState<ReceivedNudgeRow[]>([]);

  const load = useCallback(async () => {
    // フレンド一覧・申請は既存の最重要データ。ここが失敗したら他は試さない
    let f: Friend[];
    try {
      const [fetched, r] = await Promise.all([fetchFriends(), fetchFriendRequests()]);
      f = fetched;
      setFriends(fetched);
      setRequests(r);
    } catch (e) {
      console.warn('[friends] 一覧の取得に失敗しました', e);
      return;
    }

    // ここから下は新機能（未マイグレーションのDBだとRPCが無くて失敗しうる）。
    // 失敗してもフレンド一覧自体は表示されたままにしたいので個別にtry/catchする
    try {
      const n = await getMyNudgesSentToday();
      setNudgedToday(Object.fromEntries(n.map((row) => [row.to_user_id, row.emoji])));
    } catch (e) {
      console.warn('[friends] 応援ナッジの取得に失敗しました（migration_12未実行の可能性）', e);
    }

    try {
      // 自分のカード宛てにもらったコメントも見えるよう、自分自身のidも含める
      const friendIds = f.map((x) => x.user_id);
      const summaries = await getFriendCommentSummary(friendIds);
      setCommentSummary(Object.fromEntries(summaries.map((s) => [s.to_user_id, s])));
    } catch (e) {
      console.warn('[friends] コメントの取得に失敗しました（migration_14未実行の可能性）', e);
    }

    try {
      setReceivedNudges(await getMyReceivedNudges());
    } catch (e) {
      console.warn('[friends] 受け取ったリアクションの取得に失敗しました（migration_12未実行の可能性）', e);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      await load();
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [load]);

  // Realtime Presence（オンライン状況）
  useEffect(() => subscribeToPresence(setOnline), []);

  // 新しいフレンド申請の到着を購読
  useEffect(
    () =>
      subscribeToFriendRequests(() => {
        void fetchFriendRequests().then(setRequests);
      }),
    [],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleAccept = async (req: FriendRequest) => {
    tapImpact();
    setRequests((prev) => prev.filter((r) => r.request_id !== req.request_id));
    try {
      await acceptFriendRequest(req.request_id);
      notifySuccess();
    } catch (e) {
      console.warn('[friends] 承認に失敗しました', e);
    }
    await load();
  };

  const handleReject = async (req: FriendRequest) => {
    tapLight();
    setRequests((prev) => prev.filter((r) => r.request_id !== req.request_id));
    try {
      await rejectFriendRequest(req.request_id);
    } catch (e) {
      console.warn('[friends] 拒否に失敗しました', e);
    }
  };

  const handleNudge = async (friend: Friend, emoji: string) => {
    if (nudgedToday[friend.user_id]) return;
    tapImpact();
    setNudgedToday((prev) => ({ ...prev, [friend.user_id]: emoji }));
    try {
      const res = await sendFriendNudge(friend.user_id, emoji);
      if (res.ok) {
        notifySuccess();
      } else {
        setNudgedToday((prev) => {
          const next = { ...prev };
          delete next[friend.user_id];
          return next;
        });
        if (res.reason === 'already_nudged_today') {
          setNudgedToday((prev) => ({ ...prev, [friend.user_id]: emoji }));
        } else {
          Alert.alert('送れませんでした', 'もう一度お試しください');
        }
      }
    } catch (e) {
      console.warn('[friends] ナッジの送信に失敗しました', e);
      setNudgedToday((prev) => {
        const next = { ...prev };
        delete next[friend.user_id];
        return next;
      });
    }
  };

  const handleRemove = (friend: Friend) => {
    if (friend.is_self) return;
    Alert.alert('フレンドを解除', `${friend.username} さんを解除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '解除する',
        style: 'destructive',
        onPress: async () => {
          tapImpact();
          setFriends((prev) => prev.filter((f) => f.user_id !== friend.user_id));
          try {
            await removeFriend(friend.user_id);
          } catch (e) {
            console.warn('[friends] 解除に失敗しました', e);
            await load(); // 失敗したら一覧を元に戻す
          }
        },
      },
    ]);
  };

  // 週間ランキング: 今週（JST月曜始まり）の筋トレ時間が多い順
  const ranked = useMemo(
    () => [...friends].sort((a, b) => b.week_minutes - a.week_minutes),
    [friends],
  );
  const friendsOnly = ranked.filter((f) => !f.is_self);
  const onlineCount = friendsOnly.filter((f) => online[f.user_id]).length;

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={MonoColors.ink} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable hitSlop={10} onPress={() => router.back()}>
          <Feather name="chevron-left" size={24} color={MonoColors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>フレンド</Text>
        <Pressable
          hitSlop={10}
          onPress={() => {
            tapLight();
            setAddOpen(true);
          }}>
          <Feather name="user-plus" size={22} color={MonoColors.ink} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={MonoColors.textMuted}
          />
        }>
        <Text style={styles.summaryLine}>
          {onlineCount}人がオンライン／ 
          {friendsOnly.length}人 
        </Text>

        {/* 届いているフレンド申請 */}
        {requests.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              フレンド申請 <Text style={styles.countPill}>{requests.length}</Text>
            </Text>
            <View style={styles.card}>
              {requests.map((req, i) => (
                <View key={req.request_id}>
                  {i > 0 && <View style={styles.hair} />}
                  <RequestRow
                    req={req}
                    onAccept={() => handleAccept(req)}
                    onReject={() => handleReject(req)}
                  />
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ランキング */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>週間ランキング</Text>
            {friendsOnly.length > 0 && (
              <Text style={styles.sectionHint}>長押しで解除</Text>
            )}
          </View>
          <View style={{ gap: 12 }}>
            {ranked.map((friend, i) => (
              <FriendCard
                key={friend.user_id}
                friend={friend}
                rank={i + 1}
                online={online[friend.user_id]}
                onRemove={() => handleRemove(friend)}
                nudgedEmoji={nudgedToday[friend.user_id]}
                onNudge={(emoji) => handleNudge(friend, emoji)}
                commentSummary={commentSummary[friend.user_id]}
                onOpenComments={() => setCommentTarget(friend)}
              />
            ))}
          </View>
        </View>

        <Text style={styles.footNote}>
          {MonoGlyph.star} むりせず、ゆるく、いっしょに
        </Text>
      </ScrollView>

      <AddFriendModal visible={addOpen} onClose={() => setAddOpen(false)} />
      <CommentModal
        friend={commentTarget}
        receivedNudges={receivedNudges}
        onClose={() => setCommentTarget(null)}
        onPosted={load}
      />
    </SafeAreaView>
  );
}

/* ============================================================
 * フレンドカード
 * ========================================================== */

function FriendCard({
  friend,
  rank,
  online,
  onRemove,
  nudgedEmoji,
  onNudge,
  commentSummary,
  onOpenComments,
}: {
  friend: Friend;
  rank: number;
  online?: { last_active_at: string };
  onRemove: () => void;
  nudgedEmoji?: string;
  onNudge: (emoji: string) => void;
  commentSummary?: FriendCommentSummaryRow;
  onOpenComments: () => void;
}) {
  const isOnline = !!online;
  const lastActive = online?.last_active_at ?? friend.last_active_at;
  const stars = Math.min(5, Math.floor(friend.streak_days / STAR_PER_DAYS));
  const goal = Math.max(friend.best_streak_days, STAR_PER_DAYS);
  const progress = Math.min(1, friend.streak_days / goal);
  const status = friendStatus(friend, friend.is_self);
  const canNudge = !friend.is_self;
  const nudgeEmojis = status.vibe === 'streak' ? REACTION_EMOJIS_CHEER : REACTION_EMOJIS_SUPPORT;

  return (
    <Pressable
      style={[styles.friendCard, rank === 1 && styles.friendCardTop]}
      onLongPress={friend.is_self ? undefined : onRemove}
      delayLongPress={350}>
      {/* ランク */}
      <View style={[styles.rankBadge, rank === 1 && styles.rankBadgeTop]}>
        {rank === 1 ? (
          <Text style={styles.rankStar}>{MonoGlyph.star}</Text>
        ) : (
          <Text style={styles.rankNum}>{rank}</Text>
        )}
      </View>

      {/* アバター＋オンライン発光 */}
      <Avatar
        uri={friend.avatar_url}
        emoji={friend.avatar_emoji}
        online={isOnline}
      />

      {/* 本文 */}
      <View style={styles.friendBody}>
        <View style={styles.nameRow}>
          <Text style={styles.friendName} numberOfLines={1}>
            {friend.username}
          </Text>
          {friend.is_self ? (
            <View style={styles.selfBadge}>
              <Text style={styles.selfBadgeText}>あなた</Text>
            </View>
          ) : isOnline ? (
            <View style={styles.onlineBadge}>
              <View style={styles.onlineDot} />
              <Text style={styles.onlineText}>Online</Text>
            </View>
          ) : (
            <Text style={styles.lastActive}>{formatRelative(lastActive)}</Text>
          )}
        </View>

        {/* 継続度に応じた見出し ＋ 今週の合計時間を横並びで */}
        <View style={styles.streakRow}>
          <Text style={styles.streakLine}>{status.headline}</Text>
          <Text style={styles.weekMinutesLine}>今週の筋トレ時間 {friend.week_minutes}分</Text>
        </View>

        {friend.streak_days > 0 && stars > 0 && (
          <Text style={styles.starRow}>
            {'★'.repeat(stars)}
            <Text style={styles.starMuted}>{'☆'.repeat(5 - stars)}</Text>
          </Text>
        )}

        <StreakBar progress={progress} highlight={rank === 1} />
        <Text
          style={[styles.barCaption, status.vibe === 'nudge' && styles.nudgeCaption]}>
          {status.caption}
        </Text>

        {canNudge && (
          <NudgeRow emojis={nudgeEmojis} sentEmoji={nudgedEmoji} onPick={onNudge} />
        )}

        <Pressable style={styles.commentPreview} onPress={onOpenComments} hitSlop={4}>
          <Feather name="message-circle" size={12} color={MonoColors.textMuted} />
          {commentSummary && commentSummary.comment_count > 0 ? (
            <Text style={styles.commentPreviewText} numberOfLines={1}>
              <Text style={styles.commentPreviewName}>{commentSummary.latest_from_name}</Text>
              {'：' + commentSummary.latest_body}
              {commentSummary.comment_count > 1 && (
                <Text style={styles.commentPreviewCount}>
                  {'　他' + (commentSummary.comment_count - 1) + '件'}
                </Text>
              )}
            </Text>
          ) : (
            <Text style={styles.commentPreviewText}>
              {friend.is_self ? 'まだコメントはありません' : 'ひと言コメントする'}
            </Text>
          )}
        </Pressable>
      </View>
    </Pressable>
  );
}

/* ============================================================
 * 応援ナッジ（運動記録が無いフレンドにも絵文字でリアクション）
 * ========================================================== */

function NudgeRow({
  emojis,
  sentEmoji,
  onPick,
}: {
  emojis: string[];
  sentEmoji?: string;
  onPick: (emoji: string) => void;
}) {
  if (sentEmoji) {
    return (
      <View style={styles.nudgeSentPill}>
        <Text style={styles.nudgeSentText}>{sentEmoji} 今日はもうリアクション済み</Text>
      </View>
    );
  }

  return (
    <View style={styles.nudgeRow}>
      {emojis.map((emoji) => (
        <Pressable
          key={emoji}
          style={styles.nudgeBtn}
          hitSlop={4}
          onPress={() => onPick(emoji)}>
          <Text style={styles.nudgeBtnText}>{emoji}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/* ============================================================
 * 継続度に応じた表示（見出し＋ひとこと＋トーン）
 * ========================================================== */

type FriendVibe = 'streak' | 'rest' | 'nudge' | 'fresh';

function friendStatus(
  f: Friend,
  isSelf: boolean,
): {
  headline: React.ReactNode;
  caption: string;
  vibe: FriendVibe;
} {
  const s = f.streak_days;
  const rest = f.rest_days;

  // --- 継続中 ---
  if (s > 0) {
    const gap = Math.max(0, f.best_streak_days - s);
    let caption: string;
    if (s >= f.best_streak_days) caption = '自己ベスト更新中！🎉';
    else if (gap <= 3) caption = `自己ベストまで あと ${gap}日`;
    else if (s === 1) caption = '継続1日目 ✨';
    else if (s <= 3) caption = 'いい調子！3日の壁を越えよう';
    else if (s <= 6) caption = '1週間までもう少し 💪';
    else if (s <= 13) caption = '習慣化ゾーン。えらい！';
    else if (s <= 29) caption = 'すごい継続力 ⭐️';
    else caption = '殿堂入り 👑';
    return {
      headline: (
        <>
          <Text style={styles.streakNum}>🔥{s}</Text>
          <Text style={styles.streakUnit}>日連続！</Text>
        </>
      ),
      caption,
      vibe: 'streak',
    };
  }

  // --- まだ記録なし ---
  if (rest == null) {
    return {
      headline: <Text style={styles.restText}>まだ記録がないみたい</Text>,
      caption: isSelf ? 'はじめてみよう 🌱' : 'いっしょに始めよ 🌱',
      vibe: 'fresh',
    };
  }

  // --- サボり中 ---
  let head: string;
  let caption: string;
  let vibe: FriendVibe = 'rest';
  if (rest <= 0) {
    head = '今日は動いた！えらい ✨';
    caption = 'この調子で継続してこ';
  } else if (rest <= 3) {
    head = `サボり${rest}日目`;
    caption = rest === 1 ? 'まだ取り戻せる！' : '筋トレ再開しない？ 🌱';
  } else if (rest <= 6) {
    head = `サボり${rest}日目`;
    caption = isSelf ? '今日動いてみる？ 📣' : '誘ってみよう！ 📣';
    vibe = 'nudge';
  } else if (rest <= 13) {
    head = '1週間お休み中 🍵';
    caption = isSelf ? '久しぶりに動いてみない？' : '久しぶりに声かけてみる？';
    vibe = 'nudge';
  } else if (rest <= 29) {
    head = `${rest}日ぶり…`;
    caption = isSelf ? 'また始めよう、いつでも' : 'また一緒にやれたらいいね';
  } else {
    head = 'しばらくお休み中';
    caption = 'いつでも戻ってこれるよ';
  }
  return {
    headline: <Text style={styles.restText}>{head}</Text>,
    caption,
    vibe,
  };
}

/* ============================================================
 * アバター（オンライン時はピンク/ゴールドに発光）
 * ========================================================== */

function Avatar({
  uri,
  emoji,
  online,
  size = 52,
}: {
  uri: string | null;
  emoji: string;
  online: boolean;
  size?: number;
}) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (online) {
      pulse.value = withRepeat(
        withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      );
    } else {
      pulse.value = withTiming(0, { duration: 200 });
    }
  }, [online, pulse]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.25 + (1 - pulse.value) * 0.5,
    transform: [{ scale: 1 + pulse.value * 0.35 }],
  }));

  return (
    <View style={{ width: size + 12, height: size + 12, alignItems: 'center', justifyContent: 'center' }}>
      {online && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glowRing,
            { width: size + 12, height: size + 12, borderRadius: (size + 12) / 2 },
            glowStyle,
          ]}
        />
      )}
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: size / 2 },
          online && styles.avatarOnline,
        ]}>
        {uri ? (
          <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
        ) : (
          <Text style={{ fontSize: size * 0.42 }}>{emoji}</Text>
        )}
      </View>
    </View>
  );
}

/* ============================================================
 * 継続プログレスバー（Reanimated）
 * ========================================================== */

function StreakBar({
  progress,
  highlight,
}: {
  progress: number;
  highlight?: boolean;
}) {
  const w = useSharedValue(0);

  useEffect(() => {
    w.value = withTiming(progress, { duration: 900, easing: Easing.out(Easing.cubic) });
  }, [progress, w]);

  const fillStyle = useAnimatedStyle(() => ({ flex: Math.max(0.001, w.value) }));
  const restStyle = useAnimatedStyle(() => ({ flex: Math.max(0.001, 1 - w.value) }));

  return (
    <View style={styles.barTrack}>
      <Animated.View
        style={[styles.barFill, highlight && styles.barFillTop, fillStyle]}
      />
      <Animated.View style={restStyle} />
    </View>
  );
}

/* ============================================================
 * 申請の行
 * ========================================================== */

function RequestRow({
  req,
  onAccept,
  onReject,
}: {
  req: FriendRequest;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <View style={styles.reqRow}>
      <Avatar uri={req.from_avatar_url} emoji={req.from_avatar_emoji} online={false} size={40} />
      <View style={styles.reqBody}>
        <Text style={styles.reqName}>{req.from_username}</Text>
        <Text style={styles.reqMeta}>{formatRelative(req.created_at)}・フレンド申請</Text>
      </View>
      <Pressable style={[styles.reqBtn, styles.reqReject]} onPress={onReject} hitSlop={6}>
        <Feather name="x" size={16} color={MonoColors.textSecondary} />
      </Pressable>
      <Pressable style={[styles.reqBtn, styles.reqAccept]} onPress={onAccept} hitSlop={6}>
        <Feather name="check" size={16} color={MonoColors.onInk} />
      </Pressable>
    </View>
  );
}

/* ============================================================
 * フレンド追加モーダル
 * ========================================================== */

function AddFriendModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [myCode, setMyCode] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    fetchMyFriendCode().then((c) => {
      if (alive) setMyCode(c);
    });
    return () => {
      alive = false;
    };
  }, [visible]);

  const close = () => {
    setCode('');
    setResult(null);
    setCopied(false);
    onClose();
  };

  const copyMyCode = async () => {
    if (!myCode) return;
    tapLight();
    await Clipboard.setStringAsync(myCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const submit = async () => {
    if (!code.trim() || sending) return;
    tapImpact();
    setSending(true);
    setResult(null);
    const res = await sendFriendRequest(code);
    setSending(false);
    if (res.ok) {
      notifySuccess();
      setResult('申請を送りました ✨');
      setCode('');
    } else {
      setResult(REASON_TEXT[res.reason]);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>フレンドを追加 {MonoGlyph.ribbon}</Text>
          <Text style={styles.sheetSub}>相手のフレンドコードを入力して申請します</Text>

          {/* 自分のコード（共有用） */}
          <Pressable style={styles.myCodeRow} onPress={copyMyCode}>
            <View style={styles.flex}>
              <Text style={styles.myCodeLabel}>あなたのフレンドコード</Text>
              <Text style={styles.myCodeValue}>{myCode || '—'}</Text>
            </View>
            <View style={styles.copyPill}>
              <Feather
                name={copied ? 'check' : 'copy'}
                size={13}
                color={MonoColors.accent}
              />
              <Text style={styles.copyPillText}>{copied ? 'コピー済み' : 'コピー'}</Text>
            </View>
          </Pressable>

          <View style={styles.searchRow}>
            <Feather name="search" size={18} color={MonoColors.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="例）ZBR-8A2K7X"
              placeholderTextColor={MonoColors.textMuted}
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              onSubmitEditing={submit}
              returnKeyType="send"
            />
          </View>

          {result && <Text style={styles.resultText}>{result}</Text>}

          <Pressable
            style={[styles.sendBtn, (sending || !code.trim()) && styles.sendBtnDisabled]}
            onPress={submit}
            disabled={sending || !code.trim()}>
            {sending ? (
              <ActivityIndicator color={MonoColors.onInk} size="small" />
            ) : (
              <>
                <Feather name="send" size={15} color={MonoColors.onInk} />
                <Text style={styles.sendBtnText}>申請を送る</Text>
              </>
            )}
          </Pressable>

          <Pressable onPress={close} hitSlop={8} style={styles.cancelLink}>
            <Text style={styles.cancelLinkText}>閉じる</Text>
          </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ============================================================
 * ひと言コメント モーダル（継続ランキングのフレンドカード用）
 * ========================================================== */

function CommentModal({
  friend,
  receivedNudges,
  onClose,
  onPosted,
}: {
  friend: Friend | null;
  /** 自分のカードの時だけ、上部に横一列で表示する */
  receivedNudges: ReceivedNudgeRow[];
  onClose: () => void;
  onPosted: () => void;
}) {
  const { session } = useAuthSession();
  const myUserId = session?.user?.id;

  const [comments, setComments] = useState<FriendCommentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const targetId = friend?.user_id ?? null;

  useEffect(() => {
    if (!targetId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const rows = await getFriendComments(targetId);
        if (alive) setComments(rows);
      } catch (e) {
        console.warn('[friends] コメント取得に失敗しました', e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [targetId]);

  const close = () => {
    setBody('');
    setComments([]);
    onClose();
  };

  const submit = async () => {
    if (!targetId || !body.trim() || sending) return;
    tapImpact();
    setSending(true);
    const res = await addFriendComment(targetId, body);
    setSending(false);
    if (res.ok) {
      setBody('');
      notifySuccess();
      try {
        setComments(await getFriendComments(targetId));
      } catch (e) {
        console.warn('[friends] コメント再取得に失敗しました', e);
      }
      onPosted();
    } else {
      Alert.alert('送れませんでした', 'もう一度お試しください');
    }
  };

  const handleDelete = (commentId: string) => {
    Alert.alert('コメントを削除', 'このコメントを削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除する',
        style: 'destructive',
        onPress: async () => {
          tapImpact();
          const prev = comments;
          setComments((cur) => cur.filter((c) => c.comment_id !== commentId));
          try {
            await deleteFriendComment(commentId);
            onPosted();
          } catch (e) {
            console.warn('[friends] コメント削除に失敗しました', e);
            setComments(prev);
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={!!friend} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable
            style={[styles.sheet, styles.commentSheet]}
            onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {friend?.is_self ? 'あなたへのコメント' : `${friend?.username}さんへのコメント`}
            </Text>
            <Text style={styles.sheetSub}>
              {friend?.is_self
                ? 'フレンドからもらった、ひと言の応援メモです（24時間で自動的に消えます）'
                : 'フレンドだけに見える、ひと言の応援メモです（24時間で自動的に消えます）'}
            </Text>

            {friend?.is_self && (
              <>
                <Text style={styles.reactionRowLabel}>もらったリアクション</Text>
                {receivedNudges.length === 0 ? (
                  <Text style={styles.commentEmpty}>まだリアクションはありません</Text>
                ) : (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.reactionRow}>
                    {receivedNudges.map((n, i) => (
                      <View key={`${n.from_user_id}-${n.created_at}-${i}`} style={styles.reactionChip}>
                        <Text style={styles.reactionChipEmoji}>{n.emoji}</Text>
                        <Text style={styles.reactionChipName} numberOfLines={1}>
                          {n.from_name ?? 'ゲスト'}
                        </Text>
                      </View>
                    ))}
                  </ScrollView>
                )}
                <View style={styles.reactionDivider} />
              </>
            )}

            <ScrollView style={styles.commentList} contentContainerStyle={{ gap: 12 }}>
              {loading ? (
                <ActivityIndicator color={MonoColors.ink} />
              ) : comments.length === 0 ? (
                <Text style={styles.commentEmpty}>まだコメントがありません</Text>
              ) : (
                comments.map((c) => (
                  <View key={c.comment_id} style={styles.commentRow}>
                    <Avatar
                      uri={c.from_avatar_url}
                      emoji={c.from_avatar_emoji ?? '✦'}
                      online={false}
                      size={30}
                    />
                    <View style={styles.flex}>
                      <Text style={styles.commentRowName}>{c.from_name ?? 'ゲスト'}</Text>
                      <Text style={styles.commentRowBody}>{c.body}</Text>
                      <Text style={styles.commentRowTime}>{formatRelative(c.created_at)}</Text>
                    </View>
                    {(c.from_user_id === myUserId || friend?.is_self) && (
                      <Pressable
                        hitSlop={8}
                        onPress={() => handleDelete(c.comment_id)}
                        style={styles.commentDeleteBtn}>
                        <Feather name="trash-2" size={14} color={MonoColors.textMuted} />
                      </Pressable>
                    )}
                  </View>
                ))
              )}
            </ScrollView>

            {!friend?.is_self && (
              <View style={styles.commentInputRow}>
                <TextInput
                  style={styles.commentInput}
                  placeholder="今日のひと言を送る"
                  placeholderTextColor={MonoColors.textMuted}
                  value={body}
                  onChangeText={setBody}
                  maxLength={200}
                  onSubmitEditing={submit}
                  returnKeyType="send"
                />
                <Pressable
                  style={[styles.commentSendBtn, (sending || !body.trim()) && styles.sendBtnDisabled]}
                  onPress={submit}
                  disabled={sending || !body.trim()}>
                  {sending ? (
                    <ActivityIndicator color={MonoColors.onInk} size="small" />
                  ) : (
                    <Feather name="send" size={15} color={MonoColors.onInk} />
                  )}
                </Pressable>
              </View>
            )}

            <Pressable onPress={close} hitSlop={8} style={styles.cancelLink}>
              <Text style={styles.cancelLinkText}>閉じる</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ============================================================
 * もらったリアクション一覧モーダル（自分のカード用・閲覧のみ）
 * ========================================================== */

/* ============================================================
 * ヘルパー
 * ========================================================== */

const REASON_TEXT: Record<string, string> = {
  not_found: 'そのフレンドコードのユーザーが見つかりませんでした',
  already_friend: 'すでにフレンドです ✨',
  already_requested: 'すでに申請済みです',
  self: '自分のコードです',
  unknown: 'うまくいきませんでした。もう一度お試しください',
};

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  return `${day}日前`;
}

/* ============================================================
 * スタイル
 * ========================================================== */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: MonoColors.screenBg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: MonoLayout.screenPadding, paddingBottom: 48 },

  /* 未ログイン時のゲート */
  gate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: MonoLayout.screenPadding,
    paddingBottom: 64,
  },
  gateGlyph: { fontSize: 28, color: MonoColors.textMuted, marginBottom: 16 },
  gateTitle: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 1,
    color: MonoColors.ink,
  },
  gateSub: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    color: MonoColors.textSecondary,
  },
  gateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 28,
    paddingHorizontal: 24,
    height: 52,
    backgroundColor: MonoColors.ink,
    borderRadius: MonoLayout.radiusControl,
  },
  gateBtnText: {
    color: MonoColors.onInk,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },

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

  summaryLine: {
    fontSize: 12,
    color: MonoColors.textSecondary,
    marginTop: 4,
    marginBottom: 20,
  },

  section: { marginBottom: 24 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionHint: {
    fontSize: 10,
    color: MonoColors.textMuted,
    marginRight: 4,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    color: MonoColors.textSecondary,
    marginBottom: 12,
    marginLeft: 4,
  },
  countPill: {
    color: MonoColors.accent,
    fontWeight: '700',
  },

  card: {
    backgroundColor: MonoColors.surface,
    borderRadius: MonoLayout.radiusCard,
    borderWidth: 1,
    borderColor: MonoColors.border,
    paddingHorizontal: 14,
  },
  hair: { height: 1, backgroundColor: MonoColors.border, marginLeft: 52 },

  /* フレンドカード */
  friendCard: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: MonoColors.surface,
    borderRadius: MonoLayout.radiusCard,
    borderWidth: 1,
    borderColor: MonoColors.border,
    padding: 14,
  },
  friendCardTop: {
    borderColor: MonoColors.ink,
  },
  rankBadge: {
    position: 'absolute',
    top: -8,
    left: -8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: MonoColors.surface,
    borderWidth: 1,
    borderColor: MonoColors.border,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  rankBadgeTop: {
    backgroundColor: MonoColors.ink,
    borderColor: MonoColors.ink,
  },
  rankNum: { fontSize: 11, fontWeight: '700', color: MonoColors.textSecondary },
  rankStar: { fontSize: 11, color: MonoColors.onInk },

  friendBody: { flex: 1, gap: 4 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  friendName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: MonoColors.ink,
  },
  onlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: MonoColors.accentTint,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: MonoLayout.radiusPill,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#3Fae7f',
  },
  onlineText: {
    fontSize: 10,
    fontWeight: '700',
    color: MonoColors.accent,
    letterSpacing: 0.5,
  },
  lastActive: { fontSize: 11, color: MonoColors.textMuted },
  selfBadge: {
    backgroundColor: MonoColors.surfaceAlt,
    borderWidth: 1,
    borderColor: MonoColors.border,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: MonoLayout.radiusPill,
    flex: 0,
  },
  selfBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: MonoColors.inkSoft,
    letterSpacing: 0.5,
  },

  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 2,
  },
  streakLine: {},
  streakNum: { fontSize: 15, fontWeight: '800', color: MonoColors.ink },
  streakUnit: { fontSize: 12, fontWeight: '600', color: MonoColors.inkSoft },
  restText: { fontSize: 12, fontWeight: '600', color: MonoColors.textSecondary },
  weekMinutesLine: { fontSize: 11, color: MonoColors.textMuted },

  starRow: { fontSize: 11, color: MonoColors.accent, letterSpacing: 2 },
  starMuted: { color: MonoColors.border },

  barTrack: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    backgroundColor: MonoColors.surfaceAlt,
    overflow: 'hidden',
    marginTop: 6,
  },
  barFill: {
    backgroundColor: MonoColors.inkSoft,
    borderRadius: 3,
  },
  barFillTop: { backgroundColor: GLOW_GOLD },
  barCaption: { fontSize: 10, color: MonoColors.textMuted, marginTop: 4 },
  nudgeCaption: { color: MonoColors.accent, fontWeight: '700' },

  /* 応援ナッジ */
  nudgeRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  nudgeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MonoColors.surfaceAlt,
    borderWidth: 1,
    borderColor: MonoColors.border,
  },
  nudgeBtnText: { fontSize: 14 },
  nudgeSentPill: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: MonoLayout.radiusPill,
    backgroundColor: MonoColors.accentTint,
  },
  nudgeSentText: { fontSize: 11, fontWeight: '700', color: MonoColors.accent },

  /* ひと言コメント */
  commentPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  commentPreviewText: {
    flex: 1,
    fontSize: 11,
    color: MonoColors.textSecondary,
  },
  commentPreviewName: { fontWeight: '700', color: MonoColors.inkSoft },
  commentPreviewCount: { color: MonoColors.textMuted },

  commentSheet: { maxHeight: '80%' },

  reactionRowLabel: {
    alignSelf: 'stretch',
    fontSize: 11,
    fontWeight: '700',
    color: MonoColors.textMuted,
    letterSpacing: 0.5,
    marginTop: 4,
  },
  reactionRow: { gap: 8, paddingVertical: 8 },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: MonoColors.surface,
    borderWidth: 1,
    borderColor: MonoColors.border,
    borderRadius: MonoLayout.radiusPill,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  reactionChipEmoji: { fontSize: 13 },
  reactionChipName: { fontSize: 11, fontWeight: '700', color: MonoColors.inkSoft, maxWidth: 90 },
  reactionDivider: { alignSelf: 'stretch', height: 1, backgroundColor: MonoColors.border, marginTop: 4 },

  commentList: { alignSelf: 'stretch', maxHeight: 280, marginTop: 4 },
  commentEmpty: {
    fontSize: 12,
    color: MonoColors.textMuted,
    textAlign: 'center',
    paddingVertical: 24,
  },
  commentRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  commentDeleteBtn: { padding: 4 },
  commentRowName: { fontSize: 12, fontWeight: '700', color: MonoColors.ink },
  commentRowBody: { fontSize: 13, color: MonoColors.inkSoft, marginTop: 2, lineHeight: 18 },
  commentRowTime: { fontSize: 10, color: MonoColors.textMuted, marginTop: 2 },
  commentInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
    marginTop: 14,
  },
  commentInput: {
    flex: 1,
    fontSize: 13,
    color: MonoColors.ink,
    backgroundColor: MonoColors.surfaceAlt,
    borderWidth: 1,
    borderColor: MonoColors.border,
    borderRadius: MonoLayout.radiusControl,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  commentSendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MonoColors.ink,
  },

  /* アバター */
  glowRing: {
    position: 'absolute',
    borderWidth: 2.5,
    borderColor: GLOW_PINK,
    shadowColor: GLOW_GOLD,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: MonoColors.surfaceAlt,
    borderWidth: 1,
    borderColor: MonoColors.border,
  },
  avatarOnline: { borderColor: GLOW_PINK },

  /* 申請行 */
  reqRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  reqBody: { flex: 1 },
  reqName: { fontSize: 14, fontWeight: '700', color: MonoColors.ink },
  reqMeta: { fontSize: 11, color: MonoColors.textMuted, marginTop: 2 },
  reqBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reqReject: { borderWidth: 1, borderColor: MonoColors.border, backgroundColor: MonoColors.surface },
  reqAccept: { backgroundColor: MonoColors.ink },

  footNote: {
    marginTop: 8,
    textAlign: 'center',
    fontSize: 12,
    letterSpacing: 1,
    color: MonoColors.textMuted,
  },

  /* モーダル */
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(26,26,26,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: MonoColors.screenBg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 36,
    alignItems: 'center',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: MonoColors.border,
    marginBottom: 20,
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: MonoColors.ink },
  sheetSub: {
    fontSize: 12,
    color: MonoColors.textSecondary,
    marginTop: 6,
    marginBottom: 16,
  },

  flex: { flex: 1 },
  myCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
    backgroundColor: MonoColors.accentTint,
    borderRadius: MonoLayout.radiusControl,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  myCodeLabel: { fontSize: 10, fontWeight: '600', color: MonoColors.accent },
  myCodeValue: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 2,
    color: MonoColors.ink,
    marginTop: 3,
  },
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: MonoColors.surface,
    borderRadius: MonoLayout.radiusPill,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  copyPillText: { fontSize: 11, fontWeight: '700', color: MonoColors.accent },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
    backgroundColor: MonoColors.surface,
    borderWidth: 1,
    borderColor: MonoColors.border,
    borderRadius: MonoLayout.radiusControl,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  searchInput: { flex: 1, fontSize: 15, color: MonoColors.ink, paddingVertical: 12 },
  resultText: {
    alignSelf: 'flex-start',
    marginTop: 12,
    fontSize: 12,
    fontWeight: '600',
    color: MonoColors.inkSoft,
  },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'stretch',
    backgroundColor: MonoColors.ink,
    borderRadius: MonoLayout.radiusControl,
    height: 52,
    marginTop: 20,
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { color: MonoColors.onInk, fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  cancelLink: { marginTop: 14 },
  cancelLinkText: { fontSize: 13, color: MonoColors.textSecondary, fontWeight: '600' },
});
