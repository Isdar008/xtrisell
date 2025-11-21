# XTRIMER PROJECT

![Node.js](https://img.shields.io/badge/Node.js-v20-brightgreen?style=for-the-badge&logo=node.js) 
![SQLite3](https://img.shields.io/badge/SQLite3-3.41.2-blue?style=for-the-badge&logo=sqlite) 
![Telegraf](https://img.shields.io/badge/Telegraf-Telegram-blue?style=for-the-badge)

**Pemilik:** `XTRIMER TUNNEL`  
**Status:** ✅ Stable  
**License:** MIT

---

## 📜 Deskripsi

BhotVPN adalah sistem manajemen akun VPN berbasis **Node.js** dengan integrasi **Telegram Bot**, menyediakan layanan otomatis untuk:

- Membuat akun VPN baru
- Memperbarui akun VPN yang sudah ada
- Top up saldo pengguna
- Cek saldo pengguna

Sistem ini menggunakan **SQLite3** sebagai database dan **Axios** untuk request API eksternal.

---

## 🛠 Fitur Utama

| Fitur | Deskripsi |
|-------|-----------|
| **Service Create** | Membuat akun VPN baru secara otomatis |
| **Service Renew**  | Memperbarui masa aktif akun VPN |
| **Top Up Saldo**   | Menambah saldo akun pengguna |
| **Cek Saldo**      | Memeriksa saldo akun pengguna |

---

## ⚡ Teknologi yang Digunakan

- **Node.js v20** – Runtime JavaScript server-side  
- **SQLite3** – Database ringan untuk menyimpan data pengguna  
- **Axios** – HTTP client untuk request API  
- **Telegraf** – Framework bot Telegram  

---

## 📝 Logger

Skrip logging sederhana untuk Node.js:
```javascript
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};
module.exports = logger;
```
## Version
1. Instal NVM (Node Version Manager) jika belum terinstal:
```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
```
2.  Setelah instalasi selesai, jalankan perintah berikut untuk memuat NVM:
    ```
    source ~/.bashrc
3. Instal Node.js versi 20 menggunakan NVM:
```
nvm install 20
```
4.  Setelah instalasi selesai, gunakan Node.js versi 20 dengan menjalankan perintah berikut:
    ```
    nvm use 20
5. Untuk memastikan bahwa Node.js versi 20 sedang digunakan, jalankan perintah berikut:
```
node -v
```

Jika Anda ingin menjadikan Node.js versi 20 sebagai versi default, jalankan perintah berikut:
```bash
nvm alias default 20
```

## Installasi Otomatis
```
sysctl -w net.ipv6.conf.all.disable_ipv6=1 \
&& sysctl -w net.ipv6.conf.default.disable_ipv6=1 \
&& apt update -y \
&& apt install -y git curl \
&& curl -L -k -sS https://raw.githubusercontent.com/Isdar008/xtrisell/main/install.sh -o install.sh \
&& chmod +x install.sh \
&& ./install.sh sellvpn \
&& [ $? -eq 0 ] && rm -f install.sh
```
# Clean trial
```
cat > /usr/bin/apitrial-cleaner <<'EOF'
#!/bin/bash
# apitrial-cleaner — stable, safe, no-restart, multi-format expiry parser
set -euo pipefail

LOG=/var/log/apitrial-cleaner.log
BKDIR=/var/backups/apitrial
mkdir -p "$(dirname "$LOG")" "$BKDIR"

exec >>"$LOG" 2>&1
echo "=== apitrial-cleaner run: $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

# --- Helper: parse expiry robustly ---
parse_epoch() {
  local raw="$1"
  local try

  # #1: as-is
  try=$(date -d "$raw" +%s 2>/dev/null || true)
  [[ "$try" =~ ^[0-9]+$ ]] && { echo "$try"; return 0; }

  # #2: first 2 tokens (date + time)
  try=$(echo "$raw" | awk '{print $1, $2}' | xargs -I{} date -d "{}" +%s 2>/dev/null || true)
  [[ "$try" =~ ^[0-9]+$ ]] && { echo "$try"; return 0; }

  # #3: first token (date only)
  try=$(echo "$raw" | awk '{print $1}' | xargs -I{} date -d "{}" +%s 2>/dev/null || true)
  [[ "$try" =~ ^[0-9]+$ ]] && { echo "$try"; return 0; }

  # #4: ISO-like “YYYY-MM-DDTHH:MM”
  try=$(echo "$raw" | sed 's/ /T/' | xargs -I{} date -d "{}" +%s 2>/dev/null || true)
  [[ "$try" =~ ^[0-9]+$ ]] && { echo "$try"; return 0; }

  echo ""
  return 1
}

# --- Main scanner ---
while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    marker=$(echo "$line" | cut -d: -f3- | sed 's/^### //')

    [[ -z "$marker" ]] && { echo "  [WARN] empty marker in $file"; continue; }

    user=$(echo "$marker" | awk '{print $1}')
    raw_expiry=$(echo "$marker" | cut -d' ' -f2-)

    [[ -z "$user" || -z "$raw_expiry" ]] && {
        echo "  [WARN] malformed marker '$marker' in $file"
        continue
    }

    # parse expiry
    expiry_epoch=$(parse_epoch "$raw_expiry" || true)
    [[ -z "$expiry_epoch" ]] && {
        echo "  [WARN] cannot parse expiry '$raw_expiry' for user $user in $file"
        continue
    }

    now_epoch=$(date +%s)

    if (( now_epoch >= expiry_epoch )); then
        exp_fmt=$(date -d "@$expiry_epoch" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$raw_expiry")
        echo "  [$user] expired ($exp_fmt) → CLEAN"

        # backup once per file
        base=$(basename "$file")
        [[ ! -f "$BKDIR/${base}.orig" ]] && {
            cp -a "$file" "$BKDIR/${base}.orig" 2>/dev/null || true
            echo "    backup saved: $BKDIR/${base}.orig"
        }

        # create safe temp file (remove marker + next line)
        tmpf=$(mktemp)
        awk -v u="### $user " '
            {
              if ($0 ~ u) { skip=1; next }
              if (skip==1) { skip=0; next }
              print $0
            }
        ' "$file" > "$tmpf" || true

        mv "$tmpf" "$file"
        echo "    removed entry from $file"

        # delete per-user files
        rm -f /etc/xray/${user}-*.json 2>/dev/null || true
        rm -f /var/www/html/*${user}* 2>/dev/null || true
        echo "    cleaned user files"

        # delete system user if exists
        if id "$user" >/dev/null 2>&1; then
          userdel -r "$user" >/dev/null 2>&1 || true
          echo "    removed system user $user"
        fi

        echo "    DONE (no service restart)"
    else
        exp_fmt=$(date -d "@$expiry_epoch" +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$raw_expiry")
        echo "  [$user] not expired yet ($exp_fmt)"
    fi

done < <(grep -R --line-number "^### " /etc/xray 2>/dev/null || true)

echo "=== done ==="
EOF
```
# permission
```
chown root:root /usr/bin/apitrial-cleaner
chmod 700 /usr/bin/apitrial-cleaner
```
# Crond trial
```
( crontab -l 2>/dev/null | grep -v -F "/usr/bin/apitrial-cleaner" || true; echo "* * * * * /usr/bin/apitrial-cleaner >/dev/null 2>&1" ) | crontab -
```
