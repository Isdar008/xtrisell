// 🌐 Core Modules
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const app = express();
const axios = require('axios');
const cron = require('node-cron');
const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');
const fetch = require('node-fetch');
const TELEGRAM_UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';
const BACKUP_DIR = '/root/BotVPN2/backups';
const DB_PATH = path.resolve('./sellvpn.db');
const UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';

// Buat folder kalau belum ada
if (!fs.existsSync(TELEGRAM_UPLOAD_DIR)) fs.mkdirSync(TELEGRAM_UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 🛠️ Load Config (.vars.json) lebih awal
const vars = JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));
const {
  BOT_TOKEN,
  USER_ID,
  GROUP_ID,
  PORT = 50123,
  NAMA_STORE = 'GabutStore',
  DATA_QRIS,
  MERCHANT_ID,
  API_KEY,
  PAKASIR_API_KEY,
  PAKASIR_PROJECT_SLUG,
  PAKASIR_WEBHOOK_URL
} = vars;

// ---- tambahkan ini ----
const MIN_DEPOSIT_AMOUNT = Number(vars.MIN_DEPOSIT_AMOUNT) || 500;

const { PakasirClient } = require('pakasir-client');
app.use(express.json());
const pakasir = new PakasirClient({
  project: PAKASIR_PROJECT_SLUG,
  apiKey: PAKASIR_API_KEY
});

// 💬 Telegram
const { Telegraf, session } = require('telegraf');
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// === Middleware: pastikan user terdaftar sebelum handler lain jalan ===
bot.use(async (ctx, next) => {
  try {
    const userId = ctx.from?.id;
    if (!userId) return next(); // ada update sistem tanpa user, skip

    // ambil sedikit atribut user (optional)
    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name || null;

    // cek apakah user sudah ada
    const existing = await dbGetAsync("SELECT user_id FROM users WHERE user_id = ?", [userId]);

    if (!existing) {
      // insert idempotent: jadikan default saldo 0, role user
      await dbRunAsync(
        `INSERT INTO users (user_id, username, first_name, saldo, role, created_at)
         VALUES (?, ?, ?, 0, 'user', datetime('now'))`,
        [userId, username, firstName]
      );
      logger.info(`🆕 Auto-registered user ${userId} (via middleware)`);
    } else {
      // update username/first_name bila berubah (opsional)
      await dbRunAsync(
        `UPDATE users SET username = ?, first_name = ? WHERE user_id = ?`,
        [username, firstName, userId]
      ).catch(() => {});
    }
  } catch (e) {
    // jangan block flow kalau DB error; hanya log
    logger.warn('Middleware ensure-user error: ' + (e.message || e));
  }
  return next();
});
// 📦 Tools
const { promisify } = require('util');
const QRISPayment = require('qris-payment');
const QRCode = require('qrcode'); // npm install qrcode
const util = require('util');
const execAsync = util.promisify(exec);
const dns = require('dns').promises;

// 🧠 Admin List
const rawAdmin = USER_ID;
const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];
const FormData = require('form-data'); // ⬅️ FIX PENTING!
// 📝 Logger
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}
logger.info('Bot initialized');

// Jadwal restart harian 04:00
cron.schedule('0 4 * * *', () => {
  logger.warn('🌀 Restart harian bot (jadwal 04:00)...');
  exec('pm2 restart sellvpn', async (err, stdout, stderr) => {
    if (err) {
      logger.error('❌ Gagal restart via PM2:', err.message);
    } else {
      logger.info('✅ Bot berhasil direstart oleh scheduler harian.');

      const restartMsg = `♻️ Bot di-restart otomatis (jadwal harian).\n🕓 Waktu: ${new Date().toLocaleString('id-ID')}`;
      try {
        await bot.telegram.sendMessage(GROUP_ID || adminIds[0], restartMsg);
        logger.info('📢 Notifikasi restart harian dikirim.');
      } catch (e) {
        logger.warn('⚠️ Gagal kirim notifikasi restart:', e.message);
      }
    }
  });
});

// ✅ RESET KOMISI BULANAN OTOMATIS TIAP TANGGAL 1 JAM 01:00
cron.schedule('0 1 1 * *', () => {
  db.serialize(() => {
    db.run(`DELETE FROM reseller_sales`, (err) => {
      if (err) {
        logger.error('❌ Gagal reset reseller_sales otomatis:', err.message);
      } else {
        logger.info('✅ reseller_sales berhasil direset otomatis bulanan');
      }
    });

    db.run(`UPDATE users SET reseller_level = 'silver' WHERE role = 'reseller'`, (err) => {
      if (err) {
        logger.error('❌ Gagal reset level reseller otomatis:', err.message);
      } else {
        logger.info('✅ Level reseller direset jadi silver (otomatis)');
      }
    });

    if (GROUP_ID) {
      bot.telegram.sendMessage(GROUP_ID, `🧹 *Reset Komisi Bulanan:*\n\nSemua komisi reseller telah direset dan level dikembalikan ke *SILVER*.`, {
        parse_mode: 'Markdown'
      }).catch((err) => {
        logger.error('❌ Gagal kirim notifikasi reset bulanan:', err.message);
      });
    }
  });
});
cron.schedule('*/20 * * * * *', async () => {
  const now = Date.now();

  try {
    const rows = await dbAllAsync(
      `SELECT id, chat_id, message_id FROM pending_delete_messages
       WHERE deleted = 0 AND delete_at <= ?`,
      [now]
    );

    for (const row of rows) {
      const { id, chat_id, message_id } = row;

      try {
        await bot.telegram.deleteMessage(chat_id, message_id);
      } catch (e) {
        // message may already be deleted or not found
      }

      await dbRunAsync(
        `UPDATE pending_delete_messages SET deleted = 1 WHERE id = ?`,
        [id]
      );
    }
  } catch (err) {
    logger.error("Auto-delete worker error: " + err.message);
  }
});
// 📡 Express Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 📂 Load Modules

const { createssh } = require('./modules/createSSH');
const { createvmess } = require('./modules/createVMESS');
const { createvless } = require('./modules/createVLESS');
const { createtrojan } = require('./modules/createTROJAN');
const { createshadowsocks } = require('./modules/createSHADOWSOCKS');

const { renewssh } = require('./modules/renewSSH');
const { renewvmess } = require('./modules/renewVMESS');
const { renewvless } = require('./modules/renewVLESS');
const { renewtrojan } = require('./modules/renewTROJAN');
const { renewshadowsocks } = require('./modules/renewSHADOWSOCKS');

// 🗄️ SQLite Init
let db = new sqlite3.Database('./sellvpn.db', (err) => {
  if (err) {
    logger.error('Kesalahan koneksi SQLite3:', err.message);
  } else {
    logger.info('Terhubung ke SQLite3');
  }
});
// ... (Promisify db methods) ...
// SQLite tuning (WAJIB untuk transaksi atomic)
db.run('PRAGMA journal_mode = WAL;');
db.run('PRAGMA synchronous = NORMAL;');
db.run('PRAGMA busy_timeout = 5000;');

// ⚙️ Inisialisasi Tabel Worker Auto-Delete (Penting!)
// Tabel ini diperlukan oleh cron job agar tidak error "no such table"
db.run(`
  CREATE TABLE IF NOT EXISTS pending_delete_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    delete_at INTEGER NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT 0
  )
`, (err) => {
    if (err) logger.error("Gagal membuat tabel pending_delete_messages:", err.message);
    else logger.info("✅ Tabel pending_delete_messages siap.");
});

// Promisify db methods
const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

(async () => {
  try {
    await dbRunAsync(`
      CREATE TABLE IF NOT EXISTS reseller_upgrade_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        amount INTEGER,
        level TEXT,
        created_at TEXT
      )
    `);
    console.log('✅ Tabel reseller_upgrade_log siap digunakan.');
  } catch (error) {
    console.error('❌ Gagal membuat tabel reseller_upgrade_log:', error.message);
  }
})();

// 🔄 Cache status sistem (biar gak query terus)
const cacheStatus = {
  jumlahServer: 0,
  jumlahPengguna: 0,
  lastUpdated: 0  // timestamp dalam ms
};

///Coba markdown
const escapeMarkdownV2 = (text) => {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
};
// --- TABEL BARU UNTUK PAKASIR ---
db.run(`CREATE TABLE IF NOT EXISTS pending_deposits_pakasir (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, order_id TEXT UNIQUE, amount INTEGER, status TEXT DEFAULT 'pending',
  payment_method TEXT, payment_data TEXT, expired_at TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`, (err) => { if (err) { logger.error('Kesalahan membuat tabel pending_deposits_pakasir:', err.message); } });

//testerr
db.run(`ALTER TABLE users ADD COLUMN username TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    logger.error('❌ Gagal menambahkan kolom username:', err.message);
  } else {
    logger.info('✅ Kolom username ditambahkan ke tabel users');
  }
});
//bawaan
db.serialize(() => {
  // Tabel Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    saldo INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    reseller_level TEXT DEFAULT 'silver',
    has_trial INTEGER DEFAULT 0,
    username TEXT,
    first_name TEXT
  )`);

  // Tabel Reseller Sales
  db.run(`CREATE TABLE IF NOT EXISTS reseller_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER,
    buyer_id INTEGER,
    akun_type TEXT,
    username TEXT,
    komisi INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Akun Aktif
  db.run(`CREATE TABLE IF NOT EXISTS akun_aktif (
    username TEXT PRIMARY KEY,
    jenis TEXT
  )`);

  // Tabel Invoice Log
  db.run(`CREATE TABLE IF NOT EXISTS invoice_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    layanan TEXT,
    akun TEXT,
    hari INTEGER,
    harga INTEGER,
    komisi INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Pending Deposit
  db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
    unique_code TEXT PRIMARY KEY,
    user_id INTEGER,
    amount INTEGER,
    original_amount INTEGER,
    timestamp INTEGER,
    status TEXT,
    qr_message_id INTEGER
  )`);

  // Tabel Trial Logs
  db.run(`CREATE TABLE IF NOT EXISTS trial_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    jenis TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Server
  db.run(`CREATE TABLE IF NOT EXISTS Server (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT,
    auth TEXT,
    harga INTEGER,
    nama_server TEXT,
    quota INTEGER,
    iplimit INTEGER,
    batas_create_akun INTEGER,
    total_create_akun INTEGER DEFAULT 0
  )`);

  // Tabel Transaksi
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  type TEXT,
  reference_id TEXT,
  timestamp INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel transactions:', err.message);
  } else {
    logger.info('Transactions table created or already exists');
    
    // Add reference_id column if it doesn't exist
    db.get("PRAGMA table_info(transactions)", (err, rows) => {
      if (err) {
        logger.error('Kesalahan memeriksa struktur tabel:', err.message);
        return;
      }
      
      db.get("SELECT * FROM transactions WHERE reference_id IS NULL LIMIT 1", (err, row) => {
        if (err && err.message.includes('no such column')) {
          // Column doesn't exist, add it
          db.run("ALTER TABLE transactions ADD COLUMN reference_id TEXT", (err) => {
            if (err) {
              logger.error('Kesalahan menambahkan kolom reference_id:', err.message);
            } else {
              logger.info('Kolom reference_id berhasil ditambahkan ke tabel transactions');
            }
          });
        } else if (row) {
          // Update existing transactions with reference_id
          db.all("SELECT id, user_id, type, timestamp FROM transactions WHERE reference_id IS NULL", [], (err, rows) => {
            if (err) {
              logger.error('Kesalahan mengambil transaksi tanpa reference_id:', err.message);
              return;
            }
            
            rows.forEach(row => {
              const referenceId = `account-${row.type}-${row.user_id}-${row.timestamp}`;
              db.run("UPDATE transactions SET reference_id = ? WHERE id = ?", [referenceId, row.id], (err) => {
                if (err) {
                  logger.error(`Kesalahan mengupdate reference_id untuk transaksi ${row.id}:`, err.message);
                } else {
                  logger.info(`Berhasil mengupdate reference_id untuk transaksi ${row.id}`);
                }
              });
            });
          });
        }
      });
    });
  }
});

  // Tabel Transfer Saldo
  db.run(`CREATE TABLE IF NOT EXISTS saldo_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    amount INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Log Transfer (alternatif historis)
  db.run(`CREATE TABLE IF NOT EXISTS transfer_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    jumlah INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Pastikan blok kode ini diletakkan di bagian inisialisasi/setup database
// (Di mana Anda menjalankan perintah CREATE TABLE lainnya)

db.run(`
  CREATE TABLE IF NOT EXISTS topup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    amount INTEGER,
    reference TEXT,
    created_at TEXT
  )
`, (err) => {
  if (err) {
    // Gunakan logger.error jika Anda punya library logging seperti winston/pino
    console.error('❌ Gagal membuat tabel topup_log:', err.message);
  } else {
    // Gunakan logger.info jika Anda punya library logging
    console.log('✅ Tabel topup_log siap digunakan.'); 
  }
});


db.run(`ALTER TABLE Server ADD COLUMN isp TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    logger.error('❌ Gagal tambah kolom isp:', err.message);
  }
});
db.run(`ALTER TABLE Server ADD COLUMN lokasi TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    logger.error('❌ Gagal tambah kolom lokasi:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS akun (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  jenis TEXT,
  username TEXT,
  server_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`ALTER TABLE users ADD COLUMN last_trial_date TEXT`, () => {});
db.run(`ALTER TABLE users ADD COLUMN trial_count_today INTEGER DEFAULT 0`, () => {});

//bonus
db.run(`CREATE TABLE IF NOT EXISTS weekly_bonus_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed_date TEXT NOT NULL,
  claimed_at DATETIME DEFAULT (datetime('now')),
  reference TEXT,
  UNIQUE(user_id, claimed_date)
)` , (err) => {
  if (err) console.error('ERR init weekly_bonus_claims table:', err);
  else console.log('weekly_bonus_claims table ready');
});

db.run(`CREATE TABLE IF NOT EXISTS pending_delete_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  message_id INTEGER,
  delete_at INTEGER,   -- timestamp in ms
  deleted INTEGER DEFAULT 0
)`);

const userState = {};
global.adminState = {}; // Untuk menyimpan context step admin
logger.info('User state initialized');


// Helper untuk tambah kolom jika belum ada
function addColumn(table, column, definition) {
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error(`❌ Gagal tambah kolom ${column} di ${table}:`, err.message);
    } else {
      console.log(`✅ Kolom ${column} di ${table} siap digunakan (atau sudah ada)`);
    }
  });
}

// === Tabel transactions ===
addColumn('transactions', 'amount', 'INTEGER');
addColumn('transactions', 'reference_id', 'TEXT');
addColumn('transactions', 'username', 'TEXT');
addColumn('transactions', 'timestamp', 'INTEGER');

// === Tabel users ===
addColumn('users', 'username', 'TEXT');
addColumn('users', 'first_name', 'TEXT');
addColumn('users', 'last_trial_date', 'TEXT');
addColumn('users', 'trial_count_today', 'INTEGER DEFAULT 0');

// === Tabel Server ===
addColumn('Server', 'isp', 'TEXT');
addColumn('Server', 'lokasi', 'TEXT');

// === Tabel topup_log ===
addColumn('topup_log', 'reference', 'TEXT');

// === Tabel saldo_transfers ===
addColumn('saldo_transfers', 'amount', 'INTEGER');

// === Tabel transfer_log ===
addColumn('transfer_log', 'jumlah', 'INTEGER');

// === Tabel reseller_upgrade_log ===
addColumn('reseller_upgrade_log', 'amount', 'INTEGER');
addColumn('reseller_upgrade_log', 'level', 'TEXT');
addColumn('reseller_upgrade_log', 'created_at', 'TEXT');

console.log("🔄 Migrasi selesai, cek console untuk kolom yang berhasil ditambahkan");

// ---------- Helper: runScript ----------
async function isExecutable(path) {
  try {
    const st = await fs.stat(path);
    return Boolean(st.mode & 0o111);
  } catch (e) {
    return false;
  }
}

function runScriptCmd(cmd, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${err.message}${stderr ? '\nSTDERR: ' + stderr : ''}`;
        return reject(new Error(msg));
      }
      resolve(stdout || '');
    });
  });
}

/**
 * runScript(scriptBasePath, args[])
 * - scriptBasePath: './scripts/trialvmess.sh' (base expected)
 * - tries these candidates in order:
 *   1) exact path if executable -> run directly
 *   2) path + '.x' if executable -> run directly
 *   3) fallback: bash path (for plain-text scripts)
 */
async function runScript(scriptBasePath, args = [], opts = {}) {
  const candidates = [
    scriptBasePath,
    `${scriptBasePath}.x`
  ];

  // try candidates that are executable
  for (const p of candidates) {
    if (await isExecutable(p)) {
      // escape args safely by JSON.stringify (adds quotes)
      const safeArgs = args.map(a => (typeof a === 'string' ? JSON.stringify(a) : String(a))).join(' ');
      const cmd = `${p} ${safeArgs}`;
      return runScriptCmd(cmd, opts);
    }
  }

  // fallback: try to execute with bash (plain text)
  try {
    const safeArgs = args.map(a => (typeof a === 'string' ? JSON.stringify(a) : String(a))).join(' ');
    const cmd = `bash ${scriptBasePath} ${safeArgs}`;
    return await runScriptCmd(cmd, opts);
  } catch (e) {
    // if fallback failed, throw original error for handler to catch
    throw new Error(`Failed to run script (tried executables + bash): ${e.message}`);
  }
}

// Fungsi untuk escape karakter Markdown Telegram
function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(//g, '\')
    .replace(//g, '\')
    .replace(//g, '\')
    .replace(//g, '\')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}
// Fungsi bantu parsing output JSON dari shell
function parseJsonOutput(raw) {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(raw.substring(start, end + 1));
    }
    throw new Error('Output tidak mengandung JSON');
  } catch (e) {
    throw new Error('Gagal parsing JSON: ' + e.message);
  }
}

// Fungsi bantu kirim pesan dengan penanganan error
async function safeSend(bot, chatId, message, extra = {}) {
  try {
    await bot.telegram.sendMessage(chatId, message, extra);
  } catch (err) {
    console.warn(`⚠️ Gagal kirim ke ${chatId}: ${err.message}`);
  }
}

function cleanupOrphanResellers() {
  db.all(`
    SELECT DISTINCT reseller_id FROM reseller_sales
    WHERE reseller_id NOT IN (SELECT user_id FROM users)
  `, (err, rows) => {
    if (err) return console.error("❌ Gagal cek reseller yatim:", err.message);

    if (rows.length === 0) {
      console.log("✅ Tidak ada reseller yatim.");
      return;
    }

    const orphanIds = rows.map(row => row.reseller_id);
    console.log("⚠️ Reseller yatim ditemukan:", orphanIds);

    const placeholders = orphanIds.map(() => '?').join(',');
    db.run(`
      DELETE FROM reseller_sales WHERE reseller_id IN (${placeholders})
    `, orphanIds, function (err) {
      if (err) return console.error("❌ Gagal hapus reseller yatim:", err.message);
      console.log(`✅ ${this.changes} baris reseller_sales berhasil dibersihkan.`);
    });
  });
}

// Fungsi helper promisify db.all
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
// ---------------- TRIAL HELPERS ----------------

// tanggal versi ISO
async function getTodayIso() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// cek boleh/tidak
async function canTakeTrial(userId) {
  const user = await dbGetAsync(
    'SELECT role, last_trial_date, trial_count_today FROM users WHERE user_id = ?',
    [userId]
  );

  const role = user?.role || 'user';
  const maxTrial = role === 'reseller' ? 10 : role === 'admin' ? Infinity : 1;

  const last = user?.last_trial_date || null;
  let diffDays = Infinity;

  if (last) {
    const lastDate = new Date(`${last}T00:00:00Z`);
    const now = new Date();
    diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
  }

  const trialCount = diffDays >= 2 ? 0 : (user?.trial_count_today || 0);
  const allowed = trialCount < maxTrial;

  return { allowed, trialCount, maxTrial, role, last };
}

// claim atomic
async function claimTrialAtomic(userId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', async (err) => {
        if (err) return reject(err);

        db.get(
          'SELECT role, last_trial_date, trial_count_today FROM users WHERE user_id = ?',
          [userId],
          async (err, user) => {
            if (err) {
              db.run('ROLLBACK');
              return reject(err);
            }

            const role = user?.role || 'user';
            const maxTrial =
              role === 'reseller' ? 10 : role === 'admin' ? Infinity : 1;

            const last = user?.last_trial_date || null;
            let diffDays = Infinity;
            if (last) {
              diffDays = Math.floor(
                (new Date() - new Date(`${last}T00:00:00Z`)) /
                  (1000 * 60 * 60 * 24)
              );
            }

            let trialCount = diffDays >= 2 ? 0 : user?.trial_count_today || 0;
            if (trialCount >= maxTrial) {
              db.run('ROLLBACK');
              return resolve({ ok: false });
            }

            const today = await getTodayIso();
            const newCount = trialCount + 1;

            db.run(
              'UPDATE users SET trial_count_today = ?, last_trial_date = ? WHERE user_id = ?',
              [newCount, today, userId],
              (err2) => {
                if (err2) {
                  db.run('ROLLBACK');
                  return reject(err2);
                }

                db.run(
                  'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
                  [userId, null, 'auto'],
                  () => {
                    db.run('COMMIT', () => resolve({ ok: true, trialKe: newCount }));
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

async function getUserDetails(userId) {
  try {
    const row = await dbGetAsync(
      'SELECT saldo, role, reseller_level FROM users WHERE user_id = ?',
      [userId]
    );
    return row || { saldo: 0, role: 'user', reseller_level: 'silver' };
  } catch (e) {
    logger.error('getUserDetails error: ' + e.message);
    return { saldo: 0, role: 'user', reseller_level: 'silver' };
  }
}

async function addPendingDelete(chatId, messageId, deleteAt) {
  await dbRunAsync(
    `INSERT INTO pending_delete_messages (chat_id, message_id, delete_at, deleted)
     VALUES (?, ?, ?, 0)`,
    [chatId, messageId, deleteAt]
  );
}

// Pasang endpoint webhook di Express
app.post('/webhook/pakasir', (req, res) => {
    const payload = req.body;
    logger.info(`Webhook received. Payload: ${JSON.stringify(payload)}`);

    if (payload && payload.order_id && payload.amount && payload.status) {
        handlePakasirWebhook(payload, bot);
        res.json({ received: true });
    } else {
        res.status(400).json({ error: 'Invalid webhook payload structure.' });
    }
});

// Endpoint dummy untuk redirect sukses
app.get('/topup-success', (req, res) => {
    res.send('Pembayaran Anda sedang diverifikasi. Silakan kembali ke Telegram bot untuk melihat saldo.');
});
// Panggil saat startup
cleanupOrphanResellers();

// =========================================
// ✅ 4. COMMAND /start dan /menu
// =========================================
// --- REQUIRE JOIN GROUP BEFORE MENU (pakai GROUP_ID yang sudah ada) ---
const REQUIRED_CHANNEL = GROUP_ID || null;

// normalize channel identifier (strip https://t.me/ jika ada)
function normalizeChannelId(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^https?:\/\/t\.me\//i, '');
  return s;
}

// Action handler untuk tombol "Sudah Gabung"
bot.action('check_join_channel', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const channel = normalizeChannelId(REQUIRED_CHANNEL);
    if (!channel) {
      await ctx.answerCbQuery('⚠️ Group belum dikonfigurasi. Hubungi admin.', { show_alert: true });
      return;
    }

    let member;
    try {
      member = await bot.telegram.getChatMember(channel, userId);
    } catch (err) {
      logger.warn('getChatMember error (check_join_channel): ' + (err.message || err));
      await ctx.answerCbQuery('⚠️ Gagal cek keanggotaan. Coba lagi nanti.', { show_alert: true });
      return;
    }

    const status = (member && member.status) ? member.status : 'left';
    if (['creator','administrator','member','restricted'].includes(status)) {
      await ctx.answerCbQuery('✅ Terima kasih, verifikasi berhasil!');
      return sendMainMenu(ctx);
    } else {
      await ctx.answerCbQuery('🚫 Kamu belum bergabung di group kami.', { show_alert: true });
    }
  } catch (err) {
    logger.error('Error pada action check_join_channel: ' + (err.message || err));
  }
});

// Override /start dan /menu untuk mewajibkan join GROUP_ID
bot.command(['start', 'menu'], async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';

  try {
    await dbRunAsync(`
      INSERT INTO users (user_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = ?, first_name = ?
    `, [userId, username, firstName, username, firstName]);
  } catch (err) {
    logger.warn('Failed to insert/update user on start/menu: ' + (err.message || err));
  }

  // Jika GROUP_ID belum dikonfigurasi, langsung tampilkan menu
  if (!REQUIRED_CHANNEL) {
    return sendMainMenu(ctx);
  }

  const channelIdOrUsername = normalizeChannelId(REQUIRED_CHANNEL);
  try {
    const member = await bot.telegram.getChatMember(channelIdOrUsername, userId);
    const status = (member && member.status) ? member.status : 'left';
    if (['creator','administrator','member','restricted'].includes(status)) {
      return sendMainMenu(ctx);
    } else {
      const joinUrl = channelIdOrUsername.startsWith('@') ? `https://t.me/${channelIdOrUsername.replace(/^@/, '')}` : (isNaN(channelIdOrUsername) ? `https://t.me/${channelIdOrUsername}` : null);
      const keyboard = [
        [
          joinUrl ? { text: '🔗 Gabung Group', url: joinUrl } : { text: '🔎 Buka Group', callback_data: 'open_channel_info' },
          { text: '✅ Sudah Gabung', callback_data: 'check_join_channel' }
        ]
      ];
      const textMsg = `🔐 *Akses Terbatas*\n\nSebelum menggunakan bot, silakan bergabung dulu ke group kami.\n\nSetelah bergabung tekan tombol *Sudah Gabung*.`;
      return ctx.reply(textMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }
  } catch (error) {
    logger.warn('getChatMember error on start/menu: ' + (error.message || error));
    try {
      await ctx.reply('⚠️ Verifikasi group gagal. Pastikan bot sudah ditambahkan ke group dan konfigurasi GROUP_ID benar. Hubungi admin jika perlu.');
    } catch (e) {}
  }
});
// Command Admin
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  logger.info(`🔐 Permintaan akses admin dari ${userId}`);

  if (!adminIds.includes(String(userId))) {
    return ctx.reply('?? Anda tidak memiliki izin untuk mengakses menu admin.');
  }

  await sendAdminMenu(ctx);
});

bot.command('helpadmin', async (ctx) => {
  const userId = ctx.message.from.id;

  // Pastikan userId di-casting ke string jika adminIds berupa string[]
  if (!adminIds.includes(String(userId))) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const helpMessage = `
*📋 Daftar Perintah Admin:*

1. /addserver - Menambahkan server baru.
2. /addsaldo - Menambahkan saldo ke akun pengguna.
3. /editharga - Mengedit harga layanan.
4. /editnama - Mengedit nama server.
5. /editdomain - Mengedit domain server.
6. /editauth - Mengedit auth server.
7. /editlimitquota - Mengedit batas quota server.
8. /editlimitip - Mengedit batas IP server.
9. /editlimitcreate - Mengedit batas pembuatan akun server.
10. /edittotalcreate - Mengedit total pembuatan akun server.
11. /broadcast - Mengirim pesan siaran ke semua pengguna.
12. /hapuslog - Menghapus log bot.

Gunakan perintah ini dengan format yang benar untuk menghindari kesalahan.
`.trim();

  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

bot.command('broadcast', async (ctx) => {
  const userId = String(ctx.from.id);

  // Validasi admin
  if (!adminIds.includes(userId)) {
    logger.info(`❌ User ${userId} bukan admin, tidak diizinkan broadcast.`);
    return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan broadcast.');
  }

  // Ambil isi pesan broadcast dari reply atau dari teks setelah /broadcast
  const message = ctx.message.reply_to_message
    ? ctx.message.reply_to_message.text
    : ctx.message.text.split(' ').slice(1).join(' ');

  if (!message || message.trim() === '') {
    return ctx.reply('⚠️ Mohon balas pesan yang ingin disiarkan, atau tulis setelah perintah `/broadcast`.', {
      parse_mode: 'Markdown'
    });
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all("SELECT user_id FROM users", [], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    const results = await Promise.allSettled(rows.map(row => 
      ctx.telegram.sendMessage(row.user_id, message).catch(err => {
        logger.warn(`⚠️ Gagal kirim ke ${row.user_id}: ${err.message}`);
      })
    ));

    const sukses = results.filter(r => r.status === 'fulfilled').length;
    const gagal = results.length - sukses;

    await ctx.reply(`✅ Broadcast selesai.\n📤 Berhasil: ${sukses}\n❌ Gagal: ${gagal}`);
    logger.info(`📣 Broadcast selesai: ${sukses} sukses, ${gagal} gagal`);

  } catch (err) {
    logger.error('❌ Gagal melakukan broadcast:', err.message);
    return ctx.reply('⚠️ Terjadi kesalahan saat broadcast.');
  }
});
bot.command('saldo', (ctx) => {
  const state = userState[ctx.chat.id] || {}; // ⬅️ ini bikin gak error walau kosong
  const userId = ctx.from.id;

  db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      logger.error('❌ Gagal mengambil saldo:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil saldo.');
    }

    if (!row) {
      return ctx.reply('⚠️ Akun tidak ditemukan.');
    }

    return ctx.reply(`💰 *Saldo Anda:* \`${row.saldo}\``, { parse_mode: 'Markdown' });
  });
});

bot.command('addserver', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 7) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/addserver <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_account>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth, harga, nama_server, quota, iplimit, batas_create_akun] = args.slice(1);

  const numberOnlyRegex = /^\d+$/;
  if (!numberOnlyRegex.test(harga) || !numberOnlyRegex.test(quota) || !numberOnlyRegex.test(iplimit) || !numberOnlyRegex.test(batas_create_akun)) {
      return ctx.reply('⚠️ `harga`, `quota`, `iplimit`, dan `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun) VALUES (?, ?, ?, ?, ?, ?, ?)", 
      [domain, auth, parseInt(harga), nama_server, parseInt(quota), parseInt(iplimit), parseInt(batas_create_akun)], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Server \`${nama_server}\` berhasil ditambahkan.`, { parse_mode: 'Markdown' });
  });
});
bot.command('editharga', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editharga <domain> <harga>`', { parse_mode: 'Markdown' });
  }

  const [domain, harga] = args.slice(1);

  if (!/^\d+$/.test(harga)) {
      return ctx.reply('⚠️ `harga` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET harga = ? WHERE domain = ?", [parseInt(harga), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit harga server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit harga server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Harga server \`${domain}\` berhasil diubah menjadi \`${harga}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editnama', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editnama <domain> <nama_server>`', { parse_mode: 'Markdown' });
  }

  const [domain, nama_server] = args.slice(1);

  db.run("UPDATE Server SET nama_server = ? WHERE domain = ?", [nama_server, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit nama server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit nama server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Nama server \`${domain}\` berhasil diubah menjadi \`${nama_server}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editdomain', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editdomain <old_domain> <new_domain>`', { parse_mode: 'Markdown' });
  }

  const [old_domain, new_domain] = args.slice(1);

  db.run("UPDATE Server SET domain = ? WHERE domain = ?", [new_domain, old_domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit domain server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit domain server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Domain server \`${old_domain}\` berhasil diubah menjadi \`${new_domain}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editauth', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editauth <domain> <auth>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth] = args.slice(1);

  db.run("UPDATE Server SET auth = ? WHERE domain = ?", [auth, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit auth server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit auth server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Auth server \`${domain}\` berhasil diubah menjadi \`${auth}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitquota', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitquota <domain> <quota>`', { parse_mode: 'Markdown' });
  }

  const [domain, quota] = args.slice(1);

  if (!/^\d+$/.test(quota)) {
      return ctx.reply('⚠️ `quota` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET quota = ? WHERE domain = ?", [parseInt(quota), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit quota server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit quota server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Quota server \`${domain}\` berhasil diubah menjadi \`${quota}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitip', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitip <domain> <iplimit>`', { parse_mode: 'Markdown' });
  }

  const [domain, iplimit] = args.slice(1);

  if (!/^\d+$/.test(iplimit)) {
      return ctx.reply('⚠️ `iplimit` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET iplimit = ? WHERE domain = ?", [parseInt(iplimit), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit iplimit server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit iplimit server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Iplimit server \`${domain}\` berhasil diubah menjadi \`${iplimit}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitcreate <domain> <batas_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, batas_create_akun] = args.slice(1);

  if (!/^\d+$/.test(batas_create_akun)) {
      return ctx.reply('⚠️ `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET batas_create_akun = ? WHERE domain = ?", [parseInt(batas_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit batas_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit batas_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Batas create akun server \`${domain}\` berhasil diubah menjadi \`${batas_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});


bot.command('edittotalcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/edittotalcreate <domain> <total_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, total_create_akun] = args.slice(1);

  if (!/^\d+$/.test(total_create_akun)) {
      return ctx.reply('⚠️ `total_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET total_create_akun = ? WHERE domain = ?", [parseInt(total_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit total_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit total_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Total create akun server \`${domain}\` berhasil diubah menjadi \`${total_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});

// =========================================================================
// Bagian 2: Handler yang menerima dokumen dan melakukan eksekusi restore
// Ini adalah bagian KRITIS yang dijamin aman dari file lock
// =========================================================================
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    // 1. Cek State dan Izin
    if (!adminIds.includes(String(userId)) || userState[chatId]?.step !== 'await_restore_upload') {
        return; // Abaikan jika bukan admin atau state salah
    }

    const doc = ctx.message.document;

    // Filter dokumen: Hanya proses file .db
    if (!doc.file_name || !doc.file_name.endsWith('.db')) {
        // Reset state jika file salah dikirim
        delete userState[chatId]; 
        return ctx.reply('❌ Dokumen yang diunggah harus file database (.db). Proses dibatalkan.');
    }

    // Filter ukuran file (misalnya, batas 50MB)
    if (doc.file_size > 50 * 1024 * 1024) { 
        delete userState[chatId];
        return ctx.reply('❌ File terlalu besar untuk restore. Proses dibatalkan.');
    }

    // Reset state agar bot tidak terjebak dalam loop
    delete userState[chatId];

    try {
        await ctx.reply('⏳ Menerima dan memproses file backup. Ini mungkin membutuhkan waktu beberapa detik...');

        // 2. Dapatkan link download file
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const fileName = `restore_${Date.now()}.db`;
        // Pastikan Anda menggunakan UPLOAD_DIR yang benar, yang diizinkan untuk ditulis
        const tempFilePath = path.join(UPLOAD_DIR, fileName); 

        // 3. Download file dari Telegram
        const downloadResponse = await axios.get(fileLink.href, { responseType: 'stream' });
        const writer = fs.createWriteStream(tempFilePath);
        downloadResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // ----------------------------------------------------
        // 🔒 START CRITICAL SECTION: MENGATASI FILE LOCK (WAL MODE)
        // ----------------------------------------------------

        // 4. KELUAR DARI WAL MODE (Membersihkan file -wal dan -shm)
        if (db && typeof db.run === 'function') {
            await new Promise((resolve) => {
                // Perintah ini memaksa SQLite melepaskan file lock.
                db.run('PRAGMA journal_mode = DELETE;', (err) => {
                    if (err) logger.warn('⚠️ Gagal ubah ke DELETE mode sebelum close:', err.message);
                    resolve();
                });
            });
        }

        // 5. TUTUP KONEKSI UTAMA (Melepaskan lock pada sellvpn.db)
        if (db && typeof db.close === 'function') {
            await new Promise((resolve) => {
                db.close((err) => {
                    if (err) logger.warn('⚠️ Gagal menutup koneksi DB utama:', err.message);
                    resolve(); // Selalu resolve agar operasi file copy bisa jalan
                });
            });
        }

        // 6. TINDAKAN KRITIS: COPY/TIMPA FILE
        fs.copyFileSync(tempFilePath, DB_PATH);
        logger.info(`File ${DB_PATH} berhasil ditimpa dengan backup baru dari Telegram.`);

        // 7. HAPUS SISA FILE WAL (Optional, untuk memastikan bersih)
        try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
        try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}

        // 8. BUKA KEMBALI KONEKSI (Menggunakan data database yang baru)
        db = new sqlite3.Database(DB_PATH); 
        
        // 9. AKTIFKAN KEMBALI WAL MODE UNTUK KINERJA
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA synchronous = NORMAL;');
        db.run('PRAGMA busy_timeout = 5000;');
        logger.info('Koneksi database berhasil dibuka kembali dan WAL mode diaktifkan.');
        
        // ----------------------------------------------------
        // 🔓 END CRITICAL SECTION
        // ----------------------------------------------------

        await ctx.reply('🎉 **Restore Database Berhasil!**\n\nDatabase bot telah diperbarui dan bot kembali beroperasi normal.');

    } catch (err) {
        logger.error('❌ Error fatal saat proses restore DB:', err);
        
        // PENTING: Jika gagal, setidaknya koneksi harus dibuka kembali
        if (!db || typeof db.close !== 'function') {
             // Coba buat koneksi baru ke DB_PATH yang ada
             db = new sqlite3.Database(DB_PATH); 
        }

        await ctx.reply(`❌ Gagal melakukan restore database:\n\`${err.message}\`\n\n*Disarankan mematikan bot lalu restore manual.*`);
    }
});
// Fungsi updateGlobalStats
async function updateGlobalStats() {
  try {
    const resellerCount = await dbGetAsync('SELECT COUNT(*) AS count FROM users WHERE role = "reseller"');
    const totalAkun = await dbGetAsync('SELECT COUNT(*) AS count FROM akun');
    const totalServers = await dbGetAsync('SELECT COUNT(*) AS count FROM Server WHERE total_create_akun > 0');

    // Buat tabel jika belum ada (opsional, sekali saja)
    await dbRunAsync(`
      CREATE TABLE IF NOT EXISTS global_stats (
        id INTEGER PRIMARY KEY,
        reseller_count INTEGER DEFAULT 0,
        total_akun INTEGER DEFAULT 0,
        total_servers INTEGER DEFAULT 0
      )
    `);

    // Insert pertama jika kosong
    await dbRunAsync(`INSERT OR IGNORE INTO global_stats (id) VALUES (1)`);

    // Update isinya
    await dbRunAsync(`
      UPDATE global_stats
      SET reseller_count = ?, total_akun = ?, total_servers = ?
      WHERE id = 1
    `, [resellerCount.count, totalAkun.count, totalServers.count]);

    console.log('✅ Statistik global diperbarui');
  } catch (err) {
    console.error('❌ Gagal update statistik global:', err.message);
  }
}

///waktuuu
async function refreshCacheIfNeeded() {
  const now = Date.now();
  const delay = 60 * 1000; // 1 menit

  if (now - cacheStatus.lastUpdated < delay) return;

  try {
    const serverCount = await dbGetAsync('SELECT COUNT(*) AS count FROM Server');
    const userCount = await dbGetAsync('SELECT COUNT(*) AS count FROM users');

    cacheStatus.jumlahServer = serverCount?.count || 0;
    cacheStatus.jumlahPengguna = userCount?.count || 0;
    cacheStatus.lastUpdated = now;
    logger.info('✅ Cache status diperbarui otomatis');
  } catch (err) {
    logger.warn('⚠️ Gagal refresh cache status:', err.message);
  }
}

// 🔰 Kirim Menu Utama (HTML Version + Block Quote "<blockquote>")
// Helper function untuk escape karakter HTML
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  // Nama user: jika tidak ada first_name, pakai 'Partner'
  const firstName = ctx.from.first_name ? escapeHtml(ctx.from.first_name) : 'Partner'; 
  const ADMIN_USERNAME = global.vars?.ADMIN_USERNAME || '@joyhayabuse'; // Variabel yang Anda minta ditambahkan di bawah ini
  
  await refreshCacheIfNeeded();

  let saldo = 0, role = '', reseller_level = '', totalAkunDibuat = 0;
  let totalUserBot = 0; // Variabel baru untuk menampung total pengguna

  try {
    // 1. Ambil data total transaksi user
    const akunData = await dbGetAsync('SELECT COUNT(*) AS total FROM invoice_log WHERE user_id = ?', [userId]);
    totalAkunDibuat = akunData?.total || 0;

    // 2. Ambil data detail user
    const user = await dbGetAsync('SELECT saldo, role, reseller_level FROM users WHERE user_id = ?', [userId]);
    saldo = user?.saldo || 0;
    role = user?.role || 'user';
    reseller_level = user?.reseller_level || 'silver';

    // 3. Ambil total pengguna bot (PENAMBAHAN BARU)
    const totalUserData = await dbGetAsync('SELECT COUNT(*) AS total FROM users');
    totalUserBot = totalUserData?.total || 0; 

    // (Bagian Top Reseller sudah DIHAPUS sesuai request)

  } catch (err) {
    logger.error(`❌ Gagal ambil data user/statistik: ${err.message}`); // Menyesuaikan pesan error
  }

  // Format Role Label dengan Icon
  const roleLabel = role === 'admin'
    ? '👑 Administrator'
    : role === 'reseller'
      ? `Reseller (${reseller_level.toUpperCase()})`
      : 'Member';

  // Susun Keyboard
  const keyboard = [];

  if (role === 'reseller') {
    keyboard.push([{ text: '⚙️ Menu Reseller', callback_data: 'menu_reseller' }]);
  }

  // Asumsi adminIds tersedia di scope global/module
  if (role === 'admin' || adminIds.includes(String(userId))) {
    keyboard.push([{ text: '🛠 Menu Admin', callback_data: 'menu_adminreseller' }]);
  }

  keyboard.push([
    { text: '🛍 Buat Akun', callback_data: 'service_create' },
    { text: '⌛ Trial Akun', callback_data: 'service_trial' }
  ]);
  keyboard.push([
    { text: '♻️ Perpanjang', callback_data: 'service_renew' },
    { text: '💰 TopUp Saldo', callback_data: 'topup_saldo' }    
  ]);
  
  // Tombol upgrade (hanya utk user biasa)
  if (role !== 'admin' && role !== 'reseller') {
     keyboard.push([{ text: '🚀 Upgrade ke Reseller', callback_data: 'upgrade_to_reseller' }]);
  }

  // --- FORMAT TAMPILAN HTML ---
  const namaStore = escapeHtml(NAMA_STORE || 'PREMIUM STORE'); // Asumsi NAMA_STORE tersedia
  const saldoFormatted = saldo.toLocaleString('id-ID');
  const lastUpdate = new Date(cacheStatus.lastUpdated).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); // Asumsi cacheStatus tersedia

  // Copywriting baru yang lebih bersih & profesional
  const text = `
<b>⚡ WELCOME TO ${escapeHTML(NAMA_STORE)} STORE ⚡</b>
<blockquote><i>🔹 Sistem otomatis & real-time</i>   
<i>🔹 Pembelian layanan VPN premium</i>  
<i>🔹 Akses internet cepat, stabil & aman</i></blockquote> 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>👤 INFORMASI PENGGUNA</b>
<blockquote>┌🏅 <b>Status</b> : <code>${escapeHTML(roleLabel)}</code>
├💳 <b>Saldo Anda</b>  : <code>Rp${saldoFormatted}</code>
├🆔 <b>User ID</b> : <code>${userId}</code>
├📦 <b>Transaksi</b> : <code>${totalAkunDibuat} Sukses</code>
└🫂 <b>Total Pengguna</b> : <code>${totalUserBot} User</code></blockquote>
<b>🎁 BONUS JUMAT</b>
<blockquote>Dapatkan bonus saldo otomatis setiap hari Jumat  
setelah melakukan top up sesuai minimum nominal.</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📞 Bantuan & Dukungan</b>
<blockquote><b>Hubungi Admin:</b> ${escapeHTML(ADMIN_USERNAME)}</blockquote>
`.trim();

  try {
    const options = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    };

    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery();
      try {
        await ctx.editMessageText(text, options);
      } catch (e) {
         // Abaikan error jika pesan tidak berubah
         if (!e.description.includes('message is not modified')) throw e;
      }
    } else {
      await ctx.reply(text, options);
    }
    logger.info(`✅ Menu utama dikirim ke ${userId}`);
  } catch (err) {
    logger.error(`❌ Gagal kirim menu utama: ${err.message}`);
    await ctx.reply('❌ Gagal menampilkan menu utama.');
  }
}

// 🔁 Handle Layanan: create / renew / trial
async function handleServiceAction(ctx, action) {
  const { keyboard, pesan } = generateServiceMenu(action);

  try {
    await ctx.editMessageText(pesan, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    // fallback: kirim pesan baru jika edit gagal (mis. karena waktu habis)
    try {
      await ctx.reply(pesan, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      logger.error('❌ Failed to send service menu:', err?.message || err);
    }
  }
}

// ------- generateServiceMenu (single, cleaned) -------
function generateServiceMenu(action) {
  let keyboard = [], teks = '';

  if (action === 'create') {
    teks = `<b>🚀 Pembuatan Akun VPN Premium</b>
<i>Kinerja tinggi, stabilitas maksimal, dan perlindungan optimal.</i>

Setiap akun dibuat melalui sistem otomatis untuk memastikan kecepatan proses 
dan keamanan data Anda. Setelah akun berhasil dibuat, layanan langsung aktif 
dan siap digunakan tanpa memerlukan pengaturan tambahan.

Silakan pilih protokol yang ingin Anda gunakan:`;

    keyboard = [
      [
        { text: '🧿 Buat SSH', callback_data: 'create_ssh' },
        { text: '🌐 Buat VMESS', callback_data: 'create_vmess' }
      ],
      [
        { text: '🔓 Buat VLESS', callback_data: 'create_vless' },
        { text: '⚡ Buat TROJAN', callback_data: 'create_trojan' }
      ],
      [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]
    ];

  } else if (action === 'renew') {
    teks = `<b>♻️ Perpanjangan Akun</b>
<i>Jaga koneksi tetap stabil kapan pun Anda membutuhkannya.</i>

Dengan melakukan perpanjangan, masa aktif layanan Anda akan diperbarui secara 
otomatis tanpa perlu konfigurasi ulang. Semua pengaturan dan data tetap aman, 
sehingga Anda bisa langsung melanjutkan aktivitas tanpa hambatan.

Pastikan saldo mencukupi lalu pilih jenis akun yang ingin diperpanjang:`;

    keyboard = [
      [
        { text: '🧿 Renew SSH', callback_data: 'renew_ssh' },
        { text: '🌐 Renew VMESS', callback_data: 'renew_vmess' }
      ],
      [
        { text: '🔓 Renew VLESS', callback_data: 'renew_vless' },
        { text: '⚡ Renew TROJAN', callback_data: 'renew_trojan' }
      ],
      [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]
    ];

  } else if (action === 'trial') {
    teks = `<b>🧪 Akun Trial Gratis</b>
<i>60 menit akses penuh • Kuota dibatasi • Satu kali penggunaan</i>

Gunakan akun trial ini untuk menguji performa server kami, mulai dari kecepatan 
download, stabilitas koneksi, hingga keamanan yang diberikan. Trial ini memberikan 
pengalaman nyata seperti layanan premium, sehingga Anda bisa menilai kualitasnya 
secara langsung tanpa biaya.

Pilih jenis layanan untuk memulai percobaan:`;

    keyboard = [
      [
        { text: '🧿 Trial SSH', callback_data: 'trial_ssh' },
        { text: '🌐 Trial VMESS', callback_data: 'trial_vmess' }
      ],
      [
        { text: '🔓 Trial VLESS', callback_data: 'trial_vless' },
        { text: '⚡ Trial TROJAN', callback_data: 'trial_trojan' }
      ],
      [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]
    ];
  }

  return { keyboard, pesan: teks };
}

// ------- showTrialServerMenu (single, cleaned) -------
async function showTrialServerMenu(ctx, jenis) {
  try {
    // Asumsi escapeHTML sudah didefinisikan di scope luar
    const servers = await dbAllAsync('SELECT id, nama_server, lokasi, quota FROM Server ORDER BY id ASC');
    if (!servers || servers.length === 0) {
      return ctx.reply('<b>⚠️ TIDAK TERSEDIA!</b>\nServer Trial sedang tidak tersedia. Kami akan segera menyediakannya kembali. Coba lagi nanti!', {
        parse_mode: 'HTML'
      });
    }
    
    // Pastikan jenis di-escape dan di-uppercase untuk tampilan
    const jenisUpper = escapeHTML(String(jenis).toUpperCase());

    const keyboard = servers.map(s => [{
      // Menampilkan nama server dan lokasi (jika tersedia)
      text: `${escapeHTML(s.nama_server)} (${escapeHTML(s.lokasi || 'Global')})`, 
      callback_data: `trial_server_${jenis}_${s.id}`
    }]);

    keyboard.push([{ text: '⬅️ Kembali ke Pilihan Protokol', callback_data: 'service_trial' }]);

    const pesan =
`<b>🧪 PILIH SERVER TRIAL ${escapeHTML(jenis.toUpperCase())}</b>

Nikmati akses <b>trial 60 menit</b> untuk mencoba kualitas jaringan kami!  
Pilih server terbaik sesuai kebutuhan kamu.

<b>ℹ️ Ketentuan Trial:</b>
• Berlaku 60 menit sejak dibuat  
• Kuota & performa mengikuti masing-masing server  
• Setiap user hanya dapat mengambil <b>1x trial per 2 hari</b>

<b>🌐 Silakan pilih server di bawah:</b>`;

    // Menggunakan ctx.answerCbQuery() di sini agar tidak ada loading
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery();
      // Mengganti editMessageText agar lebih kuat
      await ctx.editMessageText(pesan, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    } else {
      await ctx.reply(pesan, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }
  } catch (err) {
    logger.error(`❌ Gagal tampilkan server trial (${jenis}): ${err?.message || err}`);
    await ctx.reply('❌ Terjadi kesalahan saat memuat daftar server. Silakan coba kembali atau hubungi Administrator.', { parse_mode: 'HTML' });
  }
}


// ------- startSelectServer (update; improved layout + pagination) -------
async function startSelectServer(ctx, action, type, page = 0) {
  try {
    logger.info(`Memulai proses ${action} untuk ${type} (halaman ${page + 1})`);

    const servers = await dbAllAsync('SELECT * FROM Server ORDER BY id ASC');
    if (!servers || servers.length === 0) {
      return ctx.reply('<b>⚠️ PERHATIAN!</b>\nTidak ada server yang tersedia saat ini. Coba lagi nanti!', {
        parse_mode: 'HTML'
      });
    }

    const serversPerPage = 4; // tampilkan 4 server per halaman (lebih padat)
    const totalPages = Math.max(1, Math.ceil(servers.length / serversPerPage));
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const currentServers = servers.slice(start, start + serversPerPage);

    // bangun keyboard dua kolom per baris (jika ada)
    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      const s1 = currentServers[i];
      const s2 = currentServers[i + 1];

      row.push({
        text: `${escapeHTML(s1.nama_server)}`,
        callback_data: `${action}_username_${type}_${s1.id}`
      });

      if (s2) {
        row.push({
          text: `${escapeHTML(s2.nama_server)}`,
          callback_data: `${action}_username_${type}_${s2.id}`
        });
      }

      keyboard.push(row);
    }

    // navigation buttons
    const navButtons = [];
    if (currentPage > 0) {
      navButtons.push({ text: '⬅️ Back', callback_data: `navigate_${action}_${type}_${currentPage - 1}` });
    }
    if (currentPage < totalPages - 1) {
      navButtons.push({ text: 'Next ➡️', callback_data: `navigate_${action}_${type}_${currentPage + 1}` });
    }
    if (navButtons.length) keyboard.push(navButtons);

    keyboard.push([{ text: '🔙 BACK TO MENU', callback_data: 'send_main_menu' }]);

    // format server cards (compact, 1 block per server) — tanpa flag lokasi
    const serverCards = currentServers.map(s => {
      const harga30 = (s.harga || 0) * 30;
      const isFull = (s.total_create_akun || 0) >= (s.batas_create_akun || 0);
      const status = isFull ? '❌ PENUH' : '✅ Tersedia';

      return (
        `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
        `<b>${escapeHTML(s.nama_server)}</b>\n` +
        `• Lokasi     : <i>${escapeHTML(s.lokasi || '-')}</i>\n` +
        `• Harga/hari : <code>Rp${(s.harga || 0).toLocaleString('id-ID')}</code>\n` +
        `• Harga/30h  : <code>Rp${harga30.toLocaleString('id-ID')}</code>\n` +
        `• Kuota      : <code>${escapeHTML(String(s.quota || '-'))} GB</code>\n` +
        `• IP Max     : <code>${escapeHTML(String(s.iplimit || '-'))}</code>\n` +
        `• Akun       : <code>${escapeHTML(String(s.total_create_akun || 0))}/${escapeHTML(String(s.batas_create_akun || 0))}</code>\n` +
        `• Status     : ${status}\n` +
        `<b>━━━━━━━━━━━━━━━━━━━━━━</b>`
      );
    }).join('\n\n');

    const text = `<b>📋 List Server (Hal ${currentPage + 1}/${totalPages})</b>\n\n${serverCards}\n\n` +
                 `<i>Pilih server dengan menekan tombol nama server di bawah.</i>`;

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });

    // simpan state supaya flow tahu next step
    userState[ctx.chat.id] = {
      step: `${action}_username_${type}`,
      page: currentPage
    };
  } catch (error) {
    logger.error(`❌ Error saat memulai proses ${action}/${type}:`, error?.stack || error?.message || error);
    await ctx.reply('<b>❌ Terjadi kesalahan saat memuat server. Coba lagi nanti.</b>', { parse_mode: 'HTML' });
  }
}

async function sendAdminMenu(ctx) {
  const adminKeyboard = [
  [
    { text: '➕ Tambah Server', callback_data: 'addserver' },
    { text: '❌ Hapus Server', callback_data: 'deleteserver' }
  ],
  [
    { text: '💲 Edit Harga', callback_data: 'editserver_harga' },
    { text: '📝 Edit Nama', callback_data: 'nama_server_edit' }
  ],
  [
    { text: '🌐 Edit Domain', callback_data: 'editserver_domain' },
    { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }
  ],
  [
    { text: '📊 Edit Quota', callback_data: 'editserver_quota' },
    { text: '📶 Edit Limit IP', callback_data: 'editserver_limit_ip' }
  ],
  [
    { text: '🔢 Edit Batas Create', callback_data: 'editserver_batas_create_akun' },
    { text: '🔢 Edit Total Create', callback_data: 'editserver_total_create_akun' }
  ],
  [
    { text: '💵 Tambah Saldo', callback_data: 'addsaldo_user' },
    { text: '💸 Kurangi Saldo', callback_data: 'reducesaldo_user' }
  ],
  [
    { text: '📋 List Server', callback_data: 'listserver' },
    { text: '♻️ Reset Server', callback_data: 'resetdb' }
  ],
  [
    { text: 'ℹ️ Detail Server', callback_data: 'detailserver' }
  ],
  [
    { text: '🔙 Kembali', callback_data: 'send_main_menu' }
  ]
];

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: adminKeyboard
    });
    logger.info('Admin menu sent');
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply('⚙️ MENU ADMIN', {
        reply_markup: {
          inline_keyboard: adminKeyboard
        }
      });
      logger.info('Admin menu sent as new message');
    } else {
      logger.error('Error saat mengirim menu admin:', error);
    }
  }
}

///Upgrade to reseller
// helper: pastikan escapeMarkdownV2 ada (dipakai buat aman MarkdownV2)
bot.action('upgrade_to_reseller', async (ctx) => {
  const userId = ctx.from.id;

  const user = await dbGetAsync('SELECT saldo, role FROM users WHERE user_id = ?', [userId]);

  if (!user) {
    return ctx.reply('❌ Akun tidak ditemukan di sistem.');
  }

  if (user.role === 'reseller') {
    return ctx.reply('✅ Kamu sudah menjadi reseller.');
  }

  const minimumSaldo = 30000;

  if (user.saldo < minimumSaldo) {
    return ctx.reply(
      escapeMarkdownV2(
        `💸 Saldo kamu belum cukup untuk upgrade.\n` +
        `Minimal saldo: Rp${minimumSaldo.toLocaleString('id-ID')}\n` +
        `Saldo kamu: Rp${user.saldo.toLocaleString('id-ID')}`
      ),
      { parse_mode: 'MarkdownV2' }
    );
  }

  // Konfirmasi upgrade (perhatikan: biaya hanya syarat, TIDAK dipotong)
  const pesanKonfirmasi = 
    `🆙 𝗨𝗽𝗴𝗿𝗮𝗱𝗲 𝗸𝗲 𝗥𝗲𝘀𝗲𝗹𝗹𝗲𝗿\n\n` +
    `⚠️ Syarat: Memiliki saldo minimal Rp${minimumSaldo.toLocaleString('id-ID')} (saldo tidak akan dipotong)\n\n` +
    `🎯 Persyaratan lain:\n` +
    `• Bisa membuat config sendiri\n` +
    `• Paham cara jualan & tanggung jawab\n\n` +
    `Dengan menjadi Reseller, kamu bisa:\n` +
    `✅ Mendapat harga khusus\n` +
    `✅ Mengelola akun user sendiri\n` +
    `✅ Mengakses menu reseller di bot ini\n\n` +
    `Klik Ya kalau kamu siap upgrade 🚀`;

  return ctx.reply(escapeMarkdownV2(pesanKonfirmasi), {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Ya, Upgrade Sekarang', callback_data: 'confirm_upgrade_reseller' }],
        [{ text: '❌ Batal', callback_data: 'send_main_menu' }]
      ]
    }
  });
});

// ------------------------- CONFIRM UPGRADE (TANPA POTONG SALDO) -------------------------
bot.action('confirm_upgrade_reseller', async (ctx) => {
  const userId = ctx.from.id;
  const minimumSaldo = 30000;

  const user = await dbGetAsync('SELECT saldo, role FROM users WHERE user_id = ?', [userId]);
  if (!user) return ctx.reply('❌ Akun tidak ditemukan.');
  if (user.role === 'reseller') return ctx.reply('✅ Kamu sudah menjadi reseller.');

  if (user.saldo < minimumSaldo) {
    return ctx.reply(escapeMarkdownV2(`❌ Saldo kamu tidak mencukupi untuk upgrade.`), { parse_mode: 'MarkdownV2' });
  }

  // UPDATE role tanpa memotong saldo
  await dbRunAsync('UPDATE users SET role = "reseller", reseller_level = "silver" WHERE user_id = ?', [userId]);

  // Catat log upgrade dengan amount = 0 (gratis)
  await dbRunAsync(`
    INSERT INTO reseller_upgrade_log (user_id, username, amount, level, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `, [userId, ctx.from.username || ctx.from.first_name, 0, 'silver']);

  await ctx.reply(
    escapeMarkdownV2(
      '🏆 𝗦𝗲𝗹𝗮𝗺𝗮𝘁! Kamu telah berhasil upgrade ke Reseller (Silver).\n' +
      'Saldo minimal sudah dicek namun tidak dipotong.\n' +
      'Silakan mulai transaksi dengan harga khusus!'
    ),
    { parse_mode: 'MarkdownV2' }
  );

  // Opsional: kirim ke GROUP_ID (tetap gunakan blok notif yang sudah ada)
  if (GROUP_ID) {
    const mention = ctx.from.username
      ? `@${escapeMarkdownV2(ctx.from.username)}`
      : `[${escapeMarkdownV2(ctx.from.first_name)}](tg://user?id=${ctx.from.id})`;

    const notif = `
━━━━━━━━━━━━━━━━━━━━━━━
🏆 *UPGRADE KE RESELLER*
━━━━━━━━━━━━━━━━━━━━━━━
💌 *User:* ${mention}
⚠️ *Syarat:* Minimal saldo${escapeMarkdownV2(minimumSaldo.toLocaleString('id-ID'))}
📈 *Role:* Reseller  _Silver_
🕒 *Waktu:* ${escapeMarkdownV2(new Date().toLocaleString('id-ID'))}
━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    // kirim notif (kamu bilang ini sudah aman)
    await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: 'MarkdownV2' }).catch(() => {});
  }
});

///admin
// ===== Admin Panel Main Menu =====
bot.action('menu_adminreseller', async (ctx) => {
  const userId = ctx.from.id;

  try {
    const user = await dbGetAsync('SELECT role FROM users WHERE user_id = ?', [userId]);

    if ((!user || user.role !== 'admin') && !((global.adminIds || adminIds || []).includes(String(userId)))) {
      return ctx.reply('🚫 Kamu tidak memiliki izin.');
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🖥️ Menu Server', callback_data: 'admin_server_menu' }],
        [{ text: '⚙️ Menu Sistem', callback_data: 'admin_system_menu' }],
        [{ text: '⬅️ Kembali', callback_data: 'send_main_menu' }]
      ]
    };

    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('id-ID');

    const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'Admin';

    const content = `
<b>👑  ADMIN CONTROL PANEL</b>
<i>${escapeHTML(dateStr)} • ${escapeHTML(timeStr)}</i>

<b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>
<b>📌 MENU UTAMA ADMIN</b>
• Kelola Server & Konfigurasi Hosting  
• Pengaturan Sistem & Layanan  
• Kontrol penuh fitur bot  
<b>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</b>

<i>Selamat bertugas, ${escapeHTML(who)}.</i>
`.trim();

    try {
      await ctx.editMessageText(content, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (e) {
      await ctx.reply(content, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    }
  } catch (err) {
    logger.error('❌ Gagal tampilkan menu admin:', err?.stack || err?.message || err);
    await ctx.reply('❌ Gagal menampilkan menu admin. Coba lagi nanti.');
  }
});

// =================== MENU SERVER ===================
bot.action('admin_server_menu', async (ctx) => {
  const keyboardServer = {
  inline_keyboard: [
    [
      { text: '➕ Tambah Server', callback_data: 'addserver' },
      { text: '❌ Hapus Server', callback_data: 'deleteserver' }
    ],
    [
      { text: '💲 Edit Harga', callback_data: 'editserver_harga' },
      { text: '📝 Edit Nama', callback_data: 'nama_server_edit' }
    ],
    [
      { text: '🌐 Edit Domain', callback_data: 'editserver_domain' },
      { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }
    ],
    [
      { text: '📊 Edit Quota', callback_data: 'editserver_quota' },
      { text: '📶 Edit Limit Ip', callback_data: 'editserver_limit_ip' }
    ],
    [
      { text: '💵 Tambah Saldo', callback_data: 'addsaldo_user' },
      { text: '➖ Kurangi Saldo', callback_data: 'reducesaldo_user' }
    ],
    [
      { text: 'ℹ️ Detail Server', callback_data: 'detailserver' },
      { text: '🔢 Batas Create', callback_data: 'editserver_batas_create_akun' }
    ],
    [
      { text: '🔢 Total Create', callback_data: 'editserver_total_create_akun' },
      { text: '📋 List Server', callback_data: 'listserver' }
    ],
    [
      { text: '♻️ Reset Server', callback_data: 'resetdb' },
      { text: '⬅️ Kembali', callback_data: 'menu_adminreseller' }
    ]
  ]
};

  const message = `
🛠️ *Menu Admin - Server*

Silakan pilih manajemen server!!!
`.trim();

  try {
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboardServer
    });
  } catch {
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboardServer
    });
  }
});

// =================== MENU SISTEM ===================
bot.action('admin_system_menu', async (ctx) => {
  const keyboardSystem = {
  inline_keyboard: [
    // 🔢 Statistik dan Pengguna
    [
      { text: '📊 Statistik Global', callback_data: 'admin_stats' },
      { text: '👥 List Pengguna', callback_data: 'admin_listuser' }
    ],

    // 📢 Broadcast dan Backup
    [
      { text: '📢 Broadcast', callback_data: 'admin_broadcast' },
      { text: '💾 Backup DB', callback_data: 'admin_backup_db' }
    ],

    // 🔄 Restore dan All Backup
    [
      { text: '♻️ Restore DB', callback_data: 'admin_restore2_db' },
      { text: '🗃️ All Backup', callback_data: 'admin_restore_all' }
    ],

    // 🔼🔽 Reseller Role
    [
      { text: '⬆️ Up Reseller', callback_data: 'admin_promote_reseller' },
      { text: '⬇️ Down Reseller', callback_data: 'admin_downgrade_reseller' }
    ],

    // 🎛 Level & List Reseller
    [
      { text: '🎛 Ubah Level', callback_data: 'admin_ubah_level' },
      { text: '🧾 List Reseller', callback_data: 'admin_listreseller' }
    ],

    // 🔁 Reset & Topup Log
    [
      { text: '🔁 Reset Komisi', callback_data: 'admin_resetkomisi' },
      { text: '🔄 Reset Trial', callback_data: 'admin_reset_trial' }
    ],
    [
      { text: '📋 Log All Topup', callback_data: 'admin_view_topup' }
    ],

    // ⬅️ Kembali
    [
      { text: '⬅️ Kembali', callback_data: 'menu_adminreseller' }
    ]
  ]
};

  const message = `
⚙️ *Menu Admin - Sistem*

Silahkan pilih manajemen sistem!!!
`.trim();

  try {
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboardSystem
    });
  } catch {
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboardSystem
    });
  }
});

// Handler untuk backup manual
bot.action('admin_backup_db', async (ctx) => {
  const userId = String(ctx.from.id);
  
  // 1. Cek Izin Admin
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('🚫 Akses ditolak.');
  }

  try {
    await ctx.answerCbQuery('⏳ Proses backup sedang dimulai...');
    const waitMessage = await ctx.reply(
      '⏳ *Membuat backup database...* Mohon tunggu sebentar. Ini mungkin membutuhkan waktu beberapa detik (file db akan dikirim setelah selesai).',
      { parse_mode: 'Markdown' }
    );

    // 2. Buat nama file backup
    const dateStr = new Date().toLocaleString('sv').replace(/[^0-9]/g, ''); 
    const backupFileName = `sellvpn_backup_${dateStr}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    // 3. Execute SQLite .backup using external sqlite3 CLI
    const cmd = `sqlite3 ${DB_PATH} ".backup '${backupPath}'"`;
    
    // Perintah ini yang menyebabkan konflik I/O
    execSync(cmd, { stdio: 'pipe' }); 

    // 4. FIX UTAMA: Paksa koneksi Node.js untuk melakukan FULL CHECKPOINT WAL
    // Ini menyelesaikan konflik I/O dengan memastikan koneksi internal sinkron 
    // setelah proses eksternal (CLI) selesai.
    db.exec('PRAGMA wal_checkpoint(FULL);'); 

    // 5. Kirim file backup ke admin
    await ctx.telegram.sendDocument(ctx.chat.id, { 
      source: backupPath, 
      filename: backupFileName 
    });
    
    // 6. Hapus pesan tunggu dan kirim notifikasi sukses
    await ctx.deleteMessage(waitMessage.message_id).catch(() => {});

    await ctx.reply(
      `✅ *Backup database (${backupFileName}) berhasil dibuat dan dikirim.* Konflik I/O sudah diatasi secara internal.`, 
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    logger.error('❌ Gagal membuat backup database:', error.message);
    await ctx.reply(
      `❌ *Gagal membuat backup database.*\n\nDetail Error: \`${error.message}\``, 
      { parse_mode: 'Markdown' }
    );
  }
});


bot.action('admin_reset_trial', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('❌ Akses ditolak bro.');
  }

  try {
    await dbRunAsync(`UPDATE users SET trial_count_today = 0, last_trial_date = date('now')`);
    await ctx.reply('✅ *Semua trial user telah direset ke 0.*', { parse_mode: 'Markdown' });
    logger.info(`🔄 Admin ${userId} melakukan reset trial harian.`);
  } catch (err) {
    logger.error('❌ Gagal reset trial harian:', err.message);
    await ctx.reply('❌ *Gagal melakukan reset trial.*', { parse_mode: 'Markdown' });
  }
});


bot.action('admin_restore2_db', async (ctx) => {
  const userId = ctx.from.id;

  // Pastikan ID pengguna adalah admin
  if (!adminIds.includes(String(userId))) {
    await ctx.answerCbQuery('🚫 Akses ditolak.');
    return ctx.reply('🚫 *Akses ditolak.*', { parse_mode: 'Markdown' });
  }

  // Set state pengguna ke langkah 'await_restore_upload'
  userState[ctx.chat.id] = { step: 'await_restore_upload' };

  await ctx.answerCbQuery('Proses restore dimulai.');
  await ctx.reply(
    '📤 *Silakan kirim file backup database (.db) yang ingin direstore.*\n' +
    '_Contoh: sellvpn_2025-06-01_10-00.db_',
    { parse_mode: 'Markdown' }
  );
});

// =========================================================================
// Bagian 2: Handler yang menerima dokumen dan melakukan eksekusi restore
// Ini adalah bagian KRITIS yang dijamin aman dari file lock
// =========================================================================
bot.on('document', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    // 1. Cek State dan Izin
    if (!adminIds.includes(String(userId)) || userState[chatId]?.step !== 'await_restore_upload') {
        return; // Abaikan jika bukan admin atau state salah
    }

    const doc = ctx.message.document;

    // Filter dokumen: Hanya proses file .db
    if (!doc.file_name || !doc.file_name.endsWith('.db')) {
        // Reset state jika file salah dikirim
        delete userState[chatId]; 
        return ctx.reply('❌ Dokumen yang diunggah harus file database (.db). Proses dibatalkan.');
    }

    // Filter ukuran file (misalnya, batas 50MB)
    if (doc.file_size > 50 * 1024 * 1024) { 
        delete userState[chatId];
        return ctx.reply('❌ File terlalu besar untuk restore. Proses dibatalkan.');
    }

    // Reset state agar bot tidak terjebak dalam loop
    delete userState[chatId];

    try {
        await ctx.reply('⏳ Menerima dan memproses file backup. Ini mungkin membutuhkan waktu beberapa detik...');

        // 2. Dapatkan link download file
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const fileName = `restore_${Date.now()}.db`;
        // Pastikan Anda menggunakan UPLOAD_DIR yang benar, yang diizinkan untuk ditulis
        const tempFilePath = path.join(UPLOAD_DIR, fileName); 

        // 3. Download file dari Telegram
        const downloadResponse = await axios.get(fileLink.href, { responseType: 'stream' });
        const writer = fs.createWriteStream(tempFilePath);
        downloadResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // ----------------------------------------------------
        // 🔒 START CRITICAL SECTION: MENGATASI FILE LOCK (WAL MODE)
        // ----------------------------------------------------

        // 4. KELUAR DARI WAL MODE (Membersihkan file -wal dan -shm)
        if (db && typeof db.run === 'function') {
            await new Promise((resolve) => {
                // Perintah ini memaksa SQLite melepaskan file lock.
                db.run('PRAGMA journal_mode = DELETE;', (err) => {
                    if (err) logger.warn('⚠️ Gagal ubah ke DELETE mode sebelum close:', err.message);
                    resolve();
                });
            });
        }

        // 5. TUTUP KONEKSI UTAMA (Melepaskan lock pada sellvpn.db)
        if (db && typeof db.close === 'function') {
            await new Promise((resolve) => {
                db.close((err) => {
                    if (err) logger.warn('⚠️ Gagal menutup koneksi DB utama:', err.message);
                    resolve(); // Selalu resolve agar operasi file copy bisa jalan
                });
            });
        }

        // 6. TINDAKAN KRITIS: COPY/TIMPA FILE
        fs.copyFileSync(tempFilePath, DB_PATH);
        logger.info(`File ${DB_PATH} berhasil ditimpa dengan backup baru dari Telegram.`);

        // 7. HAPUS SISA FILE WAL (Optional, untuk memastikan bersih)
        try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
        try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}

        // 8. BUKA KEMBALI KONEKSI (Menggunakan data database yang baru)
        // 🔥 PASTIKAN DEKLARASI GLOBAL 'db' MENGGUNAKAN 'let' BUKAN 'const'
        db = new sqlite3.Database(DB_PATH); 
        
        // 9. AKTIFKAN KEMBALI WAL MODE UNTUK KINERJA
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA synchronous = NORMAL;');
        db.run('PRAGMA busy_timeout = 5000;');
        logger.info('Koneksi database berhasil dibuka kembali dan WAL mode diaktifkan.');
        
        // ----------------------------------------------------
        // 🔓 END CRITICAL SECTION
        // ----------------------------------------------------

        await ctx.reply('🎉 **Restore Database Berhasil!**\n\nDatabase bot telah diperbarui dan bot kembali beroperasi normal.');

    } catch (err) {
        logger.error('❌ Error fatal saat proses restore DB:', err);
        
        // PENTING: Jika gagal, setidaknya koneksi harus dibuka kembali
        // agar bot tidak lumpuh total.
        if (!db || typeof db.close !== 'function') {
             // Coba buat koneksi baru ke DB_PATH yang ada
             db = new sqlite3.Database(DB_PATH); 
             // Coba aktifkan kembali WAL (sebelumnya mungkin belum sempat)
             db.run('PRAGMA journal_mode = WAL;'); 
        }

        await ctx.reply(`❌ Gagal melakukan restore database:\n\`${err.message}\`\n\n*Disarankan mematikan bot lalu restore manual.*`);
    }
});

bot.action('admin_listreseller', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Kamu tidak memiliki izin.');
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(`
        SELECT user_id, username, reseller_level, saldo 
        FROM users 
        WHERE role = 'reseller' 
        LIMIT 20
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Belum ada reseller terdaftar.');
    }

    const list = rows.map((row, i) => {
      const mention = row.username
        ? `@${escapeMarkdownV2(row.username)}`
        : `ID: \`${escapeMarkdownV2(row.user_id)}\``;

      const level = escapeMarkdownV2(row.reseller_level || 'silver');
      const saldo = escapeMarkdownV2(row.saldo.toLocaleString('id-ID'));

      return `🔹 ${mention}\n🏷 Level: *${level}*\n💰 Saldo: Rp${saldo}`;
    }).join('\n\n');

    const text = `🏆 *List Reseller _Max 20_:*\n\n${list}`;

    await ctx.reply(text, {
      parse_mode: 'MarkdownV2'
    });

  } catch (err) {
    logger.error('❌ Gagal ambil list reseller:', err.message);
    ctx.reply('❌ Gagal mengambil daftar reseller.');
  }
});

bot.action('admin_stats', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('❌ Tidak diizinkan.');
  }

  try {
    const [jumlahUser, jumlahReseller, jumlahServer, totalSaldo] = await Promise.all([
      dbGetAsync('SELECT COUNT(*) AS count FROM users'),
      dbGetAsync("SELECT COUNT(*) AS count FROM users WHERE role = 'reseller'"),
      dbGetAsync('SELECT COUNT(*) AS count FROM Server'),
      dbGetAsync('SELECT SUM(saldo) AS total FROM users')
    ]);

    const sistemText = `
📊 *Statistik Sistem  _Realtime_*

👥 *User*     : ${escapeMarkdownV2(jumlahUser?.count || 0)}
👑 *Reseller* : ${escapeMarkdownV2(jumlahReseller?.count || 0)}
🖥️ *Server*   : ${escapeMarkdownV2(jumlahServer?.count || 0)}
💰 *Saldo*    : Rp${escapeMarkdownV2((totalSaldo?.total || 0).toLocaleString('id-ID'))}
`.trim();

    const [totalTransaksi, totalKomisi, topReseller] = await Promise.all([
      dbGetAsync('SELECT COUNT(*) AS count FROM invoice_log'),
      dbGetAsync('SELECT SUM(komisi) AS total FROM reseller_sales'),
      dbAllAsync(`
        SELECT u.username, r.reseller_id, SUM(r.komisi) AS total_komisi
        FROM reseller_sales r
        LEFT JOIN users u ON u.user_id = r.reseller_id
        GROUP BY r.reseller_id
        ORDER BY total_komisi DESC
        LIMIT 3
      `)
    ]);

    let globalText = `
📊 *Statistik Global*

🌐 Server Aktif : ${escapeMarkdownV2(jumlahServer?.count || 0)}
👥 Pengguna     : ${escapeMarkdownV2(jumlahUser?.count || 0)}
📦 Transaksi    : ${escapeMarkdownV2(totalTransaksi?.count || 0)}
?? Komisi Total : Rp${escapeMarkdownV2((totalKomisi?.total || 0).toLocaleString('id-ID'))}
`;

    if (topReseller && topReseller.length > 0) {
      globalText += `\n🏆 *Top 3 Reseller:*\n`;
      const medals = ['🥇', '🥈', '🥉'];
      topReseller.forEach((r, i) => {
        const mention = r.username
          ? `@${escapeMarkdownV2(r.username)}`
          : `ID\\_${escapeMarkdownV2(r.reseller_id)}`;
        const komisi = escapeMarkdownV2((r.total_komisi || 0).toLocaleString('id-ID'));
        globalText += `${medals[i] || '⭐'} ${mention} \\- Rp${komisi}\n`;
      });
    }

    await ctx.editMessageText(`${sistemText}\n\n${globalText}`.trim(), {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });

  } catch (err) {
    logger.error('❌ Gagal ambil statistik admin:', err.message);
    await ctx.reply('❌ Gagal mengambil data statistik.');
  }
});

bot.action('admin_broadcast', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Kamu tidak punya izin untuk broadcast.');
  }

  userState[ctx.chat.id] = { step: 'await_broadcast_message' };
  return ctx.reply('📝 Silakan ketik pesan yang ingin dibroadcast ke semua pengguna.');
});


bot.action('admin_ubah_level', async (ctx) => {
  const adminId = String(ctx.from.id);
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ *Khusus admin.*', { parse_mode: 'Markdown' });
  }

  userState[ctx.chat.id] = { step: 'await_level_change' };
  ctx.reply('🧬 *Masukkan ID user dan level baru:*\n\nFormat: `123456789 platinum`', {
    parse_mode: 'Markdown'
  });

  // ⏱️ Timeout auto reset 30 detik
  setTimeout(() => {
    if (userState[ctx.chat.id]?.step === 'await_level_change') {
      delete userState[ctx.chat.id];
      ctx.reply('⏳ Waktu habis. Silakan klik ulang tombol *Ubah Level Reseller*.', {
        parse_mode: 'Markdown'
      });
    }
  }, 30000);
});

bot.action('admin_downgrade_reseller', async (ctx) => {
  const adminId = String(ctx.from.id);
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ *Khusus admin.*', { parse_mode: 'Markdown' });
  }

  userState[ctx.chat.id] = { step: 'await_downgrade_id' };
  return ctx.reply('📥 *Masukkan ID user yang ingin di-DOWNGRADE ke user biasa:*', {
    parse_mode: 'Markdown'
  });
});

bot.action('admin_promote_reseller', async (ctx) => {
  const adminId = String(ctx.from.id);
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin)
    ? rawAdmin.map(String)
    : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ Hanya admin yang bisa akses fitur ini.');
  }

  // Prompt input user ID
  userState[ctx.chat.id] = { step: 'await_reseller_id' };
  setTimeout(() => {
  if (userState[ctx.chat.id]?.step === 'await_reseller_id') {
    delete userState[ctx.chat.id];
    ctx.reply('⏳ Waktu habis. Silakan ulangi /promote_reseller jika masih ingin mempromosikan user.');
  }
}, 30000); // 30 detik
  return ctx.reply('📥 Masukkan user ID yang ingin dipromosikan jadi reseller:');
});

bot.action('admin_resetkomisi', async (ctx) => {
  const adminId = ctx.from.id;
  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];

  if (!adminIds.includes(String(adminId))) {
    return ctx.reply(escapeMarkdown('⛔ Akses ditolak. Hanya admin.'), {
      parse_mode: 'MarkdownV2'
    });
  }

  userState[ctx.chat.id] = {
    step: 'reset_komisi_input'
  };

  return ctx.reply(escapeMarkdown('📨 Masukkan user_id yang ingin direset komisinya:'), {
    parse_mode: 'MarkdownV2'
  });
});

bot.action('admin_listserver', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Kamu tidak memiliki izin.');
  }

  db.all('SELECT * FROM Server ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      logger.error('❌ Error ambil list server:', err.message);
      return ctx.reply('⚠️ Gagal mengambil data server.');
    }

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Belum ada server yang ditambahkan.');
    }

    const list = rows.map((row, i) => {
      return `${i + 1}. ${row.nama_server}\n` +
             `🌐 Domain   : ${row.domain}\n` +
             `🔐 Auth     : ${row.auth}\n` +
             `💾 Quota    : ${row.quota} GB\n` +
             `🌍 IP Limit : ${row.iplimit}\n` +
             `📦 Harga    : Rp${row.harga.toLocaleString('id-ID')}\n` +
             `🧮 Total Buat: ${row.total_create_akun}`;
    }).join('\n──────────────\n');

    const msg = `📄 List Server Tersimpan:\n\n${list}`;
    ctx.reply(msg);
  });
});


bot.action('admin_listuser', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Kamu tidak memiliki izin.');
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT user_id, username, role, saldo FROM users LIMIT 20', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Tidak ada pengguna terdaftar.');
    }

    const list = rows.map((row, i) => {
      const mention = row.username
        ? `@${escapeMarkdownV2(row.username)}`
        : `ID: \`${escapeMarkdownV2(row.user_id)}\``;

      return `🔹 ${mention}\n*Role*: ${escapeMarkdownV2(row.role)}\n*Saldo*: Rp${escapeMarkdownV2(row.saldo.toLocaleString('id-ID'))}`;
    }).join('\n\n');

    const text = `👥 *List Pengguna _max 20_:*\n\n${list}`;

    await ctx.reply(text, {
      parse_mode: 'MarkdownV2'
    });

  } catch (err) {
    logger.error('❌ Gagal ambil list user:', err.message);
    ctx.reply('❌ Gagal mengambil daftar pengguna.');
  }
});
// -- handler Service --
bot.action('service_create', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'create');
});

bot.action('service_renew', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'renew');
});

bot.action('service_trial', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'trial');
});

// ===================== ACTION: MENU RESELLER =====================
bot.action('menu_reseller', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;

  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!row || row.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller.', { parse_mode: 'Markdown' });
    }

    const keyboard = {
  inline_keyboard: [
    [
      { text: '📊 Statistik riwayat', callback_data: 'reseller_riwayat' },
      { text: '📖 Cek Komisi', callback_data: 'reseller_komisi' }
    ],
    [
      { text: '🗳 Export Komisi', callback_data: 'reseller_export' },
      { text: '⏰ Top All Time', callback_data: 'reseller_top_all' }
    ],
    [
      { text: '🏆 Top Mingguan', callback_data: 'reseller_top_weekly' },
    ],
    [
      { text: '⬅️ Kembali', callback_data: 'send_main_menu' }
    ]
  ]
};

    const content = `
📂 *DASHBOARD RESELLER*

📋 Hari ini: ${new Date().toLocaleDateString('id-ID')}
🕒 Jam: ${new Date().toLocaleTimeString('id-ID')}

🏷 *Status:* Reseller Aktif
📝 Cek penghasilan dan statistik.
🏆 Cek daftar *TOP RESELLER*

🔽 Silakan pilih menu Reseller dibawah ini!!
`.trim();

    try {
      await ctx.editMessageText(content, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (err) {
      if (err.response?.error_code === 400 || err.message.includes("message can't be edited")) {
        await ctx.reply(content, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } else {
        logger.error('❌ Gagal tampilkan menu reseller:', err.message);
      }
    }

  } catch (err) {
    logger.error('❌ Error query menu_reseller:', err.message);
    return ctx.reply('⚠️ Terjadi kesalahan saat memuat menu reseller.', { parse_mode: 'Markdown' });
  }
});

bot.action('reseller_top_weekly', async (ctx) => {
  try {
    const topRows = await dbAll(db, `
      SELECT u.user_id, u.username, SUM(r.komisi) AS total_komisi
      FROM reseller_sales r
      JOIN users u ON r.reseller_id = u.user_id
      WHERE r.created_at >= datetime('now', '-7 days')
      GROUP BY r.reseller_id
      ORDER BY total_komisi DESC
      LIMIT 5
    `);

    if (!topRows || topRows.length === 0) {
      return ctx.reply(escapeMarkdownV2('📭 Belum ada transaksi reseller minggu ini.'), {
        parse_mode: 'MarkdownV2'
      });
    }

    const topList = topRows.map((row, i) => {
      const mention = row.username
        ? `@${escapeMarkdownV2(row.username)}`
        : `ID\\_${row.user_id}`;
      const medal = ['??', '🥈', '🥉', '🎖️', '⭐'][i];
      const komisi = escapeMarkdownV2(row.total_komisi.toLocaleString('id-ID'));
      return `${medal} ${mention} \\- Rp${komisi}`;
    });

    const replyText = escapeMarkdownV2(`🏆 Top Reseller Minggu Ini:\n\n`) + topList.join('\n');
    
    await ctx.reply(replyText, { parse_mode: 'MarkdownV2' });

  } catch (err) {
    logger.error('❌ Gagal ambil top reseller mingguan:', err);
    return ctx.reply(escapeMarkdownV2('⚠️ Gagal mengambil data top reseller.'), {
      parse_mode: 'MarkdownV2'
    });
  }
});

bot.action('reseller_logtransfer', async (ctx) => {
  const userId = ctx.from.id;

  await ctx.reply('🕒 Memuat log transfer saldo...', {
    parse_mode: 'Markdown'
  });

  const header = '*🧾 Riwayat Transfer Saldo Terakhir:*\n\n';

  db.all(`
    SELECT to_id, jumlah AS amount, created_at FROM transfer_log 
    WHERE from_id = ? 
    ORDER BY datetime(created_at) DESC 
    LIMIT 5
  `, [userId], async (err, rows) => {
    if (err) {
      logger.error('❌ Gagal ambil log transfer:', err.message);
      return ctx.reply('⚠️ Gagal mengambil riwayat transfer.', {
        parse_mode: 'Markdown'
      });
    }

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Belum ada riwayat transfer saldo.', {
        parse_mode: 'Markdown'
      });
    }

    const list = await Promise.all(rows.map(async (row) => {
      let recipient = `ID ${row.to_id}`;
      try {
        const user = await bot.telegram.getChat(row.to_id);
        recipient = user.username
          ? `@${user.username}`
          : user.first_name || recipient;
      } catch {}

      const date = new Date(row.created_at).toLocaleString('id-ID');
      return `🔸 Ke ${escapeMarkdown(recipient)} (ID ${row.to_id}) +Rp${row.amount.toLocaleString('id-ID')} 🕒 ${escapeMarkdown(date)}`;
    }));

    const message = header + list.join('\n');

    ctx.reply(message, { parse_mode: 'Markdown' });
  });
});

// 📤 Export Komisi
bot.action('reseller_export', async (ctx) => {
  const userId = ctx.from.id;

  db.all(`
    SELECT akun_type, username, komisi, created_at 
    FROM reseller_sales 
    WHERE reseller_id = ?
    ORDER BY datetime(created_at) DESC
  `, [userId], async (err, rows) => {
    if (err) {
      logger.error('❌ Gagal ambil data komisi:', err.message);
      return ctx.reply('⚠️ Gagal mengambil data komisi.', { parse_mode: 'Markdown' });
    }

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Belum ada data komisi untuk diexport.', { parse_mode: 'Markdown' });
    }

    const lines = rows.map(row => {
      const waktu = new Date(row.created_at).toLocaleString('id-ID');
      return `📦 ${row.akun_type.toUpperCase()} | 👤 ${row.username} | 💰 Rp${row.komisi.toLocaleString('id-ID')} | 🕒 ${waktu}`;
    });

    const exportText = `📥 *Export Data Komisi:*\n\n${lines.join('\n')}`;
    return ctx.reply(exportText, { parse_mode: 'Markdown' });
  });
});

bot.action('reseller_top_all', async (ctx) => {
  try {
    db.all(`
      SELECT r.reseller_id, COUNT(r.id) AS total_akun, 
             SUM(COALESCE(r.komisi, 0)) AS total_komisi,
             u.username
      FROM reseller_sales r
      INNER JOIN users u ON r.reseller_id = u.user_id
      GROUP BY r.reseller_id
      HAVING total_komisi > 0
      ORDER BY total_komisi DESC
      LIMIT 10
    `, async (err, rows) => {
      if (err) {
        console.error('❌ Gagal ambil data top reseller:', err);
        return ctx.reply('❌ Gagal mengambil data top reseller.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('📭 Belum ada transaksi reseller.');
      }

      let text = `🏆 Top 10 Reseller by Komisi (All Time):\n\n`;

      rows.forEach((r, i) => {
        const nama = r.username ? `@${r.username}` : `ID ${r.reseller_id}`;
        text += `#${i + 1} 👤 ${nama}\n`;
        text += `🛒 Akun Terjual: ${r.total_akun}\n`;
        text += `💰 Total Komisi : Rp${(r.total_komisi || 0).toLocaleString('id-ID')}\n\n`;
      });

      await ctx.reply(text.trim());
    });
  } catch (e) {
    console.error('❌ Terjadi kesalahan:', e);
    ctx.reply('❌ Terjadi kesalahan.');
  }
});

bot.action('reseller_komisi', (ctx) => {
  const userId = ctx.from.id;

  db.get('SELECT role, reseller_level FROM users WHERE user_id = ?', [userId], (err, user) => {
    if (err || !user || user.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller.');
    }

    db.get('SELECT COUNT(*) AS total_akun, SUM(komisi) AS total_komisi FROM reseller_sales WHERE reseller_id = ?', [userId], (err, summary) => {
      if (err) {
        logger.error('❌ Gagal ambil data komisi:', err.message);
        return ctx.reply('❌ Gagal ambil data komisi.');
      }

      db.all('SELECT akun_type, username, komisi, created_at FROM reseller_sales WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 5', [userId], (err, rows) => {
        if (err) {
          return ctx.reply('❌ Gagal ambil riwayat komisi.');
        }

        const level = user.reseller_level ? user.reseller_level.toUpperCase() : 'SILVER';

        const list = rows.map((r, i) =>
          `🔹 ${r.akun_type.toUpperCase()} - ${r.username} (+Rp${r.komisi}) 🕒 ${r.created_at}`
        ).join('\n') || '_Belum ada transaksi_';

        const text = `💰 *Statistik Komisi Reseller*\n\n` +
          `🎖️ Level: ${level}\n` +
          `🧑‍💻 Total Akun Terjual: ${summary.total_akun}\n` +
          `💸 Total Komisi: Rp${summary.total_komisi || 0}\n\n` +
          `📜 *Transaksi Terbaru:*\n${list}`;

        ctx.editMessageText(text, { parse_mode: 'Markdown' });
      });
    });
  });
});

bot.action('reseller_riwayat', async (ctx) => {
  const userId = ctx.from.id;

  db.all(`
    SELECT akun_type, username, komisi, created_at 
    FROM reseller_sales 
    WHERE reseller_id = ? 
    ORDER BY datetime(created_at) DESC 
    LIMIT 10
  `, [userId], async (err, rows) => {
    if (err) {
      logger.error('❌ Gagal ambil riwayat reseller:', err.message);
      return ctx.reply('⚠️ Gagal mengambil riwayat penjualan.', {
        parse_mode: 'Markdown'
      });
    }

    if (!rows || rows.length === 0) {
      return ctx.reply('📭 Belum ada riwayat penjualan.', {
        parse_mode: 'Markdown'
      });
    }

    let text = '*📊 Riwayat Penjualan Terakhir:*\n\n';
    rows.forEach((row, i) => {
      const tanggal = new Date(row.created_at).toLocaleString('id-ID');
      text += `🔹 ${i + 1}. ${row.akun_type.toUpperCase()} - \`${row.username}\`\n💰 Komisi: Rp${row.komisi.toLocaleString('id-ID')}\n🕒 ${tanggal}\n\n`;
    });

    ctx.reply(text.trim(), { parse_mode: 'Markdown' });
  });
});

// Handler untuk Log All Topup (FINAL KOREKSI)
bot.action('admin_view_topup', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (!adminIds.includes(userId)) {
    return ctx.answerCbQuery('🚫 Akses ditolak.');
  }

  try {
    await ctx.answerCbQuery('⏳ Mengambil data log topup...');

    // 1. QUERY DIKOREKSI: Menggunakan created_at dan reference
    const allTopups = await new Promise((resolve, reject) => {
      // Kolom yang ada di tabel: created_at, user_id, username, amount, reference
      db.all("SELECT created_at, user_id, username, amount, reference FROM topup_log ORDER BY created_at DESC", (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    if (allTopups.length === 0) {
      await ctx.reply('ℹ️ *Tidak ada data riwayat topup ditemukan.*', { parse_mode: 'Markdown' });
      return ctx.answerCbQuery('Tidak ada data.');
    }

    // 2. Format data ke dalam string log (Menggunakan created_at & reference)
    let logContent = '=== LOG ALL TOPUP BOT SELLVPN ===\n';
    logContent += `Total Transaksi: ${allTopups.length}\n`;
    logContent += `Tanggal Export: ${new Date().toLocaleString('id-ID')}\n\n`;

    allTopups.forEach((topup, index) => {
      // Menggunakan created_at
      const date = new Date(topup.created_at); 
      const formattedDate = date.toLocaleString('sv').replace(' ', ' '); 

      logContent += `[${index + 1}]\n`;
      logContent += `  Waktu    : ${formattedDate}\n`;
      logContent += `  User ID  : ${topup.user_id}\n`;
      logContent += `  Username : @${topup.username || 'N/A'}\n`;
      logContent += `  Jumlah   : Rp ${topup.amount.toLocaleString('id-ID')}\n`;
      // Menggunakan reference
      if (topup.reference) { 
        logContent += `  Ref/Ket  : ${topup.reference}\n`;
      }
      logContent += '-------------------------\n';
    });

    // 3. Simpan dan Kirim File
    const dateStr = new Date().toLocaleString('sv').replace(/[^0-9]/g, ''); 
    const logFileName = `log_topup_${dateStr}.txt`;
    const logFilePath = path.join(os.tmpdir(), logFileName); 

    fs.writeFileSync(logFilePath, logContent, 'utf8');

    await ctx.telegram.sendDocument(ctx.chat.id, { 
      source: logFilePath, 
      filename: logFileName 
    });

    await ctx.reply(`✅ *Log ${allTopups.length} riwayat topup berhasil dibuat dan dikirim.*`, { parse_mode: 'Markdown' });

    fs.unlinkSync(logFilePath);

  } catch (error) {
    const errorMessage = error.message || 'Error tidak diketahui';
    console.error('❌ Gagal membuat log topup:', errorMessage); // Pakai console.error untuk log
    
    await ctx.reply(
      `❌ *Gagal membuat log topup.*\n\nDetail Error: \`${errorMessage}\`\n\n*SOLUSI:* Pastikan tabel \`topup_log\` ada di database dan memiliki kolom yang benar.`, 
      { parse_mode: 'Markdown' }
    );
  }
});



// ===================== ACTION: TRIAL AKUN =====================
bot.action('trial_ssh', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'ssh');
});


bot.action('trial_vmess', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'vmess');
});

bot.action('trial_vless', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'vless');
});

bot.action('trial_trojan', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'trojan');
});

bot.action('trial_shadowsocks', async (ctx) => {
  await ctx.answerCbQuery();
  await showTrialServerMenu(ctx, 'shadowsocks');
});


// ——— OPTIONAL: helper kalau belum ada
const escapeHTML = (s = '') =>
  String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

bot.action(/^trial_server_ssh_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  const rawName = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
  const mention = ctx.from.username
    ? `${ctx.from.username}`
    : `<a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>`;

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await ctx.reply('✅ Proses trial berjalan, cek DM ya bro!');
  }

  try {
    // ---------- 1) CEK LIMIT TRIAL ----------
    const check = await canTakeTrial(String(userId));
    if (!check.allowed) {
      return ctx.reply(
        `❌ Kamu sudah memakai jatah trial.\n\n` +
        `📅 Terakhir: ${check.last || '-'}\n` +
        `🔢 Dipakai: ${check.trialCount}/${check.maxTrial}`
      );
    }
    const maxShow = Number.isFinite(check.maxTrial) ? check.maxTrial : '∞';

    // ---------- 2) AMBIL DATA SERVER ----------
    const server = await dbGetAsync('SELECT nama_server, domain, auth FROM Server WHERE id = ?', [serverId]);
    if (!server) return ctx.reply('❌ Server tidak ditemukan.');

    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialssh?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let api;
    try {
      api = await axios.get(url, { timeout: 12000 });
    } catch (err) {
      console.error('Error connecting to trial API:', err?.message || err);
      return ctx.reply('❌ Tidak bisa menghubungi API SSH.');
    }

    if (!api.data || api.data.status !== 'success') {
      return ctx.reply('❌ Gagal membuat akun trial SSH.');
    }

    const d = api.data.data || api.data;
    const username = d.username || '-';
    const password = d.password || '-';
    const expired = d.expiration || d.exp || d.expired || '-';
    const ns = d.ns_domain || '-';
    const city = d.city || '-';
    const ipLimit = d.ip_limit || d.iplimit || '-';
    const pubkey = d.public_key || d.pubkey || 'Not Available';
    const p = d.ports || {};
    const pick = (k, def) => (p && (p[k] || p[k.toLowerCase()])) || def;

    // ---------- 4) CLAIM ATOMIK (BARU) ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      console.warn('Claim trial failed due to limit/race for user', userId);
      return ctx.reply('⚠️ Trial ditolak (limit atau race). Coba lagi nanti.');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'ssh']
    );

    const msg =
`🌟 *AKUN SSH TRIAL* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Password* : \`${password}\`
└─────────────────────
┌─────────────────────
│ *Domain*   : \`${domain}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *OpenSSH*  : \`${pick('openssh','22')}\`
│ *UdpSSH*   : \`${pick('udp_ssh','1-65535')}\`
│ *DNS*      : \`443, 53, 22\`
│ *Dropbear* : \`${pick('dropbear','443, 109')}\`
│ *SSH WS*   : \`${pick('ssh_ws','80')}\`
│ *SSH SSL WS*: \`${pick('ssh_ssl_ws','443')}\`
│ *SSL/TLS*  : \`443\`
│ *OVPN SSL* : \`443\`
│ *OVPN TCP* : \`${pick('ovpn_tcp','1194')}\`
│ *OVPN UDP* : \`${pick('ovpn_udp','2200')}\`
│ *BadVPN UDP*: \`${pick('badvpn','7100, 7200, 7300')}\`
└─────────────────────
🔒 *PUBKEY*
\`\`\`
${pubkey}
\`\`\`
🔗 *Link dan Payload*
───────────────────────
WSS Payload:
\`\`\`
GET wss://BUG.COM/ HTTP/1.1
Host: ${domain}
Upgrade: websocket
\`\`\`

OpenVPN Link: [Download OVPN](https://${domain}:81/allovpn.zip)  
Save Account: [Klik Disini](https://${domain}:81/ssh-${username}.txt)

┌─────────────────────
│ *Expires:* \`${expired}\`
│ *IP Limit:* \`${ipLimit}\`
└─────────────────────

✨ Selamat menggunakan layanan kami! ✨`;

    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    // ============================
    // 🔔 NOTIF GRUP (Fix Sama Semua)
    // ============================
    if (GROUP_ID) {
      const roleLabel =
        check.role === 'admin' ? 'Admin' :
        check.role === 'reseller' ? 'Reseller' :
        'User';

      const notifHtml = `
<blockquote>
⏰ <b>TRIAL ACCOUNT SSH</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
🏷 <b>Trial By:</b> ${roleLabel.toUpperCase()} | ${claim.trialKe} dari ${maxShow}
📝 <b>Protocol:</b> <code>Ssh</code>
🌐 <b>Server:</b> ${server.nama_server}
⏳ <b>Duration:</b> 60 Minutes
🕒 <b>Time:</b> <b>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</b>
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();

      await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' }).catch(e => {
        console.warn('Gagal kirim notif grup:', e && e.message);
      });
    }

  } catch (err) {
    console.error('Unhandled error in trial_server_ssh handler:', err);
    await ctx.reply('❌ Terjadi error saat proses trial SSH.');
  }
});

// === TRIAL VMESS — tampil mirror createvmess (Markdown + code blocks) ===
bot.action(/^trial_server_vmess_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;

  const rawName = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
  const mention = rawName;

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  try {
    // ---------- 1) CEK LIMIT TRIAL ----------
    const check = await canTakeTrial(String(userId));
    if (!check.allowed) {
      return await bot.telegram.sendMessage(
        chatId,
        `❌ Kamu sudah memakai jatah trial.\n\n` +
        `📅 Terakhir: ${check.last || '-'}\n` +
        `🔢 Dipakai: ${check.trialCount}/${check.maxTrial}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER ----------
    const serverRow = await dbGetAsync(
      'SELECT nama_server, domain, auth FROM Server WHERE id = ?',
      [serverId]
    );
    if (!serverRow) {
      return await bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');
    }

    const { nama_server: namaServer, domain, auth } = serverRow;
    const url = `http://${domain}:5888/trialvmess?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 12000 });
    } catch (e) {
      console.error('Error call trialvmess API:', e?.message || e);
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial VMESS.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial VMESS.\n\nDetail: ${msgErr}`);
    }

    // mapping response lengkap
    const d = apiRes.data.data || apiRes.data;

    const username   = d.username || '-';
    const uuid       = d.uuid || '-';
    const domainOut  = d.domain || domain || '-';
    const ns_domain  = d.ns_domain || d.ns || '-';
    const city       = d.city || '-';
    const public_key = d.public_key || d.pubkey || 'Public key not available';
    const expiration = d.expiration || d.exp || d.expired || '-';
    const quota      = d.quota || d.quota_gb || '0 GB';
    const ip_limit   = d.ip_limit || d.iplimit || '0';

    const vmess_tls_link    = d.link_tls  || d.vmess_tls_link  || '-';
    const vmess_nontls_link = d.link_ntls || d.vmess_nontls_link || '-';
    const vmess_grpc_link   = d.link_grpc || d.vmess_grpc_link   || '-';

    // ---------- 4) CLAIM ATOMIK (BARU) ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      console.warn('Claim trial VMESS failed due to limit/race for user', userId);
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (limit atau race). Coba lagi nanti.');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'vmess']
    );

    const trialKe = claim.trialKe;

    // ==== PESAN AKUN ====
    const msg = `
🌟 *AKUN VMESS TRIAL* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Domain*   : \`${domainOut}\`
│ *Kota*     : \`${city}\`
│ *NS*       : \`${ns_domain}\`
│ *UUID*     : \`${uuid}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Network*  : \`Websocket (WS)\`
│ *Path*     : \`/vmess\`
│ *Path GRPC*: \`vmess-grpc\`
└─────────────────────

🔐 *URL VMESS TLS*
\`\`\`
${vmess_tls_link}
\`\`\`

🔓 *URL VMESS HTTP*
\`\`\`
${vmess_nontls_link}
\`\`\`

🔒 *URL VMESS GRPC*
\`\`\`
${vmess_grpc_link}
\`\`\`

🔑 *PUBKEY*
\`\`\`
${public_key}
\`\`\`

┌─────────────────────
│ *Expired:* \`${expiration}\`
│ *Quota:* \`${quota === '0 GB' ? 'Unlimited' : quota}\`
│ *IP Limit:* \`${ip_limit === '0' ? 'Unlimited' : ip_limit + ' IP'}\`
└─────────────────────

📄 *Save Account:*  
https://${domainOut}:81/vmess-${username}.txt

✨ Selamat menggunakan layanan kami! ✨
`.trim();

    await bot.telegram.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    // ==== NOTIF GRUP ====
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
      const roleLabel = check.role === 'admin' ? 'Admin' : check.role === 'reseller' ? 'Reseller' : 'User';
      const headerText = '⏰ <b>TRIAL ACCOUNT VMESS</b>';
      const notifHtml = `
<blockquote>
${headerText}
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
🏷 <b>Trial By:</b> ${roleLabel.toUpperCase()} | ${trialKe} dari ${check.maxTrial === Infinity ? '∞' : check.maxTrial}
📝 <b>Protocol:</b> <code>Vmess</code>
🌐 <b>Server:</b> ${namaServer}
⏳ <b>Duration:</b> 60 Minutes
🕒 <b>Time:</b> <b>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</b>
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {
        console.warn('Gagal kirim notif VMESS:', e.message);
      }
    }

  } catch (err) {
    console.error('❌ Error trial VMESS:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial VMESS.');
  }
});

// === TRIAL VLESS — mirror createvless + notif tetap ===
bot.action(/^trial_server_vless_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  const rawName = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
  const mention = escapeMarkdown(rawName);

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  try {
    // ---------- 1) CEK LIMIT TRIAL ----------
    const check = await canTakeTrial(String(userId));
    if (!check.allowed) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ Kamu sudah memakai jatah trial.\n\n` +
        `📅 Terakhir: ${check.last || '-'}\n` +
        `🔢 Dipakai: ${check.trialCount}/${check.maxTrial}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER ----------
    const server = await dbGetAsync('SELECT nama_server, domain, auth FROM Server WHERE id = ?', [serverId]);
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');

    const namaServer = server.nama_server;
    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialvless?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 15000 });
    } catch (e) {
      console.error('❌ Gagal call API trialvless:', e?.message || e);
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial VLESS di server. Coba lagi nanti.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial VLESS.\n\nDetail: ${msgErr}`);
    }

    const d = apiRes.data.data || apiRes.data;
    const username   = d.username || '-';
    const uuid       = d.uuid || d.password || '-';
    const domainOut  = d.domain || domain || '-';
    const pubkey     = d.public_key || d.pubkey || 'N/A';
    const expired    = d.expired || d.expiration || d.exp || 'N/A';
    const quota      = d.quota || d.quota_gb || '0 GB';
    const ip_limit   = d.ip_limit || d.iplimit || '0';
    const tls_link   = d.vless_tls_link || d.link_tls || '-';
    const ntls_link  = d.vless_nontls_link || d.link_ntls || '-';
    const grpc_link  = d.vless_grpc_link || d.link_grpc || '-';

    // ---------- 4) CLAIM ATOMIK ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      console.warn('Claim trial VLESS failed due to limit/race for user', userId);
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (limit atau race). Coba lagi nanti.');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'vless']
    );

    const trialKe = claim.trialKe;

    const replyText = `
🌟 *AKUN VLESS TRIAL* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Domain*   : \`${domainOut}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Security* : \`Auto\`
│ *Network*  : \`Websocket (WS)\`
│ *Path*     : \`/vless\`
│ *Path GRPC*: \`vless-grpc\`
└─────────────────────
🔐 *URL VLESS TLS*
\`\`\`
${tls_link}
\`\`\`
🔓 *URL VLESS HTTP*
\`\`\`
${ntls_link}
\`\`\`
🔒 *URL VLESS GRPC*
\`\`\`
${grpc_link}
\`\`\`
🔒 *UUID & PUBKEY*
\`\`\`
${uuid}
\`\`\`
\`\`\`
${pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${expired}\`
│ Quota: \`${quota === '0 GB' ? 'Unlimited' : quota}\`
│ IP Limit: \`${ip_limit === '0' ? 'Unlimited' : ip_limit + ' IP'}\`
└─────────────────────
Save Account Link: [Save Account](https://${domainOut}:81/vless-${username}.txt)
✨ Selamat menggunakan layanan kami! ✨
    `.trim();

    await bot.telegram.sendMessage(chatId, replyText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    // ====== NOTIF KE GROUP ======
    if (GROUP_ID) {
      const roleLabel = check.role === 'admin' ? 'Admin' : check.role === 'reseller' ? 'Reseller' : 'User';
      const headerText = '⏰ <b>TRIAL ACCOUNT VLESS</b>';
      const notifHtml = `
<blockquote>
${headerText}
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
🏷 <b>Trial By:</b> ${roleLabel.toUpperCase()} | ${trialKe} dari ${check.maxTrial === Infinity ? '∞' : check.maxTrial}
📝 <b>Protocol:</b> <code>VLESS</code>
🌐 <b>Server:</b> ${namaServer}
⏳ <b>Duration:</b> 60 Minutes
🕒 <b>Time:</b> <b>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</b>
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();
      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {
        console.warn('Gagal kirim notif VLESS:', e && e.message);
      }
    }

  } catch (err) {
    console.error('❌ Gagal proses trial VLESS:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial VLESS. Coba lagi nanti.');
  }
});
// === TRIAL TROJAN — tampil mirror createtrojan (kotak + code blocks) + notif tetap ===
bot.action(/^trial_server_trojan_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  const rawName = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
  const mention = escapeMarkdown(rawName);

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  try {
    // ---------- 1) CEK LIMIT TRIAL ----------
    const check = await canTakeTrial(String(userId));
    if (!check.allowed) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ Kamu sudah memakai jatah trial.\n\n` +
        `📅 Terakhir: ${check.last || '-'}\n` +
        `🔢 Dipakai: ${check.trialCount}/${check.maxTrial}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER ----------
    const server = await dbGetAsync('SELECT nama_server, domain, auth FROM Server WHERE id = ?', [serverId]);
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');

    const namaServer = server.nama_server;
    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialtrojan?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 15000 });
    } catch (e) {
      console.error('❌ Gagal call API trialtrojan:', e?.message || e);
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial TROJAN di server. Coba lagi nanti.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial TROJAN.\n\nDetail: ${msgErr}`);
    }

    // mapping response
    const d = apiRes.data.data || apiRes.data;
    const username       = d.username || '-';
    const domainOut      = d.domain || domain || '-';
    const trojan_tls_link  = d.trojan_tls_link || d.trojan_tls || d.link_tls || '-';
    const trojan_grpc_link = d.trojan_grpc_link || d.trojan_grpc || d.link_grpc || '-';
    const pubkey         = d.pubkey || d.public_key || d.publicKey || 'Not Available';
    const uuid_or_pass   = d.uuid || d.password || '-';
    const expired        = d.expired || d.expiration || d.exp || 'N/A';
    const quota          = d.quota || d.quota_gb || '0 GB';
    const ip_limit       = (typeof d.ip_limit !== 'undefined') ? String(d.ip_limit) : (d.iplimit || '0');

    // ---------- 4) CLAIM ATOMIK ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      console.warn('Claim trial TROJAN failed due to limit/race for user', userId);
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (limit atau race). Coba lagi nanti.');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'trojan']
    );

    const trialKe = claim.trialKe;
    const roleLabel = check.role === 'admin' ? 'Admin' : check.role === 'reseller' ? 'Reseller' : 'User';

    const msg = `
🌟 *AKUN TROJAN TRIAL* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Domain*   : \`${domainOut}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Security* : \`Auto\`
│ *Network*  : \`Websocket (WS)\`
│ *Path*     : \`/trojan-ws\`
│ *Path GRPC*: \`trojan-grpc\`
└─────────────────────
🔐 *URL TROJAN TLS*
\`\`\`
${trojan_tls_link}
\`\`\`
🔒 *URL TROJAN GRPC*
\`\`\`
${trojan_grpc_link}
\`\`\`
🔒 *PUBKEY*
\`\`\`
${pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${expired}\`
│ Quota: \`${quota === '0 GB' ? 'Unlimited' : quota}\`
│ IP Limit: \`${ip_limit === '0' ? 'Unlimited' : ip_limit + ' IP'}\`
└─────────────────────
🔐 *Password/UUID*
\`\`\`
${uuid_or_pass}
\`\`\`
Save Account Link: [Save Account](https://${domainOut}:81/trojan-${username}.txt)
✨ Selamat menggunakan layanan kami! ✨
    `.trim();

    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    // ====== NOTIF GROUP ======
    if (GROUP_ID) {
      const headerText = '⏰ <b>TRIAL ACCOUNT TROJAN</b>';
      const notifHtml = `
<blockquote>
${headerText}
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
🏷 <b>Trial By:</b> ${roleLabel.toUpperCase()} | ${trialKe} dari ${check.maxTrial === Infinity ? '∞' : check.maxTrial}
📝 <b>Protocol:</b> <code>TROJAN</code>
🌐 <b>Server:</b> ${namaServer}
⏳ <b>Duration:</b> 60 Minutes
🕒 <b>Time:</b> <b>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</b>
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();
      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {
        console.warn('Gagal kirim notif TROJAN:', e && e.message);
      }
    }

  } catch (err) {
    console.error('❌ Gagal proses trial TROJAN:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial TROJAN.');
  }
});

// === TRIAL SHADOWSOCKS — mirror createshadowsocks (kotak + codeblock) + notif tetap ===
bot.action(/^trial_server_shadowsocks_(\d+)$/, async (ctx) => {
  const serverId = ctx.match[1];
  const userId = ctx.from.id;
  const chatId = ctx.chat.type === 'private' ? ctx.chat.id : ctx.from.id;
  const rawName = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
  const mention = escapeMarkdown(rawName);

  await ctx.answerCbQuery().catch(() => {});
  if (ctx.chat.type !== 'private') {
    await bot.telegram.sendMessage(chatId, '✅ Proses trial berjalan, cek DM ya bro!');
  }

  try {
    // ---------- 1) CEK LIMIT TRIAL ----------
    const check = await canTakeTrial(String(userId));
    if (!check.allowed) {
      return bot.telegram.sendMessage(
        chatId,
        `❌ Kamu sudah memakai jatah trial.\n\n` +
        `📅 Terakhir: ${check.last || '-'}\n` +
        `🔢 Dipakai: ${check.trialCount}/${check.maxTrial}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ---------- 2) AMBIL DATA SERVER ----------
    const server = await dbGetAsync('SELECT nama_server, domain, auth FROM Server WHERE id = ?', [serverId]);
    if (!server) return bot.telegram.sendMessage(chatId, '❌ Server tidak ditemukan di database.');

    const namaServer = server.nama_server;
    const domain = server.domain;
    const auth = server.auth;
    const url = `http://${domain}:5888/trialshadowsocks?auth=${encodeURIComponent(auth)}`;

    // ---------- 3) PANGGIL API REMOTE ----------
    let apiRes;
    try {
      apiRes = await axios.get(url, { timeout: 15000 });
    } catch (e) {
      console.error('❌ Gagal call API trialshadowsocks:', e?.message || e);
      return bot.telegram.sendMessage(chatId, '❌ Gagal menghubungi API trial SHADOWSOCKS di server. Coba lagi nanti.');
    }

    if (!apiRes.data || apiRes.data.status !== 'success') {
      const msgErr = apiRes.data?.message || 'Unknown error';
      return bot.telegram.sendMessage(chatId, `❌ Gagal membuat akun trial SHADOWSOCKS.\n\nDetail: ${msgErr}`);
    }

    // mapping response
    const d = apiRes.data.data || apiRes.data;
    const username   = d.username || '-';
    const password   = d.password || d.uuid || '-';
    const method     = d.method || '-';
    const ns_domain  = d.ns_domain || '-';
    const city       = d.city || '-';
    const public_key = d.public_key || d.pubkey || 'Not Available';
    const expiration = d.expiration || d.exp || '-';
    const link_ws    = d.ss_link_ws || d.link_ws || 'N/A';
    const link_grpc  = d.ss_link_grpc || d.link_grpc || 'N/A';

    // ---------- 4) CLAIM ATOMIK ----------
    const claim = await claimTrialAtomic(String(userId));
    if (!claim.ok) {
      console.warn('Claim trial Shadowsocks failed due to limit/race for user', userId);
      return bot.telegram.sendMessage(chatId, '⚠️ Trial ditolak (limit atau race). Coba lagi nanti.');
    }

    // ---------- 5) INSERT LOG & KIRIM PESAN ----------
    await dbRunAsync(
      'INSERT INTO trial_logs (user_id, username, jenis, created_at) VALUES (?, ?, ?, datetime("now"))',
      [userId, username, 'shadowsocks']
    );

    const trialKe = claim.trialKe;
    const roleLabel = check.role === 'admin' ? 'Admin' : check.role === 'reseller' ? 'Reseller' : 'User';

    const msg = `
🌟 *AKUN SHADOWSOCKS TRIAL* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${username}\`
│ *Password* : \`${password}\`
│ *Method*   : \`${method}\`
│ *Domain*   : \`${domain}\`
│ *Kota*     : \`${city}\`
│ *NS*       : \`${ns_domain}\`
└─────────────────────

🔒 *PUBKEY*
\`\`\`
${public_key}
\`\`\`

🔌 *URL SHADOWSOCKS TLS (WS)*
\`\`\`
${link_ws}
\`\`\`

🔌 *URL SHADOWSOCKS GRPC*
\`\`\`
${link_grpc}
\`\`\`

┌─────────────────────
│ Expiry: \`${expiration}\`
│ Limit IP: \`Unlimited\`
└─────────────────────
Save Account Link: [Download](https://${domain}:81/shadowsocks-${username}.txt)

✨ Selamat menggunakan layanan kami! ✨
    `.trim();

    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    // ====== NOTIF GROUP ======
    if (GROUP_ID) {
      const headerText = '⏰ <b>TRIAL ACCOUNT SHADOWSOCKS</b>';
      const notifHtml = `
<blockquote>
${headerText}
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
🏷 <b>Trial By:</b> ${roleLabel.toUpperCase()} | ${trialKe} dari ${check.maxTrial === Infinity ? '∞' : check.maxTrial}
📝 <b>Protocol:</b> <code>SHADOWSOCKS</code>
🌐 <b>Server:</b> ${namaServer}
⏳ <b>Duration:</b> 60 Minutes
🕒 <b>Time:</b> <b>${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</b>
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();

      try {
        await bot.telegram.sendMessage(GROUP_ID, notifHtml, { parse_mode: 'HTML' });
      } catch (e) {
        console.warn('Gagal kirim notif SHADOWSOCKS:', e && e.message);
      }
    }

  } catch (err) {
    console.error('❌ Gagal proses trial SHADOWSOCKS:', err);
    return bot.telegram.sendMessage(chatId,'❌ Terjadi kesalahan saat proses trial SHADOWSOCKS.');
  }
});


bot.action('send_main_menu', async (ctx) => {
  await sendMainMenu(ctx);
});

bot.action(/^service_(create|renew|trial)$/, async (ctx) => {
  const action = ctx.match[1];
  await handleServiceAction(ctx, action);
});

// ===================== ACTION: CREATE / RENEW =====================
bot.action('create_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vmess');
});

bot.action('create_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vless');
});

bot.action('create_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'trojan');
});

bot.action('create_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'shadowsocks');
});

bot.action('create_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'ssh');
});

bot.action('renew_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vmess');
});

bot.action('renew_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vless');
});

bot.action('renew_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'trojan');
});

bot.action('renew_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'shadowsocks');
});

bot.action('renew_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'ssh');
});


bot.action(/navigate_(\w+)_(\w+)_(\d+)/, async (ctx) => {
  const [, action, type, page] = ctx.match;
  await startSelectServer(ctx, action, type, parseInt(page, 10));
});
bot.action(/(create|renew)_username_(vmess|vless|trojan|shadowsocks|ssh)_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const serverId = ctx.match[3];
  userState[ctx.chat.id] = { step: `username_${action}_${type}`, serverId, type, action };

  db.get('SELECT batas_create_akun, total_create_akun FROM Server WHERE id = ?', [serverId], async (err, server) => {
    if (err) {
      logger.error('⚠️ Error fetching server details:', err.message);
      return ctx.reply('❌ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
    }

    if (!server) {
      return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const batasCreateAkun = server.batas_create_akun;
    const totalCreateAkun = server.total_create_akun;

    if (totalCreateAkun >= batasCreateAkun) {
      return ctx.reply('❌ *Server penuh. Tidak dapat membuat akun baru di server ini.*', { parse_mode: 'Markdown' });
    }

    await ctx.reply('👤 *Masukkan username:*', { parse_mode: 'Markdown' });
  });
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const state = userState[chatId];
  const text = ctx.message.text.trim();

  if (!state || typeof state !== 'object') return;

  try {
    // 🧾 Langkah 1: Username
    if (typeof state.step === 'string' && state.step.startsWith('username_')) {
      if (!/^[a-zA-Z0-9]{3,20}$/.test(text)) {
        return ctx.reply('❌ *Username tidak valid.*', { parse_mode: 'Markdown' });
      }

      state.username = text;

      if (state.action === 'create' && state.type === 'ssh') {
        state.step = `password_${state.action}_${state.type}`;
        return ctx.reply('🔑 *Masukkan password:*', { parse_mode: 'Markdown' });
      }

      state.step = `exp_${state.action}_${state.type}`;
      return ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }

    // 🧾 Langkah 2: Password SSH
    if (state.step.startsWith('password_')) {
      if (!/^[a-zA-Z0-9]{6,}$/.test(text)) {
        return ctx.reply('❌ *Password minimal 6 karakter dan tanpa simbol.*', { parse_mode: 'Markdown' });
      }

      state.password = text;
      state.step = `exp_${state.action}_${state.type}`;
      return ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }

    // 🧾 Langkah 3: Expired Days
    if (state.step.startsWith('exp_')) {
      const days = parseInt(text);
      if (isNaN(days) || days <= 0 || days > 365) {
        return ctx.reply('❌ *Masa aktif tidak valid.*', { parse_mode: 'Markdown' });
      }

      const { username, password, serverId, type, action } = state;
      state.exp = days;

      const server = await dbGetAsync(`
     SELECT nama_server, domain, quota, iplimit, harga 
     FROM Server 
     WHERE id = ?
     `, [serverId]);
      let user = await dbGetAsync('SELECT saldo, role, reseller_level FROM users WHERE user_id = ?', [userId]);

      if (!user) {
        await dbRunAsync(
          `INSERT INTO users (user_id, username, saldo, role, reseller_level) VALUES (?, ?, 0, 'user', 'silver')`,
          [userId, ctx.from.username]
        );
        user = { saldo: 0, role: 'user', reseller_level: 'silver' };
      }

      if (!server) return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
                  
      const diskon = user.role === 'reseller'
        ? user.reseller_level === 'gold' ? 0.3
        : user.reseller_level === 'platinum' ? 0.4
        : 0.2
        : 0;

      const hargaSatuan = Math.floor(server.harga * (1 - diskon));
      const totalHarga = hargaSatuan * days;
      const komisi = user.role === 'reseller' ? Math.floor(totalHarga * 0.1) : 0;

      if (user.saldo < totalHarga) {
        return ctx.reply('❌ *Saldo tidak mencukupi.*', { parse_mode: 'Markdown' });
      }
      
      if (action === 'renew') {
        const row = await dbGetAsync(
          'SELECT * FROM akun_aktif WHERE username = ? AND jenis = ?',
          [username, type]
        );
        if (!row) {
          return ctx.reply('❌ *Akun tidak ditemukan atau tidak aktif.*', { parse_mode: 'Markdown' });
        }
      }

      await dbRunAsync('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [totalHarga, userId]);

      const handlerMap = {
        create: {
          vmess: () => createvmess(username, days, server.quota, server.iplimit, serverId),
          vless: () => createvless(username, days, server.quota, server.iplimit, serverId),
          trojan: () => createtrojan(username, days, server.quota, server.iplimit, serverId),
          shadowsocks: () => createshadowsocks(username, days, server.quota, server.iplimit, serverId),
          ssh: () => createssh(username, password, days, server.iplimit, serverId)
        },
        renew: {
          vmess: () => renewvmess(username, days, server.quota, server.iplimit, serverId),
          vless: () => renewvless(username, days, server.quota, server.iplimit, serverId),
          trojan: () => renewtrojan(username, days, server.quota, server.iplimit, serverId),
          shadowsocks: () => renewshadowsocks(username, days, server.quota, server.iplimit, serverId),
          ssh: () => renewssh(username, days, server.iplimit, serverId)
        }
      };

      const handler = handlerMap[action]?.[type];
      if (!handler) return ctx.reply('❌ *Tipe layanan tidak dikenali.*', { parse_mode: 'Markdown' });

      const msg = await handler();
      if (!msg || typeof msg !== 'string') {
        return ctx.reply('❌ *Terjadi kesalahan saat membuat akun.*', { parse_mode: 'Markdown' });
      }

      await dbRunAsync('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId]);
      await dbRunAsync(`
        INSERT INTO invoice_log (user_id, username, layanan, akun, hari, harga, komisi, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [userId, ctx.from.username || ctx.from.first_name, type, username, days, totalHarga, komisi]);

      if (action === 'create') {
        await dbRunAsync('INSERT OR REPLACE INTO akun_aktif (username, jenis) VALUES (?, ?)', [username, type]);
      }

      if (user.role === 'reseller') {
        await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [komisi, userId]);
        await dbRunAsync(`
          INSERT INTO reseller_sales (reseller_id, buyer_id, akun_type, username, komisi, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `, [userId, userId, type, username, komisi]);

        const res = await dbGetAsync('SELECT SUM(komisi) AS total_komisi FROM reseller_sales WHERE reseller_id = ?', [userId]);
        const totalKomisi = res?.total_komisi || 0;
        const prevLevel = user.reseller_level || 'silver';
        const level = totalKomisi >= 80000 ? 'platinum' : totalKomisi >= 50000 ? 'gold' : 'silver';
        const levelOrder = { silver: 1, gold: 2, platinum: 3 };

        if (level !== prevLevel) {
        await dbRunAsync('UPDATE users SET reseller_level = ? WHERE user_id = ?', [level, userId]);

        if (GROUP_ID) {
        const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
        const naik = levelOrder[level] > levelOrder[prevLevel];
        const icon = naik ? '📈 *Level Naik!*' : '📉 *Level Turun!*';
        const notif = `${icon}\n\n💌 ${mention}\n🎖️ Dari: *${prevLevel.toUpperCase()}* ke *${level.toUpperCase()}*`;

        await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: 'Markdown' });
  }
}
      }

const mention = ctx.from.username ? `${ctx.from.username}` : ctx.from.first_name;
const isReseller = user?.role === 'reseller';
const label = isReseller ? 'Reseller' : 'User';
const actionLabel = action === 'renew' ? '🏷 Renew By' : '🏷 Create By';
const headerText = action === 'renew' ? '✅ ACCOUNT RENEWED' : '✅ ACCOUNT CREATED';

const serverNama = server?.nama_server || server?.domain || 'Unknown Server';
const ipLimit = server?.iplimit || iplimit || '-';
const durasiHari = days || 30;
const waktuSekarang = new Date().toLocaleString('id-ID', {
  timeZone: 'Asia/Jakarta'
});

// Fungsi untuk Title Case
function toTitleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// === NOTIF HTML BLOCKQUOTE ===
const invoiceHtml = `
<blockquote>
<b>${headerText}</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>User:</b> ${mention} (<code>${ctx.from.id}</code>)
<b>${actionLabel}:</b> ${label.toUpperCase()}
🎟 <b>Username:</b> <code>${username}</code>
📝 <b>Protocol:</b> <code>${toTitleCase(type)}</code>
🌐 <b>Server:</b> ${serverNama} (${ipLimit} IP)
⏳ <b>Duration:</b> ${durasiHari} Days
🕒 <b>Time:</b> ${waktuSekarang}
━━━━━━━━━━━━━━━━━━━━
</blockquote>
`.trim();

// Kirim ke GROUP dengan HTML
await bot.telegram.sendMessage(GROUP_ID, invoiceHtml, {
  parse_mode: 'HTML'
});

// Kirim ke user
await ctx.reply(msg, {
  parse_mode: 'Markdown',
  disable_web_page_preview: true
});

delete userState[chatId];
    }
  } catch (err) {
    logger.error('❌ Error on text handler:', err.message);
    await ctx.reply('❌ *Terjadi kesalahan saat memproses permintaan.*', { parse_mode: 'Markdown' });
    delete userState[chatId];
  }


       ///ubahLevel
     if (state.step === 'await_level_change') {
  const [idStr, level] = text.split(' ');
  const validLevels = ['silver', 'gold', 'platinum'];
  const targetId = parseInt(idStr);

  if (isNaN(targetId) || !validLevels.includes(level)) {
    return ctx.reply('❌ *Format salah.*\nContoh: `123456789 gold`\nLevel valid: silver, gold, platinum', {
      parse_mode: 'Markdown'
    });
  }

  db.run(
    `UPDATE users SET reseller_level = ? WHERE user_id = ? AND role = 'reseller'`,
    [level, targetId],
    function (err) {
      if (err) {
        logger.error('❌ DB error saat ubah level:', err.message);
        return ctx.reply('❌ *Gagal mengubah level reseller.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        return ctx.reply('⚠️ *User tidak ditemukan atau bukan reseller.*', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ *User ${targetId} diubah menjadi reseller ${level.toUpperCase()}.*`, {
        parse_mode: 'Markdown'
      });
    }
  );

  delete userState[ctx.chat.id];
  return;
}
     // downgrade
     if (state.step === 'await_downgrade_id') {
  const targetId = parseInt(text);
  if (isNaN(targetId)) {
    return ctx.reply('❌ *ID tidak valid.*', { parse_mode: 'Markdown' });
  }

  db.run(
    `UPDATE users SET role = 'user', reseller_level = NULL WHERE user_id = ?`,
    [targetId],
    function (err) {
      if (err) {
        logger.error('❌ DB error saat downgrade reseller:', err.message);
        return ctx.reply('❌ *Gagal downgrade user.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        return ctx.reply('⚠️ *User belum terdaftar.*', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ *User ${targetId} telah di-*downgrade* menjadi USER biasa.*`, {
        parse_mode: 'Markdown'
      });
    }
  );

  delete userState[ctx.chat.id];
  return;
}

     // 🎖️ Promote Reseller - Input via tombol admin
if (state.step === 'await_reseller_id') {
  const targetId = parseInt(text);
  if (isNaN(targetId)) {
    return ctx.reply('⚠️ *ID tidak valid. Masukkan angka.*', { parse_mode: 'Markdown' });
  }

  db.run(
    `UPDATE users SET role = 'reseller', reseller_level = 'silver' WHERE user_id = ?`,
    [targetId],
    function (err) {
      if (err) {
        logger.error('❌ DB error saat promote:', err.message);
        return ctx.reply('❌ *Gagal promote user.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        return ctx.reply('⚠️ *User belum terdaftar.*', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ *User ${targetId} sukses dipromosikan jadi RESELLER level Silver!*`, {
        parse_mode: 'Markdown'
      });
    }
  );

  delete userState[ctx.chat.id];
  return;
}
     ///rsesetkomisi
     if (state.step === 'reset_komisi_input') {
  const targetId = parseInt(text);
  if (isNaN(targetId)) {
    return ctx.reply(escapeMarkdownV2('❌ User ID tidak valid. Masukkan angka.'), {
      parse_mode: 'MarkdownV2'
    });
  }

  try {
    await dbRunAsync('DELETE FROM reseller_sales WHERE reseller_id = ?', [targetId]);
    await dbRunAsync('UPDATE users SET reseller_level = ? WHERE user_id = ?', ['silver', targetId]);

    // ✅ Kirim pesan sukses ke admin
    await ctx.reply(escapeMarkdownV2(`✅ Komisi user ${targetId} berhasil direset.`), {
      parse_mode: 'MarkdownV2'
    });

    // 📢 Notifikasi ke grup
    if (GROUP_ID) {
      const mention = ctx.from.username
        ? `@${escapeMarkdownV2(ctx.from.username)}`
        : escapeMarkdownV2(ctx.from.first_name);

      const notif = escapeMarkdownV2(
        `🧹 Reset Komisi Reseller\n\n👤 Oleh: ${mention}\n🆔 User ID: ${targetId}\n📉 Komisi & level direset.`
      );

      await bot.telegram.sendMessage(GROUP_ID, notif, {
        parse_mode: 'MarkdownV2'
      });
    }

  } catch (err) {
    logger.error('❌ Gagal reset komisi:', err.message);
    await ctx.reply(escapeMarkdownV2('❌ Terjadi kesalahan saat reset komisi.'), {
      parse_mode: 'MarkdownV2'
    });
  }

  delete userState[ctx.chat.id];
  return;
}

// 📨 BROADCAST
  if (state.step === 'await_broadcast_message') {
    if (!adminIds.includes(String(userId))) {
      return ctx.reply('❌ Kamu tidak punya izin untuk melakukan broadcast.');
    }

    const broadcastMessage = text;
    delete userState[chatId];

    db.all('SELECT user_id FROM users', [], async (err, rows) => {
      if (err) {
        logger.error('❌ Gagal ambil daftar user:', err.message);
        return ctx.reply('❌ Gagal mengambil data user.');
      }

      let sukses = 0;
      let gagal = 0;

      for (const row of rows) {
        try {
          await bot.telegram.sendMessage(row.user_id, broadcastMessage);
          sukses++;
        } catch (e) {
          gagal++;
          logger.warn(`❌ Gagal kirim ke ${row.user_id}: ${e.message}`);
        }
      }

      ctx.reply(`📣 *Broadcast selesai:*\n✅ Berhasil: ${sukses}\n❌ Gagal: ${gagal}`, {
        parse_mode: 'Markdown'
      });
    });

    return;
  }
// FLOW: setelah user diminta memasukkan nominal pakasir
if (state.step === 'request_pakasir_amount') {
  const amount = parseInt(text, 10);

  if (isNaN(amount) || amount < MIN_DEPOSIT_AMOUNT) {
    return ctx.reply(
      `❌ *Nominal tidak valid.* Masukkan angka yang valid (minimal Rp ${MIN_DEPOSIT_AMOUNT.toLocaleString('id-ID')}).`,
      { parse_mode: 'Markdown' }
    );
  }

  // Konfirmasi sebelum membuat payment
  await ctx.reply(
    `💰 *Konfirmasi Top Up Saldo (Otomatis)*\n\n` +
    `• *Nominal:* Rp ${amount.toLocaleString('id-ID')}\n\n` +
    `Tekan tombol di bawah untuk membuat tautan pembayaran QRIS.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `🧾 Buat Pembayaran Rp ${amount.toLocaleString('id-ID')}`,
              callback_data: `create_pakasir_payment_${amount}`
            }
          ],
          [
            { text: '❌ Batalkan', callback_data: 'send_main_menu' }
          ]
        ]
      },
      parse_mode: 'Markdown'
    }
  );

  // bersihkan state user
  delete userState[ctx.chat.id];
}
  // 4️⃣ Add Server Step-by-Step
  if (state.step === 'addserver') {
    const domain = text;
    if (!domain) return ctx.reply('⚠️ *Domain tidak boleh kosong.* Silakan masukkan domain server yang valid.', { parse_mode: 'Markdown' });
    state.domain = domain;
    state.step = 'addserver_auth';
    return ctx.reply('🔑 *Silakan masukkan auth server:*', { parse_mode: 'Markdown' });
  }

  if (state.step === 'addserver_auth') {
    const auth = text;
    if (!auth) return ctx.reply('⚠️ *Auth tidak boleh kosong.* Silakan masukkan auth server yang valid.', { parse_mode: 'Markdown' });
    state.auth = auth;
    state.step = 'addserver_nama_server';
    return ctx.reply('🏷️ *Silakan masukkan nama server:*', { parse_mode: 'Markdown' });
  }

  if (state.step === 'addserver_nama_server') {
    const nama_server = text;
    if (!nama_server) return ctx.reply('⚠️ *Nama server tidak boleh kosong.*', { parse_mode: 'Markdown' });
    state.nama_server = nama_server;
    state.step = 'addserver_quota';
    return ctx.reply('📊 *Silakan masukkan quota server:*', { parse_mode: 'Markdown' });
  }

  if (state.step === 'addserver_quota') {
    const quota = parseInt(text, 10);
    if (isNaN(quota)) return ctx.reply('⚠️ *Quota tidak valid.*', { parse_mode: 'Markdown' });
    state.quota = quota;
    state.step = 'addserver_iplimit';
    return ctx.reply('🔢 *Silakan masukkan limit IP server:*', { parse_mode: 'Markdown' });
  }

  if (state.step === 'addserver_iplimit') {
    const iplimit = parseInt(text, 10);
    if (isNaN(iplimit)) return ctx.reply('⚠️ *Limit IP tidak valid.*', { parse_mode: 'Markdown' });
    state.iplimit = iplimit;
    state.step = 'addserver_batas_create_akun';
    return ctx.reply('🔢 *Silakan masukkan batas create akun server:*', { parse_mode: 'Markdown' });
  }

  if (state.step === 'addserver_batas_create_akun') {
    const batas = parseInt(text, 10);
    if (isNaN(batas)) return ctx.reply('⚠️ *Batas create akun tidak valid.*', { parse_mode: 'Markdown' });
    state.batas_create_akun = batas;
    state.step = 'addserver_harga';
    return ctx.reply('💰 *Silakan masukkan harga server:*', { parse_mode: 'Markdown' });
  }

  if (state.step === 'addserver_harga') {
  const harga = parseFloat(text);
  if (isNaN(harga) || harga <= 0) return ctx.reply('⚠️ *Harga tidak valid.*', { parse_mode: 'Markdown' });

  const { domain, auth, nama_server, quota, iplimit, batas_create_akun } = state;

  try {
    const resolvedIP = await resolveDomainToIP(domain);
    let isp = 'Tidak diketahui', lokasi = 'Tidak diketahui';

    if (resolvedIP) {
      const info = await getISPAndLocation(resolvedIP);
      isp = info.isp;
      lokasi = info.lokasi;
    }

    db.run(`
      INSERT INTO Server (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, total_create_akun, isp, lokasi)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, isp, lokasi], function(err) {
      if (err) {
        logger.error('❌ Error saat tambah server:', err.message);
        ctx.reply('❌ *Gagal menambahkan server.*', { parse_mode: 'Markdown' });
      } else {
        ctx.reply(
          `✅ *Server berhasil ditambahkan!*\n\n` +
          `🌐 Domain: ${domain}\n` +
          `📍 Lokasi: ${lokasi}\n` +
          `🏢 ISP: ${isp}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

  } catch (err) {
    logger.error('❌ Gagal resolve/tambah server:', err.message);
    ctx.reply('❌ *Terjadi kesalahan saat menambahkan server.*', { parse_mode: 'Markdown' });
  }

  delete userState[ctx.chat.id];
  return;
}
});
// create transaction via Pakasir API and return { orderId, paymentUrl, qrImageBuffer, amount }
async function generatePakasirPayment(userId, amount) {
  const orderId = `PKS-${userId}-${Date.now()}`;

  // 1) Try API transactioncreate/qris
  try {
    const apiUrl = 'https://app.pakasir.com/api/transactioncreate/qris';
    const body = {
      project: PAKASIR_PROJECT_SLUG,
      order_id: orderId,
      amount: Number(amount),
      api_key: PAKASIR_API_KEY
    };

    const resp = await axios.post(apiUrl, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const payment = resp.data && (resp.data.payment || resp.data.payment || resp.data);
    // payment likely at resp.data.payment
    const p = resp.data.payment || resp.data;

    // build paymentUrl fallback (web checkout)
    const redirectUrl = encodeURIComponent((PAKASIR_WEBHOOK_URL || '').replace('/webhook/pakasir', '/topup-success') || '');
    const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_PROJECT_SLUG)}/${encodeURIComponent(amount)}?order_id=${encodeURIComponent(orderId)}&redirect=${redirectUrl}&qris_only=1`;

    // save pending deposit in DB (as you already do)
    await new Promise((resolve, reject) => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.run(`INSERT INTO pending_deposits_pakasir (user_id, order_id, amount, status, payment_method, payment_data, expired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, orderId, amount, 'pending', 'qris', paymentUrl, expiresAt],
          (err) => {
            if (err) { logger.error('Error saving pending deposit:', err.message); return reject(err); }
            resolve();
          }
      );
    });

    // Prefer direct QR content if present
    // Some Pakasir responses include `payment.payment_number` (EMVCo string) OR a base64 image
    let qrImageBuffer = null;
    if (p && p.payment_number) {
      // convert EMVCo QR string to image
      const qrData = String(p.payment_number);
      const dataUrl = await QRCode.toDataURL(qrData, { margin: 1, errorCorrectionLevel: 'M' });
      qrImageBuffer = Buffer.from(dataUrl.split(',')[1], 'base64');
    } else if (p && (p.qrcode || p.qr_image_base64)) {
      const base64 = p.qrcode || p.qr_image_base64;
      qrImageBuffer = Buffer.from(base64, 'base64');
    }

    return { orderId, paymentUrl, qrImageBuffer, amount };
  } catch (err) {
    // if API fails, fallback to web checkout URL (what you already had)
    logger.warn('Pakasir API create failed, falling back to web checkout: ' + (err && (err.message || JSON.stringify(err))));
    const orderId = `PKS-${userId}-${Date.now()}`;
    const redirectUrl = encodeURIComponent((PAKASIR_WEBHOOK_URL || '').replace('/webhook/pakasir', '/topup-success') || '');
    const paymentUrl = `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_PROJECT_SLUG)}/${encodeURIComponent(amount)}?order_id=${encodeURIComponent(orderId)}&redirect=${redirectUrl}&qris_only=1`;

    await new Promise((resolve, reject) => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.run(`INSERT INTO pending_deposits_pakasir (user_id, order_id, amount, status, payment_method, payment_data, expired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, orderId, amount, 'pending', 'qris', paymentUrl, expiresAt],
          (err2) => {
            if (err2) { logger.error('Error saving pending deposit (fallback):', err2.message); return reject(err2); }
            resolve();
          }
      );
    });

    return { orderId, paymentUrl, qrImageBuffer: null, amount };
  }
}

// --- WEBHOOK HANDLER PAKASIR (Dengan Notifikasi Grup) ---

async function handlePakasirWebhook(payload, botInstance) {
  const { order_id, amount: rawAmount, status, project } = payload;
  const amount = Number(rawAmount || 0);

  if (status !== 'completed' || project !== PAKASIR_PROJECT_SLUG) {
    logger.warn(`Webhook ignored: status/project mismatch. order_id=${order_id} status=${status} project=${project}`);
    return;
  }

  // init processed set bila belum ada
  if (!global.processedTransactions) global.processedTransactions = new Set();
  if (global.processedTransactions.has(order_id)) {
    logger.warn(`Webhook ignored: already processed order_id=${order_id}`);
    return;
  }
  global.processedTransactions.add(order_id);

  try {
    // Ambil pending deposit
    const row = await dbGetAsync(
      'SELECT user_id, status FROM pending_deposits_pakasir WHERE order_id = ? AND status = ?',
      [order_id, 'pending']
    );

    if (!row) {
      logger.warn(`Pending deposit not found or already completed for order_id=${order_id}`);
      return;
    }

    const userId = row.user_id;

    // Mulai transaksi DB
    await dbRunAsync('BEGIN TRANSACTION');

    try {
      // Update saldo user
      await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, userId]);

      // Update pending_deposits_pakasir status -> completed
      await dbRunAsync('UPDATE pending_deposits_pakasir SET status = ? WHERE order_id = ?', ['completed', order_id]);

      // Commit jika semua sukses
      await dbRunAsync('COMMIT');
      logger.info(`Top up committed: order_id=${order_id} user=${userId} amount=${amount}`);
    } catch (txErr) {
      // Rollback jika gagal
      try { await dbRunAsync('ROLLBACK'); } catch (rbErr) { logger.error(`Rollback failed: ${rbErr.message}`); }
      logger.error(`DB transaction failed for order_id=${order_id}: ${txErr.message}`);
      return;
    }

    // Ambil detail user terbaru (safe)
    let userAfterTopUp = { saldo: 0, role: 'user' };
    try {
      userAfterTopUp = await getUserDetails(userId);
    } catch (e) {
      logger.warn(`Gagal ambil user details setelah topup untuk user ${userId}: ${e.message}`);
    }

    // Ambil username/mention (jika tersedia)
    let userTag = String(userId);
    try {
      const chat = await botInstance.telegram.getChat(userId);
      userTag = chat?.username ? `@${chat.username}` : String(userId);
    } catch (e) {
      // jangan block, pakai userId sebagai fallback
      userTag = String(userId);
    }

    // Pesan ke user (rapi & aman)
    const userMessage =
      `<b>✅ TOP UP SALDO BERHASIL (OTOMATIS)</b>\n\n` +
      `📄 <b>Invoice:</b> <code>${order_id}</code>\n` +
      `💰 <b>Jumlah:</b> Rp ${Number(amount).toLocaleString('id-ID')}\n` +
      `🏧 <b>Metode:</b> ${payload.payment_method || 'QRIS'}\n\n` +
      `Saldo Anda telah diperbarui. Terima kasih!`;

    botInstance.telegram.sendMessage(userId, userMessage, { parse_mode: 'HTML' })
      .catch(e => logger.error(`Failed to notify user ${userId}: ${e.message}`));

    // Pesan ke grup/admin (rapi)
    const groupMessage =
      `<blockquote><b>📢 NOTIFIKASI TOP UP OTOMATIS</b>\n\n` +
      `👤 <b>User:</b> ${userTag} (ID: <code>${userId}</code>)\n` +
      `🎭 <b>Role:</b> ${(userAfterTopUp.role || 'user').toString().toUpperCase()}\n\n` +
      `📄 <b>Order ID:</b> <code>${order_id}</code>\n` +
      `💰 <b>Jumlah:</b> Rp ${Number(amount).toLocaleString('id-ID')}\n` +
      `🏧 <b>Metode:</b> ${payload.payment_method || 'QRIS'}\n\n` +
      `💳 <b>Saldo Baru:</b> Rp ${Number(userAfterTopUp.saldo || 0).toLocaleString('id-ID')}\n` +
      `</blockquote>`;

    botInstance.telegram.sendMessage(GROUP_ID, groupMessage, { parse_mode: 'HTML' })
      .catch(e => logger.error(`Failed to notify admin group for order ${order_id}: ${e.message}`));

    logger.info(`Webhook processed successfully: order_id=${order_id}`);
  } catch (err) {
    logger.error(`Error processing Pakasir webhook order_id=${order_id}: ${err && err.message ? err.message : JSON.stringify(err)}`);
  }
}
async function queryPakasirTransaction(orderId, amount) {
  const url = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(PAKASIR_PROJECT_SLUG)}&amount=${encodeURIComponent(amount)}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;
  const resp = await axios.get(url, { timeout: 15000 });
  return resp.data.transaction || resp.data;
}

bot.action(/create_pakasir_payment_(\d+)/, async (ctx) => {
  const amount = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id;
  await ctx.answerCbQuery('Membuat tautan pembayaran...');

  try {
    const { orderId, paymentUrl, qrImageBuffer, amount: amt } =
      await generatePakasirPayment(userId, amount);

    const expiryDate = new Date(Date.now() + 60 * 60 * 1000);
    const expiryText = expiryDate.toLocaleString('id-ID', {
      day:'numeric', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit'
    });

    const statusButton = [
      { text: 'Cek Status Transaksi', callback_data: `check_pakasir_status_${orderId}` }
    ];

    const notice = `\n\n⚠️ *Setelah berhasil membayar, WAJIB klik tombol* _Cek Status Transaksi_ *untuk memproses top up Anda!*`;

    const originalMessage = ctx.update?.callback_query?.message;
    const deleteAt = Date.now() + 10 * 60 * 1000; // 10 menit

    // --- QR Available ---
    if (qrImageBuffer) {

      try {
        await ctx.editMessageText(
          `🧾 *PEMBAYARAN QRIS TERSEDIA*\n\n`
          + `Invoice: \`${orderId}\`\n`
          + `Nominal: *Rp ${amt.toLocaleString('id-ID')}*\n`
          + `Kadaluarsa: ${expiryText}\n\n`
          + `Silakan *scan QR* untuk membayar.${notice}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}

      const qrMsg = await ctx.replyWithPhoto(
        { source: qrImageBuffer },
        {
          caption:
            `Invoice: \`${orderId}\`\n`
            + `Nominal: Rp ${amt.toLocaleString('id-ID')}\n`
            + `Kadaluarsa: ${expiryText}\n\n`
            + `⚠️ Setelah membayar, klik tombol *Cek Status Transaksi* untuk menyelesaikan top up.`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [statusButton] }
        }
      );

      // simpan ke DB untuk auto delete aman dari restart
      if (originalMessage)
        await addPendingDelete(originalMessage.chat.id, originalMessage.message_id, deleteAt);

      if (qrMsg)
        await addPendingDelete(qrMsg.chat.id, qrMsg.message_id, deleteAt);

    }

    // --- Tanpa QR (fallback link) ---
    else {

      try {
        await ctx.editMessageText(
          `🔗 *TAUTAN PEMBAYARAN*\n\n`
          + `Invoice: \`${orderId}\`\n`
          + `Nominal: *Rp ${amt.toLocaleString('id-ID')}*\n\n`
          + `Klik tombol untuk membuka halaman pembayaran.${notice}`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [statusButton] }
          }
        );
      } catch (e) {}

      if (originalMessage)
        await addPendingDelete(originalMessage.chat.id, originalMessage.message_id, deleteAt);
    }

  } catch (err) {
    logger.error('Error creating Pakasir payment action: ' +
      (err?.stack || err?.message || err));
    await ctx.reply(
      '❌ *GAGAL!* Terjadi kesalahan saat membuat tautan pembayaran. Silakan coba lagi nanti.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.action(/check_pakasir_status_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await ctx.answerCbQuery('Mengecek status pembayaran...');

  try {
    const pending = await dbGetAsync('SELECT amount FROM pending_deposits_pakasir WHERE order_id = ? AND status = ?', [orderId, 'pending']);
    if (!pending) return ctx.reply('ℹ️ *Transaksi sudah selesai atau tidak ditemukan.* Silakan cek saldo Anda.', { parse_mode: 'Markdown' });

    const amount = Number(pending.amount);
    const txn = await queryPakasirTransaction(orderId, amount);

    const status = (txn?.status || '').toLowerCase();
    if (status === 'completed' || status === 'paid') {
      // reuse your webhook handler to credit the user
      await handlePakasirWebhook({ order_id: orderId, amount, project: PAKASIR_PROJECT_SLUG, status: 'completed', payment_method: txn.payment_method || 'qris' }, bot);
      return ctx.reply('✅ *Pembayaran berhasil dikonfirmasi!* Saldo Anda telah ditambahkan secara otomatis.', { parse_mode: 'Markdown' });
    } else if (status === 'pending' || status === 'waiting') {
      return ctx.reply(`⏳ *Status Transaksi: Menunggu Pembayaran*\n\nInvoice: \`${orderId}\`\nNominal: *Rp ${amount.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' });
    } else {
      return ctx.reply(`⚠️ *Status Transaksi: ${status.toUpperCase()}*\n\nSilakan buat transaksi Top Up baru.`, { parse_mode: 'Markdown' });
    }
  } catch (e) {
    logger.error('Error checking Pakasir status: ' + (e && (e.stack || e.message || JSON.stringify(e))));
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat mengecek status pembayaran. Coba lagi nanti.', { parse_mode: 'Markdown' });
  }
});

bot.action('addserver', async (ctx) => {
  try {
    logger.info('📥 Proses tambah server dimulai');
    await ctx.answerCbQuery();
    await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
    userState[ctx.chat.id] = { step: 'addserver' };
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses tambah server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action('detailserver', async (ctx) => {
  try {
    logger.info('📋 Proses detail server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    const buttons = [];
    for (let i = 0; i < servers.length; i += 2) {
      const row = [];
      row.push({
        text: `${servers[i].nama_server}`,
        callback_data: `server_detail_${servers[i].id}`
      });
      if (i + 1 < servers.length) {
        row.push({
          text: `${servers[i + 1].nama_server}`,
          callback_data: `server_detail_${servers[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    await ctx.reply('📋 *Silakan pilih server untuk melihat detail:*', {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('listserver', async (ctx) => {
  try {
    logger.info('📜 Proses daftar server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    let serverList = '📜 *Daftar Server* 📜\n\n';
    servers.forEach((server, index) => {
      serverList += `🔹 ${index + 1}. ${server.domain}\n`;
    });

    serverList += `\nTotal Jumlah Server: ${servers.length}`;

    await ctx.reply(serverList, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil daftar server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('deleteserver', async (ctx) => {
  try {
    logger.info('🗑️ Proses hapus server dimulai');
    await ctx.answerCbQuery();
    
    db.all('SELECT * FROM Server', [], (err, servers) => {
      if (err) {
        logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
      }

      if (servers.length === 0) {
        logger.info('⚠️ Tidak ada server yang tersedia');
        return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
      }

      const keyboard = servers.map(server => {
        return [{ text: server.nama_server, callback_data: `confirm_delete_server_${server.id}` }];
      });
      keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'kembali_ke_menu' }]);

      ctx.reply('🗑️ *Pilih server yang ingin dihapus:*', {
        reply_markup: {
          inline_keyboard: keyboard
        },
        parse_mode: 'Markdown'
      });
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses hapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});


// Menangani aksi untuk mengecek saldo
bot.action('cek_saldo', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat memeriksa saldo:', err.message);
          return reject('❌ *Terjadi kesalahan saat memeriksa saldo Anda. Silakan coba lagi nanti.*');
        }
        resolve(row);
      });
    });

    if (row) {
      await ctx.reply(`📊 *Cek Saldo*\n\n🆔 ID Telegram: ${userId}\n💰 Sisa Saldo: Rp${row.saldo}`, 
      { 
        parse_mode: 'Markdown', 
        reply_markup: {
          inline_keyboard: [
            [{ text: '💸 Top Up', callback_data: 'topup_saldo' }, { text: '📝 Menu Utama', callback_data: 'send_main_menu' }]
          ]
        } 
      });
    } else {
      await ctx.reply('⚠️ *Anda belum memiliki saldo. Silakan tambahkan saldo terlebih dahulu.*', { parse_mode: 'Markdown' });
    }
    
  } catch (error) {
    logger.error('❌ Kesalahan saat memeriksa saldo:', error);
    await ctx.reply(`❌ *${error.message}*`, { parse_mode: 'Markdown' });
  }
});

// Fungsi untuk mengambil username berdasarkan ID
const getUsernameById = async (userId) => {
  try {
    const telegramUser = await bot.telegram.getChat(userId);
    return telegramUser.username || telegramUser.first_name;
  } catch (err) {
    logger.error('❌ Kesalahan saat mengambil username dari Telegram:', err.message);
    throw new Error('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil username dari Telegram.*');
  }
};
// 📄 NEXT PAGE untuk kurangi saldo user
bot.action(/next_users_reduce_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    logger.info(`Next reduce saldo users process started for page ${currentPage + 1}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT id, user_id FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `reduce_saldo_${users[i].id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `reduce_saldo_${users[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...buttons]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_reduce_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_reduce_${currentPage + 1}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses next reduce users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});


// 📄 PREVIOUS PAGE untuk kurangi saldo user
bot.action(/prev_users_reduce_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    logger.info(`Previous reduce saldo users process started for page ${currentPage}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT id, user_id FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `reduce_saldo_${users[i].id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `reduce_saldo_${users[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...buttons]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_reduce_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_reduce_${currentPage + 1}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses previous reduce users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('reducesaldo_user', async (ctx) => {
  try {
    logger.info('Reduce saldo user process started');
    await ctx.answerCbQuery();

    // 🔹 Ambil 20 user pertama dari database
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT id, user_id FROM Users LIMIT 20', [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    // 🔹 Hitung total user untuk pagination
    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    // 🔹 Buat tombol 2 kolom per baris
    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `reduce_saldo_${users[i].id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `reduce_saldo_${users[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    // 🔹 Pagination tombol "Next"
    const currentPage = 0;
    const replyMarkup = {
      inline_keyboard: [...buttons]
    };

    if (totalUsers > 20) {
      replyMarkup.inline_keyboard.push([{
        text: '➡️ Next',
        callback_data: `next_users_reduce_${currentPage + 1}`
      }]);
    }

    // 🔹 Kirim pesan
    await ctx.reply('📉 *Silakan pilih user untuk mengurangi saldo:*', {
      reply_markup: replyMarkup,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses kurangi saldo user:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('addsaldo_user', async (ctx) => {
  try {
    logger.info('Add saldo user process started');
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all('SELECT id, user_id FROM Users LIMIT 20', [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    const currentPage = 0;
    const replyMarkup = {
      inline_keyboard: [...buttons]
    };

    if (totalUsers > 20) {
      replyMarkup.inline_keyboard.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage + 1}`
      }]);
    }

    await ctx.reply('📊 *Silakan pilih user untuk menambahkan saldo:*', {
      reply_markup: replyMarkup,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses tambah saldo user:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action(/next_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    logger.info(`Next users process started for page ${currentPage + 1}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT id, user_id FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...buttons]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage + 1}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses next users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action(/prev_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = (currentPage - 1) * 20; 

  try {
    logger.info(`Previous users process started for page ${currentPage}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT id, user_id FROM Users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM Users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const buttons = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...buttons]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses previous users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_limit_ip', async (ctx) => {
  try {
    logger.info('Edit server limit IP process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_limit_ip_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit limit IP:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit limit IP server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_batas_create_akun', async (ctx) => {
  try {
    logger.info('Edit server batas create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_batas_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit batas create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit batas create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_total_create_akun', async (ctx) => {
  try {
    logger.info('Edit server total create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit total create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit total create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_quota', async (ctx) => {
  try {
    logger.info('Edit server quota process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_quota_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit quota:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit quota server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_auth', async (ctx) => {
  try {
    logger.info('Edit server auth process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_auth_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🌐 *Silakan pilih server untuk mengedit auth:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit auth server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_harga', async (ctx) => {
  try {
    logger.info('Edit server harga process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_harga_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('💰 *Silakan pilih server untuk mengedit harga:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit harga server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_domain', async (ctx) => {
  try {
    logger.info('Edit server domain process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_domain_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🌐 *Silakan pilih server untuk mengedit domain:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit domain server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('nama_server_edit', async (ctx) => {
  try {
    logger.info('Edit server nama process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_nama_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🏷️ *Silakan pilih server untuk mengedit nama:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit nama server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('topup_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    await ctx.editMessageText(
      `💰 *TOP UP SALDO BOT*\n\n` +
      `Silakan pilih metode top up yang ingin kamu gunakan. Bot menyediakan 2 gateway otomatis:\n\n` +
      `🔁 *OrderKuota (Disarankan)*\n` +
      `• Proses cepat\n` +
      `• Stabil & minim gangguan\n` +
      `• Cocok untuk top up harian\n\n` +
      `🧾 *Pakasir*\n` +
      `• Support QRIS modern\n` +
      `• Cocok untuk pembayaran fleksibel\n\n` +
      `Pilih gateway yang sesuai kebutuhan kamu.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔁 Gunakan OrderKuota (Rekomendasi)', callback_data: 'topup_saldo_orderkuota' }
            ],
            [
              { text: '🧾 Gunakan Pakasir', callback_data: 'topup_saldo_pakasir' }
            ],
            [
              { text: '❌ Batal', callback_data: 'send_main_menu' }
            ]
          ]
        }
      }
    );

  } catch (error) {
    logger.error('❌ Gagal membuka menu topup:', error);
  }
});
bot.action('topup_saldo_orderkuota', async (ctx) => {
  try {
    await ctx.answerCbQuery(); 
    const userId = ctx.from.id;
    logger.info(`🔍 User ${userId} memulai proses top-up saldo.`);
    

    if (!global.depositState) {
      global.depositState = {};
    }
    global.depositState[userId] = { action: 'request_amount', amount: '' };
    
    logger.info(`🔍 User ${userId} diminta untuk memasukkan jumlah nominal saldo.`);
    

    const keyboard = keyboard_nomor();
    
    await ctx.editMessageText('💰 *Silakan masukkan jumlah nominal saldo yang Anda ingin tambahkan ke akun Anda:*', {
      reply_markup: {
        inline_keyboard: keyboard
      },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses top-up saldo:', error);
    await ctx.editMessageText('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action('topup_saldo_pakasir', async (ctx) => {
    try {
        await ctx.answerCbQuery();

        userState[ctx.chat.id] = {
            step: 'request_pakasir_amount',
            amount: ''
        };

        await ctx.editMessageText(
            `💰 *TOP UP SALDO (OTOMATIS)*\n\n` +
            `Silakan masukkan *nominal saldo* yang ingin Anda tambahkan ke akun.\n` +
            `Gunakan angka saja *tanpa titik atau koma*.\n\n` +
            `🔸 Minimal Top Up: *Rp ${MIN_DEPOSIT_AMOUNT.toLocaleString('id-ID')}*\n` +
            `_Contoh: 50000_`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        logger.error('❌ Kesalahan saat memulai proses top-up saldo otomatis:', error);

        await ctx.reply(
            '❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.',
            { parse_mode: 'Markdown' }
        );
    }
});

bot.action(/edit_harga_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit harga server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga', serverId: serverId };

  await ctx.reply('💰 *Silakan masukkan harga server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/add_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk menambahkan saldo user dengan ID: ${userId}`);
  userState[ctx.chat.id] = { step: 'add_saldo', userId: userId };

  await ctx.reply('📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/reduce_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengurangi saldo user dengan ID: ${userId}`);

  userState[ctx.chat.id] = { step: 'reduce_saldo', userId: userId, amount: '' };

  await ctx.reply('📉 *Masukkan jumlah saldo yang ingin dikurangi:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_batas_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit batas create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_batas_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan batas create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_total_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit total create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_total_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan total create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_limit_ip_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit limit IP server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_limit_ip', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan limit IP server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_quota_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit quota server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_quota', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan quota server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_auth_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit auth server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_auth', serverId: serverId };

  await ctx.reply('?? *Silakan masukkan auth server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_domain_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit domain server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_domain', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan domain server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_nama_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit nama server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_nama', serverId: serverId };

  await ctx.reply('🏷️ *Silakan masukkan nama server baru:*', {
    reply_markup: { inline_keyboard: keyboard_abc() },
    parse_mode: 'Markdown'
  });
});
bot.action(/confirm_delete_server_(\d+)/, async (ctx) => {
  try {
    db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], function(err) {
      if (err) {
        logger.error('Error deleting server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat menghapus server.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        logger.info('Server tidak ditemukan');
        return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      logger.info(`Server dengan ID ${ctx.match[1]} berhasil dihapus`);
      ctx.reply('✅ *Server berhasil dihapus.*', { parse_mode: 'Markdown' });
    });
  } catch (error) {
    logger.error('Kesalahan saat menghapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action(/server_detail_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(server);
      });
    });

    if (!server) {
      logger.info('⚠️ Server tidak ditemukan');
      return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const serverDetails = `📋 *Detail Server* 📋\n\n` +
      `🌐 *Domain:* \`${server.domain}\`\n` +
      `🔑 *Auth:* \`${server.auth}\`\n` +
      `🏷️ *Nama Server:* \`${server.nama_server}\`\n` +
      `📊 *Quota:* \`${server.quota}\`\n` +
      `?? *Limit IP:* \`${server.iplimit}\`\n` +
      `🔢 *Batas Create Akun:* \`${server.batas_create_akun}\`\n` +
      `📋 *Total Create Akun:* \`${server.total_create_akun}\`\n` +
      `💵 *Harga:* \`Rp ${server.harga}\`\n\n`;

    await ctx.reply(serverDetails, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});
bot.on('callback_query', async (ctx) => {
  const userId = String(ctx.from.id);
  const data = ctx.callbackQuery.data;
  const userStateData = userState[ctx.chat?.id];

  // 1️⃣ HANDLE DEPOSIT
  if (global.depositState?.[userId]?.action === 'request_amount') {
    return await handleDepositState(ctx, userId, data);
  }

  // 2️⃣ HANDLE USER STATE (EDIT, ADD SALDO, DLL)
  if (userStateData) {
    switch (userStateData.step) {
      case 'add_saldo':
        return await handleAddSaldo(ctx, userStateData, data);

      case 'reduce_saldo': // 🔹 Tambahan baru untuk kurangi saldo
        return await handleReduceSaldo(ctx, userStateData, data);

      case 'edit_batas_create_akun':
        return await handleEditBatasCreateAkun(ctx, userStateData, data);

      case 'edit_limit_ip':
        return await handleEditiplimit(ctx, userStateData, data);

      case 'edit_quota':
        return await handleEditQuota(ctx, userStateData, data);

      case 'edit_auth':
        return await handleEditAuth(ctx, userStateData, data);

      case 'edit_domain':
        return await handleEditDomain(ctx, userStateData, data);

      case 'edit_harga':
        return await handleEditHarga(ctx, userStateData, data);

      case 'edit_nama':
        return await handleEditNama(ctx, userStateData, data);

      case 'edit_total_create_akun':
        return await handleEditTotalCreateAkun(ctx, userStateData, data);
    }
  }

});

async function handleReduceSaldo(ctx, userStateData, data) {
  const userId = userStateData.userId;

  // Tambah angka ke input
  if (/^\d+$/.test(data)) {
    userStateData.amount = (userStateData.amount || '') + data;
    return await ctx.editMessageText(`📉 *Masukkan jumlah saldo yang ingin dikurangi:*\n\n💰 ${userStateData.amount}`, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }

  // Hapus angka terakhir
  if (data === 'delete') {
    userStateData.amount = (userStateData.amount || '').slice(0, -1);
    return await ctx.editMessageText(`📉 *Masukkan jumlah saldo yang ingin dikurangi:*\n\n💰 ${userStateData.amount || '0'}`, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }

  // Konfirmasi
  if (data === 'confirm') {
    const amount = parseInt(userStateData.amount || '0');
    if (!amount || amount <= 0) {
      return await ctx.reply('⚠️ Nominal tidak valid.');
    }

    db.run('UPDATE Users SET saldo = saldo - ? WHERE id = ?', [amount, userId], function (err) {
      if (err) {
        logger.error('❌ Gagal mengurangi saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengurangi saldo.');
      }

      ctx.reply(`✅ Berhasil mengurangi saldo sebesar *Rp${amount.toLocaleString('id-ID')}*`, { parse_mode: 'Markdown' });
      delete userState[ctx.chat.id]; // reset
    });
  }
}

async function handleDepositState(ctx, userId, data) {
  let currentAmount = global.depositState[userId].amount;

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ Jumlah tidak boleh kosong!', { show_alert: true });
    }
    if (parseInt(currentAmount) < 2000) {
      return await ctx.answerCbQuery('⚠️ Jumlah minimal top-up adalah  2000 Ya Kawan...!!!', { show_alert: true });
    }
    global.depositState[userId].action = 'confirm_amount';
    await processDeposit(ctx, currentAmount);
    return;
  } else {
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ Jumlah maksimal adalah 12 digit!', { show_alert: true });
    }
  }

  global.depositState[userId].amount = currentAmount;
  const newMessage = `💰 *Silakan masukkan jumlah nominal saldo yang Anda ingin tambahkan ke akun Anda:*\n\nJumlah saat ini: *Rp ${currentAmount}*`;
  
  try {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      return;
    }
    logger.error('Error updating message:', error);
  }
}

async function handleAddSaldo(ctx, userStateData, data) {
  let currentSaldo = userStateData.saldo || '';

  if (data === 'delete') {
    currentSaldo = currentSaldo.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentSaldo.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak boleh kosong!*', { show_alert: true });
    }

    try {
      await updateUserSaldo(userStateData.userId, currentSaldo);
      ctx.reply(`✅ *Saldo user berhasil ditambahkan.*\n\n📄 *Detail Saldo:*\n- Jumlah Saldo: *Rp ${currentSaldo}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat menambahkan saldo user.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[0-9]+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak valid!*', { show_alert: true });
    }
    if (currentSaldo.length < 10) {
      currentSaldo += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo maksimal adalah 10 karakter!*', { show_alert: true });
    }
  }

  userStateData.saldo = currentSaldo;
  const newMessage = `📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah saldo saat ini: *${currentSaldo}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditBatasCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'batasCreateAkun', 'batas create akun', 'UPDATE Server SET batas_create_akun = ? WHERE id = ?');
}

async function handleEditTotalCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'totalCreateAkun', 'total create akun', 'UPDATE Server SET total_create_akun = ? WHERE id = ?');
}

async function handleEditiplimit(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'iplimit', 'limit IP', 'UPDATE Server SET iplimit = ? WHERE id = ?');
}

async function handleEditQuota(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'quota', 'quota', 'UPDATE Server SET quota = ? WHERE id = ?');
}

async function handleEditAuth(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'auth', 'auth', 'UPDATE Server SET auth = ? WHERE id = ?');
}

async function handleEditDomain(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'domain', 'domain', 'UPDATE Server SET domain = ? WHERE id = ?');
}

async function handleEditHarga(ctx, userStateData, data) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah tidak boleh kosong!*', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply('❌ *Harga tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, 'UPDATE Server SET harga = ? WHERE id = ?');
      ctx.reply(`✅ *Harga server berhasil diupdate.*\n\n?? *Detail Server:*\n- Harga Baru: *Rp ${hargaBaru}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat mengupdate harga server.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Hanya angka yang diperbolehkan!*', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah maksimal adalah 12 digit!*', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = `💰 *Silakan masukkan harga server baru:*\n\nJumlah saat ini: *Rp ${currentAmount}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditNama(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'name', 'nama server', 'UPDATE Server SET nama_server = ? WHERE id = ?');
}

async function handleEditField(ctx, userStateData, data, field, fieldName, query) {
  let currentValue = userStateData[field] || '';

  if (data === 'delete') {
    currentValue = currentValue.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentValue.length === 0) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak boleh kosong!*`, { show_alert: true });
    }
    try {
      await updateServerField(userStateData.serverId, currentValue, query);
      ctx.reply(`✅ *${fieldName} server berhasil diupdate.*\n\n📄 *Detail Server:*\n- ${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}: *${currentValue}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`❌ *Terjadi kesalahan saat mengupdate ${fieldName} server.*`, { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
    }
    if (currentValue.length < 253) {
      currentValue += data;
    } else {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} maksimal adalah 253 karakter!*`, { show_alert: true });
    }
  }

  userStateData[field] = currentValue;
  const newMessage = `📊 *Silakan masukkan ${fieldName} server baru:*\n\n${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} saat ini: *${currentValue}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}
async function updateUserSaldo(userId, saldo) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE Users SET saldo = saldo + ? WHERE id = ?', [saldo, userId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan saldo user:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateServerField(serverId, value, query) {
  return new Promise((resolve, reject) => {
    db.run(query, [value, serverId], function (err) {
      if (err) {
        logger.error(`⚠️ Kesalahan saat mengupdate ${fieldName} server:`, err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function generateRandomAmount(baseAmount) {
  const random = Math.floor(Math.random() * 99) + 1;
  return baseAmount + random;
}

global.depositState = {};
global.pendingDeposits = {};
let lastRequestTime = 0;
const requestInterval = 1000; 

db.all('SELECT * FROM pending_deposits WHERE status = "pending"', [], (err, rows) => {
  if (err) {
    logger.error('Gagal load pending_deposits:', err.message);
    return;
  }
  rows.forEach(row => {
    global.pendingDeposits[row.unique_code] = {
      amount: row.amount,
      originalAmount: row.original_amount,
      userId: row.user_id,
      timestamp: row.timestamp,
      status: row.status,
      qrMessageId: row.qr_message_id
    };
  });
  logger.info('Pending deposit loaded:', Object.keys(global.pendingDeposits).length);
});

    //const qris = new QRISPayment({
    //merchantId: MERCHANT_ID,
   // apiKey: API_KEY,
   // baseQrString: DATA_QRIS,
 //   logoPath: 'logo.png'
//    });


function generateRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processDeposit(ctx, amount) {
  const currentTime = Date.now();

  if (currentTime - lastRequestTime < requestInterval) {
    await ctx.editMessageText('⚠️ *Terlalu banyak permintaan. Silakan tunggu sebentar sebelum mencoba lagi.*', { parse_mode: 'Markdown' });
    return;
  }

  lastRequestTime = currentTime;
  const userId = ctx.from.id;
  const uniqueCode = `user-${userId}-${Date.now()}`;

  // Generate final amount with random suffix
  const finalAmount = Number(amount) + generateRandomNumber(1, 300);
  const adminFee = finalAmount - Number(amount)
  try {
    const urlQr = DATA_QRIS; // QR destination
   // console.log('🔍 CEK DATA_QRIS:', urlQr);

//const sharp = require('sharp'); // opsional kalau mau resize

const bayar = await axios.get(`https://api.rajaserverpremium.web.id/orderkuota/createpayment?apikey=AriApiPaymetGetwayMod&amount=${finalAmount}&codeqr=${urlQr}`);
const get = bayar.data;

if (get.status !== 'success') {
  throw new Error('Gagal membuat QRIS: ' + JSON.stringify(get));
}

const qrImageUrl = get.result.imageqris?.url;

if (!qrImageUrl || qrImageUrl.includes('undefined')) {
  throw new Error('URL QRIS tidak valid: ' + qrImageUrl);
}

// Download gambar QR
const qrResponse = await axios.get(qrImageUrl, { responseType: 'arraybuffer' });
const qrBuffer = Buffer.from(qrResponse.data);

    const caption =
      `📝 *Detail Pembayaran:*\n\n` +
                  `💰 Jumlah: Rp ${finalAmount}\n` +
      `- Nominal Top Up: Rp ${amount}\n` +
      `- Admin Fee : Rp ${adminFee}\n` +
                  `⚠️ *Penting:* Mohon transfer sesuai nominal\n` +
      `⏱️ Waktu: 5 menit\n\n` +
                  `⚠️ *Catatan:*\n` +
                  `- Pembayaran akan otomatis terverifikasi\n` +
      `- Jika pembayaran berhasil, saldo akan otomatis ditambahkan`;

    const qrMessage = await ctx.replyWithPhoto({ source: qrBuffer }, {
      caption: caption,
          parse_mode: 'Markdown'
        }); 
    // Hapus pesan input nominal setelah QR code dikirim
    try {
      await ctx.deleteMessage();
    } catch (e) {
      logger.error('Gagal menghapus pesan input nominal:', e.message);
    }

        global.pendingDeposits[uniqueCode] = {
          amount: finalAmount,
          originalAmount: amount,
          userId,
          timestamp: Date.now(),
      status: 'pending',
      qrMessageId: qrMessage.message_id
    };

    db.run(
      `INSERT INTO pending_deposits (unique_code, user_id, amount, original_amount, timestamp, status, qr_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uniqueCode, userId, finalAmount, amount, Date.now(), 'pending', qrMessage.message_id],
      (err) => {
        if (err) logger.error('Gagal insert pending_deposits:', err.message);
      }
    );
        delete global.depositState[userId];

  } catch (error) {
    logger.error('❌ Kesalahan saat memproses deposit:', error);
    await ctx.editMessageText('❌ *GAGAL! Terjadi kesalahan saat memproses pembayaran. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
    delete global.depositState[userId];
    delete global.pendingDeposits[uniqueCode];
    db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode], (err) => {
      if (err) logger.error('Gagal hapus pending_deposits (error):', err.message);
    });
  }
}

async function checkQRISStatus() {
  try {
    const pendingDeposits = Object.entries(global.pendingDeposits);

    for (const [uniqueCode, deposit] of pendingDeposits) {
      if (deposit.status !== 'pending') continue;

      const depositAge = Date.now() - deposit.timestamp;
      if (depositAge > 5 * 60 * 1000) {
        try {
          if (deposit.qrMessageId) {
            await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
          }
          await bot.telegram.sendMessage(
            deposit.userId,
            '❌ *Pembayaran Expired*\n\n' +
              'Waktu pembayaran telah habis. Silakan klik Top Up lagi untuk mendapatkan QR baru.',
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error('Error deleting expired payment messages:', error);
        }

        delete global.pendingDeposits[uniqueCode];
        db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode], (err) => {
          if (err) logger.error('Gagal hapus pending_deposits (expired):', err.message);
        });
        continue;
      }

      try {
        const data = buildPayload(); // payload selalu fresh
        const resultcek = await axios.post(API_URL, data, { headers, timeout: 5000 });

        // API balik teks (bukan JSON)
        const responseText = resultcek.data;
        //console.log('📦 Raw response from API:\n', responseText);

        // Parse teks jadi array transaksi
        const transaksiList = [];
        const blocks = responseText.split('------------------------').filter(Boolean);

        for (const block of blocks) {
          const kreditMatch = block.match(/Kredit\s*:\s*([\d.]+)/);
          const tanggalMatch = block.match(/Tanggal\s*:\s*(.+)/);
          const brandMatch = block.match(/Brand\s*:\s*(.+)/);
          if (kreditMatch) {
            transaksiList.push({
              tanggal: tanggalMatch ? tanggalMatch[1].trim() : '-',
              kredit: Number(kreditMatch[1].replace(/\./g, '')),
              brand: brandMatch ? brandMatch[1].trim() : '-'
            });
          }
        }

        // Debug hasil parsing
        console.log('✅ Parsed transaksi:', transaksiList);

        // Cocokkan nominal
        const expectedAmount = deposit.amount;
        const matched = transaksiList.find(t => t.kredit === expectedAmount);

        if (matched) {
          const success = await processMatchingPayment(deposit, matched, uniqueCode);
          if (success) {
            logger.info(`Payment processed successfully for ${uniqueCode}`);

            // === AUTO FRIDAY TOPUP BONUS ===
            // Jika topup >= Rp5.000 di hari Jumat (Asia/Jakarta), berikan bonus Rp1.000 sekali per hari.
            try {
              (function() {
                const BONUS_THRESHOLD = 5000;
                const BONUS_AMOUNT = 1000;
                const amt = Number(deposit.originalAmount || deposit.amount || 0);

                // waktu Jakarta
                const nowJakarta = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
                const isFriday = nowJakarta.getDay() === 5; // 5 = Jumat

                if (isFriday && amt >= BONUS_THRESHOLD) {
                  const yyyy = nowJakarta.getFullYear();
                  const mm = String(nowJakarta.getMonth() + 1).padStart(2, '0');
                  const dd = String(nowJakarta.getDate()).padStart(2, '0');
                  const today = `${yyyy}-${mm}-${dd}`;

                  // Cek apakah user sudah menerima bonus hari ini
                  db.get(
                    "SELECT id FROM weekly_bonus_claims WHERE user_id = ? AND claimed_date = ?",
                    [String(deposit.userId), today],
                    (chkErr, row) => {
                      if (chkErr) {
                        logger.error('Error cek weekly_bonus_claims:', chkErr && chkErr.message ? chkErr.message : chkErr);
                        return; // jangan block proses deposit karena error cek bonus
                      }
                      if (row) {
                        // sudah klaim hari ini, tidak perlu lagi
                        return;
                      }

                      // belum klaim -> tambahkan bonus (opsional: masih aman walau transaksi utama sudah commit)
                      db.run(
                        "UPDATE users SET saldo = saldo + ? WHERE user_id = ?",
                        [BONUS_AMOUNT, deposit.userId],
                        (uErr) => {
                          if (uErr) {
                            logger.error('Error apply friday bonus update:', uErr && uErr.message ? uErr.message : uErr);
                            return;
                          }
                          const bonusRef = `friday-bonus-${Date.now()}`;
                          db.run(
                            "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                            [deposit.userId, BONUS_AMOUNT, 'bonus', bonusRef, Date.now()],
                            (tErr) => {
                              if (tErr) {
                                logger.error('Gagal insert transaction bonus:', tErr && tErr.message ? tErr.message : tErr);
                                return;
                              }
                              db.run(
                                "INSERT INTO weekly_bonus_claims (user_id, amount, claimed_date, reference) VALUES (?, ?, ?, ?)",
                                [String(deposit.userId), BONUS_AMOUNT, today, bonusRef],
                                (cErr) => {
                                  if (cErr) {
                                    // kemungkinan UNIQUE constraint (race) -> log dan lanjut
                                    logger.warn('Gagal insert weekly_bonus_claims (mungkin duplikat):', cErr && cErr.message ? cErr.message : cErr);
                                    return;
                                  }
                                  logger.info(`Bonus Jumat applied to ${deposit.userId} (+Rp${BONUS_AMOUNT}).`);
                                  try {
                                    bot.telegram.sendMessage(
                                      deposit.userId,
                                      `🎉 Bonus Jumat! Topup Rp${amt.toLocaleString('id-ID')}. Kamu menerima bonus Rp${BONUS_AMOUNT.toLocaleString('id-ID')} 🎁`
                                    ).catch(e => {});
                                  } catch (e) {}
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              })();
            } catch (e) {
              logger.error('Error evaluating Friday bonus:', e && e.message ? e.message : e);
            }

            // Hapus pending deposit setelah semua selesai
            delete global.pendingDeposits[uniqueCode];
            db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode], (err) => {
              if (err) logger.error('Gagal hapus pending_deposits (success):', err.message);
            });
          }
        }
      } catch (error) {
        logger.error(`Error checking payment status for ${uniqueCode}:`, error.message);
      }
    }
  } catch (error) {
    logger.error('Error in checkQRISStatus:', error);
  }
}

function keyboard_abc() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_nomor() {
  const alphabet = '1234567890';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_full() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

global.processedTransactions = new Set();
async function updateUserBalance(userId, amount) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [amount, userId], function(err) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengupdate saldo user:', err.message);
          reject(err);
      } else {
        resolve();
        }
    });
  });
}

async function getUserBalance(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT saldo FROM users WHERE user_id = ?", [userId], function(err, row) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengambil saldo user:', err.message);
          reject(err);
      } else {
        resolve(row ? row.saldo : 0);
        }
    });
  });
}

async function sendPaymentSuccessNotification(userId, deposit, currentBalance) {
  try {
    // Hitung admin fee
    const adminFee = deposit.amount - deposit.originalAmount;
    await bot.telegram.sendMessage(userId,
      `✅ *Pembayaran Berhasil!*\n\n` +
      `💰 Jumlah Deposit: Rp ${deposit.originalAmount}\n` +
      `💰 Biaya Admin: Rp ${adminFee}\n` +
      `💰 Total Pembayaran: Rp ${deposit.amount}\n` +
      `💳 Saldo Sekarang: Rp ${currentBalance}`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (error) {
    logger.error('Error sending payment notification:', error);
    return false;
  }
}

async function processMatchingPayment(deposit, matchingTransaction, uniqueCode) {
  const transactionKey = `${matchingTransaction.reference_id || uniqueCode}_${matchingTransaction.amount}`;
  // Use a database transaction to ensure atomicity
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      // First check if transaction was already processed
      db.get('SELECT id FROM transactions WHERE reference_id = ? AND amount = ?', 
        [matchingTransaction.reference_id || uniqueCode, matchingTransaction.amount], 
        (err, row) => {
          if (err) {
            db.run('ROLLBACK');
            logger.error('Error checking transaction:', err);
            reject(err);
            return;
          }
          if (row) {
            db.run('ROLLBACK');
    logger.info(`Transaction ${transactionKey} already processed, skipping...`);
            resolve(false);
            return;
          }
          // Update user balance
          db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', 
            [deposit.originalAmount, deposit.userId], 
            function(err) {
              if (err) {
                db.run('ROLLBACK');
                logger.error('Error updating balance:', err);
                reject(err);
                return;
              }
    // Record the transaction
      db.run(
                'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
                [deposit.userId, deposit.originalAmount, 'deposit', matchingTransaction.reference_id || uniqueCode, Date.now()],
        (err) => {
                  if (err) {
                    db.run('ROLLBACK');
                    logger.error('Error recording transaction:', err);
                    reject(err);
                    return;
                  }
                  // Get updated balance
                  db.get('SELECT saldo FROM users WHERE user_id = ?', [deposit.userId], async (err, user) => {
                    if (err) {
                      db.run('ROLLBACK');
                      logger.error('Error getting updated balance:', err);
                      reject(err);
                      return;
                    }
                    // Send notification using sendPaymentSuccessNotification
    const notificationSent = await sendPaymentSuccessNotification(
      deposit.userId,
      deposit,
                      user.saldo
                    );
                    // Delete QR code message after payment success
                    if (deposit.qrMessageId) {
                      try {
                        await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
                      } catch (e) {
                        logger.error("Gagal menghapus pesan QR code:", e.message);
                      }
                    }
    if (notificationSent) {
      // Notifikasi ke grup untuk top up
      try {
        // Pada notifikasi ke grup (top up dan pembelian/renew), ambil info user:
        let userInfo;
        try {
          userInfo = await bot.telegram.getChat(deposit ? deposit.userId : (ctx ? ctx.from.id : ''));
        } catch (e) {
          userInfo = {};
        }
        const username = userInfo.username ? `@${userInfo.username}` : (userInfo.first_name || (deposit ? deposit.userId : (ctx ? ctx.from.id : '')));
        const userDisplay = userInfo.username
          ? `${username} (${deposit ? deposit.userId : (ctx ? ctx.from.id : '')})`
          : `${username}`;
        await bot.telegram.sendMessage(
          GROUP_ID,
          `<blockquote>
✅ <b>Top Up Berhasil</b>
👤 User: ${userDisplay}
💰 Nominal: <b>Rp ${deposit.originalAmount}</b>
🏦 Saldo Sekarang: <b>Rp ${user.saldo}</b>
?? Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
</blockquote>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { logger.error('Gagal kirim notif top up ke grup:', e.message); }
      // Hapus semua file di receipts setelah pembayaran sukses
      try {
        const receiptsDir = path.join(__dirname, 'receipts');
        if (fs.existsSync(receiptsDir)) {
          const files = fs.readdirSync(receiptsDir);
          for (const file of files) {
            fs.unlinkSync(path.join(receiptsDir, file));
          }
        }
      } catch (e) { logger.error('Gagal menghapus file di receipts:', e.message); }
      db.run('COMMIT');
      global.processedTransactions.add(transactionKey);
      delete global.pendingDeposits[uniqueCode];
      db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
      resolve(true);
    } else {
      db.run('ROLLBACK');
      reject(new Error('Failed to send payment notification.'));
    }
                  });
                }
              );
            }
          );
        }
      );
    });
  });
}

setInterval(checkQRISStatus, 10000);

async function recordAccountTransaction(userId, type) {
  return new Promise((resolve, reject) => {
    const referenceId = `account-${type}-${userId}-${Date.now()}`;
    db.run(
      'INSERT INTO transactions (user_id, type, reference_id, timestamp) VALUES (?, ?, ?, ?)',
      [userId, type, referenceId, Date.now()],
      (err) => {
        if (err) {
          logger.error('Error recording account transaction:', err.message);
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

//info server
async function resolveDomainToIP(domain) {
  try {
    const res = await dns.lookup(domain);
    return res.address;
  } catch (err) {
    logger.warn('⚠️ Gagal resolve domain:', err.message);
    return null;
  }
}

async function getISPAndLocation(ip) {
  try {
    const res = await fetch(`https://ipinfo.io/${ip}/json`);
    const data = await res.json();
    const isp = data.org || 'Tidak diketahui';
    const lokasi = data.city && data.country ? `${data.city}, ${data.country}` : 'Tidak diketahui';
    return { isp, lokasi };
  } catch (err) {
    logger.warn('⚠️ Gagal ambil ISP/Lokasi:', err.message);
    return { isp: 'Tidak diketahui', lokasi: 'Tidak diketahui' };
  }
}
// 💡 Fungsi validasi user harus reseller
async function onlyReseller(ctx) {
  const userId = ctx.from.id;
  return new Promise((resolve) => {
    db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err || !row || row.role !== 'reseller') {
        ctx.reply('⛔ *Panel ini hanya tersedia untuk reseller.*', { parse_mode: 'Markdown' });
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
function insertKomisi(ctx, type, username, totalHarga) {
  const komisi = Math.floor(totalHarga * 0.1);
  db.run(
    'INSERT INTO reseller_sales (reseller_id, buyer_id, akun_type, username, komisi) VALUES (?, ?, ?, ?, ?)',
    [ctx.from.id, ctx.from.id, type, username, komisi]
  );
}

// Validasi DB: coba buka file sebagai SQLite
function isValidSQLiteDB(path) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve(false);
      db.get("SELECT name FROM sqlite_master WHERE type='table'", (err2) => {
        db.close();
        resolve(!err2);
      });
    });
  });
}

function isValidSQLDump(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, sql) => {
      if (err) return resolve(false);
      const isSQL = sql.includes('CREATE TABLE') || sql.includes('INSERT INTO');
      resolve(isSQL);
    });
  });
}
app.listen(PORT, () => {
  logger.info(`🚀 Server berjalan di port ${PORT}`);

  const startBot = async (retry = 0) => {
    try {
      await bot.launch();
      logger.info('🤖 Bot Telegram aktif!');
    } catch (err) {
      const MAX_RETRY = 5;
      const delay = Math.min(10000 * (retry + 1), 60000); // max 1 menit

      logger.error(`❌ Error saat memulai bot: ${err.message}`);

      if (
        ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code) ||
        (err.response && err.response.status >= 500)
      ) {
        if (retry < MAX_RETRY) {
          logger.warn(`🔁 Coba reconnect (${retry + 1}/${MAX_RETRY}) dalam ${delay / 1000}s...`);
          setTimeout(() => startBot(retry + 1), delay);
        } else {
          logger.error('🚫 Gagal konek ke Telegram setelah beberapa percobaan. Periksa koneksi VPS.');
        }
      } else {
        logger.error('🚨 Error lain saat start bot. Tidak dilakukan retry.');
      }
    }
  };

  // 🚀 Mulai bot dengan reconnect logic
  startBot();
});