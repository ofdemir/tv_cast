#!/bin/bash
# Pi'de TEK SEFERLİK kurulum: systemd servisleri, güncelleme zamanlayıcısı, ilk sürüm.
# Sonrasında her yeni GitHub Release'i Pi kendisi kurar (tv-cast-update.timer, dakikada bir).
#
#   curl -fsSL https://raw.githubusercontent.com/ofdemir/tv_cast/main/deploy/bootstrap_pi.sh | bash
set -euo pipefail

REPO="ofdemir/tv_cast"
BASE="$HOME/apps/tv_cast"
USER_NAME="$(id -un)"
RAW="https://raw.githubusercontent.com/$REPO/main/deploy"

echo "== paketler"
sudo apt-get install -y -qq python3-venv curl >/dev/null

if ! curl -fsSI --max-time 15 "https://github.com/$REPO/releases/latest" | tr -d '\r' |
     grep -iq '^location:.*/tag/v'; then
  echo "GitHub'da henüz release yok. Önce bir sürüm etiketi gönderin (ör. v0.1.0)."
  exit 1
fi

echo "== dizinler: $BASE"
mkdir -p "$BASE/bin" "$BASE/shared/data" "$BASE/state"
curl -fsSL "$RAW/pi_deploy.sh" -o "$BASE/bin/pi_deploy.sh"
chmod 755 "$BASE/bin/pi_deploy.sh"

# Eski düz kurulumdan (~/tv_cast) geçmiş ve konumları taşı
if [ -f "$HOME/tv_cast/data/state.json" ] && [ ! -f "$BASE/shared/data/state.json" ]; then
  cp "$HOME/tv_cast/data/state.json" "$BASE/shared/data/"
  echo "   eski veriler taşındı"
fi

echo "== systemd"
sudo tee /etc/systemd/system/tv-cast.service >/dev/null <<EOF
[Unit]
Description=TV Cast
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$BASE/current
Environment=TVCAST_DATA=$BASE/shared/data
ExecStart=$BASE/current/.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 80
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/tv-cast-update.service >/dev/null <<EOF
[Unit]
Description=TV Cast: yeni GitHub Release varsa kur
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
ExecStart=$BASE/bin/pi_deploy.sh
EOF

sudo tee /etc/systemd/system/tv-cast-update.timer >/dev/null <<EOF
[Unit]
Description=TV Cast güncelleme kontrolü (dakikada bir)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

# Deploy betiği yalnızca bu servisi yeniden başlatabilsin
echo "$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart tv-cast" |
  sudo tee /etc/sudoers.d/tv-cast >/dev/null
sudo chmod 440 /etc/sudoers.d/tv-cast

# yt-dlp sitelere ayak uydurmak için sık güncellenir: haftalık, çalışan sürümün venv'inde
echo "0 4 * * 1 root runuser -u $USER_NAME -- $BASE/current/.venv/bin/pip install -U -q yt-dlp && systemctl restart tv-cast" |
  sudo tee /etc/cron.d/tv-cast-ytdlp >/dev/null

sudo systemctl daemon-reload

echo "== ilk sürüm"
"$BASE/bin/pi_deploy.sh"

sudo systemctl enable -q tv-cast
sudo systemctl enable -q --now tv-cast-update.timer
IP="$(hostname -I | awk '{print $1}')"
echo
echo "Hazır: $(cat "$BASE/current/VERSION")   Telefon: http://$IP/   TV: http://$IP/tv"
echo "Loglar: journalctl -u tv-cast -u tv-cast-update -f"
