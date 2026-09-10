# 目標ロードマップ 永続化 — バックエンド依頼

宛: バックエンド担当（`2501168abcc`） ／ 作成: 2026-09-10 ／ ブランチ: `feat/goal-roadmap-ai`

## 背景

目標ロードマップの **AI 生成は完成**（`services/goalService.ts` の `generateRoadmap()` が Gemini を直接呼ぶ。Supabase 不使用）。
残りは **生成したツリーの保存・取得** だけ。現状は `lib/goal-draft.ts`（メモリ）に置いているだけで、アプリを閉じると消える。

やってほしいのは **1〜3**（テーブル / RLS / RPC 2本）。フロント側の配線（4）は別途こちらでやる。

---

## 0. データ構造（フロントの契約 — 変更不可）

`types/goal.ts` の `Roadmap`。保存も取得もこの形。

```
Roadmap {
  goal_id: string
  title: string
  user_input_raw: string        // ユーザーの大目標入力（原文）
  target_period_weeks: number
  milestones: Milestone[]        // 3〜5個
}
Milestone {
  milestone_id: string
  order: number                  // 1始まり
  title: string
  period_weeks: number
  description: string
  tasks: Task[]                   // 各1〜3個
}
Task {
  task_id: string
  order: number
  week_number: number            // プラン開始からの通し週（1始まり）
  title: string
  description: string
  frequency_per_week: number     // 1〜6
  workout_menu_tag: string | null
}
```

> `goal_id` / `milestone_id` / `task_id` は AI が仮の文字列を入れている。**保存時に DB 側の uuid で発番し直してよい**（フロントは id の中身に依存していない）。

---

## 1. テーブル（schema.sql に追記。差分適用スタイルでOK）

| テーブル | 主なカラム |
|---|---|
| `goal_trees` | `id uuid pk`, `user_id uuid → auth.users`, `title text`, `user_input_raw text`, `target_period_weeks int`, `is_active bool default true`, `created_at timestamptz default now()` |
| `goal_milestones` | `id uuid pk`, `goal_id uuid → goal_trees on delete cascade`, `order_index int`, `title text`, `period_weeks int`, `description text` |
| `goal_tasks` | `id uuid pk`, `milestone_id uuid → goal_milestones on delete cascade`, `order_index int`, `week_number int`, `title text`, `description text`, `frequency_per_week int`, `workout_menu_tag text null` |

メモ:
- `order` は SQL 予約語なので **`order_index`** にした（RPC の出力では `order` に戻す）。
- 1ユーザーに複数ツリーを持たせるが、表示するのは `is_active = true` の最新1本。保存時に古いものを `is_active = false` にする。
- インデックス: `goal_trees (user_id, is_active, created_at desc)` があると取得が速い。

### たたき台 SQL

```sql
-- =====================================================================
-- 8. 目標ロードマップ（goal_trees / goal_milestones / goal_tasks）
-- =====================================================================
create table if not exists public.goal_trees (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  title               text not null default '',
  user_input_raw      text not null default '',
  target_period_weeks int  not null default 12,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
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
```

---

## 2. RLS

`goal_trees` は `user_id = auth.uid()` の行だけ。子テーブルは「親の goal_tree が自分のものなら OK」。

```sql
alter table public.goal_trees      enable row level security;
alter table public.goal_milestones enable row level security;
alter table public.goal_tasks      enable row level security;

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
```

---

## 3. RPC（2本）

フロントはこの2つだけ呼ぶ。テーブルに直接クエリはしない。

### 3-1. `save_roadmap(p_roadmap jsonb) returns uuid`

- `p_roadmap` は §0 の `Roadmap` JSON まるごと。
- 処理:
  1. 呼び出しユーザーの既存 `goal_trees` を `is_active = false` に
  2. `goal_trees` に1行 insert（`title` / `user_input_raw` / `target_period_weeks`）
  3. `p_roadmap->'milestones'` をループして `goal_milestones` insert（`order` → `order_index`）
  4. 各 milestone の `tasks` をループして `goal_tasks` insert
  5. 新しい `goal_trees.id` を返す
- 全部1トランザクション（RPC 関数は元々アトミック）。
- `security definer` / `set search_path = public` / 先頭で `auth.uid()` を確認（null なら raise）。

```sql
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

  insert into public.goal_trees (user_id, title, user_input_raw, target_period_weeks)
  values (
    v_uid,
    coalesce(p_roadmap->>'title', ''),
    coalesce(p_roadmap->>'user_input_raw', ''),
    coalesce((p_roadmap->>'target_period_weeks')::int, 12)
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
```

### 3-2. `get_current_roadmap() returns jsonb`

- 呼び出しユーザーの `is_active = true` の最新ツリーを、§0 の `Roadmap` 形の JSON で返す。
- 無ければ `null`（SQL の `null`。フロントは `null` を「まだ目標なし」と扱う）。
- `order_index` は出力で `order` に戻す。

```sql
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
```

---

## 4. フロント側の配線（← こちらでやる。参考まで）

| ファイル | 変更 |
|---|---|
| `services/goalService.ts` | `saveRoadmap(r: Roadmap): Promise<void>` を追加（`supabase.rpc('save_roadmap', { p_roadmap: r })`）。`fetchCurrentRoadmap()` を `supabase.rpc('get_current_roadmap')` に差し替え（返り値 null → null） |
| `app/goal/index.tsx` | 「この目標ではじめる」で `saveRoadmap(roadmap)` を呼んでから遷移 |
| `types/db.ts` | 特に追加不要（RPC が `Roadmap`/`jsonb` をそのまま返すため。必要なら `save_roadmap` の引数型だけ） |

---

## 5. Phase 2（進捗トラッキング）— 今回は不要、将来やるなら

- `goal_tasks` に `done_count int not null default 0` を追加、または `goal_task_progress(task_id, user_id, done_at)` テーブル
- RPC `complete_task(p_task_id uuid)` / `get_roadmap_progress()`（完了率・今週のタスク）
- 「今週」の算出 = `now() - goal_trees.created_at` を7で割る
- 筋トレ完了（`workout_logs`）との自動紐付けは `workout_menu_tag` 経由で可能だが、まず手動チェックで十分

---

## 6. 実行手順（バックエンドの人）

1. §1〜§3 の SQL を `supabase/schema.sql` の末尾に追記（セクション番号は続きで）
2. Supabase ダッシュボード > SQL Editor に全文貼って Run（既存同様、差分適用なので再実行安全）
3. `save_roadmap` / `get_current_roadmap` が SQL Editor で動くか確認（適当な jsonb で `select save_roadmap('{...}'::jsonb)`）
4. こちらへ「入った」と連絡 → フロント配線してテスト
