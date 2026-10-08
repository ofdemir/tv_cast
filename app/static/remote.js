// Telefon kumandası
'use strict';

const $ = (id) => document.getElementById(id);
let ws = null;
let state = null;
let dragging = false;

function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

function send(action, value) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'cmd', action, value }));
}

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/remote');
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') render(m);
  };
  ws.onclose = () => {
    $('tvChip').textContent = 'sunucu bağlantısı yok';
    $('tvChip').className = 'chip bad';
    setTimeout(connect, 2000);
  };
}

function setMsg(text, cls) {
  $('msg').textContent = text || '';
  $('msg').className = 'msg ' + (cls || '');
}

function render(s) {
  const prevId = state && state.now && state.now.id;
  state = s;
  $('tvChip').textContent = s.tvs ? 'TV bağlı' : 'TV bağlı değil';
  $('tvChip').className = 'chip ' + (s.tvs ? 'ok' : 'bad');
  if (s.busy) setMsg(s.busy, 'busy');
  else if (s.error) setMsg(s.error, 'err');
  else if ($('msg').classList.contains('busy')) setMsg('');  // başka cihazdan yapılan gönderim bitti

  const now = s.now, tv = s.tv || {};
  $('now').classList.toggle('hidden', !now);
  if (!now) return;
  if (now.id !== prevId) loadHistory();
  $('nowTitle').textContent = now.title;
  const meta = [now.kind === 'hls' ? 'HLS' : 'Dosya', now.extractor];
  if (tv.error) meta.push('⚠ ' + tv.error);
  else if (!s.tvs) meta.push('TV\'de /tv sayfasını aç');
  else if (tv.buffering) meta.push('yükleniyor…');
  else if (tv.muted) meta.push('🔇 TV\'de ses kapalı — TV kumandasında OK');
  $('nowMeta').textContent = meta.filter(Boolean).join(' · ');

  const dur = tv.duration || 0;
  $('seek').max = dur || 0;
  $('seek').disabled = !dur;
  if (!dragging) {
    $('seek').value = tv.time || 0;
    $('tCur').textContent = fmt(tv.time);
  }
  $('tDur').textContent = dur ? fmt(dur) : (tv.time != null ? 'canlı' : '–');
  $('toggle').textContent = tv.paused === false ? '❚❚' : '▶';
  $('restart').classList.toggle('hidden', !(now.start > 0));
  if (tv.volume != null && document.activeElement !== $('vol')) $('vol').value = Math.round(tv.volume * 100);
}

// extra: eklentiden gelen doğrudan linkler için {page, title, kind, user_agent}
async function cast(url, referer, start, extra) {
  $('castBtn').disabled = true;
  setMsg('Link çözümleniyor…', 'busy');
  try {
    const r = await fetch('/api/cast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ url, referer: referer || null,
                                         start: start === undefined ? null : start }, extra || {})),
    });
    const j = await r.json();
    if (!j.ok) setMsg(j.error, 'err');
    else {
      setMsg((j.tv_connected ? 'TV\'ye gönderildi: ' : 'Hazır, TV bağlanınca başlayacak: ') + j.title +
             (j.start ? ' (kaldığın yer ' + fmt(j.start) + ')' : ''), '');
      $('url').value = '';
    }
  } catch (e) {
    setMsg('Sunucuya ulaşılamadı: ' + e, 'err');
  } finally {
    $('castBtn').disabled = false;
    loadHistory();
  }
}

async function loadHistory() {
  try {
    const items = await (await fetch('/api/history')).json();
    const ul = $('history');
    ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li style="cursor:default;color:var(--dim)">Henüz yok</li>'; return; }
    for (const it of items) {
      const li = document.createElement('li');
      const t = document.createElement('div'); t.className = 'h-title'; t.textContent = it.title;
      const sub = document.createElement('div'); sub.className = 'h-sub';
      sub.textContent = (it.pos ? '⏵ ' + fmt(it.pos) + ' · ' : '') + it.url;
      li.append(t, sub);
      li.onclick = () => castEntry(it);
      ul.append(li);
    }
  } catch (e) { /* sessizce geç */ }
}

// ------------------------------------------------------------ olaylar
$('castForm').addEventListener('submit', (e) => {
  e.preventDefault();
  cast($('url').value.trim(), $('referer').value.trim());
});
document.querySelectorAll('[data-rel]').forEach((b) => {
  b.onclick = () => send('seekrel', +b.dataset.rel);
});
$('toggle').onclick = () => send((state && state.tv && state.tv.paused === false) ? 'pause' : 'play');
$('stop').onclick = () => send('stop');
$('mute').onclick = () => send('mute');
$('restart').onclick = () => { if (state && state.now) castEntry({ url: state.now.page_url, media: state.now.media,
  kind: state.now.kind, title: state.now.title, referer: state.now.referer, user_agent: state.now.user_agent }, 0); };

// Eklentiyle gönderilmiş kayıtlar doğrudan medya linkiyle tekrar oynatılır (link süresi dolmuş olabilir)
function castEntry(it, start) {
  if (it.media) cast(it.media, it.referer, start, { page: it.url, title: it.title, kind: it.kind, user_agent: it.user_agent });
  else cast(it.url, it.referer, start);
}
$('seek').addEventListener('input', () => { dragging = true; $('tCur').textContent = fmt($('seek').value); });
$('seek').addEventListener('change', () => { send('seek', +$('seek').value); setTimeout(() => { dragging = false; }, 800); });
$('vol').addEventListener('change', () => send('volume', $('vol').value / 100));

// Bookmarklet: bulunduğu sayfanın linkini bu kumandaya ?cast= ile yollar
const bm = "javascript:(function(){window.open('" + location.origin +
           "/?cast='+encodeURIComponent(location.href),'tvcast')})()";
$('bookmarklet').href = bm;
$('bmCode').textContent = bm;

// ?cast=<link> ile açıldıysa otomatik gönder
const params = new URLSearchParams(location.search);
const incoming = params.get('cast') || params.get('url') || params.get('text');
if (incoming) {
  const m = incoming.match(/https?:\/\/\S+/);
  history.replaceState(null, '', '/');
  if (m) { $('url').value = m[0]; cast(m[0], params.get('referer')); }
}

connect();
loadHistory();
fetch('/api/health').then((r) => r.json()).then((h) => { $('version').textContent = 'TV Cast ' + h.version; }).catch(() => {});
