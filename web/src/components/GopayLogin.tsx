import { useCallback, useEffect, useState } from 'react';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type GopayStatus = { loggedIn: boolean; configured: boolean };
type Msg = { ok: boolean; text: string } | null;

/** Koneksi GoBiz untuk memantau QRIS. Login memakai email dan kata sandi yang diisi di server (GOPAY_EMAIL, GOPAY_PASSWORD). */
export default function GopayLogin({ call }: { call: Call }) {
  const [status, setStatus] = useState<GopayStatus | null>(null);
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

  async function reconnect() {
    setBusy(true);
    setMsg(null);
    try {
      await call('/api/admin/gopay/refresh', { method: 'POST' });
      setMsg({ ok: true, text: 'Koneksi GoBiz berhasil diperbarui.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!window.confirm('Putuskan koneksi GoBiz? Riwayat transaksi tidak bisa dilihat sampai login ulang.')) return;
    setBusy(true);
    try {
      await call('/api/admin/gopay/logout', { method: 'POST' });
      setMsg({ ok: true, text: 'Koneksi GoBiz diputuskan.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="form gopay-card" aria-labelledby="gopay-title">
      <h2 id="gopay-title">Koneksi GoBiz (pantau QRIS)</h2>
      <p className={`gopay-status ${status?.loggedIn ? 'on' : 'off'}`}>
        {status === null
          ? 'Memuat status…'
          : status.loggedIn
            ? 'Terhubung. Transaksi QRIS bisa dipantau.'
            : status.configured
              ? 'Belum terhubung. Tekan "Login ulang" untuk mencoba.'
              : 'Belum dikonfigurasi. Isi GOPAY_EMAIL dan GOPAY_PASSWORD di server.'}
      </p>

      {status?.configured && (
        <button className="btn" type="button" onClick={reconnect} disabled={busy}>
          {busy ? 'Memproses…' : 'Login ulang'}
        </button>
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
