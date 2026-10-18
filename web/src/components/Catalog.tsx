import { useEffect, useMemo, useState } from 'react';
import { FALLBACK_PRODUCTS, FALLBACK_SETTINGS, getJson, rupiah, waLink, type Product, type Settings } from '../lib/api';

const CATEGORIES = ['Semua', 'Sembako', 'Segar', 'Minuman', 'Camilan', 'Rumah'];
const TINTS: Record<string, string> = {
  Sembako: '#f6e3b0',
  Segar: '#d8ecd0',
  Minuman: '#d3e6ef',
  Camilan: '#f7d6c9',
  Rumah: '#e5dcf0',
};

export default function Catalog() {
  const [all, setAll] = useState<Product[]>(FALLBACK_PRODUCTS);
  const [category, setCategory] = useState('Semua');
  const [cart, setCart] = useState<Record<number, number>>({});
  const [settings, setSettings] = useState<Settings>(FALLBACK_SETTINGS);

  useEffect(() => {
    getJson<Product[]>('/api/products', FALLBACK_PRODUCTS).then(setAll);
    getJson<Settings>('/api/settings', FALLBACK_SETTINGS).then(setSettings);
  }, []);

  const shown = useMemo(
    () => (category === 'Semua' ? all : all.filter((p) => p.category === category)),
    [all, category],
  );

  const lines = useMemo(
    () => all.filter((p) => cart[p.id]).map((p) => ({ p, qty: cart[p.id] })),
    [all, cart],
  );
  const total = lines.reduce((sum, { p, qty }) => sum + p.price * qty, 0);

  const change = (id: number, delta: number) =>
    setCart((c) => {
      const next = { ...c, [id]: Math.max(0, (c[id] ?? 0) + delta) };
      if (!next[id]) delete next[id];
      return next;
    });

  const waText = encodeURIComponent(
    'Halo Nusa Kael, saya mau pesan:\n' +
      lines.map(({ p, qty }) => `- ${qty}x ${p.name} (${p.unit})`).join('\n') +
      `\nEstimasi total: ${rupiah(total)}`,
  );

  return (
    <div className="catalog-layout">
      <div>
        <div className="tabs" role="group" aria-label="Kategori produk">
          {CATEGORIES.map((c) => (
            <button key={c} className="tab" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>

        <div className="product-grid">
          {shown.map((p) => (
            <article className="product" key={p.id}>
              <div className="pic" style={{ ['--tint' as string]: TINTS[p.category] }} aria-hidden="true">
                {p.tag && <span className="badge">{p.tag}</span>}
                {p.emoji}
              </div>
              <div className="info">
                <h3>{p.name}</h3>
                <span className="unit">per {p.unit}</span>
                <div className="foot">
                  <span className="tag">{rupiah(p.price)}</span>
                  <button className="add" onClick={() => change(p.id, 1)} aria-label={`Tambah ${p.name} ke daftar belanja`}>
                    +
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      <aside className="basket" aria-label="Daftar belanja">
        <h3>Daftar belanja</h3>
        {lines.length === 0 ? (
          <p className="empty">Belum ada barang. Tekan + pada produk untuk menyusun daftar, lalu kirim ke toko lewat WhatsApp.</p>
        ) : (
          <ul>
            {lines.map(({ p, qty }) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <strong>{rupiah(p.price * qty)}</strong>
                <span className="qty">
                  <button onClick={() => change(p.id, -1)} aria-label={`Kurangi ${p.name}`}>−</button>
                  <span aria-live="polite">{qty}</span>
                  <button onClick={() => change(p.id, 1)} aria-label={`Tambah ${p.name}`}>+</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="sum">
          <span>Estimasi</span>
          <span>{rupiah(total)}</span>
        </div>
        <a
          className="btn turmeric"
          aria-disabled={lines.length === 0 || !settings.whatsapp}
          href={lines.length && settings.whatsapp ? `${waLink(settings.whatsapp)}?text=${waText}` : undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          Pesan via WhatsApp
        </a>
      </aside>
    </div>
  );
}
