import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type GopayStatus = { loggedIn: boolean; waitingOtp: boolean };
type Msg = { ok: boolean; text: string } | null;

/** Koneksi GoPay untuk QRIS. Login OTP dilakukan lewat gateway; sesi tidak pernah tampil di halaman ini. */
export default function GopayLogin({ call }: { call: Call }) {
  const [status, setStatus] = useState<GopayStatus | null>(null);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    call<GopayStatus>('/api/admin/gopay')
      .then(setStatus)
      .catch((x) => setMsg({ ok: false, text: (x as Error).message }));
  }, [call]);

  useEffect(() => {
    load();
  }, [load]);

  async function requestOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call('/api/admin/gopay/request', { method: 'POST', body: JSON.stringify({ phone }) });
      setMsg({ ok: true, text: 'Kode OTP sudah dikirim. Masukkan kode di bawah.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call('/api/admin/gopay/verify', { method: 'POST', body: JSON.stringify({ otp }) });
      setOtp('');
      setPhone('');
      setMsg({ ok: true, text: 'Koneksi GoPay berhasil.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!window.confirm('Putuskan koneksi GoPay? QRIS tidak bisa dibuat sampai login ulang.')) return;
    setBusy(true);
    try {
      await call('/api/admin/gopay/logout', { method: 'POST' });
      setMsg({ ok: true, text: 'Koneksi GoPay diputuskan.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="form gopay-card" aria-labelledby="gopay-title">
      <h2 id="gopay-title">Koneksi GoPay (QRIS)</h2>
      <p className={`gopay-status ${status?.loggedIn ? 'on' : 'off'}`}>
        {status === null
          ? 'Memuat status…'
          : status.loggedIn
            ? 'Terhubung. QRIS bisa dibuat.'
            : status.waitingOtp
              ? 'Menunggu kode OTP.'
              : 'Belum terhubung.'}
      </p>

      {status && !status.loggedIn && !status.waitingOtp && (
        <form onSubmit={requestOtp} className="gopay-form">
          <label>
            Nomor HP GoBiz
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0812xxxxxxx"
              required
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            Kirim OTP
          </button>
        </form>
      )}

      {status && !status.loggedIn && status.waitingOtp && (
        <form onSubmit={verifyOtp} className="gopay-form">
          <label>
            Kode OTP
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              required
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            Verifikasi
          </button>
        </form>
      )}

      {status?.loggedIn && (
        <button className="btn ghost" type="button" onClick={logout} disabled={busy}>
          Putuskan koneksi
        </button>
      )}

      {msg && (
        <p className={`msg ${msg.ok ? 'ok' : 'err'}`} role="status">
          {msg.text}
        </p>
      )}
    </section>
  );
}
