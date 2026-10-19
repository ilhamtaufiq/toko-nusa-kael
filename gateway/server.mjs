// Gateway pemantau transaksi QRIS (GoBiz) untuk Nusa Kael.
// Hanya membaca riwayat transaksi dari QRIS statis yang sudah ada. Tidak membuat pembayaran apa pun.
// Login memakai GOPAY_EMAIL dan GOPAY_PASSWORD (kata sandi login GoBiz), tanpa OTP.
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
// GoBiz dihubungi paling sering sekali per 30 detik, seberapapun banyak layar yang terbuka.
const CACHE_MS = 30 * 1000;

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
let cache = { at: 0, data: null };

/** Login dengan email dan kata sandi dari environment, lalu sesi disimpan. */
async function loginFromEnv() {
  if (!EMAIL || !PASSWORD) {
    throw new GobizError('GOPAY_EMAIL atau GOPAY_PASSWORD belum diisi di gateway.', 'NO_CREDENTIALS');
  }
  const tokens = await loginWithPassword({ email: EMAIL, password: PASSWORD });
  const merchantId = await findMerchantId(tokens.accessToken);
  const next = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, merchantId };
  await saveSession(next);
  session = next;
  cache = { at: 0, data: null };
  logger.info('login GoBiz berhasil');
}

async function startSession() {
  session = await loadSession();
  if (session) {
    logger.info('sesi GoBiz dimuat');
    return;
  }
  logger.warn(`File sesi tidak ditemukan di ${SESSION_PATH}. ${await describeStorage()}`);
  if (EMAIL && PASSWORD) {
    try {
      await loginFromEnv();
    } catch (err) {
      logger.error(`login otomatis gagal: ${err?.code || err?.name}`);
    }
  } else {
    logger.warn('GOPAY_EMAIL dan GOPAY_PASSWORD belum diisi. Gateway belum bisa login.');
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

/** Transaksi masuk, dengan cache 30 detik. Kalau token habis, login ulang sekali lalu coba lagi. */
async function getTransactions() {
  if (!session) throw new GobizError('Gateway belum login ke GoBiz.', 'NOT_LOGGED_IN');
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  let rows;
  try {
    rows = await listIncoming({ accessToken: session.accessToken, merchantId: session.merchantId });
  } catch (err) {
    if (err?.code !== 'TOKEN_EXPIRED') throw err;
    await loginFromEnv();
    rows = await listIncoming({ accessToken: session.accessToken, merchantId: session.merchantId });
  }
  const data = { fetchedAt: Date.now(), cacheSeconds: CACHE_MS / 1000, transactions: rows };
  cache = { at: Date.now(), data };
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, loggedIn: Boolean(session) });
    }
    if (!secretOk(req)) return send(res, 401, { message: 'Tidak diizinkan.' });

    if (req.method === 'GET' && req.url === '/v1/login/status') {
      return send(res, 200, { loggedIn: Boolean(session), configured: Boolean(EMAIL && PASSWORD) });
    }
    // Login ulang dengan kredensial dari environment, misalnya setelah kata sandi diganti di portal
    if (req.method === 'POST' && req.url === '/v1/login/refresh') {
      await loginFromEnv();
      return send(res, 200, { loggedIn: true });
    }
    if (req.method === 'POST' && req.url === '/v1/logout') {
      session = null;
      cache = { at: 0, data: null };
      await rm(SESSION_PATH, { force: true });
      return send(res, 200, { loggedIn: false });
    }

    if (req.method === 'GET' && req.url === '/v1/transactions') {
      return send(res, 200, await getTransactions());
    }

    return send(res, 404, { message: 'Tidak ada.' });
  } catch (err) {
    if (err instanceof GobizError) {
      if (err.code === 'NOT_LOGGED_IN' || err.code === 'NO_CREDENTIALS') return send(res, 503, { message: err.message });
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
