# Throttle / burst capacity 調査 (v0.8.13 〜 v0.8.15)

`chat-bulk-export.js` を 632 会話のアーカイブ用途で連用した結果、ChatGPT の conversation API が時間あたり一定件数しか処理できず、`burst`(連続成功する区間)→ `throttle`(429 連発)→ `pause`(自動停止)→ `休止` のサイクルを繰り返すパターンが観察された。本稿は v0.8.14 / v0.8.15 の throttle 対策を入れた経緯と、burst の上限を決める要因についての観察・仮説・検証実験を記録する。

## 1. 観察された現象

### 1.1 v0.8.13 run のバケット分布

5/10 20:27 〜 5/11 05:20 にかけて単一フォルダで bulk 実行。完了した会話 `.md` のタイムスタンプを 5 分以上のギャップで区切ると次の通り:

```
20:27:24 ──┐
           │ 26 件 (16 分間, 1.6 件/分)
20:43:43 ──┘
           │ 152 分 休止
23:16:13 ──┐
           │ 196 件 (43 分間, 4.5 件/分)
           │ 内部に 5/7/5 分の小ギャップ (cooldown 60-120 秒に相当)
23:47:07 ──┘ + 隣接 9 件
           │ 182 分 休止
03:10:45 ──┐
           │ 230 件 (48 分間, 4.8 件/分)
03:58:32 ──┘
           │ 32 分 休止
04:39:04 ──┐ 52 件 (1.5 件/分)
05:10:33 ──┐ 30 件 (1.5 件/分)
05:20:45 ──┘
```

**特徴**:

- 高速 burst (`4.5–4.8 件/分`) は 23:16〜 と 03:10〜 の 2 回だけ起きており、いずれも直前に 150 分超の長休止を伴っている。
- 短い休止 (19〜32 分) の後の burst は 30〜52 件で頭打ちになり、ペースも `1.5 件/分` 程度に下がる。
- burst の長さは 43〜48 分とほぼ等しい。

### 1.2 burst 内部のペースと throttle 対応

高速 burst の内部は 1 件あたり 3〜15 秒で進む。スクリプトの設計値:

- `perConversationDelayMs = 1500` (初期値, [chat-bulk-export.js](../chat-bulk-export.js))
- API レイテンシ ~1-3 秒
- 合計 ~3〜5 秒/件 → 43 分間で約 500 件処理可能なはずだが、実際には 200 件前後で頭打ち

つまり burst capacity は **delay でも API レイテンシでもなく、ChatGPT 側のレート制限**で決まっている。

### 1.3 v0.8.13 / v0.8.14 / v0.8.15 のバージョン履歴

burst の終わり方は version によって異なる:

| version | pause 条件 | 実機での pause タイミング |
|---|---|---|
| v0.8.13 まで | 通算 throttle 5 回 (monotonic counter) | 短時間で 5 回到達して強制 pause |
| v0.8.14 | 連続成功 25 件で counter を 1 段階 decay | 25 件閾値に届かず実質 v0.8.13 と同じ動作 |
| v0.8.15 | 連続成功 5 件で decay + ladder を 6 段階に拡張 | throttle ladder ではなく `maxBatchPauseMs` (15 分累積) で pause |

v0.8.15 の実機テスト ([throttle decay の実効化](../chat-bulk-export.js#L2) 参照) では 4 回の decay が確実に発火し、`throttleCount` は 0〜4 で oscillation した。pause 条件は `maxBatchPauseMs` 超過に変わり、これはレート制限の構造そのものに起因する自然な停止条件である。

## 2. 仮説

burst capacity (1 回の連続成功で処理できる会話数) を決めるのは何か。

### H1: quota refill モデル (休止時間 → capacity)

ChatGPT 側に「直近 N 時間あたりの conversation API 呼び出し可能回数」のような quota が存在し、休止中に線形ないし飽和的にリフィルされる。`t_rest` ≥ 2.5h で完全リフィル、それ未満では比例的に小さい capacity になる。

**根拠**:

- 152 分休止 → 196 件 / 182 分休止 → 230 件 と、休止時間と burst capacity に正の相関が見える
- 32 分休止後の 52 件、19 分休止後の 30 件は明らかにスケールダウンしている
- ChatGPT のレート制限ドキュメントには明示的な「1 時間あたり N 回」表記がないが、実装上 sliding window 系の制御を採用するのが一般的

### H2: ピーク負荷モデル (時刻 → capacity)

ChatGPT 全体の負荷が低い時間帯ほど capacity が大きくなる。JST 23時 / 03時 (US 西海岸 7時 / 11時) は米国昼〜夕方のピークから外れる。

**根拠**:

- 観察された高速 burst は 2 回とも深夜帯 (23時, 03時)
- 朝方 (04:39, 05:10) は短い休止しかなかったとはいえ capacity が顕著に低い
- ただし観察データだけからは時刻と休止時間の効果を分離できていない

### H3: リソース独立モデル (asset/サイズ非依存)

burst capacity は完了した「会話数」に比例し、各会話の asset 数や本文長には依存しない。すなわち conversation API の呼び出し回数だけが quota を消費し、file API は独立。

**根拠**:

- 23 時 burst の `assets/` 書き込みは 203 件、03 時 burst は 209 件あり、asset ダウンロードも並行進行していた
- 「軽い会話だけ並んでいたから速かった」説は assets/ 書き込み実績で棄却
- conversation API と file API のクォータが別系統である可能性が高い (現行コードでも cooldown を分離している)

仮説 H3 が正しい場合、heavy な会話 (asset 多) は burst capacity を等価に消費するが、各会話の処理時間は file API ダウンロードで長くなる。

## 3. 既存データからの弱い証拠

新たに run を行わなくても、v0.8.13 の bucket データで H1 は粗く検証できる:

| 直前休止 (分) | burst capacity (件) | 件数/分 |
|---:|---:|---:|
| 0 (run 開始直後) | 26 | 1.6 |
| 19 | 30 | 1.5 |
| 32 | 52 | 1.6 |
| 152 | 196 | 4.5 |
| 182 | 230 | 4.8 |

- N=5 と小さく、初期 26 件は scope filter の影響もあり比較対象として弱い
- それでも `t_rest` ≥ 120 分で capacity が **3 倍以上**ジャンプしているのは明らか
- H2 (時刻) と H3 (asset) はこのデータからは分離できない

## 4. 検証実験

### 4.1 前提となる軽量 instrumentation (v0.8.16 想定)

実験を回す前に、run ごとのメタデータを構造化出力すると後の集計が楽になる。`chat-bulk-export.js` のバッチ完了時に次を追加する。

**重要**: v0.8.15 以降は throttle decay によって 429 を踏みながら復帰して進むため、「最初の 429 までの純粋 burst」と「pause までに取れた総量」は別の量である。これらを混同しないよう metric を **4 系統に分けて** 出力する。

```js
const runStats = {
  startedAt, endedAt,
  scope: OPTIONS.scope,
  totalConversations: targets.length,
  succeeded, skippedConv, failedConv, pausedConv,

  // burst / throttle 系
  preFirstThrottleSuccessCount,   // 最初の 429 までに成功した件数 = 純粋 burst capacity
  firstThrottleAt,                // ISO 時刻、null なら 429 観測なし
  successBeforePause,             // pause 直前までの累計成功件数 (= succeeded)
  conversation429Count,           // run 内の通算 429 / 503 観測回数
  cooldownPauseMs,                // cooldown 累積待機 (ms)。maxBatchPauseMs と比較する基準

  // イベント詳細 (時系列復元用)
  throttleEvents: [...],          // { at, count, ladderIndex, cooldownMs }
  decayEvents: [...],             // { at, before, after }
  pauseReason,                    // 'maxBatchPauseMs' | null
                                  // (v0.8.15 で 'throttleLadderExceeded' は実質発生しないが、
                                  //  将来 ladder 上限到達もありうるため値として残す)
};
console.log('   📊 run-stats:', JSON.stringify(runStats));

// JSONL 形式で _bulk-run-stats.jsonl に 1 run 1 行で追記。manifest を reset する
// 実験計画では、後から `gapBeforeRun` (前回 run 終了 → 今回開始の時間) を復元する
// 必要があるため、console 出力だけでなくフォルダ内ファイルにも残す。
appendRunStatsJsonl(runStats);
```

`_bulk-run-stats.jsonl` のフォーマット例:

```jsonl
{"startedAt":"2026-05-12T13:00:00.000Z","endedAt":"2026-05-12T13:45:32.421Z","preFirstThrottleSuccessCount":196,"firstThrottleAt":"2026-05-12T13:43:21.000Z","successBeforePause":205,"conversation429Count":3,"cooldownPauseMs":270000,"pauseReason":null,...}
{"startedAt":"2026-05-12T16:00:00.000Z",...}
```

集計は `jq -s '.[] | {gap, capacity: .preFirstThrottleSuccessCount}' _bulk-run-stats.jsonl` のように 1 行で書ける。

### 4.2 実験 1: H1 (休止時間 → burst capacity)

**目的**: `t_rest` と burst capacity の関係を測定する。

**手順**:

1. 完全リフィル状態を確保: 12 時間以上の休止後にスタート
2. 計画的休止時間で次の系列を実施:
   - `t_rest ∈ {30, 60, 90, 120, 180, 240}` 分の 6 ポイント
3. 各 run は `scope: { type: 'latest', count: 300 }` で頭打ち手前まで走らせる
4. burst capacity を計測。`_bulk-manifest.json` は毎回バックアップして reset (resume が効いて burst 計測にならないため)

**集計**: `t_rest` vs `burst_capacity` の散布図

- 線形なら「quota は線形リフィル」
- S 字なら「飽和点あり」(H1 と整合)
- 平坦なら H1 棄却

**所要時間**: 6 run × (burst ≤ 45 分 + 計画休止平均 2 時間) ≈ 14 時間。1 日で全 6 ポイント取得可能。

**改良**: 各 `t_rest` で 2 回ずつ取って平均化するなら 2-3 日に分散する。

### 4.3 実験 2: H2 (時刻 → burst capacity)

**目的**: 同じ `t_rest` でも時刻によって capacity が変わるか。

**手順**:

1. `t_rest = 180 分` で固定して、開始時刻だけ変える
2. JST 03時 / 09時 / 15時 / 21時 の 4 点 (6 時間刻みで quota 干渉を避ける)
3. 各 run 同じ scope (`latest 300`)
4. burst capacity を計測

**集計**: 開始時刻 vs `burst_capacity`。深夜帯が明らかに大きいなら H2 支持。

**所要時間**: 6 時間 × 4 = 24 時間サイクル、計 4 日。ノイズ要因 (日々のグローバル負荷変動) を抑えるため、できれば 2-3 日繰り返し。

### 4.4 実験 3: H3 (asset/サイズ → 影響)

**目的**: 重い会話が burst capacity を消費するか。

**手順**:

1. `scope: { type: 'idList', ids: [...] }` で次の 2 セットを準備:
   - **軽セット 100 件**: 既存 `_bulk-manifest.json` から asset 0 件かつ md サイズ < 5KB の会話
   - **重セット 100 件**: asset ≥ 10 件の会話
2. 同じ `t_rest = 180 分` で連続実施 (順序はランダム化)
3. 計測:
   - burst capacity (会話数)
   - 平均会話処理時間
   - 最初の throttle 発火までの実時間 (秒)
   - throttle までの conversation API 呼び出し総数

**集計**:

- 両者の conversation API 呼び出し総数が同程度なら H3 支持
- 重セット側で早く throttle が出るなら H3 棄却

**注**: 軽 vs 重を連続実施すると quota 干渉あり。日を分けるか、間に十分な休止を挟む。

### 4.5 最小工数版

3 つすべてやらず、H1 だけを 3 ポイントで確認:

| `t_rest` | 期待 capacity |
|---|---|
| 60 分 | < 100 件 |
| 120 分 | ~ 150 件 |
| 180 分 | ~ 200 件 |

合計約 8 時間で結論が出る。H1 が立証できれば、H2/H3 は実用上の優先度が下がる (深夜運用 + 休止主義で運用可能)。

### 4.6 観察実験 (新規 run 不要)

既存ログ (5/10〜5/11 の 3148 + 3373 秒分) から:

1. resume ごとの `(gap before resume, burst capacity)` ペアを抽出
2. 散布図にプロット
3. 既存 5 点 ({16/26, 32/52, 19/30, 152/196, 182/230}) で直線回帰

コスト 0 で H1 のおおよその傾向を確認できる。実験 1 の前にまずこれを実施するのが現実的。

## 5. 実用上の運用指針 (現行の v0.8.15 ベース)

仮説検証を待たずとも、観察データから言える運用ルール。**用途別に分けて考える**のが重要:

### 5.1 短期続行 (1 セッションで進めるだけ進めたい)

- pause 後 **10〜30 分** 空けて resume すると、capacity 30〜50 件程度の小 burst で再開できる
- 1 日のうちで「進められる時に進める」運用に向く
- 現行の [README.md](../README.md) の「10〜30 分空けて resume」案内はこの用途を念頭に置いている

### 5.2 1 run あたりの burst 最大化 (効率的に量を稼ぎたい)

- **2.5〜3 時間以上**空けてから resume すると、capacity 200 件前後の高速 burst (4〜5 件/分) が期待できる
- 短い休止の 4〜6 倍効率的
- **深夜帯 (JST 23時前後 / 03時前後)** に走らせるとさらに有利 (H2 が成立する前提)
- 632 件規模なら **3〜4 burst = 約 1 日** で完走できる目安

### 5.3 共通

- v0.8.15 の throttle decay (5 件成功で 1 段階 decay) は burst 中の小ギャップ (5-7 分の中 cooldown) を生き残るための機構として正しく機能している
- pause メッセージが `maxBatchPauseMs` (既定 15 分) 超過なら quota 枯渇による自然停止
- README の現行案内は短期続行寄りで、5.2 の「2.5〜3 時間休止 → 1 burst で 200 件」運用は本調査で初めて明確化された。実装と doc の整合は §7 参照

## 6. 推奨優先順位 (v0.8.16 計画)

次の順で進めるのが現実的:

1. **観察実験 (既存ログから集計)** — まずこれ。コスト 0 で H1 のおおよその傾向を確認
2. **v0.8.16 として instrumentation 実装** — §4.1 の `runStats` + `_bulk-run-stats.jsonl` 出力を追加。同時に §7 の docs drift も解消する
3. **実験 1 の最小版 (60/120/180 分の 3 ポイント)** — H1 を能動的に裏取り。半日
4. **実験 2 (時刻軸)** — H2 はそもそも実用上「深夜にやれば良い」で済むので、検証より運用ルール化のほうが早い
5. **実験 3 (asset/サイズ)** — 一番後回し。理論的興味中心

## 7. ドキュメントドリフト解消ログ (v0.8.16 で対応済)

調査時点 (v0.8.15) で実装と既存 docs の間に次のズレが残っていた。v0.8.16 の instrumentation 実装と同時に解消済。

| ファイル | ズレ (v0.8.15 時点) | 解消後 (v0.8.16) |
|---|---|---|
| [AGENTS.md](../AGENTS.md) | `OPTIONS.maxBatchPauseMs`（既定 5 分） | **既定 15 分** に修正 + 6 段階 ladder と 5 件成功 decay の併記 |
| [AGENTS.md](../AGENTS.md) | 累積待機超過が「唯一の throttle 起点の停止条件」 | `throttleLadderExceeded` と `maxBatchPauseMs` の 2 経路併存に修正 |
| [CLAUDE.md](../CLAUDE.md) | conversation 側は…通算 **5 回** の throttle で…一時停止 | 6 段階 ladder + 5 件成功 decay の説明に置き換え。pause 経路を 2 種類で明示 |
| [CLAUDE.md](../CLAUDE.md) | 段階 cooldown + 通算 **5 回**で一時停止 | 同上 |
| [README.md](../README.md) | 通算 **5 回**に達した場合や cooldown の累積待機が上限を超えた場合 | `throttleLadderExceeded` / `maxBatchPauseMs` の 2 経路を明示。短期続行 (10〜30 分) と burst 最大化 (2.5〜3 時間) の使い分けも追加 |
| [README.md](../README.md) | `maxBatchPauseMs` テーブル説明で「通算閾値で早めに一時停止」 | pause の 2 経路を明示、実機では `maxBatchPauseMs` 経路が支配的と注記 |
| [README.md](../README.md) | 出力フォルダ構造に `_bulk-run-stats.jsonl` の記載なし | エントリ追加 |
| [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) | runStats / `_bulk-run-stats.jsonl` の言及なし | bulk 節に追記、本ドキュメント §4.1 へのリンクを設置 |

§5 で示した「2.5〜3 時間休止 → 1 burst 200 件」の運用パターンも v0.8.16 で [README.md](../README.md) §失敗時 に反映済。

## 関連ファイル

- [chat-bulk-export.js](../chat-bulk-export.js) — v0.8.16 実装
- [README.md](../README.md) §一括エクスポート — 運用方針とトラブルシューティング
- [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) — 設計上の前提
