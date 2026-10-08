-- =====================================================================
--  まだ未実行の3マイグレーションをまとめた「これ1本だけ実行すればOK」版
-- ---------------------------------------------------------------------
--  中身は migration_13_friend_post_social.sql → migration_12_friend_nudges.sql
--  → migration_14_friend_comments.sql を依存関係が壊れない順番で連結した
--  だけで、内容は変えていません（individual filesはそのまま残してあります）。
--
--  実行順が重要な理由:
--    migration_14（friend_comments）が migration_13 で定義する
--    public.can_view_user_posts() 関数を使うため、13を先に実行する必要がある。
--
--  前提: supabase/schema.sql（またはこれまでのmigration_01〜10）は
--  実行済みで、users / friendships / workout_logs / friend_posts / reactions
--  が存在していること。
--
--  何度実行しても安全（drop/create・if not existsで差分適用）。
--  このファイルの内容は supabase/schema.sql にも統合済みです。
-- =====================================================================


-- #####################################################################
-- ##  13. friend_posts への「リアクション」「コメント」
-- #####################################################################

-- --- 0. 可視判定ヘルパー（自分 or acceptedなフレンド） -----------------
create or replace function public.can_view_user_posts(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_owner = auth.uid() or exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.user_id_a = auth.uid() and f.user_id_b = p_owner)
        or (f.user_id_b = auth.uid() and f.user_id_a = p_owner))
  )
$$;

revoke all on function public.can_view_user_posts(uuid) from public, anon;
grant execute on function public.can_view_user_posts(uuid) to authenticated;

-- --- 1. friend_posts の RLS（既存テーブル。今はポリシー0件で全閉鎖状態） ---
alter table public.friend_posts enable row level security;

drop policy if exists friend_posts_select on public.friend_posts;
drop policy if exists friend_posts_insert on public.friend_posts;
drop policy if exists friend_posts_update on public.friend_posts;
drop policy if exists friend_posts_delete on public.friend_posts;

create policy friend_posts_select on public.friend_posts
  for select using (public.can_view_user_posts(user_id));
create policy friend_posts_insert on public.friend_posts
  for insert with check (user_id = auth.uid());
create policy friend_posts_update on public.friend_posts
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy friend_posts_delete on public.friend_posts
  for delete using (user_id = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.friend_posts;
exception when duplicate_object then null; end $$;

-- --- 2. reactions（既存）。作り直さず、重複防止の制約だけ追加 -----------
create table if not exists public.reactions (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.friend_posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null,
  created_at timestamptz not null default now()
);

alter table public.reactions enable row level security;

drop policy if exists "Allow authenticated users to read reactions" on public.reactions;
create policy "Allow authenticated users to read reactions" on public.reactions
  for select using (true);

drop policy if exists "Allow users to insert their own reactions" on public.reactions;
create policy "Allow users to insert their own reactions" on public.reactions
  for insert with check (auth.uid() = user_id);

drop policy if exists "Allow users to delete their own reactions" on public.reactions;
create policy "Allow users to delete their own reactions" on public.reactions
  for delete using (auth.uid() = user_id);

create index if not exists reactions_post on public.reactions (post_id);

delete from public.reactions r
using public.reactions r2
where r.post_id = r2.post_id
  and r.user_id = r2.user_id
  and r.type = r2.type
  and r.id > r2.id;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'reactions_unique_user_type' and conrelid = 'public.reactions'::regclass
  ) then
    alter table public.reactions
      add constraint reactions_unique_user_type unique (post_id, user_id, type);
  end if;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.reactions;
exception when duplicate_object then null; end $$;

-- --- 3. comments（新規） -----------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.friend_posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(trim(body)) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_created on public.comments (post_id, created_at);

alter table public.comments enable row level security;

drop policy if exists comments_select on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_delete on public.comments;

create policy comments_select on public.comments
  for select using (exists (
    select 1 from public.friend_posts p
    where p.id = comments.post_id and public.can_view_user_posts(p.user_id)
  ));
create policy comments_insert on public.comments
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.friend_posts p
      where p.id = comments.post_id and public.can_view_user_posts(p.user_id)
    )
  );
create policy comments_delete on public.comments
  for delete using (
    user_id = auth.uid()
    or exists (select 1 from public.friend_posts p where p.id = comments.post_id and p.user_id = auth.uid())
  );

do $$ begin
  alter publication supabase_realtime add table public.comments;
exception when duplicate_object then null; end $$;

-- --- 4. RPC -------------------------------------------------------------
drop function if exists public.toggle_post_reaction(uuid, text);
create function public.toggle_post_reaction(p_post_id uuid, p_type text)
returns table (removed boolean, type text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_type is null or trim(p_type) = '' then raise exception 'TYPE_REQUIRED'; end if;

  select user_id into v_owner from public.friend_posts where id = p_post_id;
  if v_owner is null then raise exception 'POST_NOT_FOUND'; end if;
  if not public.can_view_user_posts(v_owner) then raise exception 'FORBIDDEN'; end if;

  if exists (
    select 1 from public.reactions r
    where r.post_id = p_post_id and r.user_id = v_me and r.type = p_type
  ) then
    delete from public.reactions where post_id = p_post_id and user_id = v_me and type = p_type;
    return query select true, p_type;
  end if;

  insert into public.reactions (post_id, user_id, type) values (p_post_id, v_me, p_type)
  on conflict (post_id, user_id, type) do nothing;
  return query select false, p_type;
end;
$$;

drop function if exists public.add_post_comment(uuid, text);
create function public.add_post_comment(p_post_id uuid, p_body text)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_row public.comments;
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_body is null or char_length(trim(p_body)) = 0 then raise exception 'BODY_REQUIRED'; end if;
  if char_length(trim(p_body)) > 280 then raise exception 'BODY_TOO_LONG'; end if;

  select user_id into v_owner from public.friend_posts where id = p_post_id;
  if v_owner is null then raise exception 'POST_NOT_FOUND'; end if;
  if not public.can_view_user_posts(v_owner) then raise exception 'FORBIDDEN'; end if;

  insert into public.comments (post_id, user_id, body)
  values (p_post_id, v_me, trim(p_body))
  returning * into v_row;
  return v_row;
end;
$$;

drop function if exists public.delete_post_comment(uuid);
create function public.delete_post_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  delete from public.comments c
  where c.id = p_comment_id
    and (c.user_id = v_me or exists (
      select 1 from public.friend_posts p where p.id = c.post_id and p.user_id = v_me
    ));
  if not found then raise exception 'COMMENT_NOT_FOUND'; end if;
end;
$$;

drop function if exists public.get_post_social(uuid[]);
create function public.get_post_social(p_post_ids uuid[])
returns table (
  post_id        uuid,
  reaction_type  text,
  reaction_count int,
  my_reacted     boolean,
  comment_count  int
)
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select p.id from public.friend_posts p
    where p.id = any(p_post_ids) and public.can_view_user_posts(p.user_id)
  ),
  reaction_summary as (
    select r.post_id, r.type,
           count(*)::int as cnt,
           bool_or(r.user_id = auth.uid()) as mine
    from public.reactions r
    where r.post_id in (select id from visible)
    group by r.post_id, r.type
  )
  select v.id, rs.type, coalesce(rs.cnt, 0), coalesce(rs.mine, false),
         (select count(*)::int from public.comments c where c.post_id = v.id)
  from visible v
  left join reaction_summary rs on rs.post_id = v.id;
$$;

drop function if exists public.get_post_comments(uuid);
create function public.get_post_comments(p_post_id uuid)
returns table (
  comment_id   uuid,
  user_id      uuid,
  name         text,
  avatar_url   text,
  avatar_emoji text,
  body         text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.user_id, u.name, u.avatar_url, u.avatar_emoji, c.body, c.created_at
  from public.comments c
  join public.users u on u.id = c.user_id
  where c.post_id = p_post_id
    and exists (
      select 1 from public.friend_posts p
      where p.id = p_post_id and public.can_view_user_posts(p.user_id)
    )
  order by c.created_at asc;
$$;

revoke all on function public.toggle_post_reaction(uuid, text) from public, anon;
revoke all on function public.add_post_comment(uuid, text)     from public, anon;
revoke all on function public.delete_post_comment(uuid)        from public, anon;
revoke all on function public.get_post_social(uuid[])          from public, anon;
revoke all on function public.get_post_comments(uuid)          from public, anon;

grant execute on function public.toggle_post_reaction(uuid, text) to authenticated;
grant execute on function public.add_post_comment(uuid, text)     to authenticated;
grant execute on function public.delete_post_comment(uuid)        to authenticated;
grant execute on function public.get_post_social(uuid[])          to authenticated;
grant execute on function public.get_post_comments(uuid)          to authenticated;


-- #####################################################################
-- ##  12. 運動していないフレンドへの「応援ナッジ」
-- #####################################################################

create table if not exists public.friend_nudges (
  id           uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.users(id) on delete cascade,
  to_user_id   uuid not null references public.users(id) on delete cascade,
  emoji        text not null default '📣',
  created_at   timestamptz not null default now(),
  constraint friend_nudges_no_self check (from_user_id <> to_user_id)
);

create unique index if not exists friend_nudges_one_per_day
  on public.friend_nudges (from_user_id, to_user_id, ((created_at at time zone 'Asia/Tokyo')::date));

create index if not exists friend_nudges_to_created
  on public.friend_nudges (to_user_id, created_at desc);

alter table public.friend_nudges enable row level security;

drop policy if exists friend_nudges_select_own on public.friend_nudges;
create policy friend_nudges_select_own on public.friend_nudges
  for select using (from_user_id = auth.uid() or to_user_id = auth.uid());

drop function if exists public.send_friend_nudge(uuid, text);
create function public.send_friend_nudge(p_to_user_id uuid, p_emoji text)
returns public.friend_nudges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.friend_nudges;
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_to_user_id = v_me then raise exception 'CANNOT_NUDGE_SELF'; end if;
  if p_emoji is null or trim(p_emoji) = '' then raise exception 'EMOJI_REQUIRED'; end if;

  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.user_id_a = v_me and f.user_id_b = p_to_user_id)
        or (f.user_id_b = v_me and f.user_id_a = p_to_user_id))
  ) then
    raise exception 'NOT_FRIENDS';
  end if;

  begin
    insert into public.friend_nudges (from_user_id, to_user_id, emoji)
    values (v_me, p_to_user_id, p_emoji)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'ALREADY_NUDGED_TODAY';
  end;

  return v_row;
end;
$$;

drop function if exists public.get_my_nudges_sent_today();
create function public.get_my_nudges_sent_today()
returns table (to_user_id uuid, emoji text)
language sql
stable
security definer
set search_path = public
as $$
  select n.to_user_id, n.emoji
  from public.friend_nudges n
  where n.from_user_id = auth.uid()
    and (n.created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date;
$$;

drop function if exists public.get_my_received_nudges(int);
create function public.get_my_received_nudges(p_limit int default 20)
returns table (
  from_user_id uuid,
  from_name    text,
  from_avatar_url text,
  from_avatar_emoji text,
  emoji        text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select n.from_user_id, u.name, u.avatar_url, u.avatar_emoji, n.emoji, n.created_at
  from public.friend_nudges n
  join public.users u on u.id = n.from_user_id
  where n.to_user_id = auth.uid()
  order by n.created_at desc
  limit greatest(1, coalesce(p_limit, 20));
$$;

revoke all on function public.send_friend_nudge(uuid, text) from public, anon;
revoke all on function public.get_my_nudges_sent_today()     from public, anon;
revoke all on function public.get_my_received_nudges(int)    from public, anon;
grant execute on function public.send_friend_nudge(uuid, text) to authenticated;
grant execute on function public.get_my_nudges_sent_today()     to authenticated;
grant execute on function public.get_my_received_nudges(int)    to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.friend_nudges;
exception when duplicate_object then null; end $$;


-- #####################################################################
-- ##  14. 継続ランキングのフレンドカードへの「ひと言コメント」
-- ##      公開範囲: A(投稿者)の投稿が見えるのは「A本人」「B(カード本人)本人」
-- ##      「AともBとも両方acceptedなフレンドの人」だけ。Bのフレンドというだけ
-- ##      （Aのフレンドではない人）には見せない。
-- #####################################################################

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
drop policy if exists friend_comments_delete_own on public.friend_comments;

-- 投稿から24時間を過ぎたものは誰からも見えない
create policy friend_comments_select on public.friend_comments
  for select using (
    created_at > now() - interval '24 hours'
    and public.can_view_friend_comment(from_user_id, to_user_id)
  );
create policy friend_comments_delete_own on public.friend_comments
  for delete using (from_user_id = auth.uid() or to_user_id = auth.uid());

do $$ begin
  alter publication supabase_realtime add table public.friend_comments;
exception when duplicate_object then null; end $$;

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
-- これは実データをテーブルに残し続けないための掃除用（pg_cronが無効でも
-- アプリの見え方には影響しない）。
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
  raise notice 'pg_cronのスケジュール登録に失敗しました（拡張が未有効化の可能性）。見え方には影響しません。';
end $$;

-- =====================================================================
-- 完了。以降、friends.tsx のリアクション（🔥😭など）とコメント欄が動きます。
-- コメントは投稿から24時間で自動的に見えなくなり、1時間おきに実データも削除されます。
-- =====================================================================
