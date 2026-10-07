'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = 'http://192.168.1.110:8000';
let server = DEFAULT_SERVER;
let tab = null;

function setMsg(text, cls) { $('msg').textContent = text || ''; $('msg').className = 'msg ' + (cls || ''); }

async function checkServer() {
  try {
    const r = await fetch(server + '/api/state', { signal: AbortSignal.timeout(3000) });
    const s = await r.json();
    $('srvState').textContent = s.tvs ? 'TV bağlı' : 'sunucu var, TV bağlı değil';
    $('srvState').className = s.tvs ? 'ok' : '';
  } catch (e) {
    $('srvState').textContent = 'sunucuya ulaşılamıyor';
    $('srvState').className = 'bad';
    $('settings').open = true;
  }
}

async function cast(body) {
  setMsg('Gönderiliyor…');
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch(server + '/api/cast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) setMsg((j.tv_connected ? '✔ TV\'de oynatılıyor: ' : '✔ Hazır, TV bağlanınca başlar: ') + j.title, 'ok');
    else setMsg(j.error || 'Hata', 'err');
  } catch (e) {
    setMsg('Sunucuya ulaşılamadı (' + server + ')', 'err');
  } finally {
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

function render(items) {
  const hls = items.filter((x) => x.kind === 'hls');
  const shown = (hls.length ? hls : items.filter((x) => x.kind === 'native')).slice().reverse();
  const list = $('list');
  list.textContent = '';
  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Henüz video bulunamadı. Sayfada videoyu oynatmaya başlat, sonra bu pencereyi tekrar aç.';
    list.append(d);
    return;
  }
  shown.forEach((it, i) => {
    const u = new URL(it.url);
    const box = document.createElement('div');
    box.className = 'item';
    box.innerHTML = '<div class="top"><span class="tag"></span><span class="host"></span></div><div class="path"></div>';
    box.querySelector('.tag').textContent = it.kind === 'hls' ? 'HLS' : 'MP4';
    box.querySelector('.tag').classList.add(it.kind);
    box.querySelector('.host').textContent = u.host + (it.frame === 'iframe' ? ' · iframe' : '');
    box.querySelector('.path').textContent = u.pathname + (it.hits > 1 ? '  (' + it.hits + ' istek)' : '');
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = i === 0 ? '📺 TV\'ye gönder' : 'Bunu gönder';
    b.onclick = () => cast({
      url: it.url, kind: it.kind, referer: it.referer, page: tab.url,
      title: tab.title, user_agent: navigator.userAgent,
    });
    box.append(b);
    list.append(box);
  });
}

async function init() {
  const st = await chrome.storage.sync.get('server');
  server = (st.server || DEFAULT_SERVER).replace(/\/+$/, '');
  $('server').value = server;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('page').textContent = tab.title || tab.url;
  const k = 'tab:' + tab.id;
  render(((await chrome.storage.session.get(k))[k] || { items: [] }).items);
  checkServer();
}

$('sendPage').onclick = () => cast({ url: tab.url });
$('save').onclick = async () => {
  server = $('server').value.trim().replace(/\/+$/, '');
  await chrome.storage.sync.set({ server });
  setMsg('Kaydedildi', 'ok');
  checkServer();
};

init();
