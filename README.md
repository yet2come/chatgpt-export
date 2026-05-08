# ChatGPT 単一チャット エクスポーター

ChatGPT で現在開いている 1 件のチャットを、Markdown 本文と画像ファイルとしてローカル保存するブラウザ Console 用スクリプトです。

## 概要

このスクリプトは、ChatGPT のチャットページ `https://chatgpt.com/c/<conversation_id>` 上で実行します。会話 JSON を取得して本文を Markdown 化し、会話に含まれる画像を `images/` フォルダへ保存します。

出力構造は次の通りです。

```text
<選択フォルダ>/
├── <YYYY-MM-DD>_<title>_<convId8>.md
└── images/
    ├── file-xxxx.png
    ├── file-yyyy.webp
    └── ...
```

Markdown 内の画像参照は相対パスになります。

```markdown
![](images/file-xxxx.png)
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
4. [chat-single-export.js](/Users/yet2come/Projects/chatgpt-export/chat-single-export.js) のスクリプト全体を Console に貼り付けて実行します。
   長いスクリプトなので、途中欠落を避けるには DevTools の `Sources` → `Snippets` に貼り付けて `Command + Enter` で実行する方法がおすすめです。
5. 保存先フォルダを選択します。
6. 完了すると、選択フォルダに Markdown ファイルと `images/` フォルダが作成されます。

macOS でローカルファイルから確実にコピーする場合は、ターミナルで次を実行してから Console または Snippets に貼り付けます。

```bash
pbcopy < /Users/yet2come/Projects/chatgpt-export/chat-single-export.js
```

## 画像 ID の事前診断

本文位置への対応付けを確認したい場合は、エクスポート前に [diagnose-conversation-assets.js](/Users/yet2come/Projects/chatgpt-export/diagnose-conversation-assets.js) を ChatGPT のチャットページ Console で実行します。

この診断スクリプトは会話 JSON を取得し、次を Console に表示します。

- JSON 全体に含まれる画像 ID 数
- 現在の会話チェーンに含まれる画像 ID 数
- DOM 上の画像 URL から見つかった画像 ID 数
- メッセージごとの画像 ID 一覧
- JSON 内のどの path に画像 ID が存在したか

診断結果は `window.__assetDiag` に、会話 JSON は `window.__lastConvo` に保存されます。

macOS で確実にコピーする場合は次を使います。

```bash
pbcopy < /Users/yet2come/Projects/chatgpt-export/diagnose-conversation-assets.js
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
};
```

| オプション | 既定値 | 説明 |
|---|---:|---|
| `binBehavior` | `'save'` | 拡張子不明の `.bin` ファイルを保存するかどうか |
| `forceCloseAllFences` | `false` | 通常テキスト全体にコードフェンス修復をかけるかどうか |
| `allowLooseQueryId` | `false` | DOM 側の緩い ID 候補を画像 ID として認めるかどうか |
| `recursiveMessageAssetScan` | `true` | 各メッセージ JSON 全体から画像 ID を再帰的に探し、本文位置へ近づけるかどうか |
| `domTurnPositioning` | `true` | DOM 上の画像が含まれていた会話ターンを推定し、そのターンの本文へ挿入するかどうか |

## ユースケース別の推奨設定

| ユースケース | `binBehavior` | `forceCloseAllFences` | `allowLooseQueryId` | `recursiveMessageAssetScan` | `domTurnPositioning` |
|---|---|---|---|---|---|
| 個人のチャット保全 | `'save'` | `false` | `false` | `true` | `true` |
| 配布・他人に渡す用途 | `'skip'` | `false` | `false` | `true` | `true` |
| 画像取りこぼしが多い場合 | `'save'` | `false` | `true` | `true` | `true` |
| Markdown のコードフェンス崩れを補正したい場合 | `'save'` | `true` | `false` | `true` | `true` |
| 長期保存を整然と保ちたい場合 | `'skip'` | `false` | `false` | `true` | `true` |

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
  console.log('   v7.15: DOM画像/署名URL fetchのホスト・スキーム検証を追加しました');
})();
```

対処方法は次のいずれかです。

- DevTools の `Sources` → `Snippets` にスクリプト全体を貼り付けて実行する
- macOS なら `pbcopy < /Users/yet2come/Projects/chatgpt-export/chat-single-export.js` で確実に全体をコピーする
- Console に貼った後、末尾が `})();` で終わっているか確認する

`content.ts.js` などのログが同時に出ることがありますが、多くはブラウザ拡張機能由来のノイズです。`Unexpected end of input` の本体原因は、ほぼ常に貼り付け欠落です。

### 画像は保存されるが Markdown 本文に表示されない

ChatGPT の会話 JSON では、画像が `content.parts[].asset_pointer` ではなく `message.metadata.attachments` 側だけに入ることがあります。この場合、画像ファイルは保存できても、v7.2 以前では Markdown 本文へ画像参照が挿入されないことがありました。

このリポジトリの `chat-single-export.js` は v7.15 として、各 `message` JSON 全体の再帰スキャンに加え、DOM 上で画像が含まれていた会話ターンも使って、画像を本文位置へできるだけ近づけて反映するよう修正済みです。`content.parts[].asset_pointer` や `message.metadata.attachments` 以外の場所にある生成画像 ID も拾います。同じメッセージ内で既に描画済みの画像は重複表示しません。

診断結果で `role: "tool"` の `multimodal_text` に画像 ID が並ぶ会話では、v7.6 以前だと tool メッセージ除外のため本文位置に出せませんでした。v7.15 では、画像やファイル asset を含む tool メッセージだけを `Tool output` の asset 専用ブロックとして会話順に出力します。asset を含まない tool メッセージは引き続き除外します。

一方で、ブラウジングや資料検索の `file_search` ツールが返す `file-service://file-...` は、画像ではなく引用・検索用の内部参照であることがあります。v7.15 では `file_search` 系 tool メッセージを export asset として扱わず、`file_search` / `file-service` のような予約トークンもファイル ID として誤認しないようにしています。

比較表などの tool 出力が CSV/TSV/JSON/TXT として取得できた場合は、可能な範囲で `.bin` ではなく実体に近い拡張子で保存します。

過去のユーザー添付 PDF などが期限切れで取得できない場合でも、会話 JSON に `filename` / `name` / MIME 情報が残っていれば、Markdown には `添付ファイル取得不可` としてファイル名・種類・ID を残します。また、参考情報が tool 側にしか残っていない場合でも、外部 `http(s)` リンクは `参考リンク` として保持します。

本文末に引用処理の残骸として単独の `file` が残るケースは、通常本文の整形時に削除します。

本文中に `{{file:file-...}}` 形式の ChatGPT 内部プレースホルダが残るケースも、添付リンクは別途 Markdown 化されるため通常本文から削除します。

本文中の `sandbox:/mnt/data/...` リンクは、後日開けない内部リンクです。v7.15 ではリンク先を残さず、ファイル名だけを `添付ファイル取得不可` として保存します。

Canvas やドキュメント作成系の内部メッセージは、通常の assistant 返答ではなく `recipient` が内部ツール名になっていることがあります。v7.15 では `canmore` / `canvas` / `document` / `textdoc` / `artifact` 系の文書作成メッセージを検出し、文書本文を `Document` ブロックとして Markdown に残します。

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

v7.15 は、個人のチャット保全を主用途とした実用版です。v7.2 から、message JSON 再帰スキャン、DOM ターン位置マッピング、attachments 由来の画像反映、画像付き tool メッセージの本文順出力、file_search 参照ノイズの除外、取得不能添付ファイル名の保持、外部参考リンクの保持、重複 asset 参照の抑制、引用残骸・file プレースホルダ・期限切れ sandbox リンクの除去、Canvas/文書作成メッセージの保持、asset alias 解決の強化、保存済み未参照画像の末尾補遺、そして v7.15 では DOM 画像 fetch および署名 URL fetch のホスト・スキーム検証を加えています。これ以上の変更は、正しさの改善というより運用方針の選択になります。

まずは既定値で使い、具体的な不都合が出た場合にだけ `OPTIONS` を変更してください。
