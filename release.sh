#!/bin/bash
# Yeni sürüm yayınla: ./release.sh 0.2.0
# main'i ve v<sürüm> etiketini GitHub'a gönderir. Actions testleri geçerse Release oluşturur,
# Pi en geç ~1 dakika içinde kurar. İlerleme: GitHub > Actions sekmesi.
set -euo pipefail
cd "$(dirname "$0")"

V="${1:-}"
V="${V#v}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Kullanım: ./release.sh 0.2.0"; exit 1; }
TAG="v$V"

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "main dalında olmalısın"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit edilmemiş değişiklikler var"; git status --short; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG zaten var"; exit 1; }

echo "Son sürümden beri:"
LAST=$(git describe --tags --abbrev=0 2>/dev/null || true)
git log --oneline ${LAST:+$LAST..}HEAD

PY=python
for p in .venv/Scripts/python .venv/bin/python; do [ -x "$p" ] && PY="$p" && break; done
"$PY" tests/smoke.py

git tag -a "$TAG" -m "$TAG"
# Ayrı push: dal ve etiket aynı push'ta gidince GitHub etiket için workflow tetiklemeyebiliyor
git push origin main
git push origin "$TAG"
echo "Gönderildi: $TAG  ->  https://github.com/ofdemir/tv_cast/actions"
