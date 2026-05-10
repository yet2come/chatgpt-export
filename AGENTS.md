# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## リポジトリの性格

Node / npm プロジェクトではない。`package.json` も build / test / lint も存在しない。3 本の `.js` は Chrome / Edge の DevTools Console（または Sources → Snippets）に貼り付けて実行する想定。`chat-single-export.js` と `diagnose-conversation-assets.js` は対象ページが `https://chatgpt.com/c/<id>` のチャットページに限られ、`chat-bulk-export.js` は `https://chatgpt.com/` 配下ならどこでも実行できる（API 経由で会話を巡回するため）。File System Access API を使うため Safari / Firefox では動かない。

実行手順:

```bash
pbcopy < chat-single-export.js   # 単一会話を Markdown + assets で保存
pbcopy < chat-bulk-export.js     # 複数会話を一括エクスポート
# → ChatGPT を Console で開いて貼り付け
# → ダイアログで保存先フォルダを選択
```

ユーザー向け文字列（`alert` / `console.log`）は日本語で統一されている。既存スタイルを維持すること。

## アーキテクチャ（big picture）

[chat-single-export.js](chat-single-export.js) のエクスポート処理は次の 4 層で画像を本文位置に対応付ける。順序が設計の核なので、層を入れ替えたり省いたりしないこと。

1. **JSON 起点での asset 収集** — `convo.mapping` を走査し、各 `message` を再帰スキャンして `asset_pointer` / attachment ID / `file_…` / `file-…` 文字列を抽出する。画像参照は元メッセージ位置に挿入される。
2. **DOM ターン位置による補正** — 生成画像 ID が JSON に存在せず DOM のみにある場合、その `<img>` が含まれていた会話ターンを推定し、対応する Markdown メッセージへ挿入する。`OPTIONS.domTurnPositioning` で切り替え。
3. **URL 取得の DOM フォールバック** — backend 経由の署名 URL 取得が失敗した時のみ、`estuary/content` の `<img>` src を使って画像を取得する。
4. **末尾補遺** — JSON でも DOM でも位置特定できなかった保存済み画像は、Markdown 末尾の `保存済み未参照画像` セクションへまとめる。完全な欠落を避けるためのセーフティネット。

### backend スロットル

`/backend-api/files/<id>/download` が 429 / 503 を返したら 30 秒以上のクールダウンを設定し、その間は backend を回避して DOM 経路に逃がす（`noteBackendThrottle` / `backendCooldownUntil`）。画像ごとのリトライ嵐を防ぐ仕組みであり、削除してはいけない。

`chat-bulk-export.js` は DOM 経路を持たないため、cooldown 中はバッチ全体が `waitForCooldown` で待機して同じ asset を再試行する。`OPTIONS.maxBatchPauseMs`（既定 5 分）を超えると累積待機超過として中断し、レジュームに委ねる。

### Markdown 出力ポリシー

- 通常テキストは原文尊重。ChatGPT 引用マーカーと PUA 文字のみ除去。
- `content_type === 'code'` のみ動的コードフェンスで保護する（`forceCloseAllFences=true` で本文全体に拡大）。
- 除外メッセージ種別: `system` / `thoughts` / `reasoning_recap` / `execution_output` / `computer_output` / `system_error`、および画像 asset を含まない `tool` メッセージ。
- `file_search` 系 tool 参照は export asset として扱わない（引用・検索ノイズ回避）。`file_search` / `file-service` などの予約トークンを ID として誤認しないこと（`RESERVED_FILE_TOKENS`）。
- Canvas / `canmore` / `textdoc` / `artifact` 系の文書作成メッセージは `Document` ブロックとして保持する。

## 壊れやすい外部依存

このスクリプトは ChatGPT の非公式 API と DOM 構造に依存している。動かなくなったらまずここを疑う。

- `/api/auth/session` — アクセストークン取得
- `/backend-api/conversation/<id>` — 会話 JSON
- `/backend-api/files/<id>/download` — 画像署名 URL
- DOM セレクタ `[class*="overflow-y-auto"]` および `img[src*="estuary/content"]`

## 診断スクリプト

[diagnose-conversation-assets.js](diagnose-conversation-assets.js) は read-only の姉妹スクリプト。同じ会話 JSON を取得し、画像 ID が JSON 側 / DOM 側のどちらに何件あるかを `window.__assetDiag` と `window.__lastConvo` に出力する。エクスポーターの収集ロジックを変える前にこれを実行し、対象画像が JSON 在住か DOM のみかを切り分けてから手を入れること。

## 一括エクスポート (chat-bulk-export.js)

[chat-bulk-export.js](chat-bulk-export.js) は **JSON-only / backend-only** で動作する独立スクリプト。設計上の前提が single とは異なる:

- DOM 補正・DOM download fallback は使わない。対象会話の DOM が画面に存在しないため。
- 429 / 503 は cooldown 解除を `waitForCooldown` で待ってから同じ asset を再試行する（ラウンド上限なし）。バッチ全体の累積待機が `OPTIONS.maxBatchPauseMs` を超えた時点で `waitForCooldown` が throw し、main loop がレジューム情報を保存してバッチ停止する。これが唯一の throttle 起点の停止条件。
- 出力レイアウトは single と同じ (`<root>/<date>_<title>_<convId8>.md` + `<root>/assets/`)。会話ごとのサブフォルダは作らない。
- `_bulk-manifest.json` を会話完了ごとに全書き換えで保持。`status === 'done' && sourceUpdatedAt === conv.update_time` の会話は再実行時にスキップ。
- 失敗会話は `_bulk-failed.log` に追記。
- 実装は self-contained（single のヘルパーを必要分だけコピー）。共有コア化は Issue #9（テスト基盤）整備後に別 PR で。

DOM-only 画像欠落の検出は bulk では行えない（DOM が無いため）。画像が疑わしい会話は chat-single-export.js で個別再実行する運用を README で案内している。

## OPTIONS

`chat-single-export.js` の 5 つ（`binBehavior` / `forceCloseAllFences` / `allowLooseQueryId` / `recursiveMessageAssetScan` / `domTurnPositioning`）と、`chat-bulk-export.js` 固有の `scope` / `perConversationDelayMs` / `resume` / `maxBatchPauseMs`。意味と用途別推奨値は [README.md](README.md) の `OPTIONS` および `ユースケース別の推奨設定` を参照。迷ったら既定値のまま使う。

## バージョン履歴の慣習

`chat-single-export.js` 冒頭の doc コメントに `vX.Y` ごとの修正点を箇条書きする慣習がある（現在 v0.7.20）。動作を変える修正を入れるときは:

1. 冒頭の doc コメントに新しいバージョン見出しを足し、変更点を箇条書きで残す。
2. IIFE 末尾の `console.log('   v0.7.20: …')`（[chat-single-export.js](chat-single-export.js)）を新バージョン文言に更新する。

`chat-bulk-export.js` は single とは独立してバージョン番号を持つ（現在 v0.8.11）。同じ規則で IIFE 末尾の `console.log('   v0.8.11: …')` を更新する。

[README.md](README.md) §運用方針 / トラブルシューティングも各バージョンを前提に書かれているため、ユーザー可視の挙動を変える場合は同節も更新する。
