const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// =============================
//     CREATE VMESS PREMIUM
// =============================
async function createvmess(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating VMESS for ${username} | Exp: ${exp} days | Quota: ${quota} GB | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Gunakan tanpa spasi & simbol.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) return resolve('❌ Server tidak ditemukan.');

      const url =
        `http://${server.domain}:5888/createvmess?` +
        `user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url);

        if (data.status !== "success") {
          return resolve(`❌ Gagal membuat akun: ${data.message}`);
        }

        const d = data.data;

        // =============================
        //  PREMIUM STYLE MIRIP SSH
        // =============================
        const msg = `
🌟 *AKUN VMESS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain*   : \`${d.domain}\`
└─────────────────────
🔌 *PORT*
┌─────────────────────
│ *TLS*       : \`443\`
│ *HTTP*      : \`80\`
│ *Network*   : \`Websocket (WS)\`
│ *Path*      : \`/vmess\`
│ *Path GRPC* : \`vmess-grpc\`
│ *Quota*     : \`${d.quota === '0 GB' ? 'Unlimited' : d.quota}\`
│ *IP Limit*  : \`${d.ip_limit === '0' ? 'Unlimited' : d.ip_limit + ' IP'}\`
└─────────────────────

🔐 *VMESS TLS*
\`\`\`
${d.vmess_tls_link}
\`\`\`
🔓 *VMESS HTTP*
\`\`\`
${d.vmess_nontls_link}
\`\`\`
🔒 *VMESS GRPC*
\`\`\`
${d.vmess_grpc_link}
\`\`\`
🔑 *UUID*
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
https://${d.domain}:81/vmess-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        resolve(msg);

      } catch (error) {
        console.error("❌ VMESS API error:", error.message);
        resolve("❌ Tidak bisa menghubungi server. Coba lagi nanti.");
      }
    });
  });
}

module.exports = { createvmess };