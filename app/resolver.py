"""Sayfa linkini TV'nin oynatabileceği medya linkine çevirir (yt-dlp)."""
import asyncio
import os
import re
import urllib.parse
from dataclasses import dataclass, field

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")

MEDIA_EXT = {".m3u8": "hls", ".mp4": "native", ".m4v": "native", ".webm": "native",
             ".mkv": "native", ".mov": "native"}

# Tarayıcının oynatabildiği, ses+görüntü birlikte olan format. HLS'de master manifest
# kullanılır (hls.js kaliteyi kendisi seçer). '?' = codec/çözünürlük bilinmiyorsa da kabul et.
_AV = "[vcodec!=?none][acodec!=?none]"
FORMAT = "/".join([
    "best[protocol^=m3u8][height<=?1080]",
    f"best[ext=mp4][height<=?1080]{_AV}",
    f"best[ext=webm][height<=?1080]{_AV}",
    "best[protocol^=m3u8]",
    f"best[ext=mp4]{_AV}",
    "best",
])

# Proxy'nin kaynağa iletmeyeceği başlıklar
DROP_HEADERS = {"accept-encoding", "host", "content-length", "connection"}


class ResolveError(Exception):
    pass


@dataclass
class Resolved:
    url: str
    kind: str  # "hls" | "native"
    title: str
    headers: dict = field(default_factory=dict)
    duration: float | None = None
    extractor: str = "direct"


def base_headers(referer=None, user_agent=None):
    h = {"User-Agent": user_agent or UA}
    if referer:
        h["Referer"] = referer
        p = urllib.parse.urlparse(referer)
        h["Origin"] = f"{p.scheme}://{p.netloc}"
    return h


async def resolve(url: str, referer: str | None = None, kind: str | None = None,
                  user_agent: str | None = None) -> Resolved:
    url = url.strip()
    if not re.match(r"https?://", url):
        raise ResolveError("Geçerli bir http(s) linki değil")
    path = urllib.parse.urlparse(url).path
    if kind not in ("hls", "native"):
        kind = MEDIA_EXT.get(os.path.splitext(path)[1].lower())
    if kind:
        title = urllib.parse.unquote(os.path.basename(path)) or url
        return Resolved(url, kind, title, base_headers(referer, user_agent))
    return await asyncio.to_thread(_ytdlp, url, referer)


def _clean_error(msg: str) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    msg = msg.replace("ERROR: ", "")
    if "Unsupported URL" in msg:
        return "Bu site desteklenmiyor (yt-dlp sayfada video bulamadı)"
    if "Cloudflare" in msg:
        return ("Site bot koruması (Cloudflare) arkasında, sunucu sayfayı açamıyor. "
                "Videoyu bilgisayarda açıp Chrome eklentisiyle gönder.")
    return msg.strip()[:300]


def _ytdlp(url: str, referer: str | None) -> Resolved:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "format": FORMAT,
        "socket_timeout": 15,
    }
    if referer:
        opts["http_headers"] = {"Referer": referer}
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as e:
        raise ResolveError(_clean_error(str(e))) from None

    while info.get("_type") in ("playlist", "multi_video"):
        entries = [e for e in (info.get("entries") or []) if e]
        if not entries:
            raise ResolveError("Sayfada oynatılabilir video yok")
        info = entries[0]

    proto = info.get("protocol") or ""
    if proto.startswith("m3u8"):
        kind, media = "hls", info.get("manifest_url") or info["url"]
    elif proto in ("http", "https"):
        kind, media = "native", info["url"]
    else:
        raise ResolveError(f"Desteklenmeyen akış türü: {proto or 'bilinmiyor'}")

    headers = {k: v for k, v in (info.get("http_headers") or {}).items()
               if k.lower() not in DROP_HEADERS}
    headers.setdefault("User-Agent", UA)
    if referer:
        headers.setdefault("Referer", referer)
    elif "Referer" not in headers:
        headers["Referer"] = url  # gömülü oynatıcılar çoğu zaman sayfa adresini ister
    return Resolved(media, kind, info.get("title") or url, headers,
                    info.get("duration"), info.get("extractor_key") or "")
