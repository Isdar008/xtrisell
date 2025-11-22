const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createshadowsocks(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating SHADOWSOCKS for ${username} | Exp: ${exp} days | Quota: ${quota} GB | IP Limit: ${limitip}`);

  // validasi username: huruf & angka saja, tanpa spasi
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) {
        console.error('❌ DB Error (createshadowsocks):', err?.message || 'Server tidak ditemukan');
        return resolve('❌ Server tidak ditemukan.');
      }

      const url = `http://${server.domain}:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;

      try {
        const { data } = await axios.get(url);

        if (data.status !== 'success') {
          console.error('❌ Shadowsocks API returned error:', data.message);
          return resolve(`❌ Gagal: ${data.message}`);
        }

        const d = data.data;

        // sanitasi / fallback nilai
        const domainOut = d.domain || server.domain || '-';
        const ss_ws = d.ss_link_ws || d.link_ws || d.ss_ws || '-';
        const ss_grpc = d.ss_link_grpc || d.link_grpc || d.ss_grpc || '-';
        const pubkey = d.pubkey || d.public_key || 'Not Available';
        const expired = d.expired || d.expiration || d.exp || '-';
        const quotaStr = (d.quota === '0 GB' || d.quota === 0 || d.quota === '0') ? 'Unlimited' : (d.quota || `${quota} GB`);
        const ipLimitStr = (d.ip_limit === '0' || d.ip_limit === 0 || d.ip_limit === '0 IP') ? 'Unlimited' : (d.ip_limit || limitip || '0');

        const msg = `
🌟 *AKUN SHADOWSOCKS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${d.username}\`
│ *Domain*   : \`${domainOut}\`
└─────────────────────
┌─────────────────────
│ *Quota*    : \`${quotaStr}\`
│ *IP Limit* : \`${ipLimitStr}${ipLimitStr !== 'Unlimited' && !String(ipLimitStr).includes('IP') ? ' IP' : ''}\`
└─────────────────────

🔐 *SHADOWSOCKS WS LINK*
\`\`\`
${ss_ws}
\`\`\`
🔒 *SHADOWSOCKS gRPC LINK*
\`\`\`
${ss_grpc}
\`\`\`
🔏 *PUBKEY*
\`\`\`
${pubkey}
\`\`\`
┌─────────────────────
│ *Expired* : \`${expired}\`
└─────────────────────
📄 *Save Account*
\`\`\`
https://${domainOut}:81/shadowsocks-${d.username}.txt
\`\`\`
✨ Selamat menggunakan layanan kami! ✨
`.trim();

        console.log('✅ Shadowsocks created for', d.username);
        return resolve(msg);
      } catch (e) {
        console.error('❌ Error saat request Shadowsocks API:', e?.message || e);
        return resolve('❌ Tidak bisa menghubungi server Shadowsocks. Coba lagi nanti.');
      }
    });
  });
}

module.exports = { createshadowsocks };