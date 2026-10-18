import { useEffect, useState } from 'react';
import { FALLBACK_PROMOS, getJson, rupiah, type Promo } from '../lib/api';

const pad = (n: number) => String(n).padStart(2, '0');

function Countdown({ endsAt }: { endsAt: number }) {
  // null saat render server agar tidak beda dengan hasil hydrate
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, endsAt - Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  if (left === null) return <span className="countdown">&nbsp;</span>;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return (
    <span className="countdown">
      {left === 0 ? 'Promo berakhir' : `Berakhir dalam ${d > 0 ? `${d} hari ` : ''}${pad(h)}:${pad(m)}:${pad(s)}`}
    </span>
  );
}

export default function Promos() {
  const [promos, setPromos] = useState<Promo[]>(FALLBACK_PROMOS);

  useEffect(() => {
    getJson<Promo[]>('/api/promos', FALLBACK_PROMOS).then(setPromos);
  }, []);

  return (
    <div className="promo-grid">
      {promos.map((p) => (
        <article className="promo" key={p.id}>
          <span className="save">Hemat {rupiah(p.normal_price - p.price)}</span>
          <h3>{p.title}</h3>
          <p className="detail">{p.detail}</p>
          <div className="price-row">
            <span className="price-now">{rupiah(p.price)}</span>
            <span className="price-old">{rupiah(p.normal_price)}</span>
          </div>
          <Countdown endsAt={p.ends_at} />
        </article>
      ))}
    </div>
  );
}
