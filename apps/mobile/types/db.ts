/**
 * Supabase の実テーブル / RPC に対応する型（supabase/schema.sql と一致）
 * 既存スキーマ: users / friendships(user_id_a,b) / workout_logs
 */

/** 'HH:MM:SS' 形式（Postgres time without time zone） */
export type TimeString = string;
export type FriendshipStatus = 'pending' | 'accepted' | 'rejected';

/** public.users */
export type AppUser = {
  id: string;
  name: string | null;
  avatar_url: string | null;
  /** 画像未設定時のフォールバック絵文字（フレンドからも見える） */
  avatar_emoji: string;
  /** フレンド申請に使う固有コード（例: ZBR-8A2K7X） */
  friend_code: string | null;
  preferred_time_of_day: TimeString;
  notification_enabled: boolean;
  is_online: boolean;
  last_seen: string;
  created_at: string;
  updated_at: string;
};

/** public.friendships */
export type Friendship = {
  id: string;
  user_id_a: string; // 申請者
  user_id_b: string; // 相手
  status: FriendshipStatus;
  created_at: string;
  updated_at: string;
};

/** RPC: get_friends_with_status() の1行 */
export type FriendWithStatus = {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  is_online: boolean;
  last_seen: string;
  streak_days: number;
  /** 最終実施日からの経過日数。記録が無ければ null */
  rest_days: number | null;
  best_streak_days: number;
  /** 今週（JST月曜始まり）の筋トレ合計時間（分） */
  week_minutes: number;
  friends_since: string;
  /** true なら呼び出し本人の行（フレンドではなく自分自身） */
  is_self: boolean;
};

/** RPC: get_incoming_friend_requests() の1行 */
export type IncomingRequestRow = {
  request_id: string;
  from_user_id: string;
  from_name: string | null;
  from_avatar_url: string | null;
  created_at: string;
};

/** public.friend_posts（既存テーブル。今日の筋トレ投稿） */
export type FriendPost = {
  id: string;
  user_id: string;
  menu: string;
  reps: number | null;
  sets: number | null;
  workout_seconds: number | null;
  comment: string | null;
  photo_url: string | null;
  posted_at: string;
};

/** public.reactions（既存テーブル。type は絵文字文字列） */
export type Reaction = {
  id: string;
  post_id: string;
  user_id: string;
  type: string;
  created_at: string;
};

/** public.comments（friend_posts向けコメント） */
export type PostComment = {
  id: string;
  post_id: string;
  user_id: string;
  body: string;
  created_at: string;
};

/** RPC: get_post_social(post_ids) の1行。1 post_id につき type の種類数ぶん返る */
export type PostSocialRow = {
  post_id: string;
  /** 投稿に反応が無ければ null */
  reaction_type: string | null;
  reaction_count: number;
  my_reacted: boolean;
  comment_count: number;
};

/** RPC: get_post_comments(post_id) の1行（投稿者情報付き） */
export type PostCommentRow = {
  comment_id: string;
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  body: string;
  created_at: string;
};

/** public.friend_nudges（運動記録が無いフレンドへの応援） */
export type FriendNudge = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  emoji: string;
  created_at: string;
};

/** RPC: get_my_nudges_sent_today() の1行 */
export type NudgeSentTodayRow = {
  to_user_id: string;
  emoji: string;
};

/** RPC: get_my_received_nudges() の1行（自分が受け取ったリアクション、新しい順） */
export type ReceivedNudgeRow = {
  from_user_id: string;
  from_name: string | null;
  from_avatar_url: string | null;
  from_avatar_emoji: string | null;
  emoji: string;
  created_at: string;
};

/** send_friend_nudge() の失敗理由 */
export type SendNudgeResult =
  | { ok: true }
  | { ok: false; reason: 'not_friends' | 'self' | 'already_nudged_today' | 'unknown' };

/** public.friend_comments（継続ランキングのフレンドカードへの「ひと言コメント」） */
export type FriendComment = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  body: string;
  created_at: string;
};

/** RPC: get_friend_comments(to_user_id) の1行（投稿者情報付き・新しい順） */
export type FriendCommentRow = {
  comment_id: string;
  from_user_id: string;
  from_name: string | null;
  from_avatar_url: string | null;
  from_avatar_emoji: string | null;
  body: string;
  created_at: string;
};

/** RPC: get_friend_comment_summary(to_user_ids) の1行（一覧画面用） */
export type FriendCommentSummaryRow = {
  to_user_id: string;
  comment_count: number;
  latest_body: string | null;
  latest_from_name: string | null;
  latest_created_at: string | null;
};

/** add_friend_comment() の失敗理由 */
export type AddFriendCommentResult =
  | { ok: true }
  | { ok: false; reason: 'not_friends' | 'self' | 'empty' | 'too_long' | 'unknown' };
