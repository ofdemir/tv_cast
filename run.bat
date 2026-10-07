@echo off
rem Geliştirme: PC'de çalıştır. TV'de http://<bu-pc-ip>:8000/tv aç.
cd /d %~dp0
if not exist .venv (python -m venv .venv && .venv\Scripts\pip install -r requirements.txt)
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
