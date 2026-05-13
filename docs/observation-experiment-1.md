# 観察実験 1: 休止時間と burst capacity の関係

[docs/throttle-burst-investigation.md](throttle-burst-investigation.md) §4.6 で計画した観察実験を、2026-05-10 〜 2026-05-11 の bulk export 2 ディレクトリから既存 manifest を集計して実施。新しい run は不要。

## 入力

- `chatgpt-export-v0.8.13/_bulk-manifest.json` (543 件、status=done 543) — 最終更新 2026-05-11 05:21 JST
- `chatgpt-export-v0.8.14/_bulk-manifest.json` (399 件、status=done 399) — 最終更新 2026-05-11 12:00 JST

両 manifest とも全エントリが status=done で failed が無い。各エントリの `exportedAt` (ISO 8601 / UTC, `Z` 付き) を時系列ソート。本ドキュメント中の時刻表示は **UTC + 9 時間で JST に換算**したもの。生の JSON フィールドは UTC であることに注意 (`runStats.startedAt` 等も同様)。

### 追補 (2026-05-12, v0.8.16 runStats から)

`v0.8.16` 以降の `_bulk-run-stats.jsonl` から得た 2 点を本分析に追加した:

| run | UTC 開始 | JST 開始 | 直前 gap | `preFirstThrottleSuccessCount` |
|---|---|---|---:|---:|
| Run 1 | 2026-05-11 15:33:43Z | 2026-05-12 00:33 JST |   753 分 | 261 |
| Run 2 | 2026-05-11 18:26:39Z | 2026-05-12 03:26 JST |    91 分 | 119 |

Run 1 の直前 gap = 前回 export 終了 (2026-05-11 03:00 UTC = 12:00 JST) → Run 1 開始 (15:33 UTC) = **12.5 時間 = 753 分**。

### 追補 (2026-05-13, v0.8.17 で 3 ラン追加 / N=12 に拡張)

`v0.8.17` を同じアカウントで連続 3 セッション実行し、観察データに 3 点を追加した:

| run | UTC 開始 | UTC 終了 | JST 開始 | 直前 gap | `preFirstThrottleSuccessCount` | 終了理由 |
|---|---|---|---|---:|---:|---|
| Run A | 2026-05-12 02:56:56Z | 04:22:58Z | 05-12 11:56 JST | 183 分 (前回 23:53:43Z 終了からの間隔) | **246** | maxBatchPauseMs |
| Run B | 2026-05-12 11:39:53Z | 12:38:28Z | 05-12 20:39 JST | 437 分 (Run A 終了からの間隔) | **239** | maxBatchPauseMs |
| Run C | 2026-05-12 13:58:36Z | 14:26:58Z | 05-12 22:58 JST | 80 分 (Run B 終了からの間隔) | **95** | 完走 (pause なし) |

3 ラン合計 272 + 257 + 108 = 637 件 (1 件は conv の `update_time` 変動による再エクスポート) で **全 636 件 done**。

これらを Run 1/2 と合わせて N=12 に拡張する。

## 手法

連続する 2 件の export 完了時刻の差を `gap` とし、**`gap ≥ 10 分`** を run 境界と判定する。

10 分閾値の根拠: conversation cooldown ladder は v0.8.15 で 60/90/120/180/240/300 秒 (最大 5 分)。1 回の cooldown では 5 分を超えないが、連続 cooldown と delay の合算を考慮して 10 分マージンを確保。それ未満の gap は throttle 起因の intra-run cooldown とみなして同一 run に含める。

各 run について `(直前の run 終了 → 今回の run 開始) の gap` と `今回の run の成功件数 = capacity` を抽出。

## データ

| gap (分) | capacity (件) | 出典 | run 開始時刻 (JST) |
|---:|---:|---|---|
|  15.2 |  40 | v0.8.14 | 05-11 06:10 |
|  19.9 |  30 | v0.8.13 | 05-11 05:10 |
|  30.7 |  73 | v0.8.14 | 05-11 07:06 |
|  32.4 |  44 | v0.8.13 | 05-11 04:39 |
|  80.1 |  95 | v0.8.17 runStats | 05-12 22:58 (Run C) |
|  91.0 | 119 | v0.8.16 runStats | 05-12 03:26 (Run 2) |
| 152.5 | 205 | v0.8.13 | 05-10 23:16 |
| 182.4 | 238 | v0.8.13 | 05-11 03:10 |
| 183.2 | 246 | v0.8.17 runStats | 05-12 11:56 (Run A) |
| 188.9 | 251 | v0.8.14 | 05-11 10:57 |
| 436.9 | 239 | v0.8.17 runStats | 05-12 20:39 (Run B) |
| 753.0 | 261 | v0.8.16 runStats | 05-12 00:33 (Run 1) |

N = 12。これとは別に「初回 run」(直前 gap が観測不能なエントリ) が 2 件あり、それぞれ 26 / 35 件。

```
capacity
   264 |                                                            ●  (189, 251)
   251 |                                                         ●     (182, 238)
   238 |                                                ●              (153, 205)
   ...
    83 |          ●                                                    (31, 73)
    55 |          ●                                                    (32, 44)
    41 |    ● ●                                                        (15, 40), (20, 30)
   ----+----------------------------------------------------------+----
        0       50       100      150      200 分
```

## 回帰

### N=7 (初版、観測範囲 15-189 分のみ)

初版では gap が 189 分以下に限られていたため、線形と飽和でほぼ同等の fit が得られていた:

| モデル | パラメータ | R² (N=7) |
|---|---|---:|
| 線形 | `1.23 × gap + 16.5` | 0.989 |
| 飽和 | `400 × (1 - exp(-gap/200))` | 0.987 |

### N=9 (v0.8.16 runStats の 2 点を追加して再フィット)

長 gap 領域 (753 分) のデータが加わったことで、**線形は崩壊し、飽和モデルのパラメータも大きく修正**された:

| モデル | パラメータ | R² (N=9) |
|---|---|---:|
| 線形 | `0.30 × gap + 91.4` | **0.500** ← N=7 時の 0.989 から大幅劣化 |
| 飽和 | `275 × (1 - exp(-gap / 115))` | **0.958** |

予測値の対比 (太字は実測との誤差大):

| gap (分) | 線形予測 | 飽和予測 (新) | 旧飽和 (C=400, τ=200) | 実測 |
|---:|---:|---:|---:|---:|
|  15 |  96 |  34 |  29 |  40 |
|  20 |  97 |  44 |  38 |  30 |
|  31 | 101 |  64 |  57 |  73 |
|  32 | 101 |  68 |  60 |  44 |
|  91 | 119 | 150 | 146 | 119 |
| 153 | 137 | 202 | 213 | 205 |
| 182 | 146 | 219 | 239 | 238 |
| 189 | 148 | 222 | 245 | 251 |
| 753 | 317 | 275 | **391** | **261** |

753 分点で旧飽和モデルは 391 件と予測したが、実測 261 件で **130 件**外した。新飽和モデルは 275 件と予測し誤差 14 件 (5%) に収まる。

### N=12 (v0.8.17 の 3 ラン Run A/B/C を追加して再フィット)

3 ラン (gap=80 / 183 / 437 分) を追加すると C_max / τ がわずかに動き、R² は **0.958 → 0.933 へ低下**:

| モデル | パラメータ | R² (N=12) |
|---|---|---:|
| 飽和 | `271 × (1 - exp(-gap / 116))` | 0.933 |

ただし C_max・τ の値はほぼ変わらない (`275 / 115` → `271 / 116`)。データ点別の誤差を見ると、**新 3 点のうち 2 点が飽和モデルから明確に外れている**:

| gap (分) | 飽和予測 (N=12 fit) | 実測 | 誤差 |
|---:|---:|---:|---:|
|  80.1 (Run C) | 135 |  **95** | **−40** |
|  91.0 (Run 2) | 147 | 119 | −28 |
| 153 / 182 / 183 / 189 | 198-218 | 205-251 | ±15 以内 |
| 437 (Run B) | 265 | **239** | **−26** |
| 753 (Run 1) | 271 | 261 |  −10 |

**Run C (80 分点)** が予測 135 → 実測 95 と **40 件もアンダーシュート**しているのが新しい所見。Run C 前に Run B (gap 437 分) → maxBatchPauseMs で pause したばかりなので、**Run B の終盤で bucket は強くドレインされた状態**で 80 分しか休まずに Run C を始めた。

**Run B (437 分点)** も予測 265 → 実測 239 と −26 のアンダーシュート。これは Run A (183 分点 / 246 件) → maxBatchPauseMs pause → 7.3 時間休止後の状況で、休止時間としては十分なはずだが完全には quota が戻っていなかった。

### Run C (80 分点) アンダーシュートの解釈 — 仮説 3 通り

Run C の 95 件は予測 135 を **40 件下回った**。原因は単一には絞れず、以下 3 仮説が考えられる:

#### 仮説 1: pause penalty (直前 run が pause で終わった効果)

Run B が `maxBatchPauseMs` で強制 pause した直後の 80 分休止で Run C を始めた。pause で終わるということは server が「これ以上は与えない」と判断した状態で、そこからの bucket 回復は単純な指数より遅い可能性。

#### 仮説 2: workload composition の違い (per-conversation の API 呼び出し数)

Run C が処理した 108 件は **更新順で末尾 = 最古会話**で、asset (画像/添付) がほぼ無い。1 会話あたり `/backend-api/conversation/<id>` を 1 回叩くだけで完結する。

一方 Run 1/A/B が処理したのは新しい会話で、各会話で `/files/<id>/download` を多数叩いている。**server の bucket が `/backend-api/*` 全体共有モデル**だと、API 呼び出しの "総回数" で比較すると Run 1/A/B の方が Run C より圧倒的に多く消費している。すなわち Run C の「95 件で throttle」は「真の bucket は Run 1 と同等だが、per-conv の API 呼び出しが少ないので /conversation/ 単位の throttle が早く起きた」可能性。

この場合、本観察データの y 軸を「件数 (conversation count)」から「API call 数 (conversation + file download の合算)」に変換しないと適切な比較ができないことになる。

#### 仮説 3: 上記の混合

両方の効果が重なっている可能性。

### データだけでは仮説 1 vs 2 を切り分けられない

3 仮説のうちどれが支配的かを決めるには追加データが必要:

- 仮説 1 検証: **自然完走後の short gap** で次 run の preFirstThrottle を観測 (今のデータには無い組み合わせ)
- 仮説 2 検証: **古い会話を意図的に新しい会話と入れ替えた order** で run を実施し、conversation 別の API 呼び出し数の差を消す。または manifest の `stats.saved` (保存 asset 数) を変数に加えた多変量回帰

現状の N=12 観察では、Run C の 95 件アンダーシュートは「興味深いが原因未確定」が正確な結論。

### 結論 (N=12 時点)

- **線形仮説は引き続き棄却** (省略)
- **飽和モデルは依然支持**: N=12 でも `C_max ≈ 271, τ ≈ 116` で R² = 0.933
- **C_max ≈ 270** で頭打ち (N=9 fit の 275 とほぼ一致)
- **τ ≈ 115 分** (N=9 fit と同等)
- **新所見**: Run C (80 分点) の 95 件 vs 予測 135 の 40 件アンダーシュートは複数仮説 (pause penalty / workload composition / 混合) が並立し、現データでは切り分け不能。「conversation 件数」だけでなく「総 API call 数」を変数として観測する必要があるかもしれない

## 結論

### H1 (休止時間 → capacity) は飽和モデルで支持される

- N=9 で再フィットすると **C_max ≈ 275, τ ≈ 115 分** の飽和モデルが R² = 0.958 で当てはまる
- 観測範囲が 15-189 分に限られていた初版 (N=7) では線形と飽和が同等に見えたが、753 分点を加えると **線形は明確に棄却**された (R² 0.500)
- 初回 run の小ささ (26 / 35 件) は「事前休止が観測できない短時間の事前活動」状態と整合し、飽和モデルの低 gap 領域とも合致

### 線形 vs 飽和の判別は完了

- 旧 N=7 fit (C_max=400, τ=200) は **観測範囲外への外挿エラー**だった
- 新 N=9 fit (C_max=275, τ=115) では 753 分の予測誤差 5% と良好な fit
- **「3 時間以上空けても更に伸びるのか、それとも 275 件付近で頭打ちか」→ 後者が確認された**

### H2 (時刻軸) について

データ点の run 開始時刻 (v0.8.17 の 3 点を含む):

- 03:10 JST → capacity 238 (gap 182 分)
- 04:39 JST → capacity 44 (gap 32 分)
- 05:10 JST → capacity 30 (gap 20 分)
- 05:32 JST → capacity 35 (gap N/A)
- 06:10 JST → capacity 40 (gap 15 分)
- 07:06 JST → capacity 73 (gap 31 分)
- 10:57 JST → capacity 251 (gap 189 分)
- 23:16 JST → capacity 205 (gap 152 分)
- **11:56 JST → capacity 246 (gap 183 分) — Run A**
- **20:39 JST → capacity 239 (gap 437 分) — Run B**
- **22:58 JST → capacity 95 (gap 80 分) — Run C**

直前 gap に強く支配されており、**時刻単独で capacity が変わる強い兆候は依然見えない**。深夜帯 (23:16, 03:10) のスコアが高いのは事実だが、これらは長い gap (152, 182 分) を伴う。日中帯 (10:57, 11:56) でも gap 183-189 分で 246-251 件と同等の capacity が出ており、**時刻軸の影響は無視できる**。**H2 は弱く棄却**。

ただし「日中に 7 時間休止」(Run B, 20:39 JST, gap 437 分) が予測の 265 → 実測 239 と −26 のアンダーシュートをしているのは時刻 OR 累積消費の効果の可能性があり、完全な切り分けには追加サンプルが必要。

### H3 (asset/サイズ非依存) について

run ごとの asset 数や会話サイズの相関は本観察では分析せず。manifest には `stats.saved` (保存 asset 数) と `stats.jsonAssetCount` が含まれているため、別途分析可能。今回はスコープ外。

## 次の能動実験への含意

### 線形/飽和判別は完了。残るのはモデル精度の改善

旧計画では「300 分点で線形 vs 飽和を判別」が主目的だったが、Run 1 の 753 分点で既に決着している。残る課題:

### 1. Run C アンダーシュートの原因切り分け

N=12 で見つかった **Run C の 95 件 (予測 135 から −40)** には複数仮説あり、現データで切り分け不能 (上記§参照)。検証用ラン:

#### 1a. pause penalty 仮説の検証

| ラン | シナリオ | 期待される観測 |
|---|---|---|
| 自然完走 → 80 分休止 → 次 run | pause なしで終わってから 80 分後 | 飽和モデル予測 (135 件) に近ければ pause penalty 仮説支持 |
| pause → 80 分休止 → 次 run | (= Run C で観測済) | 95 件 (アンダー) |
| pause → 240 分休止 → 次 run | 4 時間休めば完全リカバリーするか | 240 件付近なら回復済、依然アンダーなら長期 penalty |

#### 1b. workload composition 仮説の検証

| 試行 | 期待される観測 |
|---|---|
| 最古 108 会話だけを scope に指定して fresh run | Run C 同等 (95 ± 数件) なら workload 仮説支持 |
| 最新 108 会話だけを fresh run | preFirstThrottle が Run C より明らかに高ければ asset 多寡が効いている |
| `stats.saved`/`stats.jsonAssetCount` を含めて多変量回帰 | per-conversation の API 呼び出し数を変数化して、capacity vs API call の関係に整理 |

### 2. 中 gap 領域 (40-90 分) の点数追加

依然として中 gap 領域は薄い。ただし上記 1. の累積消費効果検証と組み合わせれば共有可能。

| `t_rest` (分) | 目的 | 飽和予測 (N=12 fit) |
|---:|---|---:|
|  60 | 中 gap で τ 精度確認 |  113 |
| 120 | C_max 接近域確認 | 169 |
| 240 | プラトー入り口 | 236 |

### 3. 運用上の指針 (本観察データから直接導ける)

- **1 burst の天井は約 270 件** (C_max ≈ 271, N=12 fit)
- **3 時間 (τ ≈ 116 分の 1.5 倍) で約 80% リフィル**、5 時間で 95% リフィル
- 12 時間以上空けても 270 件以上にはならない
- 632 件規模なら **3 burst (各 250 件) × 3 時間休止**で 1 日完走可能
- ただし **pause で終わった直後の short gap (≤90 分) または 古い会話 (asset 少) ばかりが残った状況では capacity が大幅に低下** (Run C で 95 件)。原因未確定だが、3 burst 戦略では各 burst 間に最低 3 時間休止を確保すれば安全

## 補足: asset 取得失敗の diag 分析 (v0.8.17 で追加)

v0.8.17 で `_bulk-asset-failed.log` に 7 列目 `diag` を追加し、backend response body の先頭 500 文字を残せるようにした。3 ラン (2026-05-12) の合計 147 件 (Run A/B/C 全 conversation 横断、" 2.log" duplication で 128+19 に分裂したのを統合) の diag 分布:

| reason | diag (error_code) | 件数 | 解釈 |
|---|---|---:|---|
| `no_signed_url` | `file_not_found` | 116 | user upload (`file-…`) の実体が消えている。**99%** がこの状態 |
| `no_signed_url` | `permission_error` | 1 | 共有取り消し / 古い composite asset。要再ログイン検証 |
| `HTTP 404` | `{"detail":"File not found"}` | 28 | sediment (`file_…` / 生成画像) の実体消失 |
| `signed_HTTP 404` | (空) | 1 | 署名 URL 取得後の CDN 失敗 (タイミング起因) |
| `HTML_response` | (HTML body 先頭) | 1 | backend がエラー HTML を返した稀ケース |

判明事項:

1. **`no_signed_url` は 99% `error_code=file_not_found`** で backend が「実体が無い」と明示。再取得不可能。
2. **`permission_error` は 1 件のみ**で composite asset (`file-TlMOJTBvO6JlMrpw7aBeH2wh`) かつ古い会話 (2023-11)。共有取り消しの可能性。
3. ID prefix と reason の対応は完全: `file_…` (sediment) → `HTTP 404`、`file-…` (user upload) → `no_signed_url`。

create_time との相関 (会話作成月別):

- 作成から 3 ヶ月以内 → 失敗ほぼゼロ
- 3〜6 ヶ月 → 散発的、HTTP 404 が混在
- 6〜12 ヶ月 → no_signed_url が常態化、20-30% の会話で発生
- 12 ヶ月超 → 残存 asset がほぼ確実に no_signed_url 化

詳細は本 doc §補足リサーチ B / A の集計記録に準拠 (各 ChatGPT 会話で実施)。

## 補足: v0.8.17 で発見した log 書き込みのバグ

3 ラン実行後の `_bulk-asset-failed.log` を確認すると、Run C 分の 19 件しか残っておらず、Run A/B の 128 件は別ファイル `_bulk-asset-failed 2.log` に切り離されていた:

```
-rw-------@ 26463 May 12 23:11 _bulk-asset-failed 2.log    ← 128 件 (Run A+B)
-rw-------@  4221 May 12 23:22 _bulk-asset-failed.log      ← 19 件 (Run C)
```

タイムスタンプから推測: Run C 開始 (UTC 13:58) 時点で新しい file handle が生成され、macOS / iCloud / Chrome FSA のいずれかが既存ファイルを " 2.log" にリネームして新規ファイルを切り出した。

`appendAssetFailedLog` ([chat-bulk-export.js:798](../chat-bulk-export.js#L798)) は read-then-rewrite パターンで実装されており、ロジック上は append 動作するはず。ただし以下の要因で「session 跨ぎでファイル分離が起こる」ことが判明:

- 各 Console 貼り付け実行 (= browser session) で `rootDir` handle が新規生成される
- 同じフォルダを picker で選び直しても、内部 handle は別オブジェクト
- File System Access API の `createWritable()` は内部的に temp file (`.crswap`) で書き、close 時にリネーム
- macOS Documents/ は iCloud Drive 同期対象であり、複数 session からの rapid rewrite が rename レースを起こした可能性

manifest / queue / run-stats では同じ現象は発生していない (これらは session ごとに 1 回程度しか書かれない)。`_bulk-asset-failed.log` だけが**短時間内に頻繁に rewrite される**ため symptom が出やすかった。

**回避策 (v0.8.18 で実装予定)**: script 起動時に `_bulk-asset-failed N.log` パターンの duplicate を検出してメインファイルにマージする。

## 関連ファイル

- [throttle-burst-investigation.md](throttle-burst-investigation.md) — 本実験の前提となる仮説と実験設計
- 集計スクリプト本体はインライン Python (本稿 §手法 参照)。再現用に commit していない
