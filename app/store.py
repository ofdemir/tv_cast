"""Geçmiş ve 'kaldığın yerden devam' konumları (data/state.json)."""
import json
import os
import time

MAX_HISTORY = 30
SAVE_EVERY = 10  # sn


class Store:
    def __init__(self, path: str):
        self.path = path
        self.data = {"history": [], "positions": {}}
        self._dirty = False
        self._last_save = 0.0
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    self.data.update(json.load(f))
            except (OSError, ValueError):
                pass

    @property
    def history(self):
        return self.data["history"]

    def position(self, key: str) -> float | None:
        p = self.data["positions"].get(key)
        return p["t"] if p else None

    def set_position(self, key: str, t: float, duration: float | None):
        pos = self.data["positions"]
        if t < 30 or (duration and t > duration - 90):
            # Başlarda ya da sona yakınsa hatırlamaya değmez (bitti sayılır)
            changed = pos.pop(key, None) is not None
        else:
            changed = abs((pos.get(key) or {}).get("t", -100) - t) >= 5
            if changed:
                pos[key] = {"t": round(t, 1), "d": duration, "ts": int(time.time())}
        if changed:
            self._dirty = True
            self.maybe_save()

    def add_history(self, entry: dict):
        h = [e for e in self.history if e.get("url") != entry["url"]]
        h.insert(0, {**entry, "ts": int(time.time())})
        self.data["history"] = h[:MAX_HISTORY]
        keep = {e["url"] for e in self.data["history"]}
        self.data["positions"] = {k: v for k, v in self.data["positions"].items() if k in keep}
        self._dirty = True
        self.save()

    def maybe_save(self):
        if time.time() - self._last_save >= SAVE_EVERY:
            self.save()

    def save(self):
        if not self._dirty:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)
        self._dirty = False
        self._last_save = time.time()
