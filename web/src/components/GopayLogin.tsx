import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type GopayStatus = { loggedIn: boolean };
type Msg = { ok: boolean; text: string } | null;

/** Koneksi GoBiz untuk memantau QRIS. Login dengan email dan kata sandi login GoFood Merchant. */
export default function GopayLogin({ call }: { call: Call }) {
  const [status, setStatus] = useState<GopayStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call('/api/admin/gopay/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setPassword('');
      setMsg({ ok: true, text: 'Terhubung ke GoBiz.' });
      load();
    } catch (x) {
      setPassword('');
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
            : 'Belum terhubung. Masukkan email dan kata sandi login GoFood Merchant.'}
      </p>

      {status && !status.loggedIn && (
        <form onSubmit={login} className="gopay-form">
          <label>
            Email GoBiz
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Kata sandi login
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Memproses…' : 'Login'}
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
