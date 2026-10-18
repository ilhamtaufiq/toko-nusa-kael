// Login OTP sekali untuk akun GoBiz/GoPay Merchant. Dijalankan lewat:
//   docker exec -it nusa-kael-gateway npm run login
// Sesi disimpan ke DATA_DIR/gopay-session.json dengan izin 600. Token tidak pernah dicetak.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { GopayProvider } from 'merchantid';

const DATA_DIR = process.env.DATA_DIR || '/data';
const SESSION_PATH = join(DATA_DIR, 'gopay-session.json');

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

const logger = {
  debug() {},
  info: (m) => console.log(`[login] ${m}`),
  warn: (m) => console.warn(`[login] ${m}`),
  error: (m) => console.error(`[login] ${m}`),
};

async function saveSession(session) {
  await writeFile(SESSION_PATH, JSON.stringify(session), { mode: 0o600 });
  await chmod(SESSION_PATH, 0o600);
}

try {
  const phone = (await ask('Nomor HP GoBiz (contoh 0812xxxxxxx): ')).trim();
  const provider = new GopayProvider({ logger, onTokenRefreshed: saveSession });
  const challenge = await provider.requestOtp(phone);
  // Tanpa otpToken, GoPay tidak mengirim OTP. Jangan menunggu kode yang tidak akan datang.
  if (!challenge?.otpToken) throw new Error('GoPay tidak mengirim tantangan OTP untuk nomor ini.');
  console.log('OTP sudah diminta ke GoPay. Masukkan kode angka yang diterima (SMS, WhatsApp, atau aplikasi).');
  const otp = (await ask('Kode OTP: ')).trim();
  await provider.verifyOtp({ otp, otpToken: challenge.otpToken, phoneNumber: phone });
  await saveSession(provider.exportSession());
  console.log(`Login berhasil. Sesi disimpan di ${SESSION_PATH}.`);
  console.log('Restart service gateway agar polling aktif.');
} catch (err) {
  // Pesan GoPay ditampilkan, tapi string panjang mirip token disamarkan
  const detail = String(err?.message || '').replace(/[A-Za-z0-9_-]{32,}/g, '[disembunyikan]').slice(0, 200);
  console.error(`Login gagal: ${err?.code || err?.name || 'error'}${detail ? ` - ${detail}` : ''}. Coba lagi.`);
  process.exitCode = 1;
} finally {
  rl.close();
}
