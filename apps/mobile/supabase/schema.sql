-- =====================================================================
--  女性向け宅トレアプリ — Supabase スキーマ（★これ1本だけ実行すればOK）
-- ---------------------------------------------------------------------
--  Supabase ダッシュボード > SQL Editor に全文貼り付けて Run。
--  既存テーブルに対する差分適用なので、何度実行しても壊れません。
--
--  既存テーブル（前提）:
--    users(id, name, avatar_url, preferred_time_of_day time,
--          notification_enabled, created_at, updated_at)
--    friendships(id, user_id_a, user_id_b, status text, created_at)
--    workout_logs(id bigint, created_at, user_id, menu_id bigint)
--    workout_menus / friend_posts / reactions / notifications … 変更なし
--
--  前提（違う場合は先に教えてください）:
--    - users.id = auth.users.id
--    - friendships.user_id_a = 申請者 / user_id_b = 申請された側
--    - workout_logs 1行 = 運動1回（created_at を実施日時とみなす）
--
--  やること:
--    1. users にオンライン状況カラム / 既定値 / 一意名 / トリガー
--    2. friendships に status制限 / updated_at / 重複防止 / FK
--    3. workout_logs 集計用インデックス
--    4. user_workout_stats ビュー（連続日数・お休み日数）
--    5. RLS 一式（users / friendships / workout_logs）
--    6. RPC: send_friend_request / respond_to_friend_request /
--            get_friends_with_status / get_incoming_friend_requests /
--            update_my_presence / delete_current_user
--    7. Realtime publication 登録
-- =====================================================================

create extension if not exists "pgcrypto";


-- =====================================================================
-- 1. users
-- =====================================================================
alter table public.users add column if not exists is_online    boolean     not null default false;
alter table public.users add column if not exists last_seen    timestamptz not null default now();
-- アバター絵文字（画像未設定時のフォールバック。フレンドからも見える）
alter table public.users add column if not exists avatar_emoji text        not null default '✦';
-- フレンドコード（例: ZBR-8A2K7X）。フレンド申請はこのコードのみで行う。
alter table public.users add column if not exists friend_code text;

-- サインアップ時にトリガー/クライアントが最小項目で insert できるよう既定値
alter table public.users alter column preferred_time_of_day set default '20:00';
alter table public.users alter column notification_enabled  set default true;
alter table public.users alter column created_at            set default now();
alter table public.users alter column updated_at            set default now();

-- 表示名は重複OK（自分の名前をそのまま使いたい人向け）。旧: lower(name) の一意 index は撤廃。
drop index if exists public.users_name_lower_unique;

-- フレンドコードの正規化（ハイフン・大小文字を無視して比較 / 一意判定）
create or replace function public.canon_friend_code(code text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- ランダムなフレンドコード生成（紛らわしい 0/O/1/I/L を除く 30 字から6桁 + ZBR-）
create or replace function public.gen_friend_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  candidate text;
  i int;
  attempt int := 0;
begin
  loop
    candidate := 'ZBR-';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (
      select 1 from public.users
      where public.canon_friend_code(friend_code) = public.canon_friend_code(candidate)
    );
    attempt := attempt + 1;
    if attempt > 20 then
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      exit;
    end if;
  end loop;
  return candidate;
end;
$$;

create unique index if not exists users_friend_code_canon_key
  on public.users (public.canon_friend_code(friend_code))
  where friend_code is not null;

-- 既存ユーザーに採番（1行ずつ）→ 以後は必須＋既定値で自動採番
do $$
declare r record;
begin
  for r in select id from public.users where friend_code is null loop
    update public.users set friend_code = public.gen_friend_code() where id = r.id;
  end loop;
end $$;
alter table public.users alter column friend_code set default public.gen_friend_code();
alter table public.users alter column friend_code set not null;

create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.tg_set_updated_at();

-- サインアップ時に users 行を自動作成
-- （既に別トリガーで作っているなら不要。二重作成防止で on conflict do nothing）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  v_name := nullif(trim(new.raw_user_meta_data ->> 'name'), '');
  if v_name is null then
    v_name := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  end if;
  if v_name is null then
    v_name := 'user_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  -- 表示名は重複OKなのでサフィックス付与はしない。friend_code は列 default が自動採番。

  insert into public.users (id, name, avatar_url, avatar_emoji, preferred_time_of_day, notification_enabled)
  values (
    new.id,
    v_name,
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce(nullif(new.raw_user_meta_data ->> 'avatar_emoji', ''), '✦'),
    coalesce(nullif(new.raw_user_meta_data ->> 'preferred_time_of_day', '')::time, '20:00'),
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- 2. friendships
-- =====================================================================
-- status を 3 値に制限（既存に他の値があると失敗 → 先に UPDATE で寄せる）
alter table public.friendships drop constraint if exists friendships_status_check;
alter table public.friendships
  add constraint friendships_status_check check (status in ('pending', 'accepted', 'rejected'));

alter table public.friendships
  add column if not exists updated_at timestamptz not null default now();

alter table public.friendships drop constraint if exists friendships_no_self;
alter table public.friendships
  add constraint friendships_no_self check (user_id_a <> user_id_b);

-- A→B と B→A を二重に作らせない（順不同で 1 ペア 1 行）
create unique index if not exists friendships_unique_pair
  on public.friendships (least(user_id_a, user_id_b), greatest(user_id_a, user_id_b));

create index if not exists friendships_b_status on public.friendships (user_id_b, status);
create index if not exists friendships_a_status on public.friendships (user_id_a, status);

drop trigger if exists friendships_set_updated_at on public.friendships;
create trigger friendships_set_updated_at
  before update on public.friendships
  for each row execute function public.tg_set_updated_at();

-- FK（無ければ付与）
do $$ begin
  alter table public.friendships
    add constraint friendships_user_a_fkey
    foreign key (user_id_a) references public.users (id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.friendships
    add constraint friendships_user_b_fkey
    foreign key (user_id_b) references public.users (id) on delete cascade;
exception when duplicate_object then null; end $$;


-- =====================================================================
-- 3. workout_logs
-- =====================================================================
create index if not exists workout_logs_user_created
  on public.workout_logs (user_id, created_at desc);

-- 実施時間（秒）。saveWorkoutSession() が result.completedSec を入れる。
alter table public.workout_logs
  add column if not exists duration_sec integer not null default 0;


-- =====================================================================
-- 4. user_workout_stats ビュー
--    workout_logs 1行 = 実施1回。created_at を JST 暦日に丸めて連続判定。
--    「今日 もしくは 昨日」に実施していれば連続中（就寝前の猶予）。
-- =====================================================================
create or replace view public.user_workout_stats
with (security_invoker = true) as
with days as (
  select
    user_id,
    (created_at at time zone 'Asia/Tokyo')::date as day
  from public.workout_logs
  where user_id is not null
  group by user_id, (created_at at time zone 'Asia/Tokyo')::date
),
grouped as (
  select
    user_id,
    day,
    day - (row_number() over (partition by user_id order by day))::int as streak_key
  from days
),
runs as (
  select user_id, streak_key, count(*)::int as len, max(day) as last_day
  from grouped
  group by user_id, streak_key
),
last_workout as (
  select user_id, max(day) as last_day from days group by user_id
)
select
  u.id as user_id,
  coalesce((
    select r.len from runs r
    where r.user_id = u.id
      and r.last_day >= ((now() at time zone 'Asia/Tokyo')::date - 1)
    order by r.last_day desc
    limit 1
  ), 0) as streak_days,
  lw.last_day as last_workout_day,
  case
    when lw.last_day is null then null
    else ((now() at time zone 'Asia/Tokyo')::date - lw.last_day)
  end as rest_days,
  coalesce((select max(r.len) from runs r where r.user_id = u.id), 0) as best_streak_days
from public.users u
left join last_workout lw on lw.user_id = u.id;


-- =====================================================================
-- 5. RLS
-- =====================================================================
alter table public.users        enable row level security;
alter table public.friendships  enable row level security;
alter table public.workout_logs enable row level security;

-- ---- users ---------------------------------------------------------
drop policy if exists users_select_self    on public.users;
drop policy if exists users_select_related on public.users;
drop policy if exists users_insert_self    on public.users;
drop policy if exists users_update_self    on public.users;

create policy users_select_self on public.users
  for select using (id = auth.uid());

-- フレンド(accepted) / 申請中(pending)の相手のプロフィールも見える
create policy users_select_related on public.users
  for select using (exists (
    select 1 from public.friendships f
    where f.status in ('accepted', 'pending')
      and ((f.user_id_a = auth.uid() and f.user_id_b = public.users.id)
        or (f.user_id_b = auth.uid() and f.user_id_a = public.users.id))
  ));

create policy users_insert_self on public.users
  for insert with check (id = auth.uid());

create policy users_update_self on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---- friendships --------------------------------------------------
drop policy if exists friendships_select_own on public.friendships;
drop policy if exists friendships_insert_own on public.friendships;
drop policy if exists friendships_update_own on public.friendships;
drop policy if exists friendships_delete_own on public.friendships;

create policy friendships_select_own on public.friendships
  for select using (user_id_a = auth.uid() or user_id_b = auth.uid());
create policy friendships_insert_own on public.friendships
  for insert with check (user_id_a = auth.uid());
create policy friendships_update_own on public.friendships
  for update using (user_id_a = auth.uid() or user_id_b = auth.uid())
             with check (user_id_a = auth.uid() or user_id_b = auth.uid());
create policy friendships_delete_own on public.friendships
  for delete using (user_id_a = auth.uid() or user_id_b = auth.uid());

-- ---- workout_logs ------------------------------------------------
--  ★注意: RLS 有効化後は「ログイン中ユーザーの id」で INSERT する必要があります。
--  services/workoutService.ts の固定 user_id は auth.uid() 相当に直してください。
drop policy if exists workout_logs_select_self    on public.workout_logs;
drop policy if exists workout_logs_select_friends on public.workout_logs;
drop policy if exists workout_logs_write_self     on public.workout_logs;
drop policy if exists workout_logs_update_self    on public.workout_logs;
drop policy if exists workout_logs_delete_self    on public.workout_logs;

create policy workout_logs_select_self on public.workout_logs
  for select using (user_id = auth.uid());
create policy workout_logs_select_friends on public.workout_logs
  for select using (exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.user_id_a = auth.uid() and f.user_id_b = public.workout_logs.user_id)
        or (f.user_id_b = auth.uid() and f.user_id_a = public.workout_logs.user_id))
  ));
create policy workout_logs_write_self on public.workout_logs
  for insert with check (user_id = auth.uid());
create policy workout_logs_update_self on public.workout_logs
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy workout_logs_delete_self on public.workout_logs
  for delete using (user_id = auth.uid());


-- =====================================================================
-- 6. RPC（クライアントは supabase.rpc('関数名', {...}) で呼ぶ）
-- =====================================================================

-- 6-1. フレンド申請（フレンドコードで相手を検索）
drop function if exists public.send_friend_request(text);
create function public.send_friend_request(friend_code text)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me       uuid := auth.uid();
  v_target   uuid;
  v_existing public.friendships;
  v_row      public.friendships;
  v_canon    text := public.canon_friend_code(friend_code);
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_canon = '' then raise exception 'USER_NOT_FOUND'; end if;

  select id into v_target from public.users u
  where public.canon_friend_code(u.friend_code) = v_canon;
  if v_target is null then raise exception 'USER_NOT_FOUND'; end if;
  if v_target = v_me then raise exception 'CANNOT_ADD_SELF'; end if;

  select * into v_existing from public.friendships
  where least(user_id_a, user_id_b)    = least(v_me, v_target)
    and greatest(user_id_a, user_id_b) = greatest(v_me, v_target);

  if found then
    if v_existing.status = 'accepted' then
      raise exception 'ALREADY_FRIENDS';
    elsif v_existing.status = 'pending' then
      raise exception 'ALREADY_REQUESTED';
    else
      update public.friendships
        set status = 'pending', user_id_a = v_me, user_id_b = v_target, created_at = now()
        where id = v_existing.id
        returning * into v_row;
      return v_row;
    end if;
  end if;

  insert into public.friendships (user_id_a, user_id_b, status)
  values (v_me, v_target, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

-- 6-2. 申請への応答（承認 / 拒否）
create or replace function public.respond_to_friend_request(p_request_id uuid, p_accept boolean)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.friendships;
begin
  if v_me is null then raise exception 'AUTH_REQUIRED'; end if;
  update public.friendships
    set status = case when p_accept then 'accepted' else 'rejected' end,
        updated_at = now()
    where id = p_request_id and user_id_b = v_me and status = 'pending'
    returning * into v_row;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  return v_row;
end;
$$;

-- 6-3. フレンド一覧 + 継続 / お休み状況（継続日数の多い順。自分自身の行も含む）
drop function if exists public.get_friends_with_status();
create function public.get_friends_with_status()
returns table (
  user_id          uuid,
  name             text,
  avatar_url       text,
  avatar_emoji     text,
  is_online        boolean,
  last_seen        timestamptz,
  streak_days      int,
  rest_days        int,
  best_streak_days int,
  week_minutes     int,
  friends_since    timestamptz,
  is_self          boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with my_friends as (
    select
      case when user_id_a = auth.uid() then user_id_b else user_id_a end as friend_id,
      created_at as friends_since
    from public.friendships
    where status = 'accepted'
      and (user_id_a = auth.uid() or user_id_b = auth.uid())
  ),
  ids as (
    select friend_id, friends_since, false as is_self from my_friends
    union all
    select auth.uid(), now(), true
    where auth.uid() is not null
  ),
  wk as (
    select date_trunc('week', (now() at time zone 'Asia/Tokyo'))::date as start_day
  ),
  week_totals as (
    select w.user_id, sum(w.duration_sec) as total_sec
    from public.workout_logs w, wk
    where (w.created_at at time zone 'Asia/Tokyo')::date >= wk.start_day
    group by w.user_id
  )
  select
    u.id, u.name, u.avatar_url, u.avatar_emoji, u.is_online, u.last_seen,
    coalesce(s.streak_days, 0)::int,
    s.rest_days::int,
    coalesce(s.best_streak_days, 0)::int,
    coalesce(round(wt.total_sec / 60.0), 0)::int,
    i.friends_since,
    i.is_self
  from ids i
  join public.users u on u.id = i.friend_id
  left join public.user_workout_stats s on s.user_id = i.friend_id
  left join week_totals wt on wt.user_id = i.friend_id
  order by coalesce(s.streak_days, 0) desc, u.name asc;
$$;

-- 6-4. 自分宛の未応答フレンド申請
create or replace function public.get_incoming_friend_requests()
returns table (
  request_id      uuid,
  from_user_id    uuid,
  from_name       text,
  from_avatar_url text,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.user_id_a, u.name, u.avatar_url, f.created_at
  from public.friendships f
  join public.users u on u.id = f.user_id_a
  where f.user_id_b = auth.uid() and f.status = 'pending'
  order by f.created_at desc;
$$;

-- 6-5. オンライン状態の更新
create or replace function public.update_my_presence(p_is_online boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users set is_online = p_is_online, last_seen = now() where id = auth.uid();
$$;

-- 6-6. アカウント削除（関連データは FK cascade）
create or replace function public.delete_current_user()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

-- 6-7. ホーム画面の実績（連続記録 / 今週の合計）
create or replace function public.get_home_stats()
returns table (
  streak_days   integer,
  week_minutes  integer,
  week_workouts integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with wk as (
    select date_trunc('week', (now() at time zone 'Asia/Tokyo'))::date as start_day
  ),
  this_week as (
    select w.duration_sec
    from public.workout_logs w, wk
    where w.user_id = auth.uid()
      and (w.created_at at time zone 'Asia/Tokyo')::date >= wk.start_day
  )
  select
    coalesce(
      (select s.streak_days from public.user_workout_stats s where s.user_id = auth.uid()),
      0
    )::integer,
    coalesce((select round(sum(duration_sec) / 60.0) from this_week), 0)::integer,
    coalesce((select count(*) from this_week), 0)::integer;
$$;

-- 6-8. 自分のフレンドコードを取得（無ければ採番して保存）
create or replace function public.get_my_friend_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select friend_code into v_code from public.users where id = auth.uid();
  if v_code is null or v_code = '' then
    v_code := public.gen_friend_code();
    update public.users set friend_code = v_code where id = auth.uid();
  end if;
  return v_code;
end;
$$;

revoke all on function public.send_friend_request(text)                from public, anon;
revoke all on function public.respond_to_friend_request(uuid, boolean) from public, anon;
revoke all on function public.get_friends_with_status()                from public, anon;
revoke all on function public.get_incoming_friend_requests()           from public, anon;
revoke all on function public.update_my_presence(boolean)              from public, anon;
revoke all on function public.delete_current_user()                    from public, anon;
revoke all on function public.get_home_stats()                         from public, anon;
revoke all on function public.get_my_friend_code()                     from public, anon;

grant execute on function public.send_friend_request(text)                to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.get_friends_with_status()                to authenticated;
grant execute on function public.get_incoming_friend_requests()           to authenticated;
grant execute on function public.update_my_presence(boolean)              to authenticated;
grant execute on function public.delete_current_user()                    to authenticated;
grant execute on function public.get_home_stats()                         to authenticated;
grant execute on function public.get_my_friend_code()                     to authenticated;


-- =====================================================================
-- 7. Realtime
--    Presence（オンライン状況）は channel だけで動くので DB 不要。
--    下記は postgres_changes 購読用（申請の受信 / オンライン切替）。
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.friendships;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.users;
exception when duplicate_object then null; end $$;


-- =====================================================================
-- 8. 目標ロードマップ（goal_trees / goal_milestones / goal_tasks）
--    仕様: docs/goal-roadmap-persistence-spec.md
--    「この目標ではじめる」で確定したロードマップを保存し、端末をまたいで
--    同じものが見えるようにする（save_roadmap / get_current_roadmap RPC）。
-- =====================================================================
create table if not exists public.goal_trees (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  title               text not null default '',
  user_input_raw      text not null default '',
  target_period_weeks int  not null default 12,
  -- 前提10問の回答一式（表示用）。「入力した内容を見る」で大目標以外も出すため。
  input_answers       jsonb not null default '{}'::jsonb,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
alter table public.goal_trees add column if not exists input_answers jsonb not null default '{}'::jsonb;
create index if not exists goal_trees_user_active
  on public.goal_trees (user_id, is_active, created_at desc);

create table if not exists public.goal_milestones (
  id           uuid primary key default gen_random_uuid(),
  goal_id      uuid not null references public.goal_trees(id) on delete cascade,
  order_index  int  not null,
  title        text not null default '',
  period_weeks int  not null default 1,
  description  text not null default ''
);
create index if not exists goal_milestones_goal on public.goal_milestones (goal_id, order_index);

create table if not exists public.goal_tasks (
  id                 uuid primary key default gen_random_uuid(),
  milestone_id       uuid not null references public.goal_milestones(id) on delete cascade,
  order_index        int  not null,
  week_number        int  not null default 1,
  title              text not null default '',
  description        text not null default '',
  frequency_per_week int  not null default 2,
  workout_menu_tag   text
);
create index if not exists goal_tasks_milestone on public.goal_tasks (milestone_id, order_index);

alter table public.goal_trees      enable row level security;
alter table public.goal_milestones enable row level security;
alter table public.goal_tasks      enable row level security;

drop policy if exists goal_trees_all_self      on public.goal_trees;
drop policy if exists goal_milestones_all_self on public.goal_milestones;
drop policy if exists goal_tasks_all_self      on public.goal_tasks;

create policy goal_trees_all_self on public.goal_trees
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy goal_milestones_all_self on public.goal_milestones
  for all using (exists (
    select 1 from public.goal_trees g
    where g.id = goal_milestones.goal_id and g.user_id = auth.uid()
  ));

create policy goal_tasks_all_self on public.goal_tasks
  for all using (exists (
    select 1 from public.goal_milestones m
    join public.goal_trees g on g.id = m.goal_id
    where m.id = goal_tasks.milestone_id and g.user_id = auth.uid()
  ));

-- 保存: 呼び出しユーザーの既存ロードマップを非アクティブ化し、新しいツリーを1本 insert
create or replace function public.save_roadmap(p_roadmap jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_goal  uuid;
  v_ms    jsonb;
  v_task  jsonb;
  v_msid  uuid;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.goal_trees set is_active = false where user_id = v_uid and is_active;

  insert into public.goal_trees (user_id, title, user_input_raw, target_period_weeks, input_answers)
  values (
    v_uid,
    coalesce(p_roadmap->>'title', ''),
    coalesce(p_roadmap->>'user_input_raw', ''),
    coalesce((p_roadmap->>'target_period_weeks')::int, 12),
    coalesce(p_roadmap->'input_answers', '{}'::jsonb)
  )
  returning id into v_goal;

  for v_ms in select * from jsonb_array_elements(coalesce(p_roadmap->'milestones', '[]'::jsonb))
  loop
    insert into public.goal_milestones (goal_id, order_index, title, period_weeks, description)
    values (
      v_goal,
      coalesce((v_ms->>'order')::int, 1),
      coalesce(v_ms->>'title', ''),
      coalesce((v_ms->>'period_weeks')::int, 1),
      coalesce(v_ms->>'description', '')
    )
    returning id into v_msid;

    for v_task in select * from jsonb_array_elements(coalesce(v_ms->'tasks', '[]'::jsonb))
    loop
      insert into public.goal_tasks
        (milestone_id, order_index, week_number, title, description, frequency_per_week, workout_menu_tag)
      values (
        v_msid,
        coalesce((v_task->>'order')::int, 1),
        coalesce((v_task->>'week_number')::int, 1),
        coalesce(v_task->>'title', ''),
        coalesce(v_task->>'description', ''),
        coalesce((v_task->>'frequency_per_week')::int, 2),
        nullif(v_task->>'workout_menu_tag', '')
      );
    end loop;
  end loop;

  return v_goal;
end;
$$;

-- 取得: 呼び出しユーザーの is_active な最新ツリーを Roadmap 型そのままの JSON で返す
create or replace function public.get_current_roadmap()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when g.id is null then null else jsonb_build_object(
    'goal_id', g.id,
    'title', g.title,
    'user_input_raw', g.user_input_raw,
    'target_period_weeks', g.target_period_weeks,
    'input_answers', g.input_answers,
    'milestones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'milestone_id', m.id,
        'order', m.order_index,
        'title', m.title,
        'period_weeks', m.period_weeks,
        'description', m.description,
        'tasks', coalesce((
          select jsonb_agg(jsonb_build_object(
            'task_id', t.id,
            'order', t.order_index,
            'week_number', t.week_number,
            'title', t.title,
            'description', t.description,
            'frequency_per_week', t.frequency_per_week,
            'workout_menu_tag', t.workout_menu_tag
          ) order by t.order_index)
          from public.goal_tasks t where t.milestone_id = m.id
        ), '[]'::jsonb)
      ) order by m.order_index)
      from public.goal_milestones m where m.goal_id = g.id
    ), '[]'::jsonb)
  ) end
  from (
    select * from public.goal_trees
    where user_id = auth.uid() and is_active
    order by created_at desc limit 1
  ) g;
$$;

-- ホーム画面用「今週の目標」。「今週」= created_at からの経過週（JST暦日）。
create or replace function public.get_this_week_focus()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with active as (
    select * from public.goal_trees
    where user_id = auth.uid() and is_active
    order by created_at desc
    limit 1
  ),
  week_calc as (
    select
      a.*,
      greatest(1, (
        ((now() at time zone 'Asia/Tokyo')::date - (a.created_at at time zone 'Asia/Tokyo')::date) / 7
      ) + 1) as current_week
    from active a
  ),
  chosen as (
    select t.title, t.description, t.frequency_per_week, t.workout_menu_tag, m.title as milestone_title
    from week_calc w
    join public.goal_milestones m on m.goal_id = w.id
    join public.goal_tasks t on t.milestone_id = m.id
    where t.week_number <= w.current_week
    order by t.week_number desc
    limit 1
  )
  select case when w.id is null then null else jsonb_build_object(
    'roadmap_title', w.title,
    'current_week', w.current_week,
    'target_period_weeks', w.target_period_weeks,
    'is_complete', w.current_week > w.target_period_weeks,
    'milestone_title', c.milestone_title,
    'task_title', c.title,
    'task_description', c.description,
    'frequency_per_week', c.frequency_per_week,
    'workout_menu_tag', c.workout_menu_tag
  ) end
  from week_calc w
  left join chosen c on true;
$$;

revoke all on function public.save_roadmap(jsonb)      from public, anon;
revoke all on function public.get_current_roadmap()    from public, anon;
revoke all on function public.get_this_week_focus()    from public, anon;
grant execute on function public.save_roadmap(jsonb)      to authenticated;
grant execute on function public.get_current_roadmap()    to authenticated;
grant execute on function public.get_this_week_focus()    to authenticated;


-- =====================================================================
-- 9. friend_posts への「リアクション」「コメント」
--    仕様: supabase/migration_13_friend_post_social.sql
--    reactions は既存テーブル（手動作成・本番稼働中）をそのまま使う。
--    friend_posts はRLSが有効なのにポリシーが0件で全閉鎖状態だったため、
--    ここでポリシーを追加する（自分 or acceptedなフレンドのみ閲覧可）。
-- =====================================================================
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


-- =====================================================================
-- 10. 運動していないフレンドへの「応援ナッジ」
--     仕様: supabase/migration_12_friend_nudges.sql
--     運動記録の有無に関わらず、フレンド本人に直接絵文字を送れる。
--     スパム防止のため、同じ相手には1日1回まで（JST暦日）。
-- =====================================================================
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

revoke all on function public.send_friend_nudge(uuid, text) from public, anon;
revoke all on function public.get_my_nudges_sent_today()     from public, anon;
grant execute on function public.send_friend_nudge(uuid, text) to authenticated;
grant execute on function public.get_my_nudges_sent_today()     to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.friend_nudges;
exception when duplicate_object then null; end $$;


-- =====================================================================
-- 11. 継続ランキングのフレンドカードへの「ひと言コメント」
--     仕様: supabase/migration_14_friend_comments.sql
--     friend_posts向けcomments（section 9）とは別物。対象は「投稿」ではなく
--     「フレンド本人（のランキングカード）」。
--     公開範囲: コメント(from_user_id=A が to_user_id=B のカードに投稿)が
--     見えるのは「A本人」「B本人」「AともBとも両方acceptedなフレンドの人」だけ。
--     「Bのフレンドというだけ（Aのフレンドではない人）」には見せない。
-- =====================================================================
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

-- 24時間を過ぎたコメントの物理削除（1時間おき、pg_cron）。
-- 上のRLS/RPCのフィルタだけで「24時間経ったら誰にも見えない」は既に保証済みで、
-- これは実データをテーブルに残し続けないための掃除用（pg_cronが無効でも見え方には影響しない）。
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
  raise notice 'pg_cron を自動作成できませんでした。Supabaseダッシュボード > Database > Extensions で pg_cron を有効化してから、このファイルをもう一度実行してください。';
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
