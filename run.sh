#!/bin/sh
# Geliştirme/elle çalıştırma. Kalıcı kurulum için deploy/install_pi.sh
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
exec .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
