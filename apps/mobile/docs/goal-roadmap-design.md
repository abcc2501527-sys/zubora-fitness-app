# 目標ロードマップ AI 生成 — 設計（v1 ドラフト）

作成: 2026-09-10 ／ ステータス: **ドラフト（AI担当レビュー待ち）**

散逸していた「AI担当_目標ブレイクダウン設計ドラフト」の再構築。仕様書 §3・要件定義書 §3.3・`types/goal.ts`・`constants/goal-questions.ts` から起こしたもの。**確定前に AI担当（＝実装者本人）が §5 のタグ一覧と §4 のプロンプトをレビュー・調整すること。**

---

## 1. 目的とスコープ

大目標の自由入力（最大120字）＋ 前提10問（タップ選択）から、**AIが目標ツリーを一度きりで一括生成**する。チャット往復なし（ゼロフリクション方針）。

```
goal/create（大目標）→ goal/questions（10問）→ goal/generating（生成）→ goal/index（ツリー表示）
```

出力は `types/goal.ts` の `Roadmap` 型そのまま。UI はこの型だけに依存しているので**型を変えない**。

**このドキュメントの対象**: `services/goalService.ts` の `generateRoadmap(input: RoadmapInput): Promise<Roadmap>` の中身。
**対象外**: 永続化（別途 `goal_trees`/`milestones`/`tasks` テーブル）、進捗トラッキング UI。

---

## 2. 入力仕様（`RoadmapInput`）

`goal/questions` の10問が `RoadmapAnswers` に貯まり、`goalDraft.toInput()` で `RoadmapInput` に組み立てられる。プロンプトへは**ラベル（日本語）に変換して**渡す（値のままだと AI が意味を取りにくい）。

| フィールド | 質問 | 取りうる値 → ラベル |
|---|---|---|
| `goal_text` | 大目標（自由入力） | 生文字列。最大120字 |
| `frequency_level` | 今の運動頻度 | `none`ほぼしない / `low`週1-2回 / `high`週3回以上 |
| `past_failure_experience` | 習慣が続かなかった経験 | `true`ある / `false`特にない |
| `goal_focus` | 一番近い狙い | `core`お腹引き締め / `stamina`体力 / `posture`姿勢 / `stress_relief`ストレス発散 |
| `time_per_session_minutes` | 1回の時間 | `5`5分以内 / `10`10分程度 / `15_20`15-20分 / `flexible`こだわらない |
| `days_per_week` | 週の日数 | `2`週2日 / `3_4`週3-4日 / `5plus`週5日以上 / `unsure`わからない |
| `equipment_list` | 使える器具（複数可） | `none`自重のみ / `mat`ヨガマット / `dumbbells`ダンベル / `ab_roller`腹筋ローラー / `resistance_band`バンド / `other_gym_equipment`ジム器具 |
| `environment_constraint` | 運動環境 | `quiet_small`狭い・静かに / `moderate`多少音OK / `unrestricted`気にしない |
| `intensity_preference` | きつさの好み | `very_gentle`きついのは辛い / `moderate`多少OK / `challenging`追い込みたい |
| `motivation_style` | 続けるうえで大事なこと | `no_pressure`無理しない / `gradual_change`変化を感じたい / `achievement`達成感 |
| `target_period_weeks` | 期間の希望 | `4`(1ヶ月) / `12`(3ヶ月) / `24`(半年) / `null`(未定) |

**期間未定（`null`）のとき**: AI が `goal_focus` と `frequency_level` から妥当な週数を決める（8〜16週を目安）。出力の `target_period_weeks` には必ず数値を入れる。

---

## 3. 出力仕様（`Roadmap`）

`types/goal.ts` の定義がそのまま `responseSchema` になる。

```
Roadmap {
  goal_id: string            // AI は "gen-<短いランダム>" 等を入れる。保存時に DB 側 UUID で上書きされる
  title: string              // AI が整形した短いプラン名（例「お腹まわり引き締め 12週間プラン」）20字程度
  user_input_raw: string     // ユーザーの元入力をそのまま（ラベル・接頭辞なし）
  target_period_weeks: number // 必ず数値。入力が null なら AI が決める
  milestones: Milestone[]     // 3〜5個
}
Milestone {
  milestone_id: string       // "m1", "m2", ...
  order: number               // 1 始まり連番
  title: string               // 例「体を動かす習慣をつくる」
  period_weeks: number        // この中目標にかける週数。合計 == target_period_weeks
  description: string          // 60〜120字。ずぼら向けの励まし + 何をするか
  tasks: Task[]                // 各マイルストーン 1〜3個
}
Task {
  task_id: string            // "t1", "t2", ... （ツリー全体で一意）
  order: number               // マイルストーン内 1 始まり
  week_number: number         // プラン開始からの週（1 始まり）
  title: string               // 例「基本の体幹メニューに慣れる」
  description: string          // 40〜80字
  frequency_per_week: number   // 1〜6。days_per_week を超えない
  workout_menu_tag: string | null  // §5 の一覧から。合わなければ null
}
```

### 構造ルール
- `milestones` は **3〜5個**。`period_weeks` の合計 == `target_period_weeks`。
- 各 `milestone.tasks` は **1〜3個**（多すぎるとずぼらには重い）。
- `task.week_number` は昇順。マイルストーンの区切りと整合。
- `frequency_per_week` は `days_per_week` のラベルから読める上限を超えない（`週2日`→最大2、`週3-4日`→最大4、`週5日以上`→最大6、`わからない`→最大3）。**安全上限は常に6**。
- 前半のマイルストーンほど負荷を低く。`past_failure_experience=true` なら特に最初の2週を軽く。

---

## 4. システムプロンプト（ドラフト）

> 以下は英日混在の下書き。トーンや語彙は AI担当が調整。ユーザー入力は末尾に構造化して差し込む。

```
あなたは「ずぼら（面倒くさがり）な人でも続けられる」ことを最優先にする、
やさしい運動コーチです。ユーザーの大目標と前提条件から、達成までの
「目標ツリー」を一度だけ生成します。チャットのやり取りはありません。

# 絶対ルール
- 出力は指定された JSON スキーマに厳密に従う。スキーマ外のキー・自然文の前置きは一切出さない。
- 医療・栄養の助言はしない。痛み・持病・妊娠等がありうる前提で、無理をさせない表現にする。
- 「毎日」「限界まで」「絶対に」等のプレッシャー語を避ける。休んでもよいと織り込む。
- ユーザー入力が不適切・危険・目的外（例: 極端な減量、他者への加害）の場合は、
  安全で穏当な内容に読み替えてツリーを作る（拒否や空配列は返さない）。

# 生成方針
- マイルストーンは 3〜5 個。最初は「習慣化」、中盤で「少し負荷」、終盤で「仕上げ」。
- 各マイルストーンの period_weeks の合計は target_period_weeks に一致させる。
- tasks は各マイルストーン 1〜3 個。frequency_per_week は days_per_week の上限を超えない（最大 6）。
- 器具は equipment_list にあるものだけ使う。'none' のときは自重のみ。
- environment_constraint が 'quiet_small' のときはジャンプ・大きな音の動作を避ける。
- intensity_preference と motivation_style を description の語り口に反映する。
- title は 20 字前後の前向きな日本語。description はずぼら向けの短い励まし＋具体。
- workout_menu_tag は下記の一覧から最も近いものを選ぶ。該当なしは null。

# workout_menu_tag 一覧
<§5 の確定版をここに列挙>

# ユーザー入力
大目標: {goal_text}
今の運動頻度: {frequency_level_label}
過去の挫折経験: {past_failure_label}
狙い: {goal_focus_label}
1回の時間: {time_per_session_label}
週の日数: {days_per_week_label}
使える器具: {equipment_labels}
環境: {environment_constraint_label}
きつさの好み: {intensity_preference_label}
大事にしたいこと: {motivation_style_label}
期間の希望: {target_period_weeks or "未定（あなたが決める）"}
```

---

## 5. `workout_menu_tag` タクソノミー（提案・22種）

> 仕様書は「22種類」とだけ。以下は `goal_focus` 4 系統 × 難易度 + 補助で私が起こした**たたき台**。
> AI担当が確定し、将来 `workout_menus` テーブル（CV班が別途作成中）の `exercise_key` と対応付ける。

| # | tag | 内容 | 器具 | 静音 |
|---|---|---|---|---|
| 1 | `core_basic_quiet` | 基本の体幹（プランク・デッドバグ等） | 不要 | ○ |
| 2 | `core_crunch` | クランチ・レッグレイズ | マット | ○ |
| 3 | `core_ab_roller` | 腹筋ローラー | ローラー | ○ |
| 4 | `core_oblique` | 腹斜筋（サイドプランク・ツイスト） | 不要 | ○ |
| 5 | `core_advanced` | 高負荷体幹（V字・ホロウ） | マット | ○ |
| 6 | `stamina_lowimpact` | 静かな有酸素（その場もも上げ・シャドー） | 不要 | ○ |
| 7 | `stamina_cardio` | 通常の有酸素（バーピー・ジャンプ） | 不要 | ✕ |
| 8 | `stamina_interval` | インターバル（HIIT 短時間） | 不要 | ✕ |
| 9 | `stamina_stepper` | 踏み台・階段 | 台 | △ |
| 10 | `posture_stretch` | 姿勢改善ストレッチ（胸開き・肩甲骨） | 不要 | ○ |
| 11 | `posture_back` | 背面強化（バックエクステンション・Y-T-W） | マット | ○ |
| 12 | `posture_hip` | 股関節まわり（ヒップリフト・クラム） | 不要 | ○ |
| 13 | `posture_neck_shoulder` | 首肩こり向け軽運動 | 不要 | ○ |
| 14 | `stress_flow` | ゆるいフロー（ヨガ的・呼吸） | マット | ○ |
| 15 | `stress_walk` | 散歩・軽い外出 | 不要 | ○ |
| 16 | `stress_mobility` | 全身モビリティ（関節ゆるめ） | 不要 | ○ |
| 17 | `lower_bodyweight` | 下半身自重（スクワット・ランジ） | 不要 | ○ |
| 18 | `lower_weighted` | 下半身加重（ダンベルスクワット等） | ダンベル | ○ |
| 19 | `upper_bodyweight` | 上半身自重（腕立て・ディップス） | 不要 | ○ |
| 20 | `upper_band` | バンドトレ（ローイング・プレス） | バンド | ○ |
| 21 | `fullbody_beginner` | 全身入門サーキット（低負荷） | 不要 | △ |
| 22 | `rest_active` | アクティブレスト（軽い動き・休養日の推奨） | 不要 | ○ |

---

## 6. モデル・API・キー管理

| 項目 | 決定（要確認） |
|---|---|
| SDK | `@google/genai`（旧 `@google/generative-ai` は非推奨）|
| モデル | 仕様書は `gemini-3.5-flash`。**この名前は現行 API に無い可能性が高い** → 実装時に [ai.google.dev のモデル一覧](https://ai.google.dev/gemini-api/docs/models) で現行の flash 系（gemini-3.x-flash 相当）を確認して `GEMINI_MODEL` 定数に。|
| 構造化出力 | `responseMimeType: "application/json"` + `responseSchema`（`Roadmap` 構造）。必須。|
| キーの置き場 | まず `EXPO_PUBLIC_GEMINI_API_KEY`（`.env`。`.gitignore` 済みか確認）。クライアント直呼びなのでキーはアプリバイナリに露出する。学内デモ用途なら許容、本番前に Supabase Edge Function へ移す。|
| レイテンシ | 数十秒想定。`goal/generating` の待ち画面で吸収済み。タイムアウトは 60s。|

---

## 7. エラー処理・フォールバック

`generateRoadmap` は**必ず `Roadmap` を返すか throw する**（UI 契約）。`generating.tsx` は catch で「もう一度試す」を出す。

| ケース | 挙動 |
|---|---|
| API キー未設定 | 開発時: `buildMockRoadmap` を返す（現行の挙動を残す）。本番ビルド: throw。|
| ネットワーク/API エラー | throw（`generating.tsx` がリトライ UI）|
| JSON パース失敗・スキーマ不一致 | 1 回だけ自動リトライ → だめなら throw |
| `milestones` が空 / 期間合計が合わない | 軽く補正（合計を最後のマイルストーンで吸収）してから返す |

---

## 8. 実装ステップ（このドキュメント確定後）

1. `npx expo install`（または npm）で `@google/genai` 追加
2. `.env` に `EXPO_PUBLIC_GEMINI_API_KEY`、`.env.example` も追加、`.gitignore` 確認
3. `lib/goal-prompt.ts` — `RoadmapInput` → プロンプト文字列（ラベル変換 + §4 テンプレ）
4. `constants/workout-menu-tags.ts` — §5 のタグを配列で（プロンプトにも使う）
5. `services/goalService.ts` — `generateRoadmap` を実装（キー無ければ mock フォールバック）
6. `goalService` の `responseSchema` は `types/goal.ts` から手書き変換（Gemini の Schema 形式）
7. 実機/シミュレータで 10問 → 生成 → `goal/index` 表示まで確認
8. （別 PR）永続化: `goal_trees`/`milestones`/`tasks` テーブル + save/fetch
