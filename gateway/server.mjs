// Gateway QRIS dinamis (GoPay Merchant) untuk Nusa Kael.
// Hanya menerima request dari backend lewat jaringan internal Docker. Port ini tidak dibuka ke publik.
// Setiap request wajib membawa header x-gateway-secret yang sama dengan GATEWAY_SECRET.
import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GopayProvider, staticToDynamicQris } from 'merchantid';
import { FilePaymentStore } from './store.mjs';

const PORT = Number(process.env.PORT || 3100);
const DATA_DIR = process.env.DATA_DIR || '/data';
const SECRET = process.env.GATEWAY_SECRET || '';
const MERCHANT_ID = process.env.GOPAY_MERCHANT_ID || '';
const STATIC_QRIS = process.env.GOPAY_STATIC_QRIS || '';
const EXPIRY_MS = 15 * 60 * 1000;

if (SECRET.length < 32) {
  console.error('GATEWAY_SECRET wajib diisi minimal 32 karakter.');
  process.exit(1);
}

const SESSION_PATH = join(DATA_DIR, 'gopay-session.json');
const store = new FilePaymentStore(join(DATA_DIR, 'payments.json'));

async function saveSession(session) {
  await writeFile(SESSION_PATH, JSON.stringify(session), { mode: 0o600 });
  await chmod(SESSION_PATH, 0o600);
}

async function loadSession() {
  if (!existsSync(SESSION_PATH)) return undefined;
  return JSON.parse(await readFile(SESSION_PATH, 'utf8'));
}

// Hanya log status, tidak pernah mencetak token, OTP, atau isi sesi
const logger = {
  debug() {},
  info: (msg) => console.log(`[gateway] ${msg}`),
  warn: (msg) => console.warn(`[gateway] ${msg}`),
  error: (msg) => console.error(`[gateway] ${msg}`),
};

let provider = null;
let payments = null;

async function startProvider() {
  const session = await loadSession();
  if (!session) {
    logger.warn('Belum login. Login lewat halaman Pengaturan di admin.');
    return;
  }
  provider = new GopayProvider({
    merchantId: MERCHANT_ID || undefined,
    session,
    staticQris: STATIC_QRIS || undefined,
    store,
    logger,
    onTokenRefreshed: saveSession,
  });
  payments = provider.payments();
  payments.activate();
  payments.start();
  payments.on('paid', (p) => logger.info(`pembayaran lunas: ${p.reference ?? p.id}`));
  payments.on('expired', (p) => logger.info(`pembayaran kedaluwarsa: ${p.reference ?? p.id}`));
  payments.on('error', (e) => logger.error(`polling gagal: ${e.message}`));
  logger.info('sesi GoPay dimuat, polling aktif');
}

// Login OTP lewat HTTP (dipanggil dari halaman Pengaturan admin, lewat backend).
// Status "menunggu OTP" hanya disimpan di memori dan kedaluwarsa dalam 10 menit.
const OTP_TTL_MS = 10 * 60 * 1000;
let pendingLogin = null;

function stopProvider() {
  if (payments) payments.stop();
  payments = null;
  provider = null;
}

async function requestLoginOtp(phone) {
  const candidate = new GopayProvider({ logger });
  const challenge = await candidate.requestOtp(phone);
  // Tanpa otpToken, OTP tidak pernah dikirim GoPay. Jangan dianggap berhasil.
  if (!challenge?.otpToken) {
    throw Object.assign(new Error('GoPay tidak mengirim tantangan OTP untuk nomor ini.'), { code: 'OTP_NOT_SENT' });
  }
  pendingLogin = { provider: candidate, phone, otpToken: challenge.otpToken, at: Date.now() };
}

async function verifyLoginOtp(otp) {
  if (!pendingLogin || Date.now() - pendingLogin.at > OTP_TTL_MS) {
    pendingLogin = null;
    throw Object.assign(new Error('OTP belum diminta atau sudah kedaluwarsa.'), { code: 'OTP_EXPIRED' });
  }
  const { provider: candidate, phone, otpToken } = pendingLogin;
  await candidate.verifyOtp({ otp, otpToken, phoneNumber: phone });
  await saveSession(candidate.exportSession());
  pendingLogin = null;
  stopProvider();
  await startProvider();
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

function publicView(p) {
  return {
    id: p.id,
    reference: p.reference ?? null,
    status: p.status,
    baseAmount: p.baseAmount,
    uniqueAmount: p.uniqueAmount,
    expiresAt: p.expiresAt,
    qrString: p.qrString ?? null,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, loggedIn: Boolean(provider) });
    }
    if (!secretOk(req)) return send(res, 401, { message: 'Tidak diizinkan.' });

    if (req.method === 'GET' && req.url === '/v1/login/status') {
      const waiting = Boolean(pendingLogin) && Date.now() - pendingLogin.at <= OTP_TTL_MS;
      return send(res, 200, { loggedIn: Boolean(payments), waitingOtp: waiting });
    }
    if (req.method === 'POST' && req.url === '/v1/login/request') {
      const body = await readJson(req);
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      if (!/^(\+?62|0)[0-9]{8,13}$/.test(phone.replace(/[\s-]/g, ''))) {
        return send(res, 422, { message: 'Nomor HP tidak valid.' });
      }
      await requestLoginOtp(phone.replace(/[\s-]/g, ''));
      return send(res, 200, { sent: true });
    }
    if (req.method === 'POST' && req.url === '/v1/login/verify') {
      const body = await readJson(req);
      const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
      if (!/^[0-9]{4,8}$/.test(otp)) return send(res, 422, { message: 'Kode OTP tidak valid.' });
      await verifyLoginOtp(otp);
      return send(res, 200, { loggedIn: Boolean(payments) });
    }
    if (req.method === 'POST' && req.url === '/v1/logout') {
      stopProvider();
      pendingLogin = null;
      await rm(SESSION_PATH, { force: true });
      return send(res, 200, { loggedIn: false });
    }

    if (!payments) return send(res, 503, { message: 'Gateway belum login ke GoPay.' });

    if (req.method === 'POST' && req.url === '/v1/payments') {
      const body = await readJson(req);
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
        return send(res, 422, { message: 'Nominal tidak valid.' });
      }
      const reference = typeof body.reference === 'string' ? body.reference.slice(0, 64) : undefined;
      // Tanpa kode unik: pembeli membayar nominal pas. Aturannya satu pesanan per nominal yang masih menunggu.
      const scope = provider.getPaymentScope();
      const active = await store.listActive(scope);
      if (active.some((p) => p.uniqueAmount === amount && p.expiresAt > Date.now())) {
        return send(res, 409, { message: 'Masih ada pesanan QRIS dengan nominal sama. Tunggu 15 menit atau cek pembayarannya.' });
      }
      const staticQris = provider.staticQris || STATIC_QRIS;
      if (!staticQris) return send(res, 503, { message: 'QRIS statis belum diatur di gateway.' });
      const now = Date.now();
      const payment = {
        id: randomUUID(),
        scope,
        baseAmount: amount,
        uniqueOffset: 0,
        uniqueAmount: amount,
        status: 'pending',
        createdAt: now,
        expiresAt: now + EXPIRY_MS,
        reference,
        qrString: staticToDynamicQris(staticQris, amount),
      };
      await store.create(payment);
      return send(res, 201, publicView(payment));
    }

    const match = req.method === 'GET' && req.url?.match(/^\/v1\/payments\/([A-Za-z0-9_-]{1,80})$/);
    if (match) {
      const payment = await store.get(match[1]);
      if (!payment) return send(res, 404, { message: 'Pembayaran tidak ditemukan.' });
      return send(res, 200, publicView(payment));
    }

    return send(res, 404, { message: 'Tidak ada.' });
  } catch (err) {
    // Kesalahan alur yang aman ditampilkan (misalnya OTP belum diminta)
    if (err?.code === 'OTP_EXPIRED') return send(res, 409, { message: err.message });
    if (err?.code === 'OTP_NOT_SENT') {
      logger.error('OTP tidak terkirim: GoPay tidak mengembalikan tantangan OTP');
      return send(res, 502, { message: err.message });
    }
    // Pesan GoPay (misalnya "nomor tidak terdaftar") dipakai untuk admin, tanpa token, dan dipotong.
    // Detail lengkapnya hanya dicatat di log server, supaya tidak ada data sensitif ke browser.
    const detail = String(err?.message || '').replace(/[A-Za-z0-9_-]{32,}/g, '[disembunyikan]').slice(0, 200);
    logger.error(`request gagal: ${err?.code || err?.name || 'error'} ${detail}`);
    return send(res, 502, { message: detail ? `GoPay: ${detail}` : 'Gateway gagal memproses permintaan.' });
  }
});

await startProvider();
server.listen(PORT, '0.0.0.0', () => logger.info(`listening on ${PORT}`));
