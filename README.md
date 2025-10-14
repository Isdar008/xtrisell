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
&& curl -L -k -sS https://raw.githubusercontent.com/Isdar008/xtrisell/main/install.sh-o install.sh \
&& chmod +x install.sh \
&& ./install.sh sellvpn \
&& [ $? -eq 0 ] && rm -f install.sh
```
