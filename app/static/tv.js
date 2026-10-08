// TV alıcı sayfası: sunucudan gelen load/cmd mesajlarını uygular, durumu bildirir.
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('v');
let ws = null;
let hls = null;
let current = null;   // {id, src, kind, title, start}
let netRetries = 0;
let osdTimer = null;
let toastTimer = null;

$('remoteUrl').textContent = location.origin + '/';
fetch('/api/health').then((r) => r.json()).then((h) => { $('ver').textContent = h.version; }).catch(() => {});

// ------------------------------------------------------------ bağlantı
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/tv');
  ws.onopen = () => { $('conn').textContent = ''; $('conn').classList.remove('off'); sendStatus(); };
  ws.onclose = () => {
    $('conn').textContent = 'sunucuya bağlanılamıyor…';
    $('conn').classList.add('off');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'load') load(m);
    else if (m.type === 'cmd') command(m.action, m.value);
  };
}

function sendStatus() {
  if (!ws || ws.readyState !== 1 || !current) return;
  const d = video.duration;
  ws.send(JSON.stringify({
    type: 'status', id: current.id,
    time: video.currentTime || 0,
    duration: isFinite(d) ? d : null,
    paused: video.paused, ended: video.ended,
    buffering: !$('spinner').classList.contains('hidden'),
    muted: video.muted, volume: video.volume,
    error: current.error || null,
  }));
}
setInterval(sendStatus, 1000);

// ------------------------------------------------------------ oynatma
function teardown() {
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function load(m) {
  // WebSocket yeniden bağlandığında aynı içerik tekrar gelir; oynuyorsa dokunma
  if (current && current.id === m.id && !current.error) return;
  teardown();
  current = Object.assign({}, m, { error: null });
  netRetries = 0;
  $('idle').classList.add('hidden');
  $('osd').classList.remove('hidden');
  $('osdTitle').textContent = m.title || '';
  spinner(true);
  const start = m.start > 0 ? m.start : 0;

  if (m.kind === 'hls' && window.Hls && Hls.isSupported()) {
    hls = new Hls({
      startPosition: start || -1,
      maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30,  // TV belleği kısıtlı
    });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 3) {
        netRetries++;
        toast('Ağ hatası, tekrar deneniyor (' + netRetries + '/3)…');
        setTimeout(() => hls && hls.startLoad(), 1500);
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        fail('Oynatılamadı: ' + d.details);
      }
    });
    hls.loadSource(m.src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
  } else {
    video.src = m.src;
    if (start) video.addEventListener('loadedmetadata', () => { video.currentTime = start; }, { once: true });
    tryPlay();
  }
  if (start) toast('Kaldığın yerden: ' + fmt(start));
  showOsd();
}

async function tryPlay() {
  video.muted = false;
  try {
    await video.play();
  } catch (e) {
    // Otomatik oynatma politikası: sessiz başlat, OK ile ses açılır
    video.muted = true;
    try { await video.play(); toast('Ses kapalı — açmak için kumandada OK'); }
    catch (e2) { toast('Başlatmak için kumandada OK'); }
  }
}

function fail(msg) {
  if (current) current.error = msg;
  spinner(false);
  toast(msg, true, 8000);
  sendStatus();
}

function command(action, value) {
  if (!current && action !== 'stop') return;
  switch (action) {
    case 'play': video.muted ? tryPlay() : video.play(); break;
    case 'pause': video.pause(); break;
    case 'toggle': video.paused ? video.play() : video.pause(); break;
    case 'seek': video.currentTime = Math.max(0, +value || 0); break;
    case 'seekrel': video.currentTime = Math.max(0, video.currentTime + (+value || 0)); break;
    case 'volume': video.volume = Math.min(1, Math.max(0, +value)); video.muted = false; break;
    case 'mute': video.muted = !video.muted; break;
    case 'stop':
      teardown(); current = null;
      $('osd').classList.add('hidden');
      $('idle').classList.remove('hidden');
      spinner(false);
      return;
  }
  showOsd();
  setTimeout(sendStatus, 150);
}

// ------------------------------------------------------------ arayüz
function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

function renderOsd() {
  const d = video.duration;
  $('osdCur').textContent = fmt(video.currentTime);
  $('osdDur').textContent = isFinite(d) ? fmt(d) : 'canlı';
  $('osdBar').style.width = isFinite(d) && d > 0 ? (100 * video.currentTime / d) + '%' : '0';
  $('osdIcon').textContent = video.paused ? '❚❚' : '▶';
}

function showOsd() {
  renderOsd();
  $('osd').classList.remove('fade');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { if (!video.paused) $('osd').classList.add('fade'); }, 3500);
}

function spinner(on) { $('spinner').classList.toggle('hidden', !on); }

function toast(msg, err, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 4000);
}

video.addEventListener('timeupdate', renderOsd);
video.addEventListener('waiting', () => spinner(true));
video.addEventListener('seeking', () => spinner(true));
['playing', 'canplay', 'seeked', 'pause'].forEach((e) => video.addEventListener(e, () => spinner(false)));
video.addEventListener('pause', () => { showOsd(); sendStatus(); });
video.addEventListener('play', () => { showOsd(); sendStatus(); });
video.addEventListener('ended', () => { showOsd(); sendStatus(); });
video.addEventListener('error', () => {
  if (!hls && current) fail('Video hatası (kod ' + (video.error ? video.error.code : '?') + ')');
});

// TV kumandası: OK = oynat/duraklat (ses kapalıysa açar), ←/→ 10 sn, ↑/↓ 60 sn
document.addEventListener('keydown', (e) => {
  if (!current) return;
  const k = e.keyCode;
  if (k === 13 || k === 179 || k === 415 || k === 19) {
    if (video.muted) { video.muted = false; video.play(); toast('Ses açıldı'); }
    else command(k === 415 ? 'play' : k === 19 ? 'pause' : 'toggle');
  } else if (k === 37 || k === 412) command('seekrel', -10);
  else if (k === 39 || k === 417) command('seekrel', 10);
  else if (k === 38) command('seekrel', 60);
  else if (k === 40) command('seekrel', -60);
  else return;
  e.preventDefault();
});

connect();
