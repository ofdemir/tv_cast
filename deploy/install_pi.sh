#!/bin/sh
# Raspberry Pi (Raspberry Pi OS) kurulumu: venv + systemd servisi (port 80) + haftalık yt-dlp güncellemesi
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
sudo apt-get update
sudo apt-get install -y python3-venv
cd "$DIR"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
sed -e "s#__DIR__#$DIR#g" -e "s#__USER__#$USER_NAME#g" deploy/tv-cast.service | sudo tee /etc/systemd/system/tv-cast.service >/dev/null
# Siteler sık değişir; yt-dlp'yi her pazartesi güncelle ve servisi yeniden başlat
echo "0 4 * * 1 root runuser -u $USER_NAME -- $DIR/.venv/bin/pip install -U -q yt-dlp && systemctl restart tv-cast" | sudo tee /etc/cron.d/tv-cast-ytdlp >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now tv-cast
IP="$(hostname -I | awk '{print $1}')"
echo "Kuruldu. Telefon: http://$IP/   TV: http://$IP/tv"
