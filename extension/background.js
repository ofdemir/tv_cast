// Sekmelerin (iframe'ler dahil) yaptığı ağ isteklerini yalnızca GÖZLEMLER; hiçbir isteği değiştirmez.
// Video manifestlerini/dosyalarını ve tarayıcının o istekte gönderdiği Referer'ı sekme bazında saklar.
'use strict';

const MEDIA_EXT = { m3u8: 'hls', mp4: 'native', m4v: 'native', webm: 'native', mkv: 'native' };
const MEDIA_CT = [
  [/mpegurl/i, 'hls'],
  [/^video\/(mp4|webm|x-matroska)/i, 'native'],
];
// HLS/DASH parçaları, altyazı, anahtar vb. — listeyi kirletmesin
const SKIP_EXT = /\.(ts|m4s|aac|vtt|srt|key|jpg|jpeg|png|gif|webp|js|css|json|mpd)$/i;
const MAX_PER_TAB = 25;

const key = (tabId) => 'tab:' + tabId;
const pending = new Map(); // requestId -> Referer (onSendHeaders'tan)

function extKind(url) {
  try {
    const path = new URL(url).pathname;
    if (SKIP_EXT.test(path)) return 'skip';
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    return (m && MEDIA_EXT[m[1].toLowerCase()]) || null;
  } catch (e) { return 'skip'; }
}

// storage.session okuma-yazma yarışını önlemek için kayıtları sırayla işle
let chain = Promise.resolve();
function remember(tabId, item) {
  chain = chain.then(() => store(tabId, item)).catch(() => {});
}

async function store(tabId, item) {
  const k = key(tabId);
  const data = (await chrome.storage.session.get(k))[k] || { items: [] };
  const base = item.url.split('?')[0];
  // Aynı dosyanın Range istekleri ya da token'ı değişen tekrarları tek kayıt olsun
  const existing = data.items.find((x) => x.url.split('?')[0] === base);
  if (existing) {
    existing.url = item.url;
    existing.ts = item.ts;
    existing.hits = (existing.hits || 1) + 1;
  } else {
    data.items.push(item);
    if (data.items.length > MAX_PER_TAB) data.items.shift();
  }
  await chrome.storage.session.set({ [k]: data });
  updateBadge(tabId, data.items);
}

function updateBadge(tabId, items) {
  const n = visible(items).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#ffb300' });
}

// Popup ile aynı mantık: HLS varsa sadece HLS göster (mp4 olarak görünen parçaları gizler)
function visible(items) {
  const hls = items.filter((x) => x.kind === 'hls');
  return hls.length ? hls : items.filter((x) => x.kind === 'native');
}

const FILTER = { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] };

chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;
  const ref = (d.requestHeaders || []).find((h) => h.name.toLowerCase() === 'referer');
  if (ref) pending.set(d.requestId, ref.value);
}, FILTER, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const referer = pending.get(d.requestId) || d.initiator || null;
  pending.delete(d.requestId);
  if (d.tabId < 0 || d.statusCode >= 400) return;
  let kind = extKind(d.url);
  if (kind === 'skip') return;
  if (!kind) {
    const ct = ((d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '';
    const hit = MEDIA_CT.find(([re]) => re.test(ct));
    kind = hit ? hit[1] : null;
  }
  if (!kind) return;
  remember(d.tabId, { url: d.url, kind, referer, frame: d.frameId ? 'iframe' : 'sayfa', ts: Date.now() });
}, FILTER, ['responseHeaders']);

chrome.webRequest.onErrorOccurred.addListener((d) => pending.delete(d.requestId), FILTER);

// Sekme başka sayfaya geçince ya da kapanınca listeyi sıfırla
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    chrome.storage.session.remove(key(tabId));
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));
