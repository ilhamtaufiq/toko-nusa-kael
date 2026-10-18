import { useEffect, useMemo, useState } from 'react';
import { getJson, rupiah, type Product } from '../lib/api';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

type DayStat = { day: number; transactions: number; revenue: number; revenue_known: number; cost: number; profit: number };
type ProductStat = {
  product_id: number;
  name: string;
  qty: number;
  revenue: number;
  revenue_known: number;
  cost: number;
  profit: number;
  missing_cost_lines: number;
};
type Report = {
  transactions: number;
  qty: number;
  revenue: number;
  revenue_known: number;
  cost: number;
  profit: number;
  margin: number;
  missing_cost_lines: number;
  days: DayStat[];
  products: ProductStat[];
};

const TZ = 'Asia/Jakarta';
const todayWIB = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const shift = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayLabel = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString('id-ID', { timeZone: TZ, day: '2-digit', month: 'short' });

export default function Analytics({ call }: { call: Call }) {
  const today = todayWIB();
  const [from, setFrom] = useState(shift(today, -29));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    getJson<Product[]>('/api/products', []).then(setProducts);
  }, []);

  useEffect(() => {
    setError('');
    call<Report>(`/api/admin/analytics?from=${from}&to=${to}`)
      .then(setReport)
      .catch((x) => {
        setReport(null);
        setError((x as Error).message);
      });
  }, [call, from, to]);

  const noCost = useMemo(() => products.filter((p) => p.cost == null), [products]);
  const maxDay = useMemo(() => Math.max(1, ...(report?.days ?? []).map((d) => d.revenue)), [report]);

  const presets: { label: string; from: string; to: string }[] = [
    { label: 'Hari ini', from: today, to: today },
    { label: '7 hari', from: shift(today, -6), to: today },
    { label: '30 hari', from: shift(today, -29), to: today },
    { label: 'Bulan ini', from: `${today.slice(0, 8)}01`, to: today },
  ];

  return (
    <div className="an">
      <div className="an-toolbar">
        <div className="an-presets" role="group" aria-label="Rentang cepat">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="an-chip"
              aria-pressed={from === p.from && to === p.to}
              onClick={() => {
                setFrom(p.from);
                setTo(p.to);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="an-range">
          <label>
            Dari
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Sampai
            <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </div>

      {error && <p className="an-error" role="alert">{error}</p>}

      {report && (
        <>
          <div className="an-cards">
            <Card label="Omzet" value={rupiah(report.revenue)} />
            <Card label="HPP (harga beli)" value={rupiah(report.cost)} />
            <Card label="Laba kotor" value={rupiah(report.profit)} tone={report.profit >= 0 ? 'good' : 'bad'} />
            <Card label="Margin" value={report.revenue_known > 0 ? `${report.margin.toFixed(1)}%` : '—'} />
            <Card label="Transaksi" value={String(report.transactions)} />
            <Card label="Barang terjual" value={String(report.qty)} />
          </div>

          {report.missing_cost_lines > 0 && (
            <p className="an-warn">
              {report.missing_cost_lines} baris penjualan belum punya harga beli saat dijual. Laba dan margin hanya dihitung dari barang yang harga belinya sudah diisi.
            </p>
          )}

          <section className="an-section">
            <h2>Omzet dan laba per hari</h2>
            {report.days.length === 0 ? (
              <p className="an-empty">Belum ada penjualan di rentang ini.</p>
            ) : (
              <div className="an-bars" role="img" aria-label="Grafik omzet dan laba per hari">
                {report.days.map((d) => (
                  <div className="an-day" key={d.day} title={`${dayLabel(d.day)}: omzet ${rupiah(d.revenue)}, laba ${rupiah(d.profit)}`}>
                    <div className="an-bar-pair">
                      <div className="an-bar revenue" style={{ height: `${(d.revenue / maxDay) * 100}%` }} />
                      <div
                        className={`an-bar profit${d.profit < 0 ? ' neg' : ''}`}
                        style={{ height: `${(Math.abs(d.profit) / maxDay) * 100}%` }}
                      />
                    </div>
                    <small>{dayLabel(d.day)}</small>
                  </div>
                ))}
              </div>
            )}
            <div className="an-legend">
              <span><i className="dot-revenue" /> Omzet</span>
              <span><i className="dot-profit" /> Laba</span>
            </div>
          </section>

          <section className="an-section">
            <h2>Barang per laba</h2>
            {report.products.length === 0 ? (
              <p className="an-empty">Belum ada barang terjual.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Barang</th><th>Terjual</th><th>Omzet</th><th>HPP</th><th>Laba</th><th>Margin</th></tr>
                  </thead>
                  <tbody>
                    {report.products.map((p) => {
                      const margin = p.revenue_known > 0 ? (p.profit / p.revenue_known) * 100 : null;
                      return (
                        <tr key={p.product_id}>
                          <td>
                            {p.name}
                            {p.missing_cost_lines > 0 && <small className="an-miss">harga beli belum diisi</small>}
                          </td>
                          <td>{p.qty}</td>
                          <td>{rupiah(p.revenue)}</td>
                          <td>{p.revenue_known > 0 ? rupiah(p.cost) : '—'}</td>
                          <td className={p.profit < 0 ? 'neg' : 'pos'}>{p.revenue_known > 0 ? rupiah(p.profit) : '—'}</td>
                          <td>{margin === null ? '—' : `${margin.toFixed(1)}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section className="an-section">
        <h2>Belum punya harga beli</h2>
        {noCost.length === 0 ? (
          <p className="an-empty">Semua barang sudah punya harga beli.</p>
        ) : (
          <>
            <p className="an-empty">Isi di tab Produk supaya laba terhitung lengkap.</p>
            <div className="an-chips-plain">
              {noCost.map((p) => (
                <span key={p.id} className="an-tag">{p.name}</span>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`an-card${tone ? ` ${tone}` : ''}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
