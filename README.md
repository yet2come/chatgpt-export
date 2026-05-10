# ChatGPT 単一チャット エクスポーター

ChatGPT で現在開いている 1 件のチャットを、Markdown 本文と画像ファイルとしてローカル保存するブラウザ Console 用スクリプトです。

## 免責

- 本スクリプトは ChatGPT の**非公式・内部 API および DOM 構造に依存**しています。仕様変更により予告なく動作しなくなる可能性があります。
- 個人のチャット保全を目的としたユーティリティであり、OpenAI の利用規約の範囲内で各自の責任の下にご利用ください。
- **無保証**です。本スクリプトの利用に伴ういかなる損害についても作者は責任を負いません。
- ライセンス: [MIT](./LICENSE)

## 概要

このスクリプトは、ChatGPT のチャットページ `https://chatgpt.com/c/<conversation_id>` 上で実行します。会話 JSON を取得して本文を Markdown 化し、会話に含まれる画像や添付ファイル（PDF / CSV / TSV / JSON / TXT 等）を `assets/` フォルダへ保存します。

出力構造は次の通りです。

```text
<選択フォルダ>/
├── <YYYY-MM-DD>_<title>_<convId8>.md
└── assets/
    ├── file-xxxx.png
    ├── file-yyyy.webp
    ├── file-zzzz.pdf
    └── ...
```

Markdown 内の画像参照は相対パスになります。

```markdown
![](assets/file-xxxx.png)
```

Obsidian や VS Code の Markdown プレビューで、そのまま画像付きで閲覧できます。

## 重要な注意

このスクリプトは ChatGPT の非公式・内部 API と DOM 構造に依存しています。ChatGPT 側の仕様変更により、予告なく動かなくなる可能性があります。

主な依存先は次の通りです。

- `/api/auth/session`
- `/backend-api/conversation/<id>`
- `/backend-api/files/<id>/download`
- `[class*="overflow-y-auto"]`
- `img[src*="estuary/content"]`

レート制限を尊重し、短時間に大量実行しないでください。

## 対応ブラウザ

File System Access API を使うため、Chrome または Edge で実行してください。Safari や Firefox では基本的に動作しません。

## 使い方

1. Chrome または Edge で対象チャットを開きます。
   例: `https://chatgpt.com/c/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
2. DevTools を開きます。
   macOS: `Command + Option + J`
3. Console に貼り付け許可が必要な場合は、画面の指示に従って許可します。
4. [chat-single-export.js](./chat-single-export.js) のスクリプト全体を Console に貼り付けて実行します。
   長いスクリプトなので、途中欠落を避けるには DevTools の `Sources` → `Snippets` に貼り付けて `Command + Enter` で実行する方法がおすすめです。
5. 保存先フォルダを選択します。
6. 完了すると、選択フォルダに Markdown ファイルと `assets/` フォルダが作成されます。

macOS でローカルファイルから確実にコピーする場合は、ターミナルで次を実行してから Console または Snippets に貼り付けます。

```bash
pbcopy < ./chat-single-export.js
```

## 一括エクスポート

複数の会話をまとめて保存したい場合は [chat-bulk-export.js](./chat-bulk-export.js) を使います。動作は single と独立した self-contained スクリプトです。

```bash
pbcopy < ./chat-bulk-export.js
```

ChatGPT のページ（`https://chatgpt.com/` 配下なら任意）の Console（または Sources → Snippets）に貼り付けて実行します。保存先フォルダを 1 度選ぶと、対象会話を順に取得し、single と同じレイアウトでフラットに保存します。

```text
<選択フォルダ>/
├── _bulk-manifest.json              ← レジューム情報
├── _bulk-failed.log                 ← 失敗会話の id とエラー
├── 2026-05-08_…_<convId8>.md
├── 2026-05-07_…_<convId8>.md
└── assets/
    ├── file-aaa.png
    ├── file-bbb.pdf
    └── ...
```

### 既定設定

```javascript
const OPTIONS = {
  binBehavior: 'save',
  forceCloseAllFences: false,
  allowLooseQueryId: false,
  recursiveMessageAssetScan: true,
  emitFrontmatter: true,
  emitBlockRefs: false,
  obsidianImageWidth: false,
  includeImagePrompts: false,

  scope: { type: 'all' },
  perConversationDelayMs: 1500,
  resume: true,
  maxBatchPauseMs: 15 * 60 * 1000,
};
```

`emitFrontmatter` / `emitBlockRefs` / `obsidianImageWidth` / `includeImagePrompts` の意味は single 側 §OPTIONS と同じです（v8.1 で取り込み）。

| オプション | 既定値 | 説明 |
|---|---:|---|
| `scope` | `{ type: 'all' }` | 対象範囲。`{ type: 'latest', count: N }` / `{ type: 'sinceDays', days: 30 }` / `{ type: 'idList', ids: [...] }` も指定可能。旧既定は `{ type: 'latest', count: 50 }`（直近 N 件のみ取得したい場合は `count` を指定）。`idList` は会話一覧を経由せず `/backend-api/conversation/<id>` を直接 fetch するため、見つからない ID は `_bulk-failed.log` に失敗として記録される。レジューム比較できないので毎回再エクスポートになる |
| `perConversationDelayMs` | `1500` | 会話ごとの待機時間（ミリ秒）の初期値 / 下限。v0.8.5 以降は適応制御で、429 観測時に最大 `15000` ms まで自動的に伸び、10 件連続成功ごとに 0.7 倍ずつ漸減してこの値まで戻る |
| `resume` | `true` | `_bulk-manifest.json` を読み、`update_time` が変わっていない `done` 会話をスキップ |
| `maxBatchPauseMs` | `900000` | クールダウン累積待機の上限（ミリ秒）。超えるとバッチを停止し、再実行で resume。v0.8.12 で 5 分 → 15 分に拡大（cooldown が 60 秒に伸びた分、1 セッションで処理できる会話数を維持するため） |

既定で全会話を順に処理します（`scope: { type: 'all' }`）。会話数が多い環境では長時間バッチになり、backend cooldown で自動停止することもあるため、初回はディスク容量・所要時間を見積もってから実行し、停止 → 同じフォルダで resume を回す運用を前提にしてください。直近 N 件のみ処理したい場合は `scope: { type: 'latest', count: N }` に書き換えます。

### bulk の制限事項（重要）

- bulk は **JSON-only / backend-only** で動作します。chat-single-export.js が持つ DOM 補正・DOM download fallback は意図的に無効化しています。対象会話の DOM が画面に存在しないため、信頼性のある DOM 経路を構築できないことが理由です。
- backend が 429 / 503 を返した場合、cooldown 解除を待って同じ asset を再試行します（DOM fallback には逃がしません）。`maxBatchPauseMs` を超えるとバッチを停止します。
- DOM-only 画像（`content.parts[].asset_pointer` にも `metadata.attachments` にも記載がなく、画面の DOM にしか残っていない生成画像）が含まれる会話では、画像が欠落することがあります。**画像欠落が疑わしい会話は chat-single-export.js で個別に再エクスポートしてください**。bulk → single の出力先が同じレイアウトのため、同じフォルダを再利用すれば追記・上書きされます。
- bulk は DOM-only の検出機能を持ちません。`_bulk-manifest.json` には `mode: "json-only"` が記録されます。

### 中断と再開

実行中に止めたい場合は Console で次を入力します。

```javascript
window.__bulkAbort = true
```

進行中の会話を最後まで保存してから停止します。同じフォルダを選び直して再実行すると、`_bulk-manifest.json` を読み込み、`update_time` が変わっていない完了済み会話をスキップして残りだけ処理します。

### 失敗時

会話単位の失敗（404、JSON 取得不可、書き込み失敗など）はバッチを止めません。失敗内容は `_bulk-manifest.json` の該当エントリの `status: "failed"` と `_bulk-failed.log` に記録されます。

## 画像 ID の事前診断

本文位置への対応付けを確認したい場合は、エクスポート前に [diagnose-conversation-assets.js](./diagnose-conversation-assets.js) を ChatGPT のチャットページ Console で実行します。

この診断スクリプトは会話 JSON を取得し、次を Console に表示します。

- JSON 全体に含まれる画像 ID 数
- 現在の会話チェーンに含まれる画像 ID 数
- DOM 上の画像 URL から見つかった画像 ID 数
- メッセージごとの画像 ID 一覧
- JSON 内のどの path に画像 ID が存在したか

診断結果は `window.__assetDiag` に、会話 JSON は `window.__lastConvo` に保存されます。

macOS で確実にコピーする場合は次を使います。

```bash
pbcopy < ./diagnose-conversation-assets.js
```

Console で特に見るべき値は次です。

```javascript
window.__assetDiag.messageRows.filter(r => r.assetCount > 0)
window.__assetDiag.jsonAssetIds.length
window.__assetDiag.domAssetIds.length
```

`jsonAssetIds` が少なく `domAssetIds` が多い場合、画像 ID は会話 JSON ではなく DOM 側にしか残っていないため、`domTurnPositioning` が重要になります。

## OPTIONS

スクリプト冒頭の `OPTIONS` で挙動を切り替えられます。

```javascript
const OPTIONS = {
  binBehavior: 'save',
  forceCloseAllFences: false,
  allowLooseQueryId: false,
  recursiveMessageAssetScan: true,
  domTurnPositioning: true,
  emitFrontmatter: true,
  emitBlockRefs: false,
  obsidianImageWidth: false,
  includeImagePrompts: false,
};
```

| オプション | 既定値 | 説明 |
|---|---:|---|
| `binBehavior` | `'save'` | 拡張子不明の `.bin` ファイルを保存するかどうか |
| `forceCloseAllFences` | `false` | 通常テキスト全体にコードフェンス修復をかけるかどうか |
| `allowLooseQueryId` | `false` | DOM 側の緩い ID 候補を画像 ID として認めるかどうか |
| `recursiveMessageAssetScan` | `true` | 各メッセージ JSON 全体から画像 ID を再帰的に探し、本文位置へ近づけるかどうか |
| `domTurnPositioning` | `true` | DOM 上の画像が含まれていた会話ターンを推定し、そのターンの本文へ挿入するかどうか |
| `emitFrontmatter` | `true` | YAML frontmatter（title / conversation_id / url / created_at / updated_at / exported_at / model / message_count / tags）を冒頭に出力するかどうか |
| `emitBlockRefs` | `false` | 各メッセージ末尾に Obsidian 用の block reference anchor `^msg-yymmdd-HHMMSS` を付けるかどうか。別ノートから `![[file#^id]]` で個別メッセージを埋め込めるようになる |
| `obsidianImageWidth` | `false` | `false` または正の整数。整数を指定すると画像 alt が `Image\|<幅>` になり、Obsidian で画像幅を制御できる。CommonMark 互換性とは引き換え |
| `includeImagePrompts` | `false` | `dalle.text2im` などの画像生成 tool 呼び出しで送信された JSON プロンプトを、画像直前に fence で出力するかどうか |

## ユースケース別の推奨設定

| ユースケース | `binBehavior` | `forceCloseAllFences` | `allowLooseQueryId` | `recursiveMessageAssetScan` | `domTurnPositioning` | `emitFrontmatter` | `emitBlockRefs` | `obsidianImageWidth` | `includeImagePrompts` |
|---|---|---|---|---|---|---|---|---|---|
| 個人のチャット保全 | `'save'` | `false` | `false` | `true` | `true` | `true` | `false` | `false` | `false` |
| 配布・他人に渡す用途 | `'skip'` | `false` | `false` | `true` | `true` | `true` | `false` | `false` | `false` |
| 画像取りこぼしが多い場合 | `'save'` | `false` | `true` | `true` | `true` | `true` | `false` | `false` | `false` |
| Markdown のコードフェンス崩れを補正したい場合 | `'save'` | `true` | `false` | `true` | `true` | `true` | `false` | `false` | `false` |
| Obsidian vault に取り込む用途 | `'save'` | `false` | `false` | `true` | `true` | `true` | `true` | `60` | `true` |
| プレーン Markdown のみで運用する場合 | `'save'` | `false` | `false` | `true` | `true` | `false` | `false` | `false` | `false` |

迷った場合は既定値のまま使ってください。

## 設計方針

### JSON 起点で画像を収集

会話 JSON の `mapping` を走査し、各 `message` オブジェクト内の `asset_pointer`、attachment ID、生成画像メタデータに含まれる `file_...` / `file-...` を抽出します。画面に表示されていない画像でも JSON に含まれていれば保存対象になり、可能な限り該当メッセージの末尾へ挿入します。

### DOM ターン位置で補正

生成画像の ID が会話 JSON 内のどの `message` にも残っていない場合があります。その場合はページ DOM 上で画像が含まれていた会話ターンを推定し、同じ順番の Markdown メッセージへ画像を挿入します。JSON と DOM の両方で位置を特定できない画像だけ、最後の `保存済み未参照画像` セクションへ回します。

### DOM はフォールバック

JSON 起点で解決できない画像や、署名 URL が必要な画像については、画面上の `estuary/content` 画像 URL をフォールバックとして利用します。

### backend throttle

画像取得時に backend API から `429` または `503` が返った場合、一定時間 backend 経路を停止し、DOM フォールバックへ逃がします。画像ごとに何度も待機し続けることを避けるためです。

### Markdown 本文を壊しにくくする

通常テキストは原文を尊重し、ChatGPT 特有の引用マーカーや PUA 文字だけを除去します。`content_type === 'code'` のコード本文は、本文中のバックティック数に応じて動的なコードフェンスで囲みます。

## Markdown に含めないもの

可読性を優先し、以下のような内部メッセージは出力から除外します。

- `system`
- `tool`（画像 asset を含まないもの）
- `thoughts`
- `reasoning_recap`
- `execution_output`
- `computer_output`
- `system_error`

会話の完全な内部ログ保存ではなく、通常閲覧向けの Markdown エクスポートを目的としています。

## トラブルシューティング

### `Uncaught SyntaxError: Unexpected end of input` が出る

スクリプトが途中までしか貼り付けられていません。Console に表示されたコードが途中で終わっている場合、末尾の `})();` まで入っていない状態です。

完全なスクリプトの末尾は次の形です。

```javascript
  console.log('   v7.17: YAML frontmatter / block ref / 画像プロンプト保持の OPTIONS を追加しました');
})();
```

対処方法は次のいずれかです。

- DevTools の `Sources` → `Snippets` にスクリプト全体を貼り付けて実行する
- macOS なら `pbcopy < ./chat-single-export.js` で確実に全体をコピーする
- Console に貼った後、末尾が `})();` で終わっているか確認する

`content.ts.js` などのログが同時に出ることがありますが、多くはブラウザ拡張機能由来のノイズです。`Unexpected end of input` の本体原因は、ほぼ常に貼り付け欠落です。

### 画像は保存されるが Markdown 本文に表示されない

ChatGPT の会話 JSON では、画像が `content.parts[].asset_pointer` ではなく `message.metadata.attachments` 側だけに入ることがあります。この場合、画像ファイルは保存できても、v7.2 以前では Markdown 本文へ画像参照が挿入されないことがありました。

このリポジトリの `chat-single-export.js` は v7.16 として、各 `message` JSON 全体の再帰スキャンに加え、DOM 上で画像が含まれていた会話ターンも使って、画像を本文位置へできるだけ近づけて反映するよう修正済みです。`content.parts[].asset_pointer` や `message.metadata.attachments` 以外の場所にある生成画像 ID も拾います。同じメッセージ内で既に描画済みの画像は重複表示しません。

診断結果で `role: "tool"` の `multimodal_text` に画像 ID が並ぶ会話では、v7.6 以前だと tool メッセージ除外のため本文位置に出せませんでした。v7.16 では、画像やファイル asset を含む tool メッセージだけを `Tool output` の asset 専用ブロックとして会話順に出力します。asset を含まない tool メッセージは引き続き除外します。

一方で、ブラウジングや資料検索の `file_search` ツールが返す `file-service://file-...` は、画像ではなく引用・検索用の内部参照であることがあります。v7.16 では `file_search` 系 tool メッセージを export asset として扱わず、`file_search` / `file-service` のような予約トークンもファイル ID として誤認しないようにしています。

比較表などの tool 出力が CSV/TSV/JSON/TXT として取得できた場合は、可能な範囲で `.bin` ではなく実体に近い拡張子で保存します。

過去のユーザー添付 PDF などが期限切れで取得できない場合でも、会話 JSON に `filename` / `name` / MIME 情報が残っていれば、Markdown には `添付ファイル取得不可` としてファイル名・種類・ID を残します。また、参考情報が tool 側にしか残っていない場合でも、外部 `http(s)` リンクは `参考リンク` として保持します。

本文末に引用処理の残骸として単独の `file` が残るケースは、通常本文の整形時に削除します。

本文中に `{{file:file-...}}` 形式の ChatGPT 内部プレースホルダが残るケースも、添付リンクは別途 Markdown 化されるため通常本文から削除します。

本文中の `sandbox:/mnt/data/...` リンクは、後日開けない内部リンクです。v7.16 ではリンク先を残さず、ファイル名だけを `添付ファイル取得不可` として保存します。

Canvas やドキュメント作成系の内部メッセージは、通常の assistant 返答ではなく `recipient` が内部ツール名になっていることがあります。v7.16 では `canmore` / `canvas` / `document` / `textdoc` / `artifact` 系の文書作成メッセージを検出し、文書本文を `Document` ブロックとして Markdown に残します。

通常本文に偶然出てきた裸の `file-...` 文字列は再帰収集しません。これにより、同一添付の重複表示や lowercase 化された偽 ID の混入を抑えます。

また、`file-service://file-...` や `sediment://file_...#...` のようなスキーム・フラグメント付き ID と、保存済みファイル名の base ID がずれるケースにも対応しています。描画できなかった場合は Console に `🔎 描画失敗:` ログを出し、`window.__lastConvo` と `window.__lastExtMap` で後追い診断できます。

それでも本文中の位置へ対応付けられなかった取得済み画像は、Markdown 末尾の `保存済み未参照画像` セクションへまとめて列挙します。これにより、取得済み画像が Markdown から完全に欠落することを避けます。

### 「チャットページで実行してください」と表示される

URL が `https://chatgpt.com/c/<id>` になっているか確認してください。共有 URL や `/share/...` 形式には対応していません。

### ログインしているのに token が取れない

`/api/auth/session` の仕様変更、ログイン状態の不整合、または別ドメインで開いている可能性があります。ページを再読み込みしてから再実行してください。

### 会話 JSON の取得に失敗する

Console の HTTP ステータスを確認してください。`429` の場合はレート制限です。`404` や `403` の場合は、チャット ID、ログイン状態、または内部 API の変更が疑われます。

### 画像が一部取れない

まず既定設定で実行し、取りこぼしが多い場合は次を試してください。

```javascript
allowLooseQueryId: true
```

それでも取れない場合は、ChatGPT 側の画像 URL 構造が変わっている可能性があります。DevTools の Network タブで実際の画像 URL を確認し、DOM 収集部分のセレクタや ID 抽出ロジックを調整してください。

### `.bin` ファイルが出る

拡張子を判定できなかったファイルです。チャット保全を優先する場合は保存しておき、不要なら削除してください。配布用途では次の設定がおすすめです。

```javascript
binBehavior: 'skip'
```

### Markdown のコードブロックが崩れる

通常は `content_type === 'code'` のみ動的フェンスで保護します。通常テキスト全体にも修復をかけたい場合は、次を有効化できます。

```javascript
forceCloseAllFences: true
```

ただし、通常本文の Markdown を意図せず変える可能性があります。

## 運用方針

v0.7.20 (`chat-single-export.js`) は、個人のチャット保全を主用途とした実用版です。v7.2 から、message JSON 再帰スキャン、DOM ターン位置マッピング、attachments 由来の画像反映、画像付き tool メッセージの本文順出力、file_search 参照ノイズの除外、取得不能添付ファイル名の保持、外部参考リンクの保持、重複 asset 参照の抑制、引用残骸・file プレースホルダ・期限切れ sandbox リンクの除去、Canvas/文書作成メッセージの保持、asset alias 解決の強化、保存済み未参照画像の末尾補遺、v7.15 で DOM 画像 fetch および署名 URL fetch のホスト・スキーム検証、v7.16 で出力ディレクトリを `images/` から `assets/` に変更（非画像添付も同じフォルダに収まるため）、v7.17 で YAML frontmatter のデフォルト出力と Obsidian 連携用 OPTIONS（`emitBlockRefs` / `obsidianImageWidth` / `includeImagePrompts`）を追加、v0.7.18 で Business / Enterprise 環境向けに `ChatGPT-Account-Id` ヘッダ自動付与と同一オリジン署名 URL の Cookie 維持を追加、v0.7.19 で sediment / 生成画像のダウンロードエンドポイントを `/backend-api/files/download/<id>?conversation_id=…` 形式に揃え、v0.7.20 でファイル名末尾の衝突回避 ID を UUID 末尾 8 文字に変更（先頭 8 文字は UUID v7 の採番秒で衝突する。同日同タイトル時の上書きデータ消失を防止）。これ以上の変更は、正しさの改善というより運用方針の選択になります。

v0.8.11 (`chat-bulk-export.js`) は単一エクスポートの姉妹スクリプトとして、複数会話の一括取得を JSON-only / backend-only で行います。DOM 経路を持たないため画像取りこぼしの可能性がある反面、レジューム可能でレート制限を尊重したアーカイブ用途に適します。v8.1 では single の v7.17 と同じ Obsidian 連携用 OPTIONS（`emitFrontmatter` / `emitBlockRefs` / `obsidianImageWidth` / `includeImagePrompts`）を取り込み、v0.8.2 で `ChatGPT-Account-Id` ヘッダ付与と同一オリジン署名 URL の Cookie 維持を追加、v0.8.3 で sediment / 生成画像のダウンロードエンドポイントを ChatGPT 本体と同じ `/backend-api/files/download/<id>?conversation_id=…` 形式に揃えて Business / Team 環境でも生成画像が保存できるようにしました。v0.8.4 で既定 scope を全件モード (`{ type: 'all' }`) に変更。v0.8.5 で conversation/ エンドポイントの 429 を cooldown 機構に接続して連鎖待機を圧縮、`perConversationDelayMs` を適応制御化し、バックオフ初期値を 5 秒に。v0.8.6 で resume 状態の起動ログを追加。v0.8.7 で `tsToSeconds` の数値 passthrough バグ（resume が常に不一致になっていた）を修正。v0.8.8 で resume 比較に ±2 秒の許容を導入し manifest は list 側の `update_time` を優先保存（API drift 対策）。v0.8.10 でログから会話 ID 抜粋を削除し `[i/N]` インデックスのみで識別。v0.8.11 で single と同じくファイル名末尾の衝突回避 ID を UUID 末尾 8 文字に変更（同名ファイル上書きでのデータ消失を防止）。普段は single を、まとめて取りたい時だけ bulk を使う運用を想定しています。

まずは既定値で使い、具体的な不都合が出た場合にだけ `OPTIONS` を変更してください。
