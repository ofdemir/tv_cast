"""TV Cast sunucusu.

  /        telefon kumandası
  /tv      TV'de açık duran alıcı sayfa
  /ws/tv, /ws/remote   anlık komut/durum kanalı
  /api/cast            link gönder (yt-dlp ile çözülür, TV'ye yüklenir)
  /p/...               medya proxy'si
"""
import asyncio
import io
import json
import os
import secrets
from contextlib import asynccontextmanager

import segno
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .proxy import Proxy
from .resolver import ResolveError, resolve
from .store import Store

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA = os.environ.get("TVCAST_DATA", os.path.join(os.path.dirname(HERE), "data"))


def _read_version():
    # Deploy betiği sürüm klasörüne VERSION dosyası yazar; geliştirmede "dev"
    try:
        with open(os.path.join(os.path.dirname(HERE), "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or "dev"
    except OSError:
        return "dev"


VERSION = _read_version()


class Hub:
    def __init__(self):
        self.tvs: set[WebSocket] = set()
        self.remotes: set[WebSocket] = set()
        self.now: dict | None = None  # şu an TV'ye yüklenen içerik
        self.tv: dict = {}  # TV'nin son bildirdiği durum
        self.busy: str | None = None  # "çözümleniyor" mesajı
        self.error: str | None = None

    def state(self):
        now = {k: v for k, v in self.now.items() if k != "src"} if self.now else None
        return {"type": "state", "now": now, "tv": self.tv, "tvs": len(self.tvs),
                "busy": self.busy, "error": self.error}

    async def _send(self, sockets, msg):
        data = json.dumps(msg)
        for ws in list(sockets):
            try:
                await ws.send_text(data)
            except Exception:  # noqa: BLE001 — kopan istemci
                sockets.discard(ws)

    async def to_tvs(self, msg):
        await self._send(self.tvs, msg)

    async def broadcast_state(self):
        await self._send(self.remotes, self.state())

    def load_msg(self, start=None):
        n = self.now
        return {"type": "load", "id": n["id"], "src": n["src"], "kind": n["kind"],
                "title": n["title"], "start": start if start is not None else n.get("start", 0)}


hub = Hub()
proxy = Proxy()
store = Store(os.path.join(DATA, "state.json"))


async def _keepalive():
    # Bazı TV tarayıcıları boşta kalan WebSocket'i kapatır; periyodik ping bağlantıyı canlı tutar.
    while True:
        await asyncio.sleep(20)
        await hub.to_tvs({"type": "ping"})


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(_keepalive())
    yield
    task.cancel()
    store.save()
    await proxy.close()


app = FastAPI(title="TV Cast", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def remote_page():
    return FileResponse(os.path.join(STATIC, "remote.html"), headers={"Cache-Control": "no-cache"})


@app.get("/tv")
async def tv_page():
    return FileResponse(os.path.join(STATIC, "tv.html"), headers={"Cache-Control": "no-cache"})


@app.get("/qr.svg")
async def qr(request: Request):
    buf = io.BytesIO()
    segno.make(str(request.base_url), error="m").save(buf, kind="svg", scale=8, border=2,
                                                       dark="#000", light="#fff")
    return Response(buf.getvalue(), media_type="image/svg+xml")


class CastReq(BaseModel):
    url: str
    referer: str | None = None
    start: float | None = None  # None: kaldığı yerden; 0: baştan
    # Tarayıcı eklentisinden gelen doğrudan medya linkleri için:
    page: str | None = None  # videonun izlendiği sayfa (geçmiş/kaldığın yer anahtarı)
    title: str | None = None
    kind: str | None = None  # "hls" | "native"; verilirse yt-dlp'ye uğramaz
    user_agent: str | None = None


@app.post("/api/cast")
async def cast(req: CastReq):
    hub.busy, hub.error = "Link çözümleniyor…", None
    await hub.broadcast_state()
    try:
        r = await resolve(req.url, req.referer or None, req.kind, req.user_agent)
    except ResolveError as e:
        hub.busy, hub.error = None, str(e)
        await hub.broadcast_state()
        return JSONResponse({"ok": False, "error": str(e)}, status_code=422)
    except Exception as e:  # noqa: BLE001 — yt-dlp beklenmedik hatalar fırlatabilir
        hub.busy, hub.error = None, f"Beklenmeyen hata: {e!r}"[:300]
        await hub.broadcast_state()
        return JSONResponse({"ok": False, "error": hub.error}, status_code=500)

    sid = proxy.register(r.headers)
    page_url = (req.page or req.url).strip()
    media = req.url.strip() if req.page else None  # eklentiden gelen doğrudan link
    title = (req.title or "").strip() or r.title
    start = req.start if req.start is not None else (store.position(page_url) or 0)
    hub.now = {"id": secrets.token_hex(4), "page_url": page_url, "media": media, "title": title,
               "kind": r.kind, "src": proxy.url(sid, r.url), "start": start,
               "extractor": "eklenti" if media else r.extractor, "referer": req.referer,
               "user_agent": req.user_agent}
    hub.busy, hub.tv = None, {}
    store.add_history({"url": page_url, "media": media, "kind": req.kind, "title": title,
                       "referer": req.referer, "user_agent": req.user_agent})
    await hub.to_tvs(hub.load_msg())
    await hub.broadcast_state()
    return {"ok": True, "title": title, "kind": r.kind, "start": start,
            "tv_connected": bool(hub.tvs)}


@app.get("/api/health")
async def health():
    return {"ok": True, "version": VERSION}


@app.get("/api/history")
async def history():
    return [{**e, "pos": store.position(e["url"])} for e in store.history]


@app.get("/api/state")
async def state():
    return hub.state()


@app.api_route("/p/{sid}/{name}", methods=["GET", "HEAD"])
async def media_proxy(sid: str, name: str, request: Request):
    return await proxy.handle(request, sid)


@app.websocket("/ws/tv")
async def ws_tv(ws: WebSocket):
    await ws.accept()
    hub.tvs.add(ws)
    if hub.now:  # TV sayfası yenilendiyse kaldığı yerden yükle
        await ws.send_text(json.dumps(hub.load_msg(start=hub.tv.get("time") or None)))
    await hub.broadcast_state()
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "status":
                if hub.now and msg.get("id") == hub.now["id"]:
                    hub.tv = msg
                    if msg.get("time") is not None:
                        store.set_position(hub.now["page_url"], msg["time"], msg.get("duration"))
                await hub.broadcast_state()
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        hub.tvs.discard(ws)
        await hub.broadcast_state()


@app.websocket("/ws/remote")
async def ws_remote(ws: WebSocket):
    await ws.accept()
    hub.remotes.add(ws)
    await ws.send_text(json.dumps(hub.state()))
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") != "cmd":
                continue
            if msg.get("action") == "stop":
                hub.now, hub.tv = None, {}
                store.save()
                await hub.broadcast_state()
            await hub.to_tvs(msg)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        hub.remotes.discard(ws)

