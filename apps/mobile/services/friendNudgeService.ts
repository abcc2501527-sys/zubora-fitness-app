/**
 * 運動していないフレンドへの「応援ナッジ」データ層
 * =====================================================================
 * workout_logs とは無関係に、フレンド本人へ直接絵文字を送る（😭📣💪👋など）。
 * スパム防止で同じ相手には1日1回まで（supabase/migration_12_friend_nudges.sql）。
 *
 *   sendFriendNudge(toUserId, emoji) … 送信＋Push通知
 *   getMyNudgesSentToday()           … 今日もう送った相手（ボタンのdisabled判定用）
 *   getMyReceivedNudges()            … 自分が受け取ったリアクション一覧（新しい順）
 * =====================================================================
 */

import { supabase } from '@/supabase';
import { sendPushNotification } from '@/services/notificationService';
import type { NudgeSentTodayRow, ReceivedNudgeRow, SendNudgeResult } from '@/types/db';

/** 今日すでに送った相手一覧。UIでボタンを送信済み表示に切り替えるために使う */
export async function getMyNudgesSentToday(): Promise<NudgeSentTodayRow[]> {
  const { data, error } = await supabase.rpc('get_my_nudges_sent_today');
  if (error) throw error;
  return (data ?? []) as NudgeSentTodayRow[];
}

/** 自分が受け取ったリアクション一覧（新しい順）。自分のカードのプレビュー表示に使う */
export async function getMyReceivedNudges(): Promise<ReceivedNudgeRow[]> {
  const { data, error } = await supabase.rpc('get_my_received_nudges', { p_limit: 20 });
  if (error) throw error;
  return (data ?? []) as ReceivedNudgeRow[];
}

/** 応援ナッジを送る（フレンド限定・1日1回まで）。送れたらPush通知も送る */
export async function sendFriendNudge(
  toUserId: string,
  emoji: string,
): Promise<SendNudgeResult> {
  const { error } = await supabase.rpc('send_friend_nudge', {
    p_to_user_id: toUserId,
    p_emoji: emoji,
  });

  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('NOT_FRIENDS')) return { ok: false, reason: 'not_friends' };
    if (msg.includes('CANNOT_NUDGE_SELF')) return { ok: false, reason: 'self' };
    if (msg.includes('ALREADY_NUDGED_TODAY')) return { ok: false, reason: 'already_nudged_today' };
    return { ok: false, reason: 'unknown' };
  }

  void notifyNudgeTarget(toUserId, emoji);
  return { ok: true };
}

async function notifyNudgeTarget(toUserId: string, emoji: string): Promise<void> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const myUserId = auth.user?.id;
    if (!myUserId) return;

    const [{ data: myProfile }, { data: targetProfile }] = await Promise.all([
      supabase.from('users').select('name').eq('id', myUserId).single(),
      supabase.from('users').select('push_token').eq('id', toUserId).single(),
    ]);

    const pushToken = targetProfile?.push_token as string | undefined;
    if (!pushToken) return;

    const myName = myProfile?.name ?? '誰か';
    await sendPushNotification(
      pushToken,
      `${emoji} 応援が届きました`,
      `${myName}さんが${emoji}で応援しています`,
    );
  } catch (err) {
    console.error('[friendNudgeService] Push notification trigger error:', err);
  }
}
