-- =====================================================================
--  マイグレーション #13 — friend_posts への「リアクション」「コメント」
-- ---------------------------------------------------------------------
--  reactions テーブルは既にSupabase上に手動作成・本番稼働中（確認済み）:
--    reactions(id uuid pk, post_id uuid -> friend_posts(id) on delete cascade,
--              user_id uuid -> auth.users(id) on delete cascade,
--              type text, created_at timestamptz)
--    RLS: 認証済み全員が select 可 / insert・delete は本人のみ（そのまま維持）
--
--  friend_posts も既存（id, user_id, menu, reps, sets, workout_seconds,
--  comment, photo_url, posted_at）だが、RLSが有効なのにポリシーが0件で
--  API経由では誰も読み書きできない状態だった。今回ここにポリシーを追加する。
--
--  このマイグレーションでやること:
--    1. friend_posts にRLSポリシーを追加（自分 or acceptedなフレンドのみ閲覧可）
--    2. reactions はテーブル定義ごと作り直さない。重複防止のユニーク制約だけ追加
--       （post_id, user_id, type）。既存に重複行があれば先に間引く。
--    3. comments テーブルを新規追加（friend_posts向け）
--    4. RPC: toggle_post_reaction / add_post_comment / delete_post_comment /
--            get_post_social / get_post_comments
--
--  schema.sql にも同内容を統合済み。何度実行しても安全。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 可視判定ヘルパー（自分 or acceptedなフレンド）
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 1. friend_posts の RLS（既存テーブル。今はポリシー0件で全閉鎖状態）
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 2. reactions（既存）。作り直さず、重複防止の制約だけ追加
-- ---------------------------------------------------------------------
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

-- 同じ(post_id,user_id,type)の重複行を間引いてからユニーク制約を追加
-- （重複が無ければ何も削除されない。何度実行しても安全）
delete from public.reactions r
using public.reactions r2
where r.post_id = r2.post_id
  and r.user_id = r2.user_id
  and r.type = r2.type
  and r.id > r2.id;

-- ユニーク制約は裏でインデックスも作るため、重複時に出るエラーは
-- duplicate_object ではなく duplicate_table (42P07) になる。
-- exceptionで握りつぶすと取りこぼすので、存在チェックしてから追加する
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


-- ---------------------------------------------------------------------
-- 3. comments（新規）
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 4. RPC
-- ---------------------------------------------------------------------

-- 4-1. リアクションの切り替え（同じtype→取り消し / 別type→追加。1人で複数種類OK）
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

-- 4-2. コメント追加
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

-- 4-3. コメント削除（本人 or 投稿の本人）
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

-- 4-4. 一覧画面用の集計（複数投稿ぶんのリアクション内訳・コメント数）
--      1 post_id につき type の種類数ぶん行が返る（type=null は無反応の投稿）
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

-- 4-5. 1件ぶんのコメント一覧（投稿者情報付き）
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
