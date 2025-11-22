const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createssh(username, password, exp, iplimit, serverId) {
  console.log(`⚙️ Creating SSH for ${username} | Exp: ${exp} | IP Limit: ${iplimit}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) return resolve('❌ Server tidak ditemukan.');

      const url = `http://${server.domain}:5888/createssh?user=${username}&password=${password}&exp=${exp}&iplimit=${iplimit}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url);
        if (data.status !== 'success') return resolve(`❌ Gagal: ${data.message}`);

        const d = data.data;

        // =========================
        //   STYLE PREMIUM TERBARU
        // =========================
        const msg = `
🌟 *AKUN SSH PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Password* : \`${d.password}\`
│ *Domain*   : \`${d.domain}\`
└─────────────────────
🔌 *PORT*
┌─────────────────────
│ *TLS*        : \`443\`
│ *HTTP*       : \`80\`
│ *OpenSSH*    : \`${d.ports?.openssh || '22'}\`
│ *SSH WS*     : \`${d.ports?.ssh_ws || '80'}\`
│ *SSH SSL WS* : \`${d.ports?.ssh_ssl_ws || '443'}\`
│ *Dropbear*   : \`${d.ports?.dropbear || '109, 443'}\`
│ *DNS*        : \`53, 443, 22\`
│ *OVPN SSL*   : \`${d.ports?.ovpn_ssl || '443'}\`
│ *OVPN TCP*   : \`${d.ports?.ovpn_tcp || '1194'}\`
│ *OVPN UDP*   : \`${d.ports?.ovpn_udp || '2200'}\`
└─────────────────────

🔐 *PUBKEY*
\`\`\`
${d.pubkey || 'Pubkey tidak tersedia'}
\`\`\`
🔗 *Link & File*
WSS Payload :
\`\`\`
GET wss://BUG.COM/ HTTP/1.1
Host: ${d.domain}
Upgrade: websocket
\`\`\`
OpenVPN :
\`\`\`
https://${d.domain}:81/allovpn.zip
\`\`\`
Save Account :
\`\`\`
https://${d.domain}:81/ssh-${d.username}.txt
\`\`\`
┌─────────────────────
│ *Expired*  : \`${d.expired}\`
│ *IP Limit* : \`${d.ip_limit === '0' ? 'Unlimited' : d.ip_limit + ' IP'}\`
└─────────────────────
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        return resolve(msg);

      } catch (error) {
        console.error('❌ Error API createssh:', error);
        return resolve('❌ Gagal request ke API SSH.');
      }
    });
  });
}

module.exports = { createssh };