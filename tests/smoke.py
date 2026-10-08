"""Duman testi: uygulama açılıyor, sayfalar ve temel akış (cast -> TV'ye load) çalışıyor.

Ağ erişimi gerektirmez (doğrudan .m3u8 linki yt-dlp'ye uğramaz).
  python tests/smoke.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TVCAST_DATA"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def main():
    with TestClient(app) as c:
        for path in ("/", "/tv", "/qr.svg", "/static/tv.js", "/static/remote.js",
                     "/static/vendor/hls.min.js", "/api/state", "/api/history"):
            r = c.get(path)
            assert r.status_code == 200, f"{path} -> {r.status_code}"

        h = c.get("/api/health").json()
        assert h["ok"] is True and h["version"], h

        with c.websocket_connect("/ws/tv") as tv:
            r = c.post("/api/cast", json={"url": "https://example.com/video/index.m3u8",
                                          "page": "https://example.com/izle/1", "title": "Test"})
            assert r.status_code == 200 and r.json()["ok"], r.text
            msg = tv.receive_json()
            while msg.get("type") != "load":
                msg = tv.receive_json()
            assert msg["kind"] == "hls" and msg["src"].startswith("/p/"), msg

        hist = c.get("/api/history").json()
        assert hist and hist[0]["url"] == "https://example.com/izle/1", hist

        r = c.post("/api/cast", json={"url": "dosya://yok"})
        assert r.status_code == 422, r.text
    print("smoke OK")


if __name__ == "__main__":
    main()
