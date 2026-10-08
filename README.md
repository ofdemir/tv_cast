# TV Cast

Telefondan/PC'den gönderilen film-dizi linkini Vestel TV'nin tarayıcısında oynatır;
oynat/duraklat/sar/ses kontrolü telefondan yapılır. Raspberry Pi 3B+ üzerinde sunucu olarak çalışacak
şekilde tasarlandı (TV'ye HDMI ile bağlanmaz, görüntüyü TV kendisi çözer).

```
Telefon (/)  ──POST /api/cast──►  Sunucu (FastAPI)
     ▲  WebSocket                   ├─ yt-dlp: sayfa → gerçek video linki (m3u8 / mp4)
     └──────── durum ────────┐      ├─ proxy /p/...: Referer/UA ekler, m3u8 içini yeniden yazar
                             │      └─ WebSocket hub: komutlar TV'ye, durum telefona
TV tarayıcısı (/tv)  ◄──load/cmd──┘
  hls.js / <video>  ──medya──► /p/... (aynı origin → CORS sorunu yok)
```

Arka plan ve TV testleri: `../tv_cast_probe/README.md`.

## Çalıştırma

**PC'de (geliştirme):** `run.bat` → telefonda `http://<pc-ip>:8000/`, TV'de `http://<pc-ip>:8000/tv`

**Raspberry Pi'de:** sürümlü otomatik deploy (aşağıda).

Öneriler:
- Modemde Pi'ye **sabit IP (DHCP rezervasyonu)** ver, böylece adresler değişmez.
- TV tarayıcısında `http://<pi-ip>/tv` adresini **yer imi / başlangıç sayfası** yap.

## Sürüm yayınlama ve otomatik deploy

```
./release.sh 0.2.0
   └─ main + v0.2.0 etiketi GitHub'a gönderilir
        └─ GitHub Actions: sözdizimi + duman testi ──geçerse──► GitHub Release v0.2.0
             └─ Pi (tv-cast-update.timer, dakikada bir) yeni Release'i görür
                  ├─ releases/v0.2.0'a indirir, ayrı .venv kurar
                  ├─ current -> v0.2.0, servisi yeniden başlatır
                  └─ /api/health sürümü doğrulanamazsa önceki sürüme geri döner
```

- Pi dışarıdan erişim gerektirmez; GitHub'ı kendisi yoklar. Test geçmeyen sürüm Release olmaz,
  dolayısıyla Pi'ye hiç gelmez. Çalışan sürüm kumandanın en altında görünür.
- Pi'deki dizin: `~/apps/tv_cast/{releases,current,shared/data,state,bin}`. Son 3 sürüm saklanır.
- **Elle geri dönüş:** `ssh ofarukdemir@192.168.1.109 ~/apps/tv_cast/bin/pi_deploy.sh v0.1.0`
  (sağlık kontrolünden geçemeyen sürümler `state/bad_tags`'e yazılır ve otomatik tekrar denenmez)
- **Loglar:** `journalctl -u tv-cast -u tv-cast-update -f`
- **İlk kurulum (tek sefer, ilk Release yayınlandıktan sonra, Pi'de):**
  `curl -fsSL https://raw.githubusercontent.com/ofdemir/tv_cast/main/deploy/bootstrap_pi.sh | bash`

## Kullanım

1. TV'de `/tv` sayfasını aç. Boştayken kumanda adresini ve QR kodunu gösterir.
2. Telefonda QR'ı okut (ya da `http://<pi-ip>/`), izlemek istediğin sayfanın linkini yapıştır → **TV'de oynat**.
3. Kontroller: ±10/±30 sn, sürgüyle sarma, oynat/duraklat, ses, durdur, baştan başla.
4. **Kaldığın yerden devam:** her link için konum kaydedilir (`data/state.json`); aynı link
   tekrar gönderilince oradan başlar.
5. **TV kumandası** da çalışır: OK = oynat/duraklat (ses kapalıysa açar), ←/→ = 10 sn, ↑/↓ = 60 sn.
6. **Bilgisayardan tek tık:** kumanda sayfasındaki "📺 TV'ye gönder" bookmarklet'ini yer imleri
   çubuğuna sürükle. Ayrıca `http://<pi-ip>/?cast=<link>` adresi de linki doğrudan gönderir.

## Chrome eklentisi (bot korumalı siteler için)

Bazı siteler (Cloudflare bot kontrolü) sunucunun sayfayı açmasına izin vermez. Bu durumda video
bilgisayardaki Chrome'da normal şekilde açılır ve eklenti, sayfanın kendi yüklediği video linkini
(`.m3u8` / `.mp4`, iframe'ler dahil) ağ trafiğinden **gözlemleyerek** TV Cast'e gönderir.
Çerez gönderilmez; yalnızca link, Referer ve User-Agent iletilir. Video sunucusu da bot kontrolü
uyguluyorsa bu yöntem çalışmaz.

Kurulum: Chrome → `chrome://extensions` → sağ üstte **Geliştirici modu** → **Paketlenmemiş öğe yükle**
→ `tv_cast/extension` klasörünü seç. Simgeyi araç çubuğuna sabitle.

Kullanım: sitede videoyu oynatmaya başlat → simgede sayı rozeti çıkar → simgeye tıkla →
**📺 TV'ye gönder**. Sunucu adresi popup'taki "Sunucu adresi" bölümünden değiştirilir
(Pi'ye geçince `http://<pi-ip>`). Kontrol yine telefondaki kumandadan yapılır; kaldığın yer
sayfa adresine göre hatırlanır.

Gelişmiş: bazı gömülü oynatıcılar belirli bir `Referer` ister; kumandadaki "Gelişmiş" alanından verilebilir.
Doğrudan `.m3u8` / `.mp4` linkleri yt-dlp'ye uğramadan oynatılır.

## Bilinen sınırlar

- **Android "Paylaş" menüsü yok:** Web Share Target için PWA kurulumu gerekir, PWA da HTTPS ister;
  yerel ağda http ile çalıştığımız için şimdilik bookmarklet / yapıştırma kullanılıyor.
- **yt-dlp'nin tanımadığı siteler:** "Bu site desteklenmiyor" hatası verir. Çözüm adayları: sayfadaki
  iframe'in (oynatıcı) linkini göndermek ya da ileride m3u8'i ağ trafiğinden yakalayan küçük bir
  tarayıcı eklentisi.
- DRM'li servisler (Netflix vb.) teknik olarak mümkün değil.
- Ayrı ses+görüntü DASH akışları (ör. YouTube'un yüksek kaliteleri) desteklenmiyor; tek dosya ya da HLS gerekir.
- Proxy yalnızca sunucunun çözümlediği oturumlar için çalışır, ama yerel ağa açıktır; internete açmayın.

## Dosyalar

| Dosya | İş |
|---|---|
| `app/main.py` | FastAPI uygulaması, WebSocket hub, `/api/cast` |
| `app/resolver.py` | yt-dlp ile link çözümleme, format seçimi |
| `app/proxy.py` | Medya proxy'si, m3u8 yeniden yazımı |
| `app/store.py` | Geçmiş ve kaldığın yer (`data/state.json`) |
| `app/static/tv.*` | TV alıcı sayfası |
| `app/static/remote.*` | Telefon kumandası |
| `deploy/pi_deploy.sh` | Pi: yeni Release'i kur, sağlık kontrolü, geri dönüş |
| `deploy/bootstrap_pi.sh` | Pi: tek seferlik kurulum (systemd servis + timer) |
| `.github/workflows/release.yml` | CI: testler, etiketlerde Release oluşturma |
| `release.sh` | PC: sürüm yayınla |
| `tests/smoke.py` | Duman testi |
