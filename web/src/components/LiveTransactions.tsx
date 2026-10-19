import { useCallback, useEffect, useState } from 'react';
import { rupiah } from '../lib/api';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type Incoming = { id: string; time: string | null; amount: number; status: string; paymentType: string };
type Feed = { fetchedAt: number; cacheSeconds: number; transactions: Incoming[] };

// Halaman ini memakai cache gateway (30 detik). Tidak perlu lebih sering dari itu.
const REFRESH_MS = 30_000;

function formatTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Transaksi QRIS masuk dari GoBiz, untuk memantau pembayaran di QRIS statis toko. */
export default function LiveTransactions({ call }: { call: Call }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    call<Feed>('/api/admin/transactions')
      .then((r) => {
        setFeed(r);
        setError('');
      })
      .catch((x) => setError((x as Error).message))
      .finally(() => setLoading(false));
  }, [call]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const total = feed?.transactions.reduce((sum, t) => sum + t.amount, 0) ?? 0;

  return (
    <section className="form live-tx" aria-labelledby="live-tx-title">
      <h2 id="live-tx-title">Transaksi QRIS masuk</h2>
      <p className="live-tx-note">
        Diambil dari riwayat GoBiz setiap 30 detik. Pembayaran lewat QRIS statis toko.
      </p>

      <div className="live-tx-bar">
        <span>
          {feed
            ? `${feed.transactions.length} transaksi · total ${rupiah(total)} · diperbarui ${formatTime(new Date(feed.fetchedAt).toISOString())}`
            : 'Memuat…'}
        </span>
        <button type="button" className="btn ghost" onClick={load} disabled={loading}>
          {loading ? 'Memuat…' : 'Muat ulang'}
        </button>
      </div>

      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}

      {feed && feed.transactions.length === 0 && !error && (
        <p className="live-tx-empty">Belum ada transaksi QRIS masuk.</p>
      )}

      {feed && feed.transactions.length > 0 && (
        <div className="live-tx-table">
          <table>
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Nominal</th>
                <th>Jenis</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {feed.transactions.map((t) => (
                <tr key={t.id}>
                  <td>{formatTime(t.time)}</td>
                  <td>{rupiah(t.amount)}</td>
                  <td>{t.paymentType}</td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
