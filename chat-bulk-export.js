/**
 * ChatGPT bulk conversation exporter v0.8.18
 *
 * v0.8.18 fixes (session 跨ぎの log duplicate 統合):
 * - `_bulk-asset-failed.log` が session 跨ぎで `_bulk-asset-failed 2.log` のような
 *   duplicate に分裂する事例を v0.8.17 の 3 ラン観測で発見
 *   (docs/observation-experiment-1.md §補足: log 書き込みのバグ 参照)。原因は
 *   macOS / iCloud / Chrome FSA の相互作用で、`createWritable()` の rename
 *   レースで既存ファイルが " N.log" にリネームされていたもの。
 * - `mergeOrphanLogDuplicates(baseName)` を新設し、起動時に同 prefix の duplicate
 *   ファイル (` 2.log`, ` 3.log`, …) を検出して main file へ統合、duplicate 側は
 *   空に truncate する。`_bulk-asset-failed.log` と `_bulk-failed.log` の双方を
 *   対象。
 *
 * v0.8.17 fixes (asset 取得失敗の診断強化):
 * - `_bulk-asset-failed.log` に 7 列目として diag を追加。`HTTP <status>` /
 *   `no_signed_url` 発生時に backend が返した response body を tab/改行除去 +
 *   500 文字までに切り詰めて記録する。`HTML_response` のときは blob 先頭
 *   512 バイトをデコードした文字列を 200 文字まで記録。
 * - 用途: `no_signed_url` の細分 (削除済 / 期限切れ / 権限切れ) や `HTTP 404`
 *   の理由特定。docs/observation-experiment-1.md の post-mortem で
 *   「user upload は概ね 6〜12 ヶ月で no_signed_url 化する」傾向は判明済だが、
 *   backend が返す `error_code` / `status` 等のフィールドを残さないと
 *   削除イベント vs 期限切れ vs 権限ロストの分離ができないため。
 * - 既存の TSV 列 (timestamp / convId / assetBase / source / composite / reason)
 *   はそのまま。diag が空の行は末尾タブが残るだけで後方互換 (awk -F$'\t' で
 *   1〜6 列を読む既存スクリプトは無修正で動く)。
 * - `downloadAssetBlob` の戻り値を `{ blob, reason, diag }` に拡張。
 *   `recordAssetSkip` も第 2 引数 `diagTag` を受け取れるよう拡張。
 *
 * v0.8.16 fixes (run-scoped instrumentation + docs drift の解消):
 * - バッチ完了時に runStats を構造化出力 + `_bulk-run-stats.jsonl` へ 1 run 1 行
 *   追記。docs/throttle-burst-investigation.md §4.1 で設計した metric を実装:
 *     preFirstThrottleSuccessCount  = 最初の 429 までの純粋 burst capacity
 *     firstThrottleAt               = その時刻 (ISO)
 *     successBeforePause            = pause 直前の累計成功件数
 *     conversation429Count          = 通算 429 / 503 観測回数
 *     cooldownPauseMs               = cooldown 累積待機 (ms)
 *     throttleEvents / decayEvents  = 時系列復元用
 *     pauseReason                   = 'maxBatchPauseMs' | 'throttleLadderExceeded'
 *                                     | 'userAbort' | null
 *   manifest reset を伴う実験計画でも、後から `gapBeforeRun` (前回 run 終了 →
 *   今回開始の時間) を復元できるよう JSONL ファイルにも残す。
 * - BatchPauseError に `pauseKind` フィールドを追加し、main loop で pauseReason
 *   を正しく分類できるようにした。
 * - AGENTS.md / CLAUDE.md / README.md の v0.8.15 実装とのズレ
 *   (`maxBatchPauseMs` 既定値 / 「通算 5 回で一時停止」記述) を解消。詳細は
 *   docs/throttle-burst-investigation.md §7 を参照。
 *
 * v0.8.15 fixes (conversation throttle decay の実効化):
 * - conversation throttle 通算カウンタの減衰条件を 25 件連続成功から
 *   5 件成功蓄積へ変更。
 *   実機ログでは throttle 間の成功 burst が 0〜3 件程度で、25 件には到達せず
 *   v0.8.14 の減衰が一度も発火していなかった。
 * - `bumpAdaptiveDelay()` では delay 制御用の連続成功カウンタだけをリセットし、
 *   throttle 減衰用カウンタは run 全体で蓄積する。throttle 発生のたびに
 *   throttle 減衰用カウンタを 0 に戻すと、小さな成功 burst が捨てられ
 *   通算カウンタが monotonic に近い挙動へ戻っていた。
 * - conversation cooldown ladder を 60 → 90 → 120 → 180 秒から
 *   60 → 90 → 120 → 180 → 240 → 300 秒へ拡張し、pause 直前の余裕を増やした。
 *
 * v0.8.14 fixes (取得診断と Office MIME):
 * - `guessExt` に Office Open XML (docx/pptx/xlsx) と旧 MS Office (doc/ppt/xls) の
 *   MIME 判定を追加。さらに ZIP マジックバイト (PK\x03\x04) で `.zip` を識別する
 *   フォールバックを入れ、backend が Content-Type を欠落させるケース (v0.8.13
 *   ログ #327: `mime=multipart/form-data` で実体は OOXML) でも `.bin` 化を回避。
 * - `downloadAssetBlob` の戻り値を `{ blob, reason }` に変更。失敗時の HTTP
 *   ステータス (`HTTP 404` / `signed_HTTP 403` / `no_signed_url` /
 *   `invalid_url` / `fetch_error:...`) を呼び出し側まで伝搬し、コンソールに
 *   `❌ 取得不可 (HTTP 404)` 形式で出す。原因切り分けが格段に楽になる。
 * - `_bulk-asset-failed.log` を新設。会話完了時に asset 失敗を TSV 1 行で追記
 *   (timestamp / convId / assetBase / source / composite フラグ / reason)。
 *   bulk 完了後に「single で個別再取得すべき会話」を機械可読で抽出可能。
 *   会話単位失敗の `_bulk-failed.log` とは別ファイル。
 *   reason は HTTP ステータス系のほかに `HTML_response` (backend がログイン HTML を
 *   返したケース) と `bin_skip:<mime>` (`OPTIONS.binBehavior === 'skip'` で
 *   拡張子不明をスキップしたケース) も含む。これらは extMap に入らず Markdown
 *   側で「添付ファイル取得不可」になるため、再取得対象として記録する。
 * - conversation throttle 通算カウンタの連続成功減衰を追加。25 件連続成功で
 *   1 段階ずつ減衰し、4 段階 ladder 中の余裕を回復する。v0.8.13 までは monotonic
 *   で、Run 内 5 回到達で必ず pause していた。
 *
 * v0.8.13 fixes (resume 時の list 揺らぎ対策):
 * - `/backend-api/conversations` の取得件数が resume 実行ごとに揺れる問題に
 *   対して `_bulk-queue.json` を導入。過去に list API で見えた会話 ID と
 *   update_time の union を保存し、`scope: { type: 'all' }` では queue 全体を
 *   targets として使う。これは完全な最新性保証ではなく、list truncate で
 *   対象会話が run ごとに消える事故を防ぐための安全網。
 * - queue 由来で今回 list に出ていない会話は `fromQueueOnly` として扱い、
 *   done スキップ時に「更新検知できない可能性」を診断ログへ出す。
 * - conversation API と file API の cooldown を分離。conversation は
 *   60 → 90 → 120 → 180 秒の段階 cooldown とし、通算 5 回の throttle で
 *   BatchPauseError による自動一時停止へ移行する。file 側は従来どおり
 *   60 秒固定で、404 は cooldown 起点にしない。
 * - cooldown による中断は会話失敗ではないため `_bulk-failed.log` に書かず、
 *   manifest の該当会話も failed にしない。manifest と queue を保存して
 *   同じフォルダでの resume に委ねる。
 *
 * v0.8.12 fixes (cooldown 戦略の本格修正):
 * - backend cooldown 機構が事実上空振りしていた問題を解消。fetchWithBackoff の
 *   バックオフ sleep (5+8+13+20 ≈ 46 秒) の合計が、cooldown の最低時間 30 秒を
 *   上回るため、会話完了後に waitForCooldown を呼んでも cooldown は既に満了
 *   している、という構造だった。実機で 631 件中 400 件で累積待機 5 分超過に
 *   なるまで、ほぼ全会話で 429 を踏み続けていた。
 *   修正:
 *   1. backend cooldown が active な間は固定バックオフではなく waitForCooldown
 *      で待機 (会話内バックオフループ自体が cooldown を尊重する)
 *   2. cooldown 最低時間を 30 秒 → 60 秒に延長 (実測で quota が 30 秒では
 *      回復しないため)
 *   3. OPTIONS.maxBatchPauseMs を 5 分 → 15 分に拡大 (1 回の Console セッション
 *      で長く粘れるように)
 *   これで cooldown 発動後は次の会話開始まで実効的に 60 秒以上空き、サーバ側
 *   quota の回復を待ってから処理を再開する動きになる。
 *
 * v0.8.11 fixes (重要 — データ消失バグ修正):
 * - ファイル名末尾の衝突回避 ID を UUID 先頭 8 文字 → 末尾 8 文字 に変更。
 *   ChatGPT の会話 ID は UUID v7 で先頭 8 文字が採番タイムスタンプ秒の
 *   ため、同じ秒に大量採番された会話 (例: バックエンド移行で 0x681fdcb1
 *   付近に集中) で先頭 8 文字が衝突する。同じ日付・同じタイトル
 *   (例: "New chat") の会話と組み合わさると同名ファイルとなり、
 *   getFileHandle({ create: true }) + createWritable() が後勝ちで
 *   上書きするため、過去の export でデータ消失が発生していた。
 *   末尾 8 文字は完全ランダム部 (4.3B 通り) で衝突確率は実質ゼロ。
 *
 *   既存ファイルは旧スキーマ (先頭 8 文字) のまま残り、新規 export は
 *   末尾 8 文字で書かれる。manifest の mdFile は別追跡のため resume は
 *   壊れない。ただし過去の上書きで失われたデータは復元できないため、
 *   消失が疑われる会話 ("New chat" 系の重複候補) は手動で resume を
 *   無効化して再 export する必要がある。
 *
 * v0.8.10 fixes:
 * - ログから会話 ID 抜粋を完全削除し、`[i/N]` インデックスのみで識別する
 *   よう変更。実際の処理はすべて full UUID で行われており、短縮 ID は
 *   人間の可読性のためだけに存在していた。`exportConversation` に tag を
 *   渡し、内部ログも `[i/N]` 形式に統一。後追い調査が必要な場合は完了
 *   ログの ${fname} (日付 + タイトル + 8 文字 ID) で照合できる。
 *
 * v0.8.9 (skipped): ログ ID を末尾 6 文字に変更したが、v0.8.10 で
 *   ID 表示自体を廃止したため上書き。
 *
 * v0.8.8 fixes:
 * - resume 比較に ±2 秒の許容範囲を導入。ChatGPT の list API と
 *   full JSON API が同一会話に対して 100〜200ms 異なる update_time を返す
 *   ため、floor 後の秒整数が 1 秒ズレて毎回再エクスポートに回る現象が
 *   v0.8.7 修正後も残っていた。実ユーザの会話更新は分〜時単位なので
 *   ±2 秒の許容は誤判定を起こさない。
 * - manifest の sourceUpdatedAt は list 側 (convMeta.update_time) を
 *   優先して保存するように変更。比較で使う側を保存することで、
 *   今後生成される manifest からは API drift が起きなくなる。
 *   idList scope では convMeta.update_time が無いので full JSON に
 *   フォールバック (resume 比較は元々できないので影響なし)。
 *
 * v0.8.7 fixes:
 * - resume が事実上機能していなかった致命バグを修正。manifest に保存される
 *   sourceUpdatedAt は full JSON 由来の float 秒 (例 1778319436.195755) で、
 *   list API は ISO 文字列 (例 "2026-05-09T09:37:16.195755Z") を返す。
 *   tsToSeconds は文字列分岐で `Math.floor(t / 1000)` していたが、数値分岐では
 *   passthrough していたため、float 秒 vs 秒整数 の比較が常に不一致になり、
 *   done 済み会話を毎回再エクスポートしていた。数値側にも Math.floor を適用。
 *
 * v0.8.6 fixes:
 * - resume が効いているかを判別できる起動ログを追加。manifest 読込時に
 *   `done / failed / 全 N 件` を出力し、0 件のときは「別フォルダを選択した
 *   可能性があります」と警告する。これまでは readManifest が silent に
 *   newManifest fallback していたため、フォルダ選択ミスや manifest 破損
 *   を Console から判別できなかった。
 * - resume 比較が失敗して再エクスポートに回った場合、最初の 3 件まで
 *   理由を出力 (timestamp 不一致 / 値が空)。原因切り分け用の診断ログ。
 *
 * v0.8.5 fixes:
 * - 後半に入って quota が枯渇すると /backend-api/conversation/<id> が
 *   連続して 429 を返し、1 件ごとに 65 秒級のフルバックオフを毎回踏む
 *   問題を解消。fetchWithBackoff に opts.noteThrottle を追加し、
 *   conversation 取得 / conversation list 取得で 429 を観測した瞬間に
 *   noteBackendThrottle() を呼んで backendCooldownUntil を更新する。
 *   exportConversation 冒頭でも waitForCooldown() を呼ぶことで、
 *   一度 throttle を観測したら後続の会話はまとめて cooldown 解除を待つ。
 *   これで N 会話 × 65 秒の連鎖待機が、1 回 30 秒の cooldown に圧縮される。
 * - perConversationDelayMs を初期値として扱い、throttle 観測で 2 倍
 *   (上限 15s)、10 件連続成功で 0.7 倍に漸減する hysteresis に変更。
 *   固定 1500ms では quota 復帰前に再び 429 を踏みやすかった。
 *   OPTIONS.perConversationDelayMs の意味は「初期値 / 下限」になる。
 * - バックオフ初期値を 1500ms から 5000ms に引き上げ。最初 2 回の
 *   2 秒待機は ChatGPT 側の quota 回復にほぼ無効で attempt を浪費して
 *   いた。retry-after ヘッダがあれば従来どおりそれを優先する。
 *
 * v0.8.4 fixes:
 * - 既定 scope を { type: 'all' } に変更。直近 50 件モードは
 *   コメントで残しているため、必要なら 1 行戻すだけで復帰できる。
 *   全件モードは長時間バッチになるため、停止 → resume での再実行を
 *   前提とする運用は従来どおり。
 *
 * v0.8.3 fixes:
 * - 生成画像 (sediment://file_XXX) が backend ファイル API で 401 を返して
 *   一切保存できなかった問題を解消。ChatGPT 本体が実際に叩いている
 *   エンドポイントは
 *     /backend-api/files/download/<id>?conversation_id=<convId>&inline=false
 *   というパス順 (download と <id> が逆) で、さらに sediment ファイルでは
 *   conversation_id クエリが必須だった。downloadAssetBlob にこの URL 形式と
 *   conversation_id 受け渡しを実装。bulk は DOM フォールバックを持たない
 *   ため、この修正で初めて生成画像を保存できるようになる。
 * - downloadAssetBlob は (fileId, convIdForAsset) を受け取るシグネチャに
 *   変更。呼び出し側 (exportConversation 内のループ) は conversation の
 *   convId を渡す。
 *
 * v0.8.2 fixes:
 * - Business / Enterprise / multi-workspace 環境では backend ファイル API
 *   が 401 を返すため画像が一切保存できない問題を修正。起動時に
 *   /backend-api/accounts/check/v4-2023-04-27 から account_id を取得して
 *   `ChatGPT-Account-Id` ヘッダを全 backend 呼び出しに付与する。bulk は
 *   DOM フォールバックを持たないため、この修正で初めて Business 環境の
 *   生成画像/添付ファイルを保存できるようになる。
 * - 同一オリジン (chatgpt.com / openai.com) の署名 URL を
 *   credentials: 'omit' で叩くと estuary が 403 を返すケースに対応。
 *   isAllowedAssetHost() を bulk にも追加し、同一オリジンなら
 *   credentials: 'include' に切り替える。これで user-uploaded 画像
 *   (file-XXX) の estuary 取得も bulk から成功するようになる。
 *
 * v8.1 fixes:
 * - chat-single-export.js v7.17 で導入された Obsidian 連携用の出力機能を
 *   bulk にも反映:
 *   - emitFrontmatter (既定 true): YAML frontmatter (title /
 *     conversation_id / url / created_at / updated_at / exported_at /
 *     model / message_count / tags) を Markdown 冒頭に付与する。
 *   - emitBlockRefs (既定 false): 各メッセージ末尾に Obsidian block
 *     reference anchor `^msg-yymmdd-HHMMSS` を付ける。
 *   - obsidianImageWidth (既定 false): 数値時に画像 alt が `Image|<幅>`
 *     になる。CommonMark の alt セマンティクスとは引き換え。
 *   - includeImagePrompts (既定 false): 画像生成 tool 呼び出し
 *     (dalle.text2im 等) の JSON プロンプトを画像直前に fenced JSON で
 *     出力する。
 *   single と同じデフォルト挙動になるため、bulk 出力の冒頭にも会話単位の
 *   frontmatter が並び、Dataview などで一括索引できる。
 *
 * v8.0 fixes:
 * 指定スコープの会話を一括で Markdown + assets としてローカル保存する。
 * chat-single-export.js と同じ出力レイアウトに揃え、サブフォルダ分割は行わない:
 *
 *   <選択フォルダ>/
 *   ├── _bulk-manifest.json
 *   ├── _bulk-queue.json
 *   ├── _bulk-failed.log
 *   ├── <YYYY-MM-DD>_<title>_<convIdSuffix8>.md  (UUID 末尾 8 文字)
 *   ├── ...
 *   └── assets/
 *       ├── file-...png
 *       └── ...
 *
 * 設計方針:
 * - JSON-only / backend-only。DOM 補正と DOM download fallback は意図的に
 *   無効化している。一括処理では対象会話の DOM が画面に存在しないため、
 *   信頼性のある DOM 経路を構築できないことが理由。
 * - conversation / file の 429/503 は別 cooldown として扱う。conversation は
 *   通算 throttle 回数で段階的に待機し、回復しない時間帯は自動一時停止して
 *   resume に委ねる。file は 60 秒固定で同じ asset を再試行する。
 * - 画像欠落の検出 (needs-dom-rerun 等) は出力しない。bulk は DOM-only 画像
 *   の存在を判定できないため、画像が疑わしい会話は chat-single-export.js で
 *   個別に再エクスポートする運用を README で案内する。
 * - レジューム: `_bulk-manifest.json` を会話ごとに全書き換えで保持し、
 *   `status === 'done' && sourceUpdatedAt === conv.update_time` のものは
 *   再実行時にスキップする。
 * - queue: `_bulk-queue.json` に list API で見えた会話 ID の union を保持し、
 *   list API の一時的な欠落で targets から未処理会話が消えるのを防ぐ。
 * - chat-single-export.js とは独立した self-contained 実装。共有コア化は
 *   テスト基盤 (Issue #9) 整備後に別 PR で行う。
 *
 * Non-official ChatGPT internal API 依存スクリプト。
 */
(async () => {
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
    // 旧既定: { type: 'latest', count: 50 }
    // 例:
    //   { type: 'sinceDays', days: 30 }
    //   { type: 'idList', ids: ['xxxx-...', 'yyyy-...'] }
    perConversationDelayMs: 1500,
    resume: true,
    maxBatchPauseMs: 15 * 60 * 1000,
  };

  if (!window.showDirectoryPicker) {
    alert('Chrome / Edge で実行してください');
    return;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const MIN_WAIT_MS = 800;
  const MANIFEST_NAME = '_bulk-manifest.json';
  const QUEUE_NAME = '_bulk-queue.json';
  const FAILED_LOG_NAME = '_bulk-failed.log';
  const ASSET_FAILED_LOG_NAME = '_bulk-asset-failed.log';
  const RUN_STATS_LOG_NAME = '_bulk-run-stats.jsonl';
  const PAGE_LIMIT = 100;

  class BatchPauseError extends Error {
    constructor(message, kind = null) {
      super(message);
      this.name = 'BatchPauseError';
      this.isBatchPause = true;
      // v0.8.16: pauseReason 分類用。`'maxBatchPauseMs'` (累積待機超過) /
      // `'throttleLadderExceeded'` (ladder 上限到達) / null。main loop で
      // catch して runStats.pauseReason に流す。
      this.pauseKind = kind;
    }
  }

  const session = await fetch('/api/auth/session').then(r => r.json());
  const token = session.accessToken;
  if (!token) {
    alert('ログインしてから実行してください');
    return;
  }
  const headers = { Authorization: `Bearer ${token}` };

  // ChatGPT-Account-Id: Business / Enterprise / multi-workspace 環境では
  // backend ファイル API がワークスペース context を要求するため、
  // /backend-api/accounts/check で account_id を取得して全 backend 呼び出しに付与する。
  // bulk は対象会話の DOM にアクセスできず DOM フォールバックも無いため、
  // 認証ヘッダの完全性が画像取得成功率を直接決める。失敗しても致命ではないので silent fallback。
  try {
    const accRes = await fetch('/backend-api/accounts/check/v4-2023-04-27', { headers });
    if (accRes.ok) {
      const accJson = await accRes.json();
      const accountsObj = accJson?.accounts || {};
      let chosenId = null;
      for (const [, acc] of Object.entries(accountsObj)) {
        const id = acc?.account?.account_id || acc?.id;
        if (!id) continue;
        if (acc?.is_default || acc?.account?.is_default || acc?.account?.role === 'owner') {
          chosenId = id;
          break;
        }
        if (!chosenId) chosenId = id;
      }
      if (chosenId) {
        headers['ChatGPT-Account-Id'] = chosenId;
        console.log(`🪪 ChatGPT-Account-Id: ${chosenId}`);
      }
    }
  } catch (_) { /* noop */ }

  const isAllowedAssetHost = (url) => {
    try {
      const u = new URL(url, location.origin);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      return u.hostname === location.hostname
        || u.hostname.endsWith('.openai.com')
        || u.hostname.endsWith('.chatgpt.com');
    } catch (_) {
      return false;
    }
  };

  const rootDir = await window.showDirectoryPicker({ mode: 'readwrite' });
  const assetsDir = await rootDir.getDirectoryHandle('assets', { create: true });

  // ===== Common networking =====

  const parseRetryAfter = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) {
      const sec = parseFloat(s);
      if (Number.isFinite(sec) && sec >= 0) return Math.min(120000, sec * 1000);
    }
    const t = Date.parse(s);
    if (Number.isFinite(t)) {
      const ms = t - now();
      return ms > 0 ? Math.min(120000, ms) : 0;
    }
    return null;
  };

  // 適応 delay: throttle 観測で 2 倍に伸び、N 件連続成功で漸減して初期値に戻る。
  // 固定 delay では一度 quota を超えると毎会話 429 → フルバックオフ階段を踏むため、
  // 観測ベースで負荷を下げる必要がある。
  const BACKOFF_BASE_MS = 5000;
  const ADAPTIVE_DELAY_MAX_MS = 15000;
  const ADAPTIVE_DECAY_AFTER = 10;
  // throttle counter (通算 429 回数) は v0.8.13 まで monotonic で、5 回到達で必ず pause していた。
  // v0.8.14 の 25 件閾値は実機の小さな成功 burst では発火しなかったため、
  // v0.8.15 では 5 件単位で蓄積成功を throttle 余裕へ戻す。
  const THROTTLE_COUNT_DECAY_AFTER = 5;
  let adaptiveDelayMs = OPTIONS.perConversationDelayMs;
  let consecutiveSuccessForDelay = 0;
  let successesSinceThrottleDecay = 0;
  const noteAdaptiveSuccess = () => {
    consecutiveSuccessForDelay++;
    successesSinceThrottleDecay++;
    if (consecutiveSuccessForDelay >= ADAPTIVE_DECAY_AFTER && adaptiveDelayMs > OPTIONS.perConversationDelayMs) {
      const next = Math.max(OPTIONS.perConversationDelayMs, Math.round(adaptiveDelayMs * 0.7));
      if (next !== adaptiveDelayMs) {
        adaptiveDelayMs = next;
        console.log(`  📉 会話間 delay を ${adaptiveDelayMs}ms に減衰`);
      }
      consecutiveSuccessForDelay = 0;
    }
    if (successesSinceThrottleDecay >= THROTTLE_COUNT_DECAY_AFTER && conversationThrottleCount > 0) {
      const before = conversationThrottleCount;
      conversationThrottleCount--;
      console.log(`  📉 conversation throttle 通算: ${before} → ${conversationThrottleCount} 回 (成功蓄積 ${THROTTLE_COUNT_DECAY_AFTER} 件)`);
      decayEvents.push({ at: new Date().toISOString(), before, after: conversationThrottleCount });
      successesSinceThrottleDecay = 0;
    }
  };

  let conversationCooldownUntil = 0;
  let fileCooldownUntil = 0;
  let totalConversationPauseMs = 0;
  let totalFilePauseMs = 0;
  let totalBatchPauseMs = 0;
  const FILE_COOLDOWN_BASE_MS = 60000;
  const CONVERSATION_COOLDOWN_LADDER_MS = [60000, 90000, 120000, 180000, 240000, 300000];
  let conversationThrottleCount = 0;

  // Run-scoped stats (v0.8.16): batch 開始から終了までの観測値。
  // noteConversationThrottle / noteAdaptiveSuccess の decay 経路 / main loop の
  // pause / abort 経路から書き込み、バッチ完了時に runStats として出力する。
  // succeeded 等の通算カウンタは noteConversationThrottle からも snapshot される
  // ため、関数定義より前で初期化しておく (TDZ 回避)。
  let succeeded = 0;
  let skippedConv = 0;
  let failedConv = 0;
  let pausedConv = 0;
  let firstThrottleAt = null;
  let preFirstThrottleSuccessCount = null;
  let conversation429Count = 0;
  const throttleEvents = [];
  const decayEvents = [];
  let pauseReason = null;

  const cooldownLabel = (kind) => kind === 'file' ? 'file' : 'conv';
  const cooldownUntilFor = (kind) => kind === 'file' ? fileCooldownUntil : conversationCooldownUntil;
  const kindPauseMs = (kind) => kind === 'file' ? totalFilePauseMs : totalConversationPauseMs;
  const addKindPauseMs = (kind, value) => {
    if (kind === 'file') totalFilePauseMs += value;
    else totalConversationPauseMs += value;
    totalBatchPauseMs += value;
  };
  const formatSec = (ms) => Math.round(ms / 1000);
  const cooldownAvailable = (kind) => now() >= cooldownUntilFor(kind);

  const bumpAdaptiveDelay = () => {
    const bumped = Math.min(ADAPTIVE_DELAY_MAX_MS, Math.max(adaptiveDelayMs * 2, OPTIONS.perConversationDelayMs * 2));
    if (bumped !== adaptiveDelayMs) {
      adaptiveDelayMs = bumped;
      console.log(`  📈 会話間 delay を ${adaptiveDelayMs}ms に引き上げ`);
    }
    consecutiveSuccessForDelay = 0;
  };

  const noteConversationThrottle = (retryAfterMs, status = 429) => {
    const at = new Date().toISOString();
    conversation429Count++;
    if (preFirstThrottleSuccessCount === null) {
      preFirstThrottleSuccessCount = succeeded;
      firstThrottleAt = at;
    }
    conversationThrottleCount++;
    if (conversationThrottleCount > CONVERSATION_COOLDOWN_LADDER_MS.length) {
      throw new BatchPauseError(
        `conversation API ${status} が通算 ${conversationThrottleCount} 回 — 自動一時停止します。10〜30 分空けて resume してください`,
        'throttleLadderExceeded',
      );
    }
    const ladder = CONVERSATION_COOLDOWN_LADDER_MS[conversationThrottleCount - 1];
    const base = Math.max(retryAfterMs ?? 0, ladder);
    conversationCooldownUntil = Math.max(conversationCooldownUntil, now() + base);
    throttleEvents.push({
      at,
      count: conversationThrottleCount,
      ladderIndex: conversationThrottleCount - 1,
      cooldownMs: base,
    });
    console.log(`  🧊 conversation クールダウン: 通算 ${conversationThrottleCount} 回 / 次回 ${formatSec(conversationCooldownUntil - now())}秒後まで使用しません`);
    bumpAdaptiveDelay();
  };

  const noteFileThrottle = (retryAfterMs) => {
    const base = Math.max(retryAfterMs ?? 0, FILE_COOLDOWN_BASE_MS);
    fileCooldownUntil = Math.max(fileCooldownUntil, now() + base);
    console.log(`  🧊 file クールダウン: 次回 ${formatSec(fileCooldownUntil - now())}秒後まで使用しません`);
  };

  const noteThrottleForKind = (kind, retryAfterMs, status) => {
    if (kind === 'file') noteFileThrottle(retryAfterMs);
    else noteConversationThrottle(retryAfterMs, status);
  };

  const waitForCooldown = async (kind = 'conversation') => {
    while (!cooldownAvailable(kind)) {
      const remaining = cooldownUntilFor(kind) - now();
      if (
        totalBatchPauseMs + remaining > OPTIONS.maxBatchPauseMs
        || kindPauseMs(kind) + remaining > OPTIONS.maxBatchPauseMs
      ) {
        throw new BatchPauseError(
          `バッチ累積待機が ${Math.round(OPTIONS.maxBatchPauseMs / 1000)}秒を超過したため一時停止します`,
          'maxBatchPauseMs',
        );
      }
      const label = cooldownLabel(kind);
      console.log(`  ⏳ クールダウン待機: ${label} 残り ${formatSec(remaining)}秒 (累積 conv ${formatSec(totalConversationPauseMs)}s / file ${formatSec(totalFilePauseMs)}s / 総 ${formatSec(totalBatchPauseMs)}s)`);
      const wait = remaining + 500;
      addKindPauseMs(kind, wait);
      await sleep(wait);
    }
  };

  const fetchWithBackoff = async (url, init = {}, label = url, opts = {}) => {
    const maxAttempts = opts.maxAttempts ?? 26;
    const returnOnThrottle = opts.returnOnThrottle ?? false;
    const noteThrottle = opts.noteThrottle ?? false;
    const cooldownKind = opts.cooldownKind || 'conversation';
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        lastErr = e;
        if (attempt + 1 >= maxAttempts) break;
        const wait = Math.max(MIN_WAIT_MS, Math.min(60000, BACKOFF_BASE_MS * Math.pow(1.6, attempt)));
        await sleep(wait);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const ra = parseRetryAfter(res.headers.get('retry-after'));
        if (noteThrottle) noteThrottleForKind(cooldownKind, ra, res.status);
        if (returnOnThrottle) return res;
        if (attempt + 1 >= maxAttempts) return res;
        // cooldown が active なら、固定バックオフ秒ではなく cooldown 解除を待つ。
        // これがないと 5+8+13+20 ≈ 46秒のバックオフ中に 30〜60秒の cooldown が
        // 満了してしまい、cooldown 機構が事実上空振りする (v0.8.5〜v0.8.8 で観測)。
        // waitForCooldown は累積待機が maxBatchPauseMs を超えたら throw するので、
        // バッチ停止条件は引き続き機能する。
        if (!cooldownAvailable(cooldownKind)) {
          console.log(`  ⏳ ${res.status} ${label}: クールダウン解除を待機 (${attempt + 1}/${maxAttempts})`);
          await waitForCooldown(cooldownKind);
          continue;
        }
        const wait = Math.max(MIN_WAIT_MS, ra != null ? ra : Math.min(60000, BACKOFF_BASE_MS * Math.pow(1.6, attempt)));
        console.log(`  ⏳ ${res.status} ${label}: ${Math.round(wait / 1000)}秒待機 (${attempt + 1}/${maxAttempts})`);
        await sleep(wait);
        continue;
      }
      return res;
    }
    throw new Error(`fetch giving up: ${label}${lastErr ? ' / ' + lastErr.message : ''}`);
  };

  // ===== Conversation list =====

  // 注意: ChatGPT の API は update_time の型が一貫しない。
  //   /backend-api/conversations (list)        → ISO 文字列 ("2026-05-09T09:37:16.195755Z")
  //   /backend-api/conversation/<id> (full)    → float 秒 (1778319436.195755)
  // resume 比較では両者を秒整数に正規化する必要があるため、数値分岐でも必ず floor する。
  // 過去 (v0.8.5 以前) は数値を passthrough していたため float vs ISO→秒整数 で常に不一致になり、
  // resume が機能していなかった。
  const tsToSeconds = (v) => {
    if (typeof v === 'number') return Math.floor(v);
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
    }
    return 0;
  };

  const queueIdCount = (queue) => Array.isArray(queue?.ids) ? queue.ids.length : 0;
  const newQueue = () => ({
    version: 1,
    ids: [],
  });
  const normalizeQueueItem = (item, seenAt = new Date().toISOString()) => {
    if (!item?.id) return null;
    return {
      id: String(item.id),
      update_time: item.update_time ?? item.create_time ?? null,
      create_time: item.create_time ?? null,
      title: item.title ?? null,
      lastSeenAt: seenAt,
    };
  };
  const readQueue = async () => {
    try {
      const fh = await rootDir.getFileHandle(QUEUE_NAME);
      const f = await fh.getFile();
      const text = await f.text();
      const j = JSON.parse(text);
      if (!j || typeof j !== 'object' || j.version !== 1 || !Array.isArray(j.ids)) {
        console.warn(`  ⚠️ ${QUEUE_NAME} を解釈できないため新規扱いします`);
        return newQueue();
      }
      j.ids = j.ids.map(item => normalizeQueueItem(item, item.lastSeenAt)).filter(Boolean);
      return j;
    } catch (_) {
      return newQueue();
    }
  };
  const writeQueue = async (queue) => {
    const fh = await rootDir.getFileHandle(QUEUE_NAME, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(queue || newQueue(), null, 2));
    await w.close();
  };
  const mergeListIntoQueue = (queue, items) => {
    const q = queue || newQueue();
    q.ids = Array.isArray(q.ids) ? q.ids : [];
    const byId = new Map(q.ids.map(item => [item.id, item]));
    const seenAt = new Date().toISOString();
    let added = 0;
    let updated = 0;
    for (const raw of items || []) {
      const next = normalizeQueueItem(raw, seenAt);
      if (!next) continue;
      const prev = byId.get(next.id);
      if (!prev) {
        byId.set(next.id, next);
        added++;
        continue;
      }
      const prevSec = tsToSeconds(prev.update_time ?? prev.create_time);
      const nextSec = tsToSeconds(next.update_time ?? next.create_time);
      if (nextSec >= prevSec) {
        byId.set(next.id, { ...prev, ...next });
        updated++;
      } else {
        byId.set(next.id, { ...prev, lastSeenAt: seenAt });
      }
    }
    q.ids = Array.from(byId.values()).sort((a, b) => {
      const bt = tsToSeconds(b.update_time ?? b.create_time);
      const at = tsToSeconds(a.update_time ?? a.create_time);
      return bt - at || String(a.id).localeCompare(String(b.id));
    });
    return { added, updated, total: q.ids.length };
  };

  const fetchConversationPage = async (offset, limit) => {
    const url = `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`;
    const r = await fetchWithBackoff(url, { headers }, `conversations[${offset}..]`, { maxAttempts: 8, noteThrottle: true, cooldownKind: 'conversation' });
    if (!r.ok) throw new Error(`会話リスト取得失敗: HTTP ${r.status}`);
    return r.json();
  };

  const collectConversations = async (scope, queue) => {
    const all = [];
    const seenIds = new Set();
    let offset = 0;
    let total = Infinity;
    let reportedTotal = null;
    let endedEarly = false;
    let paused = false;
    while (offset < total) {
      let page;
      try {
        page = await fetchConversationPage(offset, PAGE_LIMIT);
      } catch (e) {
        if (e?.isBatchPause) {
          paused = true;
          throw e;
        }
        throw e;
      }
      total = typeof page.total === 'number' ? page.total : (offset + (page.items?.length || 0));
      reportedTotal = Number.isFinite(total) ? total : reportedTotal;
      const items = page.items || [];
      if (!items.length) {
        endedEarly = Number.isFinite(total) && offset < total;
        break;
      }
      mergeListIntoQueue(queue, items);
      for (const c of items) all.push(c);
      for (const c of items) if (c?.id) seenIds.add(c.id);
      offset += items.length;
      if (scope.type === 'latest' && all.length >= scope.count) break;
      if (scope.type === 'sinceDays') {
        const cutoff = (now() / 1000) - (scope.days * 86400);
        const oldest = items[items.length - 1];
        const oldestUpdate = tsToSeconds(oldest?.update_time ?? oldest?.create_time);
        if (oldestUpdate && oldestUpdate < cutoff) break;
      }
      await sleep(300);
    }
    if (Number.isFinite(total) && all.length < total && !paused) {
      endedEarly = endedEarly || (scope.type === 'all' && all.length < total);
    }
    return { items: all, seenIds, reportedTotal, endedEarly, paused };
  };

  // idList は collectConversations を経由せず main で直接 fetch するため
  // ここでは扱わない。
  const filterByScope = (list, scope) => {
    if (scope.type === 'all') return list;
    if (scope.type === 'latest') return list.slice(0, scope.count);
    if (scope.type === 'sinceDays') {
      const cutoff = (now() / 1000) - (scope.days * 86400);
      return list.filter(c => tsToSeconds(c.update_time ?? c.create_time) >= cutoff);
    }
    return [];
  };
  const queueItemsSorted = (queue) => (Array.isArray(queue?.ids) ? queue.ids : [])
    .filter(item => item?.id)
    .slice()
    .sort((a, b) => {
      const bt = tsToSeconds(b.update_time ?? b.create_time);
      const at = tsToSeconds(a.update_time ?? a.create_time);
      return bt - at || String(a.id).localeCompare(String(b.id));
    });
  const targetFromQueueItem = (item, fromQueueOnly) => ({
    id: item.id,
    update_time: item.update_time ?? item.create_time ?? null,
    create_time: item.create_time ?? null,
    title: item.title ?? null,
    fromQueueOnly,
  });
  const buildTargetsFromQueue = (queue, scope, seenIds = new Set()) => {
    const items = queueItemsSorted(queue);
    if (scope.type === 'all') {
      return items.map(item => targetFromQueueItem(item, !seenIds.has(item.id)));
    }
    if (scope.type === 'sinceDays') {
      const cutoff = (now() / 1000) - (scope.days * 86400);
      return items
        .filter(item => tsToSeconds(item.update_time ?? item.create_time) >= cutoff)
        .map(item => targetFromQueueItem(item, !seenIds.has(item.id)));
    }
    return [];
  };
  const buildLatestTargets = (list, queue, scope, seenIds = new Set()) => {
    const count = scope.count || 0;
    const byId = new Map();
    for (const item of list.slice(0, count)) {
      if (!item?.id) continue;
      byId.set(item.id, { ...item, fromQueueOnly: false });
    }
    if (byId.size < count) {
      const needed = count - byId.size;
      let added = 0;
      for (const item of queueItemsSorted(queue)) {
        if (added >= needed) break;
        if (!item?.id || byId.has(item.id)) continue;
        byId.set(item.id, targetFromQueueItem(item, !seenIds.has(item.id)));
        added++;
      }
      if (added > 0) {
        console.warn(`  ⚠️ latest scope: list が ${byId.size - added}/${count} 件のため queue から ${added} 件補完しました。補完分の update_time は最新とは限りません`);
      }
    }
    return Array.from(byId.values()).slice(0, count);
  };

  // ===== Manifest =====

  const newManifest = () => ({
    version: 1,
    mode: 'json-only',
    startedAt: new Date().toISOString(),
    scope: OPTIONS.scope,
    conversations: {},
  });

  const readManifest = async () => {
    try {
      const fh = await rootDir.getFileHandle(MANIFEST_NAME);
      const f = await fh.getFile();
      const text = await f.text();
      const j = JSON.parse(text);
      if (!j || typeof j !== 'object' || j.version !== 1 || typeof j.conversations !== 'object') {
        console.warn(`  ⚠️ ${MANIFEST_NAME} を解釈できないため新規扱いします`);
        return newManifest();
      }
      return j;
    } catch (_) {
      return newManifest();
    }
  };

  const writeManifest = async (manifest) => {
    const fh = await rootDir.getFileHandle(MANIFEST_NAME, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(manifest, null, 2));
    await w.close();
  };

  const appendFailedLog = async (line) => {
    const fh = await rootDir.getFileHandle(FAILED_LOG_NAME, { create: true });
    let prev = '';
    try {
      const f = await fh.getFile();
      prev = await f.text();
    } catch (_) {}
    const w = await fh.createWritable();
    await w.write(prev + line + '\n');
    await w.close();
  };
  // session 跨ぎ + 短時間 rewrite で `_bulk-asset-failed 2.log` のような
  // duplicate が生成される事例があった (v0.8.17 で観測、docs/observation-experiment-1.md
  // §補足: log 書き込みのバグ 参照)。macOS / iCloud / Chrome FSA の相互作用で
  // 既存ファイルが " 2.log" などにリネームされ、新しい session が同名で新規ファイルを
  // 切り出す症状。startup 時に同 prefix の duplicate を検出してメインファイルへ
  // 統合し、duplicate 側は空にする。
  const mergeOrphanLogDuplicates = async (baseName) => {
    // baseName = "_bulk-asset-failed.log" → match "_bulk-asset-failed 2.log",
    // "_bulk-asset-failed 3.log" など。
    const m = baseName.match(/^(.+)\.([^.]+)$/);
    if (!m) return;
    const [_, stem, ext] = m;
    const dupRe = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)\\.${ext}$`);
    const dupNames = [];
    try {
      for await (const [name] of rootDir.entries()) {
        if (dupRe.test(name)) dupNames.push(name);
      }
    } catch (_) {
      return; // iteration 不可なら何もしない
    }
    if (!dupNames.length) return;
    // duplicate ファイルから内容を吸い上げ、main へ append、duplicate は空に
    let merged = '';
    for (const name of dupNames.sort()) {
      try {
        const fh = await rootDir.getFileHandle(name);
        const f = await fh.getFile();
        const text = await f.text();
        if (text) {
          merged += (merged && !merged.endsWith('\n') ? '\n' : '') + text;
          if (!text.endsWith('\n')) merged += '\n';
        }
      } catch (_) { /* skip */ }
    }
    if (!merged) return;
    // main にマージ
    const mainFh = await rootDir.getFileHandle(baseName, { create: true });
    let prev = '';
    try {
      const f = await mainFh.getFile();
      prev = await f.text();
    } catch (_) {}
    const w = await mainFh.createWritable();
    await w.write(prev + merged);
    await w.close();
    // duplicate ファイルを空にする (削除権限が無いケースに備えて truncate)
    for (const name of dupNames) {
      try {
        const fh = await rootDir.getFileHandle(name);
        const w2 = await fh.createWritable();
        await w2.write('');
        await w2.close();
      } catch (_) { /* skip */ }
    }
    console.log(`  🧹 ${baseName}: duplicate ${dupNames.length} 件をマージしました (${merged.split('\n').filter(Boolean).length} 行)`);
  };

  // asset 単位の失敗ログ。会話完了時にまとめて 1 回だけ書き込み、I/O を抑える
  // (会話あたり数十件失敗するケースがあるため毎件 read-write は重い)。
  const appendAssetFailedLog = async (lines) => {
    if (!Array.isArray(lines) || !lines.length) return;
    const fh = await rootDir.getFileHandle(ASSET_FAILED_LOG_NAME, { create: true });
    let prev = '';
    try {
      const f = await fh.getFile();
      prev = await f.text();
    } catch (_) {}
    const w = await fh.createWritable();
    await w.write(prev + lines.join('\n') + '\n');
    await w.close();
  };

  // run-scoped 統計を _bulk-run-stats.jsonl に追記 (v0.8.16)。1 run 1 行の JSONL。
  // manifest を reset する実験計画でも、後から `gapBeforeRun` (前回 run 終了 →
  // 今回開始の時間) を復元できるよう、console 出力だけでなくフォルダ内ファイル
  // にも残す。書き込み失敗してもバッチ完了自体は妨げない (warn のみ)。
  const appendRunStatsJsonl = async (stats) => {
    try {
      const fh = await rootDir.getFileHandle(RUN_STATS_LOG_NAME, { create: true });
      let prev = '';
      try {
        const f = await fh.getFile();
        prev = await f.text();
      } catch (_) {}
      const w = await fh.createWritable();
      await w.write(prev + JSON.stringify(stats) + '\n');
      await w.close();
    } catch (e) {
      console.warn(`  ⚠️ ${RUN_STATS_LOG_NAME} 書き込み失敗: ${e?.message || e}`);
    }
  };
  const pauseBatch = async ({ manifest, queue, reason }) => {
    console.warn(`⏸️  ${reason} — 同フォルダで resume してください`);
    if (queue) {
      try {
        await writeQueue(queue);
      } catch (e) {
        console.warn(`  ⚠️ ${QUEUE_NAME} 保存に失敗: ${e?.message || e}`);
      }
    }
    if (manifest) {
      try {
        await writeManifest(manifest);
      } catch (e) {
        console.warn(`  ⚠️ ${MANIFEST_NAME} 保存に失敗: ${e?.message || e}`);
      }
    }
  };

  // ===== Pure helpers ported from chat-single-export.js =====

  const stripScheme = (s) => String(s).replace(/^[a-z][a-z0-9+\-.]*:\/\//i, '');
  const stripFragment = (s) => String(s).split('#')[0];
  const ID_PARAM_KEYS = ['id', 'file_id', 'asset_id', 'fileId', 'assetId'];
  const RESERVED_FILE_TOKENS = new Set(['file_search', 'file-search', 'file_service', 'file-service']);

  const isStrictFileId = (s) => {
    const text = String(s || '');
    if (RESERVED_FILE_TOKENS.has(text)) return false;
    const m = /^file[_-]([A-Za-z0-9]+)$/.exec(text);
    return !!m && m[1].length >= 12;
  };
  const isFileSearchToolMessage = (msg) => {
    if (msg?.author?.role !== 'tool') return false;
    const name = String(msg?.author?.name || msg?.recipient || '');
    const ct = msg?.content?.content_type;
    return name === 'file_search' || ct === 'tether_browsing_display';
  };

  const fileIdLikeStrict = (s) => {
    if (!s) return null;
    const t = String(s);
    if (isStrictFileId(t)) return t;
    const noScheme = stripFragment(stripScheme(t));
    if (isStrictFileId(noScheme)) return noScheme;
    try {
      const u = new URL(t, location.origin);
      for (const k of ID_PARAM_KEYS) {
        const v = u.searchParams.get(k);
        if (!v) continue;
        if (isStrictFileId(v)) return v;
        if (OPTIONS.allowLooseQueryId && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
      }
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg && isStrictFileId(seg)) return seg;
    } catch (_) {}
    const seg = stripFragment(t.split('?')[0]).split('/').pop();
    if (seg && isStrictFileId(seg)) return seg;
    return null;
  };

  const pickFirst = (...values) => values.find(v => v != null && String(v).trim());

  const attachmentInfos = (msg) => {
    const out = [];
    const atts = msg?.metadata?.attachments;
    if (!Array.isArray(atts)) return out;
    for (const a of atts) {
      for (const v of [a?.asset_pointer, a?.id, a?.file_id, a?.fileId, a?.url].filter(Boolean)) {
        out.push({
          raw: String(v),
          filename: pickFirst(a?.filename, a?.name, a?.file_name, a?.fileName, a?.original_filename, a?.title),
          mime: pickFirst(a?.mime_type, a?.mime, a?.content_type),
          size: a?.size || a?.file_size,
          externalUrl: a?.url,
        });
      }
    }
    return out;
  };
  const attachmentRawIds = (msg) => attachmentInfos(msg).map(info => info.raw);

  const messageAssetRaws = (msg) => {
    if (isFileSearchToolMessage(msg)) return [];
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      if (!raw) return;
      const s = String(raw);
      const key = `${stripFragment(stripScheme(s))}::${s}`;
      if (seen.has(key)) return;
      if (!fileIdLikeStrict(s)) return;
      seen.add(key);
      out.push(s);
    };

    for (const raw of attachmentRawIds(msg)) add(raw);

    const scanString = (s, structured = false) => {
      if (!s) return;
      const text = String(s);
      const schemeRe = /\b(?:file-service|sediment):\/\/file[_-][A-Za-z0-9]+(?:#[^\s"'<>)]*)?/g;
      for (const m of text.matchAll(schemeRe)) add(m[0]);
      if (!structured) return;
      const bareRe = /\bfile[_-][A-Za-z0-9]+\b/g;
      for (const m of text.matchAll(bareRe)) add(m[0]);
      add(text);
    };
    const isAssetKey = (key) => /^(asset_pointer|id|file_id|fileId|asset_id|assetId|url)$/i.test(String(key || ''));

    if (!OPTIONS.recursiveMessageAssetScan) return out;

    const visited = new WeakSet();
    const scan = (value, depth = 0, key = '') => {
      if (depth > 10 || value == null) return;
      if (typeof value === 'string') {
        scanString(value, isAssetKey(key));
        return;
      }
      if (typeof value !== 'object') return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1, key);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === 'text' && typeof child === 'string' && child.length > 20000) continue;
        scan(child, depth + 1, key);
      }
    };

    scan(msg);
    return out;
  };

  const guessExt = (mime, head, sampleText = '') => {
    const mt = String(mime || '').toLowerCase();
    if (mt.includes('csv')) return 'csv';
    if (mt.includes('tab-separated-values') || mt.includes('tsv')) return 'tsv';
    if (mt.includes('json')) return 'json';
    if (mt.includes('html')) return 'html';
    if (mime?.includes('png')) return 'png';
    if (mime?.includes('jpeg') || mime?.includes('jpg')) return 'jpg';
    if (mime?.includes('webp')) return 'webp';
    if (mime?.includes('gif')) return 'gif';
    if (mime?.includes('pdf')) return 'pdf';
    // Office Open XML (OOXML / ZIP-backed). MIME 一致が最も確実。
    if (mt.includes('officedocument.wordprocessingml.document')) return 'docx';
    if (mt.includes('officedocument.presentationml.presentation')) return 'pptx';
    if (mt.includes('officedocument.spreadsheetml.sheet')) return 'xlsx';
    // 旧 MS Office (CFB/OLE2)。MIME のみで判定。CFB マジックバイトは Excel/Word/PPT 共通で
    // 中身を見ないと識別不能なので head 判定はしない。
    if (mt === 'application/msword') return 'doc';
    if (mt === 'application/vnd.ms-powerpoint') return 'ppt';
    if (mt === 'application/vnd.ms-excel') return 'xls';
    if (head[0] === 0x89 && head[1] === 0x50) return 'png';
    if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
    if (head[0] === 0x52 && head[1] === 0x49) return 'webp';
    if (head[0] === 0x47 && head[1] === 0x49) return 'gif';
    if (head[0] === 0x25 && head[1] === 0x50) return 'pdf';
    // ZIP マジック (PK\x03\x04)。MIME が multipart/form-data などでも内容が ZIP のことがある
    // (backend が Content-Type を欠落させるケースを観測 v0.8.13 ログ #327)。
    // OOXML は ZIP コンテナだが mime 不明だと中身が判別できないので .zip にしておき、
    // ユーザが必要に応じて拡張子変更する運用とする。
    if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) return 'zip';
    const text = String(sampleText || '').replace(/^﻿/, '');
    const trimmed = text.trimStart();
    if (/^[\[{]/.test(trimmed)) return 'json';
    const lines = text.split(/\r?\n/).filter(line => line.trim()).slice(0, 3);
    if (lines.length >= 2 && lines.every(line => line.includes('\t'))) return 'tsv';
    if (lines.length >= 2 && lines.every(line => line.includes(','))) return 'csv';
    if (mt.startsWith('text/')) return 'txt';
    return 'bin';
  };

  const decodeSandboxFileName = (rawPath, fallback = '') => {
    const tail = String(rawPath || '').split('/').pop() || String(fallback || '').trim() || String(rawPath || '');
    try {
      return decodeURIComponent(tail);
    } catch (_) {
      return tail || String(fallback || '').trim() || String(rawPath || '');
    }
  };

  const cleanMarkup = (text) => {
    if (!text) return text;
    text = text.replace(/[-]/g, '');
    text = text.replace(/[​‌‍]/g, '');
    text = text.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    for (let i = 0; i < 3; i++) text = text.replace(/【\d+†[^【】]*】/g, '');
    text = text.replace(/【\d+†[^】]*】/g, '');
    text = text.replace(/cite(?:turn\d+(?:search|news|image|video|forecast|file|item|view)\d+,?)+/g, '');
    text = text.replace(/(?<![A-Za-z0-9])(?:i)?turn\d+(?:search|news|image|video|forecast|file|item|view)\d+,?/g, '');
    text = text.replace(/\s*[(（](?:i)?turn\d+(?:file|item)\d+[)）]/g, '');
    text = text.replace(/^(navlist|summary)(?=\W|$)/gm, '');
    text = text.replace(/oaicite:?\d+/g, '');
    text = text.replace(/\{\{file:\s*file[_-][A-Za-z0-9]+\s*\}\}/g, '');
    text = text.replace(/\[([^\]]+)\]\(sandbox:\/mnt\/data\/([^)]+)\)/g, (_, label, rawPath) => {
      return `_(添付ファイル取得不可: ${decodeSandboxFileName(rawPath, label)})_`;
    });
    text = text.replace(/sandbox:\/mnt\/data\/[^\s)\]]+/g, rawPath => {
      return `_(添付ファイル取得不可: ${decodeSandboxFileName(rawPath)})_`;
    });
    text = text.replace(/[?&]utm_source=chatgpt\.com(?=[\s\)\]"'<>]|$)/g, '');
    text = text.replace(/([。！？])\s*file\b\s*/g, '$1');
    text = text.replace(/([.!?])\s*file\b/g, '$1');
    text = text.replace(/^\s*file\s*$/gm, '');
    text = text.replace(/  +/g, ' ');
    text = text.replace(/ +([。、,.])/g, '$1');
    text = text.replace(/ +\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text;
  };
  const cleanCodeText = (text) => String(text || '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const cleanHeading = (s) => String(s || '(無題)').replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/^\s*#+\s*/, '').trim() || '(無題)';
  const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const safeFilename = (s, max = 80) => {
    let r = (s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim();
    r = r.replace(/^[.\s]+|[.\s]+$/g, '');
    if (!r) r = 'untitled';
    if (WIN_RESERVED.test(r)) r = '_' + r;
    r = r.slice(0, max).replace(/[.\s]+$/g, '');
    if (!r) r = 'untitled';
    if (WIN_RESERVED.test(r)) r = '_' + r;
    return r;
  };
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const blockRefId = (ts) => {
    if (!ts) return null;
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `msg-${yy}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  const isoFromEpoch = (ts) => {
    if (!ts) return '';
    return new Date(ts * 1000).toISOString();
  };
  const yamlEscape = (s) => {
    const text = String(s == null ? '' : s);
    if (!text) return '""';
    if (/[:#\[\]{}&*!|>'"%@`,\n]/.test(text) || /^\s|\s$/.test(text)) {
      return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return text;
  };
  const linearize = (mapping, current) => {
    const chain = [];
    let id = current;
    while (id && mapping[id]) {
      chain.push(mapping[id]);
      id = mapping[id].parent;
    }
    return chain.reverse();
  };
  const sanitizeLang = (lang) => {
    if (!lang) return '';
    const s = String(lang).trim();
    return /^[A-Za-z0-9_+.#-]+$/.test(s) ? s : '';
  };
  const codeFenceFor = (text) => {
    const matches = [...String(text || '').matchAll(/`+/g)].map(mm => mm[0].length);
    const max = matches.length ? Math.max(...matches) : 0;
    return '`'.repeat(Math.max(3, max + 1));
  };
  const wrapCodeFence = (text, lang = '') => {
    const fence = codeFenceFor(text);
    return `${fence}${sanitizeLang(lang)}\n${text}\n${fence}`;
  };
  const isPreviewableImageExt = (ext) => ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
  const escapeMdLinkText = (text) => String(text || '').replace(/[[\]]/g, '');
  const ensureCodeFenceClosed = (text) => {
    const lines = text.split('\n');
    let openLen = null;
    for (const line of lines) {
      const mm = line.match(/^(`{3,})\s*(.*)$/);
      if (!mm) continue;
      const len = mm[1].length;
      const info = mm[2].trim();
      if (openLen === null) openLen = len;
      else if (len >= openLen && info === '') openLen = null;
    }
    if (openLen === null) return text;
    return `${text.endsWith('\n') ? text : `${text}\n`}${'`'.repeat(openLen)}\n`;
  };
  const parseJsonMaybe = (text) => {
    const s = String(text || '').trim();
    if (!s || !/^[{[]/.test(s)) return null;
    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  };
  const messageRawTextParts = (msg) => {
    const content = msg?.content || {};
    const out = [];
    if (typeof content.text === 'string') out.push(content.text);
    for (const part of content.parts || []) {
      if (typeof part === 'string') out.push(part);
      else if (part && typeof part === 'object' && typeof part.text === 'string') out.push(part.text);
    }
    return out;
  };
  const documentPayloadFromValue = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const name = pickFirst(value.name, value.title, value.documentTitle, value.document_title);
    const direct = pickFirst(value.content, value.markdown, value.text, value.body);
    if (direct && String(direct).trim()) {
      return { name, body: String(direct) };
    }
    if (Array.isArray(value.updates)) {
      const bodies = [];
      for (const update of value.updates) {
        const replacement = pickFirst(update?.replacement, update?.content, update?.text);
        if (replacement && String(replacement).trim()) bodies.push(String(replacement));
      }
      if (bodies.length) return { name, body: bodies.join('\n\n---\n\n') };
    }
    if (value.args && typeof value.args === 'object') return documentPayloadFromValue(value.args);
    if (value.arguments && typeof value.arguments === 'object') return documentPayloadFromValue(value.arguments);
    return null;
  };
  const renderAssistantDocumentMessage = (msg) => {
    const recipient = String(msg?.recipient || '');
    const looksDocumentTool = /(canmore|canvas|document|textdoc|artifact)/i.test(recipient);
    const payloads = [];
    for (const raw of messageRawTextParts(msg)) {
      const parsed = parseJsonMaybe(raw);
      const payload = parsed ? documentPayloadFromValue(parsed) : null;
      if (payload?.body) payloads.push(payload);
      else if (looksDocumentTool && raw && String(raw).trim() && !/^\s*[{[]/.test(String(raw))) {
        payloads.push({ name: '', body: String(raw) });
      }
    }
    if (!payloads.length) return null;
    const title = payloads.map(p => p.name).find(Boolean);
    const body = payloads.map(p => cleanMarkup(p.body)).filter(Boolean).join('\n\n---\n\n');
    if (!body.trim()) return null;
    return { title, body };
  };

  // ===== Bulk-aware asset download (waits on cooldown, no DOM fallback) =====
  // 終了条件は (a) 成功 (b) 4xx/5xx 等の恒久失敗 (c) waitForCooldown が
  // maxBatchPauseMs 超過で throw、の 3 つのみ。429/503 が続く限り再試行する。

  // 戻り値: { blob, reason, diag } の object。成功時 reason=null、失敗時 reason は
  // 'HTTP <status>' / 'fetch_error' / 'no_signed_url' / 'invalid_url' / 'signed_HTTP <status>'
  // のいずれか。BatchPauseError は throw で上に伝搬。reason は呼び出し側でログ出力と
  // _bulk-asset-failed.log への記録に用いる (v0.8.14 で追加)。
  // diag は HTTP エラー / no_signed_url 時に backend が返した body を tab/改行除去 +
  // 500 文字まで切り詰めた診断文字列 (v0.8.17 で追加)。`no_signed_url` の細分
  // (削除済 / 期限切れ / 権限切れ) や HTTP 404 の理由特定に用いる。
  const captureBodyText = async (r) => {
    try {
      const t = await r.text();
      return (t || '').replace(/[\t\n\r]+/g, ' ').slice(0, 500);
    } catch (_) {
      return '';
    }
  };
  const downloadAssetBlob = async (fileId, convIdForAsset) => {
    // ChatGPT 本体が実際に叩いているエンドポイントは
    //   /backend-api/files/download/<id>?conversation_id=<convId>&inline=false  (sediment / 生成画像)
    //   /backend-api/files/download/<id>?post_id=&inline=false                  (user-uploaded)
    // パスの順序が /files/<id>/download とは逆。生成画像はさらに conversation_id が必須。
    // 旧パス /files/<id>/download は user-uploaded には通っていたが sediment では 401 を返す。
    const isSediment = /^file_/.test(String(fileId));
    const qs = isSediment && convIdForAsset
      ? `conversation_id=${encodeURIComponent(convIdForAsset)}&inline=false`
      : `post_id=&inline=false`;
    const downloadPath = `/backend-api/files/download/${encodeURIComponent(fileId)}?${qs}`;
    while (true) {
      await waitForCooldown('file');
      let r;
      try {
        r = await fetchWithBackoff(
          downloadPath,
          { headers, redirect: 'follow' },
          `files/${fileId}`,
          { maxAttempts: 4, returnOnThrottle: true, cooldownKind: 'file' },
        );
      } catch (e) {
        if (e?.isBatchPause) throw e;
        return { blob: null, reason: `fetch_error:${e?.message || e}` };
      }
      if (r.status === 429 || r.status === 503) {
        noteFileThrottle(parseRetryAfter(r.headers.get('retry-after')));
        continue;
      }
      if (!r.ok) {
        const diag = await captureBodyText(r);
        return { blob: null, reason: `HTTP ${r.status}`, diag };
      }
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        // .json() を 2 回読めないので text を 1 度だけ取って parse する。
        // no_signed_url 分岐で body を diag に残すため (v0.8.17)。
        const text = await r.text();
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch (_) { j = null; }
        const url = j?.download_url || j?.url || j?.file_url || j?.signed_url;
        if (!url) {
          const diag = (text || '').replace(/[\t\n\r]+/g, ' ').slice(0, 500);
          return { blob: null, reason: 'no_signed_url', diag };
        }
        try {
          const u = new URL(url);
          if (u.protocol !== 'https:') return { blob: null, reason: `invalid_url:${u.protocol}` };
        } catch (_) {
          return { blob: null, reason: 'invalid_url:parse' };
        }
        // 同一オリジン (chatgpt.com / openai.com) の署名 URL は estuary が
        // Cookie セッションでも認証するため credentials: 'include' でないと
        // 403 になる。それ以外のホストは Cookie を漏らさず 'omit' のまま。
        const sameOrigin = isAllowedAssetHost(url);
        const r2 = await fetchWithBackoff(
          url,
          { credentials: sameOrigin ? 'include' : 'omit' },
          `asset-url/${fileId}`,
          { maxAttempts: 4, noteThrottle: true, cooldownKind: 'file' },
        );
        if (!r2.ok) return { blob: null, reason: `signed_HTTP ${r2.status}` };
        return { blob: await r2.blob(), reason: null };
      }
      return { blob: await r.blob(), reason: null };
    }
  };

  // ===== Per-conversation export =====

  const exportConversation = async (convMeta, tag) => {
    const convId = convMeta.id;

    await waitForCooldown('conversation');
    console.log(`📥 ${tag} 会話JSON取得中...`);
    const convoRes = await fetchWithBackoff(`/backend-api/conversation/${convId}`, { headers }, `conversation ${tag}`, { maxAttempts: 26, noteThrottle: true, cooldownKind: 'conversation' });
    if (!convoRes.ok) throw new Error(`会話JSON取得失敗: HTTP ${convoRes.status}`);
    const convo = await convoRes.json();
    convo.conversation_id = convo.conversation_id || convId;
    window.__lastConvo = convo;

    const aliasToBase = new Map();
    const assetMeta = new Map();
    const assets = new Map();
    const extMap = {};
    const renderedAssetBases = new Set();
    const renderedExternalLinks = new Set();

    const registerAlias = (alias, base) => {
      if (!alias || !base) return;
      if (!aliasToBase.has(alias)) aliasToBase.set(alias, base);
    };
    const registerWithUnderscoreSwap = (id, base) => {
      if (!id) return;
      registerAlias(id, base);
      if (id.startsWith('file-')) registerAlias('file_' + id.slice(5), base);
      if (id.startsWith('file_')) registerAlias('file-' + id.slice(5), base);
    };
    const mergeAssetMeta = (base, meta = {}) => {
      if (!base || !meta) return;
      const prev = assetMeta.get(base) || {};
      const next = {
        ...prev,
        filename: prev.filename || pickFirst(meta.filename, meta.name, meta.file_name, meta.fileName, meta.original_filename, meta.title),
        mime: prev.mime || pickFirst(meta.mime, meta.mime_type, meta.content_type),
        size: prev.size || meta.size || meta.file_size,
        externalUrl: prev.externalUrl || pickFirst(meta.externalUrl, meta.url),
      };
      assetMeta.set(base, next);
    };
    const addAsset = (raw, source, meta = {}) => {
      if (!raw) return null;
      const noScheme = stripScheme(raw);
      const noFrag = stripFragment(noScheme);
      let base = fileIdLikeStrict(raw);
      if (!base && isStrictFileId(noFrag)) base = noFrag;
      if (!base) {
        const seg = noFrag.split(/[\/?]/).pop();
        if (seg && isStrictFileId(seg)) base = seg;
      }
      if (!base) {
        console.warn(`  ⚠️ ${tag} ID として認識できない asset をスキップ: ${raw}`);
        return null;
      }
      const fragment = noScheme.includes('#') ? noScheme.slice(noScheme.indexOf('#')) : '';
      const composite = !!fragment;
      if (!assets.has(base)) {
        assets.set(base, { raw, full: noScheme, base, composite, fragment, source });
      } else {
        const a = assets.get(base);
        if (composite && !a.composite) {
          a.composite = true;
          a.full = noScheme;
          a.fragment = fragment;
        }
      }
      registerWithUnderscoreSwap(base, base);
      registerAlias(raw, base);
      registerAlias(noScheme, base);
      registerAlias(noFrag, base);
      const segNoScheme = noScheme.split(/[\/?]/).pop();
      const segNoFrag = noFrag.split(/[\/?]/).pop();
      registerWithUnderscoreSwap(segNoScheme, base);
      registerWithUnderscoreSwap(segNoFrag, base);
      mergeAssetMeta(base, meta);
      return base;
    };

    for (const node of Object.values(convo.mapping || {})) {
      const msg = node?.message;
      for (const info of attachmentInfos(msg)) addAsset(info.raw, 'json', info);
      for (const raw of messageAssetRaws(msg)) addAsset(raw, 'json');
    }
    const jsonAssetCount = assets.size;
    console.log(`  🧩 ${tag} JSON 由来 asset: ${jsonAssetCount} 件 / alias: ${aliasToBase.size}`);

    const resolveAssetBase = (raw) => {
      if (!raw) return null;
      const noScheme = stripScheme(raw);
      const noFrag = stripFragment(noScheme);
      const segNoFrag = noFrag.split(/[\/?]/).pop();
      const segNoScheme = noScheme.split(/[\/?]/).pop();
      const candidates = [
        raw,
        noScheme,
        noFrag,
        segNoFrag,
        segNoScheme,
        fileIdLikeStrict(noScheme),
      ].filter(Boolean);
      for (const c of candidates) {
        if (aliasToBase.has(c)) return aliasToBase.get(c);
        if (typeof c === 'string') {
          if (c.startsWith('file-') && aliasToBase.has('file_' + c.slice(5))) return aliasToBase.get('file_' + c.slice(5));
          if (c.startsWith('file_') && aliasToBase.has('file-' + c.slice(5))) return aliasToBase.get('file-' + c.slice(5));
        }
      }
      for (const c of candidates) {
        if (typeof c !== 'string') continue;
        if (Object.prototype.hasOwnProperty.call(extMap, c)) return c;
        const swap = c.startsWith('file-')
          ? `file_${c.slice(5)}`
          : c.startsWith('file_')
            ? `file-${c.slice(5)}`
            : null;
        if (swap && Object.prototype.hasOwnProperty.call(extMap, swap)) return swap;
      }
      return null;
    };

    let saved = 0;
    let failed = 0;
    let skipped = 0;
    let binCount = 0;
    const assetFailedLines = [];
    for (const [base, asset] of assets) {
      let blob = null;
      let reason = null;
      let diag = '';
      try {
        const result = await downloadAssetBlob(base, convId);
        blob = result?.blob || null;
        reason = result?.reason || null;
        diag = result?.diag || '';
      } catch (e) {
        if (e?.isBatchPause) throw e;
        reason = `exception:${e?.message || e}`;
        console.warn(`  ⚠️ ${tag} backend ${base}: ${e.message}`);
      }
      if (!blob) {
        failed++;
        const compositeTag = asset.composite ? ' (composite)' : '';
        const reasonTag = reason ? ` (${reason})` : '';
        console.warn(`  ❌ ${tag} ${base}${compositeTag} [${asset.source}]: 取得不可${reasonTag}`);
        // _bulk-asset-failed.log: TSV (timestamp / convId / assetBase / source / composite / reason / diag)
        // 会話タイトルは manifest 側にあるため重複保持しない。single で再取得する際は
        // convId だけ拾えば十分。diag は v0.8.17 で追加: no_signed_url / HTTP エラー時の
        // backend body (tab/改行除去 + 500 文字まで)。空のときは末尾タブが残るだけ。
        assetFailedLines.push([
          new Date().toISOString(),
          convId,
          base,
          asset.source || '',
          asset.composite ? 'composite' : 'single',
          reason || 'unknown',
          diag,
        ].join('\t'));
        continue;
      }
      const headBytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
      const head = headBytes.slice(0, 8);
      // HTML 応答 / bin skip も extMap に入らないため Markdown 側は「添付ファイル取得不可」になる。
      // single 再取得対象抽出のために _bulk-asset-failed.log にも積む (v0.8.14 で対応漏れていた)。
      const recordAssetSkip = (reasonTag, diagTag = '') => {
        assetFailedLines.push([
          new Date().toISOString(),
          convId,
          base,
          asset.source || '',
          asset.composite ? 'composite' : 'single',
          reasonTag,
          diagTag,
        ].join('\t'));
      };
      const sampleText = new TextDecoder('utf-8').decode(headBytes);
      if (head[0] === 0x3c) {
        skipped++;
        console.log(`  ⏭️ ${tag} ${base} (HTML応答)`);
        const htmlDiag = sampleText.replace(/[\t\n\r]+/g, ' ').slice(0, 200);
        recordAssetSkip('HTML_response', htmlDiag);
        continue;
      }
      const ext = guessExt(blob.type, head, sampleText);
      if (ext === 'bin') {
        binCount++;
        console.warn(`  ⚠️ ${tag} ${base}: 拡張子不明 (mime=${blob.type || 'unknown'} size=${blob.size}). binBehavior=${OPTIONS.binBehavior}`);
        if (OPTIONS.binBehavior === 'skip') {
          skipped++;
          recordAssetSkip(`bin_skip:${blob.type || 'unknown'}`);
          continue;
        }
      }
      const fh = await assetsDir.getFileHandle(`${base}.${ext}`, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      extMap[base] = ext;
      saved++;
      console.log(`  💾 ${tag} ${base}.${ext} [backend/${asset.source}]${asset.composite ? ' composite' : ''}`);
      await sleep(250);
    }
    console.log(`  ✅ ${tag} asset: 保存 ${saved} / スキップ ${skipped} / 失敗 ${failed} / .bin ${binCount}`);
    if (assetFailedLines.length) {
      try {
        await appendAssetFailedLog(assetFailedLines);
      } catch (e) {
        console.warn(`  ⚠️ ${tag} ${ASSET_FAILED_LOG_NAME} 追記失敗: ${e?.message || e}`);
      }
    }

    const displayNameForAsset = (base) => {
      const meta = assetMeta.get(base) || {};
      return meta.filename || base;
    };
    const renderAssetMarkdown = (raw, seenBases) => {
      const noScheme = stripScheme(raw);
      const fragment = noScheme.includes('#') ? noScheme.slice(noScheme.indexOf('#')) : '';
      const base = resolveAssetBase(raw);
      const ext = base ? extMap[base] : null;
      if (!base || !ext) {
        const meta = base ? assetMeta.get(base) || {} : {};
        const label = base ? `${displayNameForAsset(base)}${fragment}` : noScheme;
        const details = [
          meta.mime ? `type=${meta.mime}` : '',
          meta.size ? `size=${meta.size}` : '',
          base ? `id=${base}` : '',
        ].filter(Boolean).join(' / ');
        console.warn(`  🔎 ${tag} 描画失敗: raw=${raw} / base=${base} / ext-keys-sample=${Object.keys(extMap).slice(0, 3).join(',')}`);
        if (base && seenBases) seenBases.add(base);
        if (base) renderedAssetBases.add(base);
        return details
          ? `_(添付ファイル取得不可: ${label} / ${details})_`
          : `_(添付ファイル取得不可: ${label})_`;
      }
      if (seenBases) seenBases.add(base);
      renderedAssetBases.add(base);
      const path = `assets/${base}.${ext}`;
      const linkLabel = (assetMeta.get(base) || {}).filename || `${base}.${ext}`;
      const widthOpt = OPTIONS.obsidianImageWidth;
      const imgAlt = (typeof widthOpt === 'number' && Number.isFinite(widthOpt) && widthOpt > 0)
        ? `Image|${Math.floor(widthOpt)}`
        : '';
      const ref = isPreviewableImageExt(ext)
        ? `![${imgAlt}](${path})`
        : `[添付ファイル: ${escapeMdLinkText(linkLabel)}](${path})`;
      return fragment ? `${ref}\n_(ページ指定: ${fragment.slice(1)})_` : ref;
    };

    const messageExternalLinks = (msg) => {
      const refs = [];
      const seen = new Set();
      const add = (url) => {
        let u = String(url || '').replace(/[)\].,、。]+$/g, '');
        if (!/^https?:\/\//i.test(u)) return;
        try {
          const parsed = new URL(u);
          if (parsed.hostname === location.hostname) return;
          if (parsed.hostname.endsWith('.openai.com') || parsed.hostname.endsWith('.chatgpt.com')) return;
          u = parsed.href;
        } catch (_) {
          return;
        }
        if (seen.has(u)) return;
        seen.add(u);
        refs.push(u);
      };
      const visited = new WeakSet();
      const scan = (value, depth = 0) => {
        if (depth > 10 || value == null) return;
        if (typeof value === 'string') {
          for (const m of String(value).matchAll(/https?:\/\/[^\s"'<>]+/g)) add(m[0]);
          return;
        }
        if (typeof value !== 'object') return;
        if (visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) {
          for (const item of value) scan(item, depth + 1);
          return;
        }
        for (const child of Object.values(value)) scan(child, depth + 1);
      };
      scan(msg);
      return refs;
    };
    const renderExternalLinks = (msg) => {
      const lines = [];
      for (const url of messageExternalLinks(msg)) {
        if (renderedExternalLinks.has(url)) continue;
        renderedExternalLinks.add(url);
        lines.push(`- ${url}`);
      }
      return lines.length ? [`**参考リンク**\n\n${lines.join('\n')}`] : [];
    };

    const renderPart = (part, seenBases) => {
      if (typeof part === 'string') return cleanMarkup(part);
      if (part && typeof part === 'object' && part.asset_pointer) {
        return renderAssetMarkdown(part.asset_pointer, seenBases);
      }
      return '';
    };

    const renderMessageJsonAssets = (msg, seenBases) => {
      const refs = [];
      for (const raw of messageAssetRaws(msg)) {
        const base = resolveAssetBase(raw);
        if (!base || seenBases.has(base)) continue;
        if (renderedAssetBases.has(base)) continue;
        if (!extMap[base] && !assetMeta.has(base)) continue;
        const md = renderAssetMarkdown(raw, seenBases);
        if (md) refs.push(md);
      }
      return refs;
    };

    const renderMessage = (msg) => {
      if (!msg) return null;
      const role = msg.author?.role || 'unknown';
      const content = msg.content || {};
      const ct = content.content_type;
      const recipient = msg.recipient || 'all';
      if (role === 'system') return null;
      const internalTypes = [
        'thoughts',
        'reasoning_recap',
        'model_editable_context',
        'user_editable_context',
        'tether_browsing_display',
        'tether_quote',
        'execution_output',
        'app_pairing_content',
        'computer_output',
        'system_error',
      ];

      const seenBases = new Set();
      const parts = [];
      const appendMessageAssetRefs = () => {
        for (const r of renderMessageJsonAssets(msg, seenBases)) parts.push(r);
      };

      if (role === 'assistant' && recipient !== 'all') {
        const doc = renderAssistantDocumentMessage(msg);
        if (doc) {
          parts.push(doc.body);
          appendMessageAssetRefs();
          for (const r of renderExternalLinks(msg)) parts.push(r);
          const body = parts.filter(p => p && p.trim()).join('\n\n');
          if (!body.trim()) return null;
          let header = `### 📝 Document${doc.title ? `: ${cleanHeading(doc.title)}` : ''}`;
          if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
          return `${header}\n\n${body}`;
        }
        if (OPTIONS.includeImagePrompts && /(?:^|\.)(?:dalle|image_gen|image_generator)/i.test(recipient)) {
          const promptText = messageRawTextParts(msg).map(t => String(t || '').trim()).filter(Boolean).join('\n\n');
          if (!promptText) return null;
          let header = '### 🎨 生成プロンプト';
          if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
          const fence = codeFenceFor(promptText);
          return `${header}\n\n${fence}json\n${promptText}\n${fence}`;
        }
        return null;
      }

      if (role === 'tool') {
        appendMessageAssetRefs();
        for (const r of renderExternalLinks(msg)) parts.push(r);
        const body = parts.filter(p => p && p.trim()).join('\n\n');
        if (!body.trim()) return null;
        let header = '### 📎 Tool output';
        if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
        return `${header}\n\n${body}`;
      }

      if (internalTypes.includes(ct)) {
        appendMessageAssetRefs();
        for (const r of renderExternalLinks(msg)) parts.push(r);
        const body = parts.filter(p => p && p.trim()).join('\n\n');
        if (!body.trim()) return null;
        let header = '### 📎 Tool output';
        if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
        return `${header}\n\n${body}`;
      }

      const label = role === 'user' ? '👤 User' : role === 'assistant' ? '🤖 Assistant' : role;
      if (ct === 'text' || ct === 'multimodal_text') {
        for (const p of (content.parts || [])) {
          const r = renderPart(p, seenBases);
          if (r) parts.push(r);
        }
        appendMessageAssetRefs();
      } else if (ct === 'code') {
        const text = cleanCodeText(content.text || '');
        if (text) parts.push(wrapCodeFence(text, content.language || ''));
        appendMessageAssetRefs();
      } else {
        appendMessageAssetRefs();
        if (!parts.length) return null;
      }
      const body = parts.filter(p => p && p.trim()).join('\n\n');
      if (!body.trim()) return null;
      let header = `### ${label}`;
      if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
      return `${header}\n\n${body}`;
    };

    const headingTitle = cleanHeading(convo.title);
    const cTime = convo.create_time;
    const uTime = convo.update_time;
    const model = convo.default_model_slug || '(モデル不明)';
    const chain = linearize(convo.mapping, convo.current_node);
    const blocks = [];
    for (const node of chain) {
      const block = renderMessage(node.message);
      if (block) {
        let body = block;
        if (OPTIONS.emitBlockRefs) {
          const ref = blockRefId(node.message?.create_time);
          if (ref) body = `${block}\n\n^${ref}`;
        }
        blocks.push(body);
      }
    }
    let frontmatter = '';
    if (OPTIONS.emitFrontmatter) {
      const lines = [
        '---',
        `title: ${yamlEscape(headingTitle)}`,
        `conversation_id: ${yamlEscape(convo.conversation_id || convId)}`,
        `url: ${yamlEscape(`https://chatgpt.com/c/${convId}`)}`,
      ];
      if (cTime) lines.push(`created_at: ${yamlEscape(isoFromEpoch(cTime))}`);
      if (uTime) lines.push(`updated_at: ${yamlEscape(isoFromEpoch(uTime))}`);
      lines.push(`exported_at: ${yamlEscape(new Date().toISOString())}`);
      if (model) lines.push(`model: ${yamlEscape(model)}`);
      lines.push(`message_count: ${blocks.length}`);
      lines.push('tags: [ChatGPT]');
      lines.push('---', '');
      frontmatter = lines.join('\n') + '\n';
    }
    const headerSection = `# ${headingTitle}\n\n`
      + `- **作成日時:** ${fmtTime(cTime)}\n`
      + `- **最終更新:** ${fmtTime(uTime)}\n`
      + `- **モデル:** ${model}\n`
      + `- **会話ID:** ${convo.conversation_id}\n\n---\n\n`;
    let md = frontmatter + headerSection + blocks.join('\n\n---\n\n') + '\n';

    const savedUnreferenced = Object.entries(extMap)
      .filter(([base]) => !renderedAssetBases.has(base))
      .sort(([a], [b]) => a.localeCompare(b));
    if (savedUnreferenced.length) {
      let appendix = `\n\n---\n\n## 保存済み未参照画像\n\n`;
      appendix += `_画像ファイルは取得済みですが、会話JSON内の本文位置と対応付けられなかったため、末尾にまとめて列挙しています。_\n\n`;
      for (const [base, ext] of savedUnreferenced) {
        const path = `assets/${base}.${ext}`;
        appendix += isPreviewableImageExt(ext)
          ? `- ![](${path})\n`
          : `- [添付ファイル: ${base}.${ext}](${path})\n`;
      }
      md += appendix;
    }

    if (OPTIONS.forceCloseAllFences) md = ensureCodeFenceClosed(md);

    const dateStr = cTime ? fmtTime(cTime).slice(0, 10) : 'unknown';
    // ファイル名衝突回避用 ID は UUID 末尾 8 文字 (完全ランダム部) を使う。
    // 旧実装は先頭 8 文字 (UUID v7 のタイムスタンプ秒部) を使っていたが、
    // 同じ秒に採番された会話間で衝突し、同日同タイトル ("New chat" など) と
    // 重なると上書きでデータ消失していた。末尾 8 文字なら 4.3B 通りで実質ユニーク。
    const convIdFile = convId.slice(-8);
    const fname = `${dateStr}_${safeFilename(headingTitle)}_${convIdFile}.md`;
    const fh = await rootDir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(md);
    await w.close();

    console.log(`  🎉 ${tag} 完了: ${fname}`);
    return { fname, saved, skipped, failed, binCount, jsonAssetCount, sourceUpdatedAt: uTime ?? cTime ?? null };
  };

  // ===== Main loop =====

  let targets;
  let queue = null;
  let listResult = null;
  let listSeenIds = new Set();

  const manifest = OPTIONS.resume ? await readManifest() : newManifest();
  manifest.startedAt = new Date().toISOString();
  manifest.scope = OPTIONS.scope;
  manifest.mode = 'json-only';
  manifest.conversations = manifest.conversations || {};
  if (OPTIONS.resume) {
    const entries = Object.values(manifest.conversations);
    const doneCount = entries.filter(e => e?.status === 'done').length;
    const failedCount = entries.filter(e => e?.status === 'failed').length;
    console.log(`📂 manifest 読込: done ${doneCount} / failed ${failedCount} / 全 ${entries.length} 件`);
    if (entries.length === 0) {
      console.log('   ⚠️ manifest 0 件 — 別フォルダを選択した可能性があります。前回と同じフォルダか確認してください');
    }
  }

  // v0.8.18: 過去 session で生まれた " 2.log" duplicate をマージ。
  // appendAssetFailedLog は session 跨ぎで稀にファイル分離するため、
  // 起動時に拾い直して main file に統合する。
  try {
    await mergeOrphanLogDuplicates(ASSET_FAILED_LOG_NAME);
    await mergeOrphanLogDuplicates(FAILED_LOG_NAME);
  } catch (e) {
    console.warn(`  ⚠️ duplicate log merge 失敗: ${e?.message || e}`);
  }

  if (OPTIONS.scope.type === 'idList') {
    const ids = Array.isArray(OPTIONS.scope.ids) ? OPTIONS.scope.ids.filter(Boolean) : [];
    if (!ids.length) {
      console.log('idList が空のため終了します');
      return;
    }
    console.log(`📋 idList: ${ids.length} 件を /backend-api/conversation/<id> から直接取得します`);
    // 一覧取得を経由しないため、404 等の見つからない ID は exportConversation 内で
    // 例外となり main loop で failed として manifest / _bulk-failed.log に記録される。
    targets = ids.map(id => ({ id }));
  } else {
    queue = await readQueue();
    const queueBeforeCount = queueIdCount(queue);
    console.log(`📚 queue 読込: ${queueBeforeCount} 件`);
    console.log('📋 会話リスト取得中...');
    try {
      listResult = await collectConversations(OPTIONS.scope, queue);
    } catch (e) {
      if (!e?.isBatchPause) throw e;
      if (queueIdCount(queue) === 0) {
        pauseReason = e.pauseKind || 'unknown';
        await pauseBatch({ manifest, queue, reason: e.message || String(e) });
        return;
      }
      console.warn(`  ⚠️ 会話リスト取得は一時停止しましたが、既存 queue ${queueIdCount(queue)} 件から続行します: ${e.message || e}`);
      await writeQueue(queue);
      listResult = { items: [], seenIds: new Set(), reportedTotal: null, endedEarly: true, paused: true };
    }

    let allList = listResult.items;
    listSeenIds = listResult.seenIds || new Set();
    console.log(`  → 取得 ${allList.length} 件${listResult.reportedTotal != null ? ` / reported total ${listResult.reportedTotal}` : ''}`);

    const shouldSecondPass = OPTIONS.scope.type === 'all' && (
      queueBeforeCount === 0
      || listResult.endedEarly
      || allList.length < queueBeforeCount
    );
    if (shouldSecondPass) {
      console.log('  🔁 会話リスト 2 パス目を実行します');
      await sleep(2000);
      try {
        const second = await collectConversations(OPTIONS.scope, queue);
        const known = new Set(allList.map(c => c?.id).filter(Boolean));
        let addedToList = 0;
        for (const c of second.items) {
          if (!c?.id || known.has(c.id)) continue;
          known.add(c.id);
          allList.push(c);
          addedToList++;
        }
        for (const id of second.seenIds || []) listSeenIds.add(id);
        console.log(`  🔁 2 パス目: 追加 ${addedToList} 件 / queue ${queueIdCount(queue)} 件`);
      } catch (e) {
        if (!e?.isBatchPause) throw e;
        console.warn(`  ⚠️ 2 パス目は一時停止しました。queue ${queueIdCount(queue)} 件から続行します: ${e.message || e}`);
      }
    } else if (OPTIONS.scope.type === 'all') {
      console.log('  → 1 パス目で揺らぎなし — 2 パス目スキップ');
    }

    const queueAfterCount = queueIdCount(queue);
    if (OPTIONS.scope.type === 'all' && allList.length < queueBeforeCount) {
      console.warn(`⚠️ 会話一覧 API の揺らぎ検出: 今回 ${allList.length} 件 / queue 既知 ${queueBeforeCount} 件 (差 ${queueBeforeCount - allList.length}) — queue から補完して targets を構築します`);
    }
    await writeQueue(queue);

    if (OPTIONS.scope.type === 'latest') {
      targets = buildLatestTargets(filterByScope(allList, OPTIONS.scope), queue, OPTIONS.scope, listSeenIds);
    } else {
      targets = buildTargetsFromQueue(queue, OPTIONS.scope, listSeenIds);
    }
    console.log(`📚 queue 更新: ${queueBeforeCount} → ${queueAfterCount} 件`);
    console.log(`📋 対象会話: ${targets.length} 件 (scope=${JSON.stringify(OPTIONS.scope)})`);
  }
  if (!targets.length) {
    console.log('対象がないため終了します');
    return;
  }
  let resumeMismatchLogged = 0;
  let queueOnlySkipWarnLogged = 0;
  let queueOnlyDoneSkipped = 0;

  // succeeded / skippedConv / failedConv / pausedConv は v0.8.16 で前方へ移動
  // (noteConversationThrottle から snapshot するため). 初期値 0 のまま使う。
  const startedAt = now();
  const startedAtIso = new Date(startedAt).toISOString();

  for (let i = 0; i < targets.length; i++) {
    if (window.__bulkAbort) {
      console.warn('🛑 中断要求 (window.__bulkAbort=true) を検出 — 停止します');
      if (queue) await writeQueue(queue);
      await writeManifest(manifest);
      pauseReason = 'userAbort';
      break;
    }
    const convMeta = targets[i];
    // 表示用は [i/N] のみ。実際の処理は full UUID で行うため短縮 ID は不要。
    // 完了ログの ${fname} に日付・タイトル・末尾 8 文字 ID が出るので、
    // [i/N] と ${fname} の対応で会話を後追いできる。
    const tag = `[${i + 1}/${targets.length}]`;
    const prev = manifest.conversations[convMeta.id];
    // idList 経路は convMeta.update_time を持たないため resume 比較不可。
    // その場合は常に再エクスポートする（明示指定された ID なので妥当）。
    // 許容範囲付きで比較: list API と full JSON API が同じ会話に対して
    // 100〜200ms 異なる update_time を返すため、floor 後の秒整数が 1 秒ズレる
    // ケースが頻発する。実ユーザの会話更新は分〜時単位で起きるので
    // ±2 秒の許容は安全。
    const RESUME_TOLERANCE_SEC = 2;
    if (
      OPTIONS.resume
      && prev?.status === 'done'
      && convMeta.update_time
      && prev.sourceUpdatedAt
      && Math.abs(tsToSeconds(prev.sourceUpdatedAt) - tsToSeconds(convMeta.update_time)) <= RESUME_TOLERANCE_SEC
    ) {
      skippedConv++;
      if (convMeta.fromQueueOnly) {
        queueOnlyDoneSkipped++;
        if (queueOnlySkipWarnLogged < 3) {
          console.log(`  🔁 ${tag} queue補完/未確認: 更新検知できません。次回 list で見えた時点で再判定されます`);
          queueOnlySkipWarnLogged++;
        }
      }
      console.log(`⏭️  ${tag} 変更なし — スキップ`);
      continue;
    }
    if (OPTIONS.resume && prev?.status === 'done' && resumeMismatchLogged < 3) {
      const reason = !convMeta.update_time
        ? `convMeta.update_time が空 (${convMeta.update_time})`
        : !prev.sourceUpdatedAt
          ? `manifest.sourceUpdatedAt が空`
          : `timestamp 不一致 (差 ${Math.abs(tsToSeconds(prev.sourceUpdatedAt) - tsToSeconds(convMeta.update_time))}秒): manifest=${prev.sourceUpdatedAt} (→${tsToSeconds(prev.sourceUpdatedAt)}) vs list=${convMeta.update_time} (→${tsToSeconds(convMeta.update_time)})`;
      console.log(`  🔁 ${tag} done 済みだが再エクスポート: ${reason}`);
      resumeMismatchLogged++;
    }
    try {
      const stats = await exportConversation(convMeta, tag);
      manifest.conversations[convMeta.id] = {
        status: 'done',
        exportedAt: new Date().toISOString(),
        // list API と full JSON で update_time が ~150ms ズレるため、resume 比較で
        // 使う側 (= convMeta.update_time, list 由来) を優先して保存する。
        // idList scope では convMeta.update_time が無いので full JSON にフォールバック。
        sourceUpdatedAt: convMeta.update_time ?? stats.sourceUpdatedAt ?? null,
        mdFile: stats.fname,
        stats: {
          saved: stats.saved,
          skipped: stats.skipped,
          failed: stats.failed,
          binCount: stats.binCount,
          jsonAssetCount: stats.jsonAssetCount,
        },
      };
      succeeded++;
      noteAdaptiveSuccess();
    } catch (e) {
      if (e?.isBatchPause) {
        pausedConv++;
        pauseReason = e.pauseKind || pauseReason || 'unknown';
        await pauseBatch({ manifest, queue, reason: e.message || String(e) });
        break;
      }
      failedConv++;
      const msg = String(e?.message || e);
      manifest.conversations[convMeta.id] = {
        status: 'failed',
        exportedAt: new Date().toISOString(),
        sourceUpdatedAt: convMeta.update_time ?? null,
        error: msg,
      };
      await appendFailedLog(`${new Date().toISOString()}\t${convMeta.id}\t${msg}`);
      console.error(`❌ ${tag} 失敗:`, e);
    }
    await writeManifest(manifest);
    if (queue) await writeQueue(queue);
    if (i + 1 < targets.length) await sleep(adaptiveDelayMs);
  }

  const endedAt = now();
  const elapsedSec = Math.round((endedAt - startedAt) / 1000);
  if (queueOnlyDoneSkipped > 0) {
    console.log(`  ℹ️ queue 補完分のうち ${queueOnlyDoneSkipped} 件が done スキップ — 次回 list が完全取得されたタイミングで更新検知されます`);
  }
  console.log(`\n🎉 バッチ完了: 成功 ${succeeded} / スキップ ${skippedConv} / 失敗 ${failedConv} / 一時停止 ${pausedConv} / 全 ${targets.length} (${elapsedSec}秒)`);

  // v0.8.16: run-scoped 統計を構造化出力。docs/throttle-burst-investigation.md §4.1 の仕様。
  // preFirstThrottleSuccessCount が null = この run では throttle を観測しなかった。
  // successBeforePause は succeeded と等価だが、pause 直前の値という意味で別名で出す。
  const runStats = {
    version: 'v0.8.18',
    startedAt: startedAtIso,
    endedAt: new Date(endedAt).toISOString(),
    elapsedSec,
    scope: OPTIONS.scope,
    totalConversations: targets.length,
    succeeded,
    skippedConv,
    failedConv,
    pausedConv,
    preFirstThrottleSuccessCount,
    firstThrottleAt,
    successBeforePause: succeeded,
    conversation429Count,
    cooldownPauseMs: totalConversationPauseMs,
    throttleEvents,
    decayEvents,
    pauseReason,
  };
  console.log('   📊 run-stats:', JSON.stringify(runStats));
  await appendRunStatsJsonl(runStats);
  console.log('   v0.8.18: session 跨ぎの log duplicate (_bulk-asset-failed 2.log 等) を起動時に統合');
})();
