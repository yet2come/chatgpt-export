# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## リポジトリの性格

Node / npm プロジェクトではない。`package.json` も build / test / lint も存在しない。2 本の `.js` は Chrome / Edge の DevTools Console（または Sources → Snippets）に貼り付けて実行する想定で、対象ページは `https://chatgpt.com/c/<id>` のみ。File System Access API を使うため Safari / Firefox では動かない。

実行手順:

```bash
pbcopy < chat-single-export.js
# → ChatGPT のチャットページで DevTools を開き Console に貼り付け
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

## OPTIONS

5 つのフラグ（`binBehavior` / `forceCloseAllFences` / `allowLooseQueryId` / `recursiveMessageAssetScan` / `domTurnPositioning`）の意味と用途別推奨値は [README.md](README.md) の `OPTIONS` および `ユースケース別の推奨設定` を参照。迷ったら既定値のまま使う。

## バージョン履歴の慣習

`chat-single-export.js` 冒頭の doc コメントに `vX.Y` ごとの修正点を箇条書きする慣習がある（現在 v7.16）。動作を変える修正を入れるときは:

1. 冒頭の doc コメントに新しいバージョン見出しを足し、変更点を箇条書きで残す。
2. IIFE 末尾の `console.log('   v7.16: …')`（[chat-single-export.js:1060](chat-single-export.js)）を新バージョン文言に更新する。

[README.md](README.md) §運用方針 / トラブルシューティングも v7.16 を前提に書かれているため、ユーザー可視の挙動を変える場合は同節も更新する。
