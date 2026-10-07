"""TV'nin medyayı aynı origin'den, doğru başlıklarla almasını sağlayan proxy.

/p/<sid>/<ad>?u=<kaynak>
  sid: çözümleme sırasında kaydedilen başlık seti (Referer, UA, ...). Bilinmeyen sid reddedilir,
  böylece proxy rastgele bir açık aktarıcı olmaz.
  m3u8 (uzantı, content-type veya içerik '#EXTM3U' ile başlıyorsa) içindeki tüm linkler
  yeniden /p/<sid>/... olarak yazılır.
"""
import os
import re
import secrets
import urllib.parse
from collections import OrderedDict

import httpx
from fastapi import Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

HLS_MIME = "application/vnd.apple.mpegurl"
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges",
                "last-modified", "etag")
MAX_SESSIONS = 30


def _ext(url: str) -> str:
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    return ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext) else ".bin"


class Proxy:
    def __init__(self):
        self.sessions: OrderedDict[str, dict] = OrderedDict()
        self.client = httpx.AsyncClient(follow_redirects=True,
                                        timeout=httpx.Timeout(30, connect=10))

    async def close(self):
        await self.client.aclose()

    def register(self, headers: dict) -> str:
        sid = secrets.token_urlsafe(6)
        self.sessions[sid] = dict(headers)
        while len(self.sessions) > MAX_SESSIONS:
            self.sessions.popitem(last=False)
        return sid

    @staticmethod
    def url(sid: str, src: str) -> str:
        return f"/p/{sid}/m{_ext(src)}?u={urllib.parse.quote(src, safe='')}"

    def rewrite(self, text: str, base: str, sid: str) -> str:
        def wrap(u):
            return self.url(sid, urllib.parse.urljoin(base, u.strip()))

        out = []
        for line in text.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                out.append(wrap(s))
            elif 'URI="' in s:
                out.append(re.sub(r'URI="([^"]+)"', lambda m: f'URI="{wrap(m.group(1))}"', line))
            else:
                out.append(line)
        return "\n".join(out) + "\n"

    async def handle(self, request: Request, sid: str) -> Response:
        headers = self.sessions.get(sid)
        src = request.query_params.get("u")
        if headers is None or not src or not src.startswith(("http://", "https://")):
            return Response("bilinmeyen oturum", status_code=404)
        req_headers = {**headers, "Accept-Encoding": "identity"}
        if request.headers.get("range"):
            req_headers["Range"] = request.headers["range"]
        try:
            upstream = await self.client.send(
                self.client.build_request(request.method, src, headers=req_headers), stream=True)
        except httpx.HTTPError as e:
            return Response(f"kaynak hatası: {e!r}", status_code=502)

        ctype = upstream.headers.get("content-type", "")
        maybe_playlist = "mpegurl" in ctype.lower() or _ext(src) == ".m3u8"
        it = upstream.aiter_raw()
        first = b""
        if request.method != "HEAD" and upstream.status_code < 400:
            async for chunk in it:
                first = chunk
                break
            if maybe_playlist or first.lstrip(b"\xef\xbb\xbf \r\n")[:7] == b"#EXTM3U":
                body = first + b"".join([c async for c in it])
                await upstream.aclose()
                text = self.rewrite(body.decode("utf-8", "replace"), str(upstream.url), sid)
                return Response(text, media_type=HLS_MIME,
                                headers={"Cache-Control": "no-store"})

        out_headers = {h: upstream.headers[h] for h in PASS_HEADERS if h in upstream.headers}

        async def body():
            if first:
                yield first
            async for chunk in it:
                yield chunk

        return StreamingResponse(body(), status_code=upstream.status_code, headers=out_headers,
                                 background=BackgroundTask(upstream.aclose))
