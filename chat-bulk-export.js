/**
 * ChatGPT bulk conversation exporter v0.8.3
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
 *   ├── _bulk-failed.log
 *   ├── <YYYY-MM-DD>_<title>_<convId8>.md
 *   ├── ...
 *   └── assets/
 *       ├── file-...png
 *       └── ...
 *
 * 設計方針:
 * - JSON-only / backend-only。DOM 補正と DOM download fallback は意図的に
 *   無効化している。一括処理では対象会話の DOM が画面に存在しないため、
 *   信頼性のある DOM 経路を構築できないことが理由。
 * - backend 429/503 を受けた場合、バッチ全体で cooldown 解除を待ってから
 *   同じ asset を再試行する（single の DOM fallback には逃がさない）。
 *   これにより throttle 中の大量 asset 失敗を回避する。
 * - 画像欠落の検出 (needs-dom-rerun 等) は出力しない。bulk は DOM-only 画像
 *   の存在を判定できないため、画像が疑わしい会話は chat-single-export.js で
 *   個別に再エクスポートする運用を README で案内する。
 * - レジューム: `_bulk-manifest.json` を会話ごとに全書き換えで保持し、
 *   `status === 'done' && sourceUpdatedAt === conv.update_time` のものは
 *   再実行時にスキップする。
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

    scope: { type: 'latest', count: 50 },
    // 例:
    //   { type: 'all' }
    //   { type: 'sinceDays', days: 30 }
    //   { type: 'idList', ids: ['xxxx-...', 'yyyy-...'] }
    perConversationDelayMs: 1500,
    resume: true,
    maxBatchPauseMs: 5 * 60 * 1000,
  };

  if (!window.showDirectoryPicker) {
    alert('Chrome / Edge で実行してください');
    return;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const MIN_WAIT_MS = 800;
  const MANIFEST_NAME = '_bulk-manifest.json';
  const FAILED_LOG_NAME = '_bulk-failed.log';
  const PAGE_LIMIT = 100;

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

  let backendCooldownUntil = 0;
  let totalBatchPauseMs = 0;
  const noteBackendThrottle = (retryAfterMs) => {
    const base = Math.max(retryAfterMs ?? 0, 30000);
    backendCooldownUntil = Math.max(backendCooldownUntil, now() + base);
    console.log(`  🧊 backend クールダウン: 次回 ${Math.round((backendCooldownUntil - now()) / 1000)}秒後まで使用しません`);
  };
  const backendAvailable = () => now() >= backendCooldownUntil;
  const waitForCooldown = async () => {
    while (!backendAvailable()) {
      const remaining = backendCooldownUntil - now();
      if (totalBatchPauseMs + remaining > OPTIONS.maxBatchPauseMs) {
        throw new Error(`バッチ累積待機が ${Math.round(OPTIONS.maxBatchPauseMs / 1000)}秒を超過したため中断します`);
      }
      console.log(`  ⏳ クールダウン待機: 残り ${Math.round(remaining / 1000)}秒`);
      const wait = remaining + 500;
      totalBatchPauseMs += wait;
      await sleep(wait);
    }
  };

  const fetchWithBackoff = async (url, init = {}, label = url, opts = {}) => {
    const maxAttempts = opts.maxAttempts ?? 26;
    const returnOnThrottle = opts.returnOnThrottle ?? false;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        lastErr = e;
        if (attempt + 1 >= maxAttempts) break;
        const wait = Math.max(MIN_WAIT_MS, Math.min(60000, 1500 * Math.pow(1.6, attempt)));
        await sleep(wait);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        if (returnOnThrottle) return res;
        const ra = parseRetryAfter(res.headers.get('retry-after'));
        const wait = Math.max(MIN_WAIT_MS, ra != null ? ra : Math.min(60000, 1500 * Math.pow(1.6, attempt)));
        console.log(`  ⏳ ${res.status} ${label}: ${Math.round(wait / 1000)}秒待機 (${attempt + 1}/${maxAttempts})`);
        if (attempt + 1 >= maxAttempts) return res;
        await sleep(wait);
        continue;
      }
      return res;
    }
    throw new Error(`fetch giving up: ${label}${lastErr ? ' / ' + lastErr.message : ''}`);
  };

  // ===== Conversation list =====

  const tsToSeconds = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
    }
    return 0;
  };

  const fetchConversationPage = async (offset, limit) => {
    const url = `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`;
    const r = await fetchWithBackoff(url, { headers }, `conversations[${offset}..]`, { maxAttempts: 8 });
    if (!r.ok) throw new Error(`会話リスト取得失敗: HTTP ${r.status}`);
    return r.json();
  };

  const collectConversations = async (scope) => {
    const all = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const page = await fetchConversationPage(offset, PAGE_LIMIT);
      total = typeof page.total === 'number' ? page.total : (offset + (page.items?.length || 0));
      const items = page.items || [];
      if (!items.length) break;
      for (const c of items) all.push(c);
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
    return all;
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
    if (head[0] === 0x89 && head[1] === 0x50) return 'png';
    if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
    if (head[0] === 0x52 && head[1] === 0x49) return 'webp';
    if (head[0] === 0x47 && head[1] === 0x49) return 'gif';
    if (head[0] === 0x25 && head[1] === 0x50) return 'pdf';
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
      await waitForCooldown();
      let r;
      try {
        r = await fetchWithBackoff(
          downloadPath,
          { headers, redirect: 'follow' },
          `files/${fileId}`,
          { maxAttempts: 4, returnOnThrottle: true },
        );
      } catch (_) {
        return null;
      }
      if (r.status === 429 || r.status === 503) {
        noteBackendThrottle(parseRetryAfter(r.headers.get('retry-after')));
        continue;
      }
      if (!r.ok) return null;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        const j = await r.json().catch(() => null);
        const url = j?.download_url || j?.url || j?.file_url || j?.signed_url;
        if (!url) return null;
        try {
          const u = new URL(url);
          if (u.protocol !== 'https:') return null;
        } catch (_) {
          return null;
        }
        // 同一オリジン (chatgpt.com / openai.com) の署名 URL は estuary が
        // Cookie セッションでも認証するため credentials: 'include' でないと
        // 403 になる。それ以外のホストは Cookie を漏らさず 'omit' のまま。
        const sameOrigin = isAllowedAssetHost(url);
        const r2 = await fetch(url, { credentials: sameOrigin ? 'include' : 'omit' });
        if (!r2.ok) return null;
        return r2.blob();
      }
      return r.blob();
    }
  };

  // ===== Per-conversation export =====

  const exportConversation = async (convMeta) => {
    const convId = convMeta.id;
    const convId8 = convId.slice(0, 8);

    console.log(`📥 [${convId8}] 会話JSON取得中...`);
    const convoRes = await fetchWithBackoff(`/backend-api/conversation/${convId}`, { headers }, `conversation/${convId8}`, { maxAttempts: 26 });
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
        console.warn(`  ⚠️ [${convId8}] ID として認識できない asset をスキップ: ${raw}`);
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
    console.log(`  🧩 [${convId8}] JSON 由来 asset: ${jsonAssetCount} 件 / alias: ${aliasToBase.size}`);

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
    for (const [base, asset] of assets) {
      let blob = null;
      try {
        blob = await downloadAssetBlob(base, convId);
      } catch (e) {
        if (/バッチ累積待機/.test(String(e?.message || ''))) throw e;
        console.warn(`  ⚠️ [${convId8}] backend ${base}: ${e.message}`);
      }
      if (!blob) {
        failed++;
        console.warn(`  ❌ [${convId8}] ${base}${asset.composite ? ' (composite)' : ''} [${asset.source}]: 取得不可`);
        continue;
      }
      const headBytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
      const head = headBytes.slice(0, 8);
      if (head[0] === 0x3c) {
        skipped++;
        console.log(`  ⏭️ [${convId8}] ${base} (HTML応答)`);
        continue;
      }
      const sampleText = new TextDecoder('utf-8').decode(headBytes);
      const ext = guessExt(blob.type, head, sampleText);
      if (ext === 'bin') {
        binCount++;
        console.warn(`  ⚠️ [${convId8}] ${base}: 拡張子不明 (mime=${blob.type || 'unknown'} size=${blob.size}). binBehavior=${OPTIONS.binBehavior}`);
        if (OPTIONS.binBehavior === 'skip') {
          skipped++;
          continue;
        }
      }
      const fh = await assetsDir.getFileHandle(`${base}.${ext}`, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      extMap[base] = ext;
      saved++;
      console.log(`  💾 [${convId8}] ${base}.${ext} [backend/${asset.source}]${asset.composite ? ' composite' : ''}`);
      await sleep(250);
    }
    console.log(`  ✅ [${convId8}] asset: 保存 ${saved} / スキップ ${skipped} / 失敗 ${failed} / .bin ${binCount}`);

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
        console.warn(`  🔎 [${convId8}] 描画失敗: raw=${raw} / base=${base} / ext-keys-sample=${Object.keys(extMap).slice(0, 3).join(',')}`);
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
    const fname = `${dateStr}_${safeFilename(headingTitle)}_${convId8}.md`;
    const fh = await rootDir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(md);
    await w.close();

    console.log(`  🎉 [${convId8}] 完了: ${fname}`);
    return { fname, saved, skipped, failed, binCount, jsonAssetCount, sourceUpdatedAt: uTime ?? cTime ?? null };
  };

  // ===== Main loop =====

  let targets;
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
    console.log('📋 会話リスト取得中...');
    const allList = await collectConversations(OPTIONS.scope);
    console.log(`  → 取得 ${allList.length} 件`);
    targets = filterByScope(allList, OPTIONS.scope);
    console.log(`📋 対象会話: ${targets.length} 件 (scope=${JSON.stringify(OPTIONS.scope)})`);
  }
  if (!targets.length) {
    console.log('対象がないため終了します');
    return;
  }

  const manifest = OPTIONS.resume ? await readManifest() : newManifest();
  manifest.startedAt = new Date().toISOString();
  manifest.scope = OPTIONS.scope;
  manifest.mode = 'json-only';
  manifest.conversations = manifest.conversations || {};

  let succeeded = 0;
  let skippedConv = 0;
  let failedConv = 0;
  const startedAt = now();

  for (let i = 0; i < targets.length; i++) {
    if (window.__bulkAbort) {
      console.warn('🛑 中断要求 (window.__bulkAbort=true) を検出 — 停止します');
      break;
    }
    const convMeta = targets[i];
    const tag = `[${i + 1}/${targets.length}] ${convMeta.id.slice(0, 8)}`;
    const prev = manifest.conversations[convMeta.id];
    // idList 経路は convMeta.update_time を持たないため resume 比較不可。
    // その場合は常に再エクスポートする（明示指定された ID なので妥当）。
    if (
      OPTIONS.resume
      && prev?.status === 'done'
      && convMeta.update_time
      && prev.sourceUpdatedAt
      && tsToSeconds(prev.sourceUpdatedAt) === tsToSeconds(convMeta.update_time)
    ) {
      skippedConv++;
      console.log(`⏭️  ${tag} 変更なし — スキップ`);
      continue;
    }
    try {
      const stats = await exportConversation(convMeta);
      manifest.conversations[convMeta.id] = {
        status: 'done',
        exportedAt: new Date().toISOString(),
        sourceUpdatedAt: stats.sourceUpdatedAt ?? convMeta.update_time ?? null,
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
    } catch (e) {
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
      if (/バッチ累積待機/.test(msg)) {
        console.warn('🛑 累積待機超過のためバッチを停止します。再実行で resume されます。');
        await writeManifest(manifest);
        break;
      }
    }
    await writeManifest(manifest);
    if (i + 1 < targets.length) await sleep(OPTIONS.perConversationDelayMs);
  }

  const elapsedSec = Math.round((now() - startedAt) / 1000);
  console.log(`\n🎉 バッチ完了: 成功 ${succeeded} / スキップ ${skippedConv} / 失敗 ${failedConv} / 全 ${targets.length} (${elapsedSec}秒)`);
  console.log('   v0.8.3: ファイルダウンロードのエンドポイントを /backend-api/files/download/<id>?conversation_id=… に切り替えました');
})();
