/**
 * ChatGPT conversation asset diagnostics
 *
 * Run this in DevTools Console on https://chatgpt.com/c/<conversation_id>.
 * It fetches the conversation JSON and reports where image/file IDs appear.
 * file_search browsing/citation tool references are ignored as export assets.
 */
(async () => {
  const m = location.pathname.match(/\/c\/([0-9a-f-]{8,})/i);
  if (!m) {
    alert('チャットページ（/c/<id>）で実行してください');
    return;
  }

  const convId = m[1];
  console.log('診断対象 conversation_id:', convId);

  const session = await fetch('/api/auth/session').then(r => r.json());
  const token = session.accessToken;
  if (!token) {
    alert('ログインしてから実行してください');
    return;
  }

  const res = await fetch(`/backend-api/conversation/${convId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`conversation fetch failed: HTTP ${res.status}`);

  const convo = await res.json();
  convo.conversation_id = convo.conversation_id || convId;
  window.__lastConvo = convo;

  const stripScheme = (s) => String(s).replace(/^[a-z][a-z0-9+\-.]*:\/\//i, '');
  const stripFragment = (s) => String(s).split('#')[0];
  const RESERVED_FILE_TOKENS = new Set(['file_search', 'file-search', 'file_service', 'file-service']);
  const isStrictFileId = (s) => {
    const text = String(s || '');
    if (RESERVED_FILE_TOKENS.has(text)) return false;
    const m = /^file[_-]([A-Za-z0-9]+)$/.exec(text);
    return !!m && m[1].length >= 12;
  };
  const normalizeBase = (raw) => {
    if (!raw) return null;
    const text = String(raw);
    if (isStrictFileId(text)) return text;
    const noScheme = stripFragment(stripScheme(text));
    if (isStrictFileId(noScheme)) return noScheme;
    const seg = noScheme.split(/[/?]/).pop();
    if (isStrictFileId(seg)) return seg;
    return null;
  };

  const idsFromString = (value, structured = false) => {
    const text = String(value || '');
    const out = [];
    const add = (raw, kind) => {
      const base = normalizeBase(raw);
      if (base) out.push({ raw, base, kind });
    };

    for (const mm of text.matchAll(/\b(?:file-service|sediment):\/\/file[_-][A-Za-z0-9]+(?:#[^\s"'<>)]*)?/g)) {
      add(mm[0], 'scheme');
    }
    if (!structured) return out;
    for (const mm of text.matchAll(/\bfile[_-][A-Za-z0-9]+\b/g)) {
      add(mm[0], 'bare');
    }
    add(text, 'whole');
    return out;
  };
  const isAssetKey = (key) => /^(asset_pointer|id|file_id|fileId|asset_id|assetId|url)$/i.test(String(key || ''));

  const collectFromObject = (root, rootPath) => {
    const rows = [];
    const seenObject = new WeakSet();
    const seenRow = new Set();

    const push = (item, path) => {
      const key = `${item.base}|${item.raw}|${path}`;
      if (seenRow.has(key)) return;
      seenRow.add(key);
      rows.push({ ...item, path });
    };

    const scan = (value, path, depth = 0, key = '') => {
      if (value == null || depth > 12) return;
      if (typeof value === 'string') {
        for (const item of idsFromString(value, isAssetKey(key))) push(item, path);
        return;
      }
      if (typeof value !== 'object') return;
      if (seenObject.has(value)) return;
      seenObject.add(value);
      if (Array.isArray(value)) {
        value.forEach((child, i) => scan(child, `${path}[${i}]`, depth + 1, key));
        return;
      }
      for (const [k, child] of Object.entries(value)) {
        scan(child, `${path}.${k}`, depth + 1, k);
      }
    };

    scan(root, rootPath);
    return rows;
  };

  const linearize = (mapping, current) => {
    const chain = [];
    let id = current;
    while (id && mapping[id]) {
      chain.push({ nodeId: id, node: mapping[id] });
      id = mapping[id].parent;
    }
    return chain.reverse();
  };

  const mapping = convo.mapping || {};
  const chain = linearize(mapping, convo.current_node);
  const allRows = [];
  const messageRows = [];
  const ignoredFileSearchNodeIds = new Set();
  const isFileSearchToolMessage = (msg) => {
    if (msg?.author?.role !== 'tool') return false;
    const name = String(msg?.author?.name || msg?.recipient || '');
    const ct = msg?.content?.content_type;
    return name === 'file_search' || ct === 'tether_browsing_display';
  };

  for (const [nodeId, node] of Object.entries(mapping)) {
    const msg = node?.message;
    if (!msg) continue;
    if (isFileSearchToolMessage(msg)) {
      ignoredFileSearchNodeIds.add(nodeId);
      continue;
    }
    const rows = collectFromObject(msg, `mapping.${nodeId}.message`);
    for (const row of rows) {
      allRows.push({
        nodeId,
        role: msg.author?.role || '',
        contentType: msg.content?.content_type || '',
        createTime: msg.create_time || '',
        ...row,
      });
    }
  }

  const chainIndexByNodeId = new Map(chain.map((x, i) => [x.nodeId, i]));
  for (const { nodeId, node } of chain) {
    const msg = node?.message;
    if (!msg) continue;
    const rows = allRows.filter(r => r.nodeId === nodeId);
    const uniqueBases = [...new Set(rows.map(r => r.base))];
    messageRows.push({
      chainIndex: chainIndexByNodeId.get(nodeId),
      nodeId,
      role: msg.author?.role || '',
      contentType: msg.content?.content_type || '',
      assetCount: uniqueBases.length,
      bases: uniqueBases.join(', '),
    });
  }

  const domRows = [];
  for (const img of document.querySelectorAll('img[src*="estuary/content"]')) {
    const url = img.src;
    try {
      const u = new URL(url);
      const candidates = [
        u.searchParams.get('id'),
        u.searchParams.get('file_id'),
        u.searchParams.get('asset_id'),
        u.searchParams.get('fileId'),
        u.searchParams.get('assetId'),
        u.pathname.split('/').filter(Boolean).pop(),
        img.getAttribute('data-id'),
        img.getAttribute('data-asset-id'),
        img.getAttribute('data-file-id'),
      ].filter(Boolean);
      for (const raw of candidates) {
        const base = normalizeBase(raw);
        if (base) domRows.push({ raw, base, url });
      }
    } catch (_) {}
  }

  const uniqueJsonBases = [...new Set(allRows.map(r => r.base))].sort();
  const uniqueChainBases = [...new Set(
    allRows.filter(r => chainIndexByNodeId.has(r.nodeId)).map(r => r.base),
  )].sort();
  const uniqueDomBases = [...new Set(domRows.map(r => r.base))].sort();

  const diag = {
    conversationId: convo.conversation_id,
    title: convo.title,
    mappingNodes: Object.keys(mapping).length,
    chainMessages: chain.length,
    ignoredFileSearchToolMessages: ignoredFileSearchNodeIds.size,
    jsonAssetIds: uniqueJsonBases,
    chainAssetIds: uniqueChainBases,
    domAssetIds: uniqueDomBases,
    allRows,
    messageRows,
    domRows,
  };
  window.__assetDiag = diag;

  console.log('--- Asset diagnostic summary ---');
  console.log({
    mappingNodes: diag.mappingNodes,
    chainMessages: diag.chainMessages,
    ignoredFileSearchToolMessages: diag.ignoredFileSearchToolMessages,
    jsonAssetIds: uniqueJsonBases.length,
    chainAssetIds: uniqueChainBases.length,
    domAssetIds: uniqueDomBases.length,
  });
  console.log('messageRows: messageごとの画像ID数');
  console.table(messageRows.filter(r => r.assetCount > 0));
  console.log('allRows: JSON内で見つかった全ID。window.__assetDiag.allRows でも確認できます');
  console.table(allRows.slice(0, 100));
  console.log('domRows: DOM画像URLから見つかったID。window.__assetDiag.domRows でも確認できます');
  console.table(domRows.slice(0, 100));
  console.log('診断結果は window.__assetDiag、会話JSONは window.__lastConvo に保存しました');
})();
