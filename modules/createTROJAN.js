const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// =============================
//      CREATE TROJAN PREMIUM
// =============================
async function createtrojan(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating TROJAN for ${username} | Exp: ${exp} days | Quota: ${quota} GB | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) {
        return resolve('❌ Server tidak ditemukan.');
      }

      const url =
        `http://${server.domain}:5888/createtrojan?` +
        `user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url);

        if (data.status !== "success") {
          return resolve(`❌ Gagal: ${data.message}`);
        }

        const d = data.data;

        // =======================================
        //       PREMIUM TROJAN UI FORMAT
        // =======================================
        const msg = `
🌟 *AKUN TROJAN PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain*   : \`${d.domain}\`
└─────────────────────
🔌 *PORT & JARINGAN*
┌─────────────────────
│ *TLS (WS)*   : \`443\`
│ *gRPC*       : \`443\`
│ *Network*    : Websocket / gRPC
│ *Quota*      : \`${d.quota === '0 GB' ? 'Unlimited' : d.quota}\`
│ *IP Limit*   : \`${d.ip_limit === '0' ? 'Unlimited' : d.ip_limit + ' IP'}\`
└─────────────────────

🔐 *TROJAN TLS*
\`\`\`
${d.trojan_tls_link}
\`\`\`
🔒 *TROJAN GRPC*
\`\`\`
${d.trojan_grpc_link}
\`\`\`
🔑 *PASSWORD/UUID*
\`\`\`
${d.uuid}
\`\`\`
🔏 *PUBKEY*
\`\`\`
${d.pubkey}
\`\`\`
┌─────────────────────
│ *Expired* : \`${d.expired}\`
└─────────────────────
📄 *Save Account*
\`\`\`
https://${d.domain}:81/trojan-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        resolve(msg);

      } catch (e) {
        console.error("❌ TROJAN API Error:", e.message);
        resolve("❌ Tidak bisa menghubungi server. Coba lagi nanti.");
      }
    });
  });
}

module.exports = { createtrojan };