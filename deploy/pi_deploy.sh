#!/bin/bash
# GitHub'da yeni bir Release varsa kurar; sağlık kontrolü geçmezse önceki sürüme döner.
#
#   pi_deploy.sh            en son release (timer her dakika böyle çağırır)
#   pi_deploy.sh v0.1.0     belirli bir sürüme geç / elle geri dön
#
# Dizin yapısı ($BASE):
#   releases/vX.Y.Z/   kaynak + kendi .venv'i + VERSION
#   current ->         çalışan sürüm (symlink)
#   shared/data/       geçmiş, kaldığın yer (sürümler arasında korunur)
#   state/bad_tags     sağlık kontrolünden geçemeyen sürümler (otomatik tekrar denenmez)
set -euo pipefail

REPO="ofdemir/tv_cast"
BASE="${TVCAST_BASE:-$HOME/apps/tv_cast}"
PORT="${TVCAST_PORT:-80}"
KEEP=3

log() { echo "[deploy] $*"; }

mkdir -p "$BASE/releases" "$BASE/shared/data" "$BASE/state" "$BASE/bin"
exec 9>"$BASE/state/lock"
flock -n 9 || exit 0  # başka bir deploy sürüyor

MANUAL="${1:-}"
TAG="$MANUAL"
if [ -z "$TAG" ]; then
  # /releases/latest -> /releases/tag/vX.Y.Z yönlendirmesi (API kullanım limitine takılmaz)
  LOC=$(curl -fsSI --max-time 15 "https://github.com/$REPO/releases/latest" | tr -d '\r' |
        awk 'tolower($1)=="location:"{print $2}') || exit 0
  TAG="${LOC##*/tag/}"
fi
# Etiket yol içinde kullanılıyor: yalnızca vX.Y.Z kabul et
if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  [ -n "$MANUAL" ] && { log "geçersiz sürüm: $TAG"; exit 1; }
  exit 0  # henüz release yok
fi

CUR=""
[ -L "$BASE/current" ] && CUR=$(basename "$(readlink "$BASE/current")")
[ "$TAG" = "$CUR" ] && exit 0
if [ -z "$MANUAL" ] && grep -qx "$TAG" "$BASE/state/bad_tags" 2>/dev/null; then
  exit 0
fi

DIR="$BASE/releases/$TAG"
log "${CUR:-(yok)} -> $TAG"

if [ ! -f "$DIR/VERSION" ]; then
  rm -rf "$DIR.tmp" && mkdir -p "$DIR.tmp"
  log "indiriliyor"
  curl -fsSL --max-time 180 "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" |
    tar -xz -C "$DIR.tmp" --strip-components=1
  log "bağımlılıklar kuruluyor"
  python3 -m venv "$DIR.tmp/.venv"
  "$DIR.tmp/.venv/bin/pip" install -q --disable-pip-version-check -r "$DIR.tmp/requirements.txt"
  echo "$TAG" > "$DIR.tmp/VERSION"
  rm -rf "$DIR" && mv "$DIR.tmp" "$DIR"
fi

switch_to() {
  ln -sfn "releases/$1" "$BASE/current.new"
  mv -T "$BASE/current.new" "$BASE/current"
  sudo -n systemctl restart tv-cast
}

healthy() {
  for _ in $(seq 1 40); do
    sleep 1
    curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/health" | grep -q "\"version\":\"$1\"" && return 0
  done
  return 1
}

switch_to "$TAG"
if healthy "$TAG"; then
  log "OK: $TAG çalışıyor"
  # Deploy betiğinin kendisi de sürümle birlikte güncellenir
  install -m 755 "$DIR/deploy/pi_deploy.sh" "$BASE/bin/pi_deploy.sh"
  # Eski sürümleri temizle (çalışan hariç son $KEEP tanesi kalır)
  ls -1dt "$BASE"/releases/v*/ 2>/dev/null | sed 's#/$##' | grep -vx "$DIR" |
    tail -n +"$KEEP" | xargs -r rm -rf
  exit 0
fi

log "HATA: $TAG sağlık kontrolünden geçmedi"
journalctl -u tv-cast -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
echo "$TAG" >> "$BASE/state/bad_tags"
if [ -n "$CUR" ] && [ -d "$BASE/releases/$CUR" ]; then
  log "geri dönülüyor: $CUR"
  switch_to "$CUR"
  healthy "$CUR" && log "geri dönüldü: $CUR" || log "UYARI: $CUR da yanıt vermiyor"
fi
exit 1
