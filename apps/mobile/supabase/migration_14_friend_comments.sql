-- =====================================================================
--  マイグレーション #14 — 継続ランキングのフレンドカードへの「ひと言コメント」
-- ---------------------------------------------------------------------
--  friend_posts向けcomments（migration_13）とは別物。
--  対象は「投稿」ではなく「フレンド本人（のランキングカード）」。
--  friend_nudges（絵文字のみ・1日1回）の文章版だが、こちらは回数制限なし。
--
--  公開範囲（重要）: コメント(from_user_id=A が to_user_id=B のカードに投稿)が
--  見えるのは「A本人」「B本人」「AともBとも両方acceptedなフレンドの人」だけ。
--  「Bのフレンドというだけ（Aのフレンドではない人）」には見せない。
--  = 投稿者Aを基準にせず、A・B両方との関係で可視性を決める。
--
--  有効期限: 投稿から24時間を過ぎたコメントは誰からも見えなくなる
--  （RLS・RPCの両方で created_at > now() - 24h を条件に含める）。
--  実データも pg_cron で1時間おきに物理削除する（cronが使えない環境でも、
--  上記のフィルタにより見え方としては24時間で消えたのと同じになる）。
--
--  削除: 送信者本人 or カードの本人（宛先）が delete_friend_comment で削除可。
--
--  追加テーブル: friend_comments (from_user_id, to_user_id, body, created_at)
--  追加RPC:
--    add_friend_comment(p_to_user_id, p_body)
--    delete_friend_comment(p_comment_id)
--    get_friend_comments(p_to_user_id, p_limit default 30) … 1人ぶんの全文一覧（24h以内のみ）
--    get_friend_comment_summary(p_to_user_ids uuid[])      … 一覧画面用（件数＋最新1件、24h以内のみ）
--
--  schema.sql 実行済みの環境で、この差分だけ SQL Editor で Run。
--  何度実行しても安全。
-- =====================================================================

-- A・Bが互いにacceptedなフレンドか（順不同）
create or replace function public.is_accepted_friend(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.user_id_a = a and f.user_id_b = b) or (f.user_id_b = a and f.user_id_a = b))
  )
$$;

revoke all on function public.is_accepted_friend(uuid, uuid) from public, anon;
grant execute on function public.is_accepted_friend(uuid, uuid) to authenticated;

-- このコメントを見ていいか（投稿者p_from・カード本人p_to の両方との関係で判定）
create or replace function public.can_view_friend_comment(p_from uuid, p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() = p_from
      or auth.uid() = p_to
      or (public.is_accepted_friend(auth.uid(), p_from) and public.is_accepted_friend(auth.uid(), p_to))
$$;

revoke all on function public.can_view_friend_comment(uuid, uuid) from public, anon;
grant execute on function public.can_view_friend_comment(uuid, uuid) to authenticated;

create table if not exists public.friend_comments (
  id           uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.users(id) on delete cascade,
  to_user_id   uuid not null references public.users(id) on delete cascade,
  body         text not null check (char_length(trim(body)) between 1 and 200),
  created_at   timestamptz not null default now(),
  constraint friend_comments_no_self check (from_user_id <> to_user_id)
);
create index if not exists friend_comments_to_created
  on public.friend_comments (to_user_id, created_at desc);

alter table public.friend_comments enable row level security;

drop policy if exists friend_comments_select on public.friend_comments;
drop policy if exists friend_comments_insert on public.friend_comments;
drop policy if exists friend_comments_delete on public.friend_comments;

-- A(投稿者)・B(カード本人)の両方とacceptedなフレンドの人だけ読める（本人同士は常にOK）。
-- 投稿から24時間を過ぎたものは誰からも見えない
create policy friend_comments_select on public.friend_comments
  for select using (
    created_at > now() - interval '24 hours'
    and public.can_view_friend_comment(from_user_id, to_user_id)
  );

-- 投稿はRPC（security definer）経由のみ。直接insertはさせない運用にする
-- （自分宛てには書けない／可視範囲の相手にしか書けない、をDB側でも保証するため）

drop policy if exists friend_comments_delete_own on public.friend_comments;
create policy friend_comments_delete_own on public.friend_comments
  for delete using (from_user_id = auth.uid() or to_user_id = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.friend_comments;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------

drop function if exists public.add_friend_comment(uuid, text);
create function public.add_friend_comment(p_to_user_id uuid, p_body text)
returns public.friend_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.friend_comments;
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_to_user_id = v_me then raise exception 'CANNOT_COMMENT_SELF'; end if;
  if p_body is null or char_length(trim(p_body)) = 0 then raise exception 'BODY_REQUIRED'; end if;
  if char_length(trim(p_body)) > 200 then raise exception 'BODY_TOO_LONG'; end if;
  if not public.can_view_user_posts(p_to_user_id) then raise exception 'NOT_FRIENDS'; end if;

  insert into public.friend_comments (from_user_id, to_user_id, body)
  values (v_me, p_to_user_id, trim(p_body))
  returning * into v_row;
  return v_row;
end;
$$;

drop function if exists public.delete_friend_comment(uuid);
create function public.delete_friend_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  delete from public.friend_comments
  where id = p_comment_id and (from_user_id = v_me or to_user_id = v_me);
  if not found then raise exception 'COMMENT_NOT_FOUND'; end if;
end;
$$;

-- 1人ぶんの全文一覧（新しい順）。投稿者ごとに可視性が変わるので1行ずつ判定する
drop function if exists public.get_friend_comments(uuid, int);
create function public.get_friend_comments(p_to_user_id uuid, p_limit int default 30)
returns table (
  comment_id   uuid,
  from_user_id uuid,
  from_name    text,
  from_avatar_url text,
  from_avatar_emoji text,
  body         text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.from_user_id, u.name, u.avatar_url, u.avatar_emoji, c.body, c.created_at
  from public.friend_comments c
  join public.users u on u.id = c.from_user_id
  where c.to_user_id = p_to_user_id
    and c.created_at > now() - interval '24 hours'
    and public.can_view_friend_comment(c.from_user_id, c.to_user_id)
  order by c.created_at desc
  limit greatest(1, coalesce(p_limit, 30));
$$;

-- 一覧画面用（複数フレンド分の件数＋最新1件をまとめて取得）。
-- 件数・最新1件は「自分が実際に見られるコメントだけ」で集計する
drop function if exists public.get_friend_comment_summary(uuid[]);
create function public.get_friend_comment_summary(p_to_user_ids uuid[])
returns table (
  to_user_id   uuid,
  comment_count int,
  latest_body  text,
  latest_from_name text,
  latest_created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with visible_comments as (
    select c.*
    from public.friend_comments c
    where c.to_user_id = any(p_to_user_ids)
      and c.created_at > now() - interval '24 hours'
      and public.can_view_friend_comment(c.from_user_id, c.to_user_id)
  ),
  latest as (
    select distinct on (vc.to_user_id)
      vc.to_user_id, vc.body, u.name as from_name, vc.created_at
    from visible_comments vc
    join public.users u on u.id = vc.from_user_id
    order by vc.to_user_id, vc.created_at desc
  )
  select
    t.uid,
    coalesce((select count(*)::int from visible_comments vc2 where vc2.to_user_id = t.uid), 0),
    l.body,
    l.from_name,
    l.created_at
  from unnest(p_to_user_ids) as t(uid)
  left join latest l on l.to_user_id = t.uid;
$$;

revoke all on function public.add_friend_comment(uuid, text)      from public, anon;
revoke all on function public.delete_friend_comment(uuid)         from public, anon;
revoke all on function public.get_friend_comments(uuid, int)      from public, anon;
revoke all on function public.get_friend_comment_summary(uuid[])  from public, anon;

grant execute on function public.add_friend_comment(uuid, text)      to authenticated;
grant execute on function public.delete_friend_comment(uuid)         to authenticated;
grant execute on function public.get_friend_comments(uuid, int)      to authenticated;
grant execute on function public.get_friend_comment_summary(uuid[])  to authenticated;

-- ---------------------------------------------------------------------
-- 24時間を過ぎたコメントの物理削除（1時間おき、pg_cron）
-- ---------------------------------------------------------------------
-- 上のRLS/RPCのフィルタだけで「24時間経ったら誰にも見えない」は既に保証済み。
-- これは行としてテーブルに残り続けないよう、実データを定期的に掃除するための
-- おまけ。pg_cronが有効化できない環境でもアプリの見え方には影響しない。
create or replace function public.purge_expired_friend_comments()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.friend_comments where created_at <= now() - interval '24 hours';
$$;

revoke all on function public.purge_expired_friend_comments() from public, anon, authenticated;

do $$ begin
  create extension if not exists pg_cron;
exception when insufficient_privilege then
  raise notice 'pg_cron を自動作成できませんでした。Supabaseダッシュボード > Database > Extensions で pg_cron を有効化してから、このファイルをもう一度実行してください（有効化するまでは物理削除だけ遅延し、見え方の24時間制限には影響しません）。';
end $$;

do $$ begin
  perform cron.unschedule('purge_expired_friend_comments_hourly');
exception when others then null; end $$;

do $$ begin
  perform cron.schedule(
    'purge_expired_friend_comments_hourly',
    '0 * * * *',
    $cron$select public.purge_expired_friend_comments();$cron$
  );
exception when others then
  raise notice 'pg_cronのスケジュール登録に失敗しました（拡張が未有効化の可能性）。上記と同じく、見え方には影響しません。';
end $$;
