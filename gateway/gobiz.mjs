// Klien GoBiz (GoPay Merchant) untuk membaca riwayat transaksi QRIS.
// Port dari kavionn/gobiz-payment (MIT): alur login OTP dan endpoint yang sama, memakai fetch
// (bukan curl). Hanya membaca data; tidak ada endpoint untuk mengubah transaksi.
// Peringatan dari penyedia: login dan polling yang sering bisa membuat akun ditandai. Karena itu
// pemanggilan ke GoBiz dibatasi lewat cache di server (lihat server.mjs).
import { randomUUID } from 'node:crypto';

const BASE_URL = 'https://api.gobiz.co.id';
const ANALYTICS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';
const CLIENT_ID = 'go-biz-web-new';
const TIMEZONE = 'Asia/Jakarta';

export class GobizError extends Error {
  constructor(message, code = 'GOBIZ_ERROR') {
    super(message);
    this.code = code;
  }
}

// Header identik dengan getAuthHeaders di gobiz-payment. GoBiz menolak request yang header identitasnya kurang.
function authHeaders(accessToken) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'id',
    'Authentication-Type': 'go-id',
    'Authorization': accessToken ? `Bearer ${accessToken}` : 'Bearer',
    'Connection': 'keep-alive',
    'Content-Type': 'application/json',
    'Gojek-Country-Code': 'ID',
    'Gojek-Timezone': TIMEZONE,
    'Origin': 'https://portal.gofoodmerchant.co.id',
    'Referer': 'https://portal.gofoodmerchant.co.id/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'X-AppVersion': 'platform-v3.107.0-94ce5d57',
    'X-PhoneMake': 'Windows 10 64-bit',
    'X-PhoneModel': 'Chrome 149.0.0.0 on Windows 10 64-bit',
    'X-Platform': 'Web',
    'X-User-Locale': 'en-US',
    'X-User-Type': 'merchant',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'x-DeviceOS': 'Web',
    'x-appId': 'go-biz-web-dashboard',
    'x-uniqueid': randomUUID(),
  };
}

async function postJson(url, body, accessToken) {
  const res = await fetch(url, { method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/** Nomor HP dibersihkan lalu dikirim sebagai digit murni + country_code terpisah, seperti di gobiz-payment. */
export function normalizePhone(phone) {
  let n = String(phone).trim().replace(/\D/g, '');
  if (n.startsWith('62')) n = n.slice(2);
  else if (n.startsWith('0')) n = n.slice(1);
  return n;
}

/** Langkah 1: minta OTP. Mengembalikan otpToken; kosong berarti OTP tidak dikirim. */
export async function requestOtp(phone) {
  const { ok, data } = await postJson(`${BASE_URL}/goid/login/request`, {
    client_id: CLIENT_ID,
    phone_number: normalizePhone(phone),
    country_code: '62',
    login_type: 'otp',
  });
  if (!ok || data?.errors?.length) {
    throw new GobizError(`Permintaan OTP ditolak: ${data?.errors?.[0]?.message || 'tidak diketahui'}`, 'OTP_REJECTED');
  }
  const payload = data.data || data;
  return { otpToken: payload.otp_token || payload.token || null, phone: normalizePhone(phone) };
}

/** Langkah 2: tukar OTP dengan token. Hanya dipanggil setelah requestOtp. */
export async function verifyOtp({ otp, otpToken, phone }) {
  const { ok, data } = await postJson(`${BASE_URL}/goid/token`, {
    client_id: CLIENT_ID,
    grant_type: 'otp',
    data: { otp, ...(otpToken ? { otp_token: otpToken } : { phone_number: phone }) },
  });
  if (!ok || data?.errors?.length || !data.access_token) {
    throw new GobizError(`Login OTP gagal: ${data?.errors?.[0]?.message || 'kode salah atau kedaluwarsa'}`, 'OTP_INVALID');
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null };
}

/** Login dengan email dan kata sandi login (diatur di portal, lihat README gobiz-payment). Tanpa OTP. */
export async function loginWithPassword({ email, password }) {
  // Langkah pertama hanya pendahuluan di gobiz-payment; kegagalannya tidak dianggap fatal
  await postJson(`${BASE_URL}/goid/login/request`, { email, login_type: 'password', client_id: CLIENT_ID }).catch(() => {});
  const { ok, data } = await postJson(`${BASE_URL}/goid/token`, {
    client_id: CLIENT_ID,
    grant_type: 'password',
    data: { email, password },
  });
  if (!ok || data?.errors?.length || !data.access_token) {
    throw new GobizError(`Login email/kata sandi gagal: ${data?.errors?.[0]?.message || 'periksa email dan kata sandi'}`, 'PASSWORD_INVALID');
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null };
}

/** Mengambil ID merchant pertama yang terhubung dengan akun. */
export async function findMerchantId(accessToken) {
  const res = await fetch(`${BASE_URL}/v1/merchants/search`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ from: 0, to: 50, _source: ['id', 'merchant_name'] }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new GobizError('Sesi GoBiz habis. Login ulang.', 'TOKEN_EXPIRED');
  if (!res.ok) throw new GobizError(`Gagal mengambil merchant (${res.status}).`, 'MERCHANT_FAILED');
  const list = Array.isArray(data) ? data : data?.merchants || data?.hits || data?.data || [];
  const first = Array.isArray(list) ? list[0] : undefined;
  const id = first?.id || first?.merchant_id;
  if (!id) throw new GobizError('Tidak ada merchant yang terhubung dengan akun ini.', 'NO_MERCHANT');
  return id;
}

/**
 * Transaksi QRIS masuk dalam beberapa hari terakhir. Hanya status sukses yang diambil.
 * Mengembalikan daftar yang sudah dirapikan: id, waktu, nominal (rupiah), dan jenis pembayaran.
 */
export async function listIncoming({ accessToken, merchantId, days = 1, size = 50 }) {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const url = new URL(ANALYTICS_URL);
  url.searchParams.append('from', '0');
  url.searchParams.append('size', String(Math.min(size, 100)));
  url.searchParams.append('statuses', 'SETTLEMENT,CAPTURE');
  url.searchParams.append('payment_types', 'QRIS');
  url.searchParams.append('start_time', start.toISOString());
  url.searchParams.append('end_time', now.toISOString());
  url.searchParams.append('merchant_ids', merchantId);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'authentication-type': 'go-id',
      'authorization': `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
  });
  if (res.status === 401) throw new GobizError('Sesi GoBiz habis. Login ulang.', 'TOKEN_EXPIRED');
  if (!res.ok) throw new GobizError(`Gagal mengambil transaksi (${res.status}).`, 'HISTORY_FAILED');
  const data = await res.json();
  const rows = Array.isArray(data?.transactions) ? data.transactions : [];
  return rows.map((t) => ({
    id: String(t.transaction_id || t.id || t.order_id || `${t.transaction_time}_${t.gross_amount}`),
    time: t.transaction_time ?? null,
    amount: Math.round(Number(t.gross_amount || 0) / 100),
    status: t.status ?? 'SETTLEMENT',
    paymentType: t.payment_type ?? 'QRIS',
  }));
}
