/**
 * ChatGPT single conversation exporter v7.14
 *
 * v7.14 fixes:
 * - Some images are present in message.metadata.attachments and get downloaded,
 *   but are not present in content.parts[].asset_pointer. Those images are now
 *   rendered at the end of the corresponding Markdown message.
 * - Asset alias resolution is strengthened for scheme / fragment forms such as
 *   file-service://file-xxx and sediment://file_xxx#....
 * - Any downloaded image that still was not rendered in-message is appended in
 *   a final "saved but unreferenced" section.
 * - Each message object is recursively scanned for asset references, so saved
 *   generated images can be rendered near their source message instead of only
 *   in the final fallback appendix.
 * - DOM-only images are mapped to the closest visible conversation turn and
 *   rendered at that turn, instead of always going to the appendix.
 * - Tool messages that contain renderable image assets are emitted as
 *   image-only Markdown blocks, preserving generated-image positions.
 * - file_search browsing/citation tool references are ignored as export assets,
 *   and reserved tokens such as file_search / file-service are not treated as
 *   file IDs.
 * - Text-like downloaded tool outputs are recognized as csv / tsv / json / txt
 *   instead of falling back to .bin when possible.
 * - Inaccessible uploaded files keep their original filename / MIME metadata in
 *   Markdown when conversation JSON still contains attachment metadata.
 * - External http(s) reference links found only in tool payloads are preserved.
 * - Bare file IDs in ordinary assistant text are not recursively re-collected,
 *   preventing duplicate placeholders and lowercased false aliases.
 * - Standalone citation remnants such as trailing "file" are removed from
 *   rendered prose.
 * - ChatGPT file placeholders such as {{file:file-...}} are removed from prose
 *   because the exporter renders the attachment link separately.
 * - Expired sandbox:/mnt/data download links are converted to filename-only
 *   inaccessible attachment notes.
 * - Canvas / document creation assistant messages addressed to internal
 *   document tools are rendered instead of being dropped.
 * - window.__lastConvo and window.__lastExtMap are exposed for diagnostics.
 *
 * Non-official ChatGPT internal API / DOM dependent script.
 */
(async () => {
  const OPTIONS = {
    binBehavior: 'save',
    forceCloseAllFences: false,
    allowLooseQueryId: false,
    recursiveMessageAssetScan: true,
    domTurnPositioning: true,
  };

  if (!window.showDirectoryPicker) {
    alert('Chrome / Edge で実行してください');
    return;
  }

  const m = location.pathname.match(/\/c\/([0-9a-f-]{8,})/i);
  if (!m) {
    alert('チャットページ（/c/<id>）で実行してください');
    return;
  }

  const convId = m[1];
  const convId8 = convId.slice(0, 8);
  console.log('🎯 対象会話:', convId);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const MIN_WAIT_MS = 800;

  const session = await fetch('/api/auth/session').then(r => r.json());
  const token = session.accessToken;
  if (!token) {
    alert('ログインしてから実行してください');
    return;
  }
  const headers = { Authorization: `Bearer ${token}` };

  const rootDir = await window.showDirectoryPicker({ mode: 'readwrite' });
  const imagesDir = await rootDir.getDirectoryHandle('images', { create: true });

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
  const noteBackendThrottle = (retryAfterMs) => {
    const base = Math.max(retryAfterMs ?? 0, 30000);
    backendCooldownUntil = Math.max(backendCooldownUntil, now() + base);
    console.log(`  🧊 backend クールダウン: 次回 ${Math.round((backendCooldownUntil - now()) / 1000)}秒後まで使用しません`);
  };
  const backendAvailable = () => now() >= backendCooldownUntil;

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

  console.log('📥 会話JSON取得中...');
  const convoRes = await fetchWithBackoff(`/backend-api/conversation/${convId}`, { headers }, 'conversation', { maxAttempts: 26 });
  if (!convoRes.ok) throw new Error(`会話JSON取得失敗: HTTP ${convoRes.status}`);
  const convo = await convoRes.json();
  convo.conversation_id = convo.conversation_id || convId;
  window.__lastConvo = convo;

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

  const aliasToBase = new Map();
  const assetMeta = new Map();
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
  const pickFirst = (...values) => values.find(v => v != null && String(v).trim());
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

  const assets = new Map();
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
      console.warn(`  ⚠️ ID として認識できない asset をスキップ: ${raw}`);
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

  for (const node of Object.values(convo.mapping || {})) {
    const msg = node?.message;
    for (const info of attachmentInfos(msg)) addAsset(info.raw, 'json', info);
    for (const raw of messageAssetRaws(msg)) addAsset(raw, 'json');
  }
  const jsonAssetCount = assets.size;
  console.log(`🧩 JSON 由来 asset: ${jsonAssetCount} 件 / alias: ${aliasToBase.size}`);

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

  const collectDomImagesAndPromote = async (maxLoops = 30) => {
    const scroller = document.querySelector('[class*="overflow-y-auto"]') || document.scrollingElement;
    const scrollTo = async (top) => {
      try {
        scroller.scrollTo({ top, behavior: 'instant' });
      } catch (_) {}
      await sleep(700);
    };
    await scrollTo(scroller.scrollHeight);
    await sleep(1000);
    let prev = -1;
    for (let i = 0; i < maxLoops; i++) {
      await scrollTo(0);
      await sleep(700);
      await scrollTo(scroller.scrollHeight);
      await sleep(700);
      const cnt = document.querySelectorAll('img[src*="estuary/content"]').length;
      if (cnt === prev && cnt > 0) break;
      prev = cnt;
    }
    const byBase = new Map();
    const byTurnIndex = new Map();
    const domTurnByBase = new Map();
    let promoted = 0;
    const resolveOrPromote = (cand, url) => {
      if (!cand) return;
      let base = aliasToBase.get(cand)
        || aliasToBase.get(cand.replace(/^file_/, 'file-'))
        || aliasToBase.get(cand.replace(/^file-/, 'file_'));
      if (!base) {
        const norm = fileIdLikeStrict(cand);
        if (norm) {
          base = aliasToBase.get(norm)
            || aliasToBase.get(norm.replace(/^file_/, 'file-'))
            || aliasToBase.get(norm.replace(/^file-/, 'file_'));
        }
        if (!base) {
          const strict = isStrictFileId(cand) ? cand : (norm && isStrictFileId(norm) ? norm : null);
          if (strict) {
            base = addAsset(strict, 'dom');
            if (base) promoted++;
          }
        }
      }
      if (base && !byBase.has(base)) byBase.set(base, url);
      return base || null;
    };

    const uniqueElements = (items) => {
      const out = [];
      const seen = new Set();
      for (const el of items) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
      return out;
    };
    const turnElements = uniqueElements([
      ...document.querySelectorAll('article[data-testid^="conversation-turn-"]'),
      ...document.querySelectorAll('[data-testid^="conversation-turn-"]'),
      ...Array.from(document.querySelectorAll('[data-message-author-role]'))
        .map(el => el.closest('article[data-testid^="conversation-turn-"]') || el.closest('article') || el),
    ]).sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    const domTurnIndexFor = (img) => {
      if (!OPTIONS.domTurnPositioning || !turnElements.length) return -1;
      const direct = turnElements.findIndex(turn => turn.contains(img));
      if (direct >= 0) return direct;
      let idx = -1;
      for (let i = 0; i < turnElements.length; i++) {
        if (turnElements[i].compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING) idx = i;
      }
      return idx;
    };

    const noteTurnBase = (turnIndex, base) => {
      if (turnIndex < 0 || !base) return;
      if (!byTurnIndex.has(turnIndex)) byTurnIndex.set(turnIndex, []);
      const list = byTurnIndex.get(turnIndex);
      if (!list.includes(base)) list.push(base);
      if (!domTurnByBase.has(base)) domTurnByBase.set(base, turnIndex);
    };

    for (const img of document.querySelectorAll('img[src*="estuary/content"]')) {
      const url = img.src;
      const turnIndex = domTurnIndexFor(img);
      try {
        const u = new URL(url);
        for (const k of ID_PARAM_KEYS) {
          const v = u.searchParams.get(k);
          if (v) noteTurnBase(turnIndex, resolveOrPromote(v, url));
        }
        noteTurnBase(turnIndex, resolveOrPromote(u.pathname.split('/').pop(), url));
      } catch (_) {}
      noteTurnBase(turnIndex, resolveOrPromote(img.getAttribute('data-id'), url));
      noteTurnBase(turnIndex, resolveOrPromote(img.getAttribute('data-asset-id'), url));
      noteTurnBase(turnIndex, resolveOrPromote(img.getAttribute('data-file-id'), url));
    }
    return { byBase, byTurnIndex, domTurnByBase, promoted, turnCount: turnElements.length };
  };

  console.log('🖼  DOM 収集中...');
  const {
    byBase: domByBase,
    byTurnIndex: domByTurnIndex,
    domTurnByBase,
    promoted,
    turnCount: domTurnCount,
  } = await collectDomImagesAndPromote();
  console.log(`  → DOM hits ${domByBase.size}/${assets.size} (DOM昇格 ${promoted} 件 / DOM turns ${domTurnCount})`);

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
    const text = String(sampleText || '').replace(/^\uFEFF/, '');
    const trimmed = text.trimStart();
    if (/^[\[{]/.test(trimmed)) return 'json';
    const lines = text.split(/\r?\n/).filter(line => line.trim()).slice(0, 3);
    if (lines.length >= 2 && lines.every(line => line.includes('\t'))) return 'tsv';
    if (lines.length >= 2 && lines.every(line => line.includes(','))) return 'csv';
    if (mt.startsWith('text/')) return 'txt';
    return 'bin';
  };

  const tryBackendDownload = async (fileId) => {
    if (!backendAvailable()) return null;
    let r;
    try {
      r = await fetchWithBackoff(
        `/backend-api/files/${fileId}/download`,
        { headers, redirect: 'follow' },
        `files/${fileId}`,
        { maxAttempts: 4, returnOnThrottle: true },
      );
    } catch (_) {
      return null;
    }
    if (r.status === 429 || r.status === 503) {
      noteBackendThrottle(parseRetryAfter(r.headers.get('retry-after')));
      return null;
    }
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      const j = await r.json().catch(() => null);
      const url = j?.download_url || j?.url || j?.file_url || j?.signed_url;
      if (!url) return null;
      const r2 = await fetch(url, { credentials: 'omit' });
      if (!r2.ok) return null;
      return r2.blob();
    }
    return r.blob();
  };

  const tryDomDownload = async (base) => {
    const url = domByBase.get(base);
    if (!url) return null;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return null;
    return r.blob();
  };

  const extMap = {};
  let saved = 0;
  let failed = 0;
  let skipped = 0;
  let binCount = 0;
  for (const [base, asset] of assets) {
    let blob = null;
    let via = '';
    try {
      blob = await tryBackendDownload(base);
      if (blob) via = 'backend';
    } catch (e) {
      console.warn(`  ⚠️ backend ${base}: ${e.message}`);
    }
    if (!blob) {
      try {
        blob = await tryDomDownload(base);
        if (blob) via = 'dom';
      } catch (e) {
        console.warn(`  ⚠️ dom ${base}: ${e.message}`);
      }
    }
    if (!blob) {
      failed++;
      console.warn(`  ❌ ${base}${asset.composite ? ' (composite)' : ''} [${asset.source}]: 取得不可`);
      continue;
    }
    const headBytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
    const head = headBytes.slice(0, 8);
    if (head[0] === 0x3c) {
      skipped++;
      console.log(`  ⏭️ ${base} (HTML応答)`);
      continue;
    }
    const sampleText = new TextDecoder('utf-8').decode(headBytes);
    const ext = guessExt(blob.type, head, sampleText);
    if (ext === 'bin') {
      binCount++;
      console.warn(`  ⚠️ ${base}: 拡張子不明 (mime=${blob.type || 'unknown'} size=${blob.size}). binBehavior=${OPTIONS.binBehavior}`);
      if (OPTIONS.binBehavior === 'skip') {
        skipped++;
        continue;
      }
    }
    const fh = await imagesDir.getFileHandle(`${base}.${ext}`, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    extMap[base] = ext;
    saved++;
    console.log(`  💾 ${base}.${ext} [${via}/${asset.source}]${asset.composite ? ' composite' : ''}`);
    await sleep(250);
  }
  console.log(`✅ asset: 保存 ${saved} / スキップ ${skipped} / 失敗 ${failed} / .bin ${binCount}`);
  window.__lastExtMap = extMap;

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
    text = text.replace(/[\uE200-\uE2FF]/g, '');
    text = text.replace(/[\u200B\u200C\u200D]/g, '');
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
  const renderedAssetBases = new Set();
  const renderedExternalLinks = new Set();
  const escapeMdLinkText = (text) => String(text || '').replace(/[[\]]/g, '');
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
      console.warn(`  🔎 描画失敗: raw=${raw} / base=${base} / ext-keys-sample=${Object.keys(extMap).slice(0, 3).join(',')}`);
      if (base && seenBases) seenBases.add(base);
      if (base) renderedAssetBases.add(base);
      return details
        ? `_(添付ファイル取得不可: ${label} / ${details})_`
        : `_(添付ファイル取得不可: ${label})_`;
    }
    if (seenBases) seenBases.add(base);
    renderedAssetBases.add(base);
    const path = `images/${base}.${ext}`;
    const linkLabel = (assetMeta.get(base) || {}).filename || `${base}.${ext}`;
    const ref = isPreviewableImageExt(ext)
      ? `![](${path})`
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

  const renderDomTurnImages = (turnIndex, seenBases) => {
    const refs = [];
    const bases = domByTurnIndex.get(turnIndex) || [];
    for (const base of bases) {
      if (!extMap[base] || seenBases.has(base) || renderedAssetBases.has(base)) continue;
      const md = renderAssetMarkdown(base, seenBases);
      if (md) refs.push(md);
    }
    return refs;
  };

  const renderMessage = (msg, turnIndex) => {
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
    const appendDomAssetRefs = () => {
      for (const r of renderDomTurnImages(turnIndex, seenBases)) parts.push(r);
    };
    const appendAssetRefs = () => {
      appendMessageAssetRefs();
      appendDomAssetRefs();
    };

    if (role === 'assistant' && recipient !== 'all') {
      const doc = renderAssistantDocumentMessage(msg);
      if (!doc) return null;
      parts.push(doc.body);
      appendAssetRefs();
      for (const r of renderExternalLinks(msg)) parts.push(r);
      const body = parts.filter(p => p && p.trim()).join('\n\n');
      if (!body.trim()) return null;
      let header = `### 📝 Document${doc.title ? `: ${cleanHeading(doc.title)}` : ''}`;
      if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
      return `${header}\n\n${body}`;
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
      appendAssetRefs();
    } else if (ct === 'code') {
      const text = cleanCodeText(content.text || '');
      if (text) parts.push(wrapCodeFence(text, content.language || ''));
      appendAssetRefs();
    } else {
      appendAssetRefs();
      if (!parts.length) return null;
    }
    const body = parts.filter(p => p && p.trim()).join('\n\n');
    if (!body.trim()) return null;
    let header = `### ${label}`;
    if (msg.create_time) header += `  _${fmtTime(msg.create_time)}_`;
    return `${header}\n\n${body}`;
  };

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

  const headingTitle = cleanHeading(convo.title);
  const cTime = convo.create_time;
  const uTime = convo.update_time;
  const model = convo.default_model_slug || '(モデル不明)';
  const front = `# ${headingTitle}\n\n`
    + `- **作成日時:** ${fmtTime(cTime)}\n`
    + `- **最終更新:** ${fmtTime(uTime)}\n`
    + `- **モデル:** ${model}\n`
    + `- **会話ID:** ${convo.conversation_id}\n\n---\n\n`;
  const chain = linearize(convo.mapping, convo.current_node);
  const blocks = [];
  let renderTurnIndex = 0;
  for (const node of chain) {
    const block = renderMessage(node.message, renderTurnIndex);
    if (block) {
      blocks.push(block);
      renderTurnIndex++;
    }
  }
  let md = front + blocks.join('\n\n---\n\n') + '\n';

  const domOnly = [];
  for (const [base, a] of assets) {
    if (a.source === 'dom' && extMap[base] && !renderedAssetBases.has(base)) {
      domOnly.push({ base, ext: extMap[base], turnIndex: domTurnByBase.get(base) });
    }
  }
  if (domOnly.length) {
    let appendix = `\n\n---\n\n## DOM検出画像 (JSON未参照)\n\n`;
    appendix += `_本文中に対応する asset_pointer がなかったが、画面上にレンダリングされていた画像です。_\n\n`;
    for (const { base, ext, turnIndex } of domOnly) {
      const path = `images/${base}.${ext}`;
      const note = Number.isInteger(turnIndex) ? ` _DOM turn ${turnIndex}_` : '';
      appendix += isPreviewableImageExt(ext)
        ? `- ![](${path})${note}\n`
        : `- [添付ファイル: ${base}.${ext}](${path})${note}\n`;
      renderedAssetBases.add(base);
    }
    md += appendix;
  }

  const savedUnreferenced = Object.entries(extMap)
    .filter(([base]) => !renderedAssetBases.has(base))
    .sort(([a], [b]) => a.localeCompare(b));
  if (savedUnreferenced.length) {
    let appendix = `\n\n---\n\n## 保存済み未参照画像\n\n`;
    appendix += `_画像ファイルは取得済みですが、会話JSON内の本文位置と対応付けられなかったため、末尾にまとめて列挙しています。_\n\n`;
    for (const [base, ext] of savedUnreferenced) {
      const path = `images/${base}.${ext}`;
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

  console.log(`\n🎉 完了: ${fname}`);
  console.log(`   asset: 保存 ${saved} / スキップ ${skipped} / 失敗 ${failed} / .bin ${binCount}`);
  console.log(`   asset 内訳: JSON由来 ${jsonAssetCount} + DOM昇格 ${promoted}`);
  console.log('   v7.14: Canvas/文書作成メッセージも本文として保持します');
})();
