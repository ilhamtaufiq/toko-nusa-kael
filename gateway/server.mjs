// Gateway pemantau transaksi QRIS (GoBiz) untuk Nusa Kael.
// Hanya membaca riwayat transaksi dari QRIS statis yang sudah ada. Tidak membuat pembayaran apa pun.
// Login dengan email dan kata sandi dari halaman Pengaturan (atau GOPAY_EMAIL/GOPAY_PASSWORD bila diisi).
// Setelah login, gateway memeriksa transaksi sendiri setiap 30 detik, dan menyimpan hasil terakhirnya.
// Hanya menerima request dari backend lewat jaringan internal Docker. Port ini tidak dibuka ke publik.
// Setiap request wajib membawa header x-gateway-secret yang sama dengan GATEWAY_SECRET.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod, rm, readdir, access, constants as fsConstants } from 'node:fs/promises';
import { join } from 'node:path';
import { loginWithPassword, findMerchantId, listIncoming, GobizError } from './gobiz.mjs';

const PORT = Number(process.env.PORT || 3100);
const DATA_DIR = process.env.DATA_DIR || '/data';
const SECRET = process.env.GATEWAY_SECRET || '';
const EMAIL = process.env.GOPAY_EMAIL || '';
const PASSWORD = process.env.GOPAY_PASSWORD || '';
// GoBiz diperiksa sekali per 30 detik. Lebih sering berisiko membuat akun GoBiz ditandai (lihat README gobiz-payment).
const POLL_MS = 30 * 1000;
const MAX_ROWS = 100;

if (SECRET.length < 32) {
  console.error('GATEWAY_SECRET wajib diisi minimal 32 karakter.');
  process.exit(1);
}

const SESSION_PATH = join(DATA_DIR, 'gobiz-session.json');

// Hanya log status. Token, kata sandi, dan isi sesi tidak pernah dicetak.
const logger = {
  info: (msg) => console.log(`[gateway] ${msg}`),
  warn: (msg) => console.warn(`[gateway] ${msg}`),
  error: (msg) => console.error(`[gateway] ${msg}`),
};

async function saveSession(s) {
  try {
    await writeFile(SESSION_PATH, JSON.stringify(s), { mode: 0o600 });
    await chmod(SESSION_PATH, 0o600);
    logger.info(`sesi disimpan di ${SESSION_PATH}`);
  } catch (err) {
    logger.error(`GAGAL menyimpan sesi di ${SESSION_PATH}: ${err?.code || err?.name}`);
    throw err;
  }
}

async function loadSession() {
  if (!existsSync(SESSION_PATH)) return undefined;
  return JSON.parse(await readFile(SESSION_PATH, 'utf8'));
}

// Diagnosis penyimpanan: hanya nama file dan izin tulis. Isi file tidak pernah dicetak.
async function describeStorage() {
  let writable = 'tidak';
  try {
    await access(DATA_DIR, fsConstants.W_OK);
    writable = 'ya';
  } catch {}
  let files = '(tidak bisa dibaca)';
  try {
    files = (await readdir(DATA_DIR)).join(', ') || '(kosong)';
  } catch {}
  return `DATA_DIR=${DATA_DIR}, bisa ditulis: ${writable}, isi: ${files}`;
}

let session = null;

// Keadaan pemantauan. Dibaca oleh backend dan halaman admin.
const monitor = {
  running: false,
  lastPollAt: null,
  lastError: null,
  lastTransactionId: null,
  transactions: [],
};
let pollTimer = null;

async function pollOnce() {
  if (!session) return;
  try {
    const rows = await listIncoming({ accessToken: session.accessToken, merchantId: session.merchantId });
    rows.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    monitor.transactions = rows.slice(0, MAX_ROWS);
    monitor.lastTransactionId = monitor.transactions[0]?.id ?? monitor.lastTransactionId;
    monitor.lastPollAt = new Date().toISOString();
    monitor.lastError = null;
  } catch (err) {
    monitor.lastPollAt = new Date().toISOString();
    if (err?.code === 'TOKEN_EXPIRED') {
      // Token habis: coba login ulang hanya jika kredensial dari environment tersedia
      session = null;
      if (EMAIL && PASSWORD) {
        try {
          await loginWithCredentials(EMAIL, PASSWORD);
          return;
        } catch (e) {
          logger.error(`login ulang otomatis gagal: ${e?.code || e?.name}`);
        }
      }
      monitor.lastError = 'Sesi GoBiz habis. Login ulang di Pengaturan.';
      stopPolling();
      return;
    }
    monitor.lastError = String(err?.message || 'Gagal mengambil transaksi.').slice(0, 200);
    logger.error(`pemeriksaan gagal: ${err?.code || err?.name}`);
  }
}

function startPolling() {
  if (pollTimer) return;
  monitor.running = true;
  logger.info(`pemeriksaan transaksi dimulai (setiap ${POLL_MS / 1000} detik)`);
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  monitor.running = false;
  logger.info('pemeriksaan transaksi dihentikan');
}

/** Login dengan email dan kata sandi, lalu sesi disimpan dan pemeriksaan dimulai. Kata sandi tidak disimpan atau dicetak. */
async function loginWithCredentials(email, password) {
  const tokens = await loginWithPassword({ email, password });
  const merchantId = await findMerchantId(tokens.accessToken);
  const next = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, merchantId };
  await saveSession(next);
  session = next;
  monitor.lastError = null;
  logger.info('login GoBiz berhasil');
  stopPolling();
  startPolling();
}

async function startSession() {
  session = await loadSession();
  if (session) {
    logger.info('sesi GoBiz dimuat');
    startPolling();
    return;
  }
  logger.warn(`File sesi tidak ditemukan di ${SESSION_PATH}. ${await describeStorage()}`);
  if (EMAIL && PASSWORD) {
    try {
      await loginWithCredentials(EMAIL, PASSWORD);
    } catch (err) {
      logger.error(`login otomatis gagal: ${err?.code || err?.name}`);
    }
  } else {
    logger.warn('Belum login. Login lewat halaman Pengaturan di admin.');
  }
}

function secretOk(req) {
  const given = Buffer.from(String(req.headers['x-gateway-secret'] || ''));
  const want = Buffer.from(SECRET);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('body terlalu besar');
  }
  return raw ? JSON.parse(raw) : {};
}

function snapshot() {
  return {
    loggedIn: Boolean(session),
    running: monitor.running,
    pollSeconds: POLL_MS / 1000,
    lastPollAt: monitor.lastPollAt,
    lastError: monitor.lastError,
    lastTransactionId: monitor.lastTransactionId,
    transactions: monitor.transactions,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, loggedIn: Boolean(session), running: monitor.running });
    }
    if (!secretOk(req)) return send(res, 401, { message: 'Tidak diizinkan.' });

    if (req.method === 'GET' && req.url === '/v1/login/status') {
      return send(res, 200, { loggedIn: Boolean(session) });
    }
    // Login dengan email dan kata sandi yang diisi di halaman Pengaturan (lewat backend)
    if (req.method === 'POST' && req.url === '/v1/login/password') {
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 1 || password.length > 200) {
        return send(res, 422, { message: 'Email atau kata sandi tidak valid.' });
      }
      await loginWithCredentials(email, password);
      return send(res, 200, { loggedIn: true });
    }
    // Login ulang dengan kredensial dari environment, bila diisi
    if (req.method === 'POST' && req.url === '/v1/login/refresh') {
      if (!EMAIL || !PASSWORD) throw new GobizError('Kredensial GoBiz belum diisi. Login lewat halaman Pengaturan.', 'NO_CREDENTIALS');
      await loginWithCredentials(EMAIL, PASSWORD);
      return send(res, 200, { loggedIn: true });
    }
    if (req.method === 'POST' && req.url === '/v1/logout') {
      stopPolling();
      session = null;
      monitor.transactions = [];
      monitor.lastTransactionId = null;
      monitor.lastPollAt = null;
      monitor.lastError = null;
      await rm(SESSION_PATH, { force: true });
      return send(res, 200, { loggedIn: false });
    }

    // Keadaan terakhir dari pemeriksaan otomatis (tidak memanggil GoBiz)
    if (req.method === 'GET' && req.url === '/v1/transactions') {
      return send(res, 200, snapshot());
    }

    return send(res, 404, { message: 'Tidak ada.' });
  } catch (err) {
    if (err instanceof GobizError) {
      if (err.code === 'NO_CREDENTIALS') return send(res, 503, { message: err.message });
      if (err.code === 'PASSWORD_INVALID') return send(res, 409, { message: err.message });
      // Pesan dari GoBiz boleh ditampilkan ke admin, tapi dipotong dan tanpa string panjang mirip token
      const detail = String(err.message || '').replace(/[A-Za-z0-9_-]{32,}/g, '[disembunyikan]').slice(0, 200);
      logger.error(`${err.code}: ${detail}`);
      return send(res, 502, { message: detail });
    }
    logger.error(`request gagal: ${err?.name || 'error'}`);
    return send(res, 502, { message: 'Gateway gagal memproses permintaan.' });
  }
});

await startSession();
server.listen(PORT, '0.0.0.0', () => logger.info(`listening on ${PORT}`));
