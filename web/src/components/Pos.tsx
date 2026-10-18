import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { getJson, rupiah, type Product } from '../lib/api';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type Line = { product: Product; qty: number };
type Sale = {
  id: number;
  created_at: number;
  items: { name: string; qty: number }[];
  total: number;
  paid: number;
  change: number;
};
type Msg = { ok: boolean; text: string } | null;
type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const timeOf = (t: number) => new Date(t * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

/** Kasir: scan barcode/QR (scanner USB atau kamera), keranjang, dan pembayaran tunai. */
export default function Pos({ call }: { call: Call }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Line[]>([]);
  const [paidText, setPaidText] = useState('');
  const [code, setCode] = useState('');
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [busy, setBusy] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const loadSales = useCallback(() => call<Sale[]>('/api/admin/sales').then(setSales).catch(() => {}), [call]);

  useEffect(() => {
    getJson<Product[]>('/api/products', []).then(setProducts);
    loadSales();
    codeRef.current?.focus();
  }, [loadSales]);

  const total = cart.reduce((sum, l) => sum + l.product.price * l.qty, 0);
  const paid = Number(paidText) || 0;
  const change = paid - total;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode ?? '').toLowerCase().includes(q))
      : products;
    return list.slice(0, 40);
  }, [products, query]);

  const addProduct = useCallback((p: Product) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i < 0) return [...c, { product: p, qty: 1 }];
      return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
    });
  }, []);

  const setQty = (id: number, qty: number) =>
    setCart((c) => (qty <= 0 ? c.filter((l) => l.product.id !== id) : c.map((l) => (l.product.id === id ? { ...l, qty } : l))));

  const addByCode = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      try {
        const p = await call<Product>(`/api/admin/barcode?code=${encodeURIComponent(value)}`);
        addProduct(p);
        setMsg({ ok: true, text: `+1 ${p.name}` });
      } catch (x) {
        setMsg({ ok: false, text: `${value}: ${(x as Error).message}` });
      }
    },
    [call, addProduct],
  );

  function onCodeSubmit(e: FormEvent) {
    e.preventDefault();
    const value = code;
    setCode('');
    addByCode(value).finally(() => codeRef.current?.focus());
  }

  // Pemindai kamera (BarcodeDetector). Browser yang tidak mendukung akan diberi tahu.
  useEffect(() => {
    if (!camOn) return;
    const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor) {
      setMsg({ ok: false, text: 'Browser ini belum mendukung pemindai kamera. Pakai scanner USB atau ketik kodenya.' });
      setCamOn(false);
      return;
    }
    const detector = new Ctor({ formats: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let alive = true;
    let last = '';
    let lastAt = 0;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = videoRef.current;
        if (!v || !alive) return;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (!alive || !videoRef.current) return;
          try {
            const raw = (await detector.detect(videoRef.current))[0]?.rawValue;
            // Kode yang sama tidak ditambahkan berkali-kali dalam 2 detik
            if (raw && (raw !== last || Date.now() - lastAt > 2000)) {
              last = raw;
              lastAt = Date.now();
              addByCode(raw);
            }
          } catch {
            /* frame belum siap, coba lagi */
          }
          timer = window.setTimeout(tick, 350);
        };
        tick();
      } catch {
        setMsg({ ok: false, text: 'Kamera tidak bisa dibuka. Izinkan akses kamera atau pakai scanner USB.' });
        setCamOn(false);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camOn, addByCode]);

  async function checkout() {
    if (!cart.length || paid < total) return;
    setBusy(true);
    try {
      const sale = await call<Sale>('/api/admin/sales', {
        method: 'POST',
        body: JSON.stringify({ items: cart.map((l) => ({ product_id: l.product.id, qty: l.qty })), paid }),
      });
      setMsg({ ok: true, text: `Transaksi #${sale.id} tersimpan. Kembalian ${rupiah(sale.change)}.` });
      setCart([]);
      setPaidText('');
      loadSales();
      getJson<Product[]>('/api/products', []).then(setProducts);
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
      codeRef.current?.focus();
    }
  }

  return (
    <div className="pos">
      <section className="pos-main">
        <form className="pos-scan" onSubmit={onCodeSubmit}>
          <input
            ref={codeRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan barcode/QR, lalu Enter"
            aria-label="Kode barcode"
            autoComplete="off"
          />
          <button type="button" className="btn ghost" onClick={() => setCamOn((v) => !v)}>
            {camOn ? 'Tutup kamera' : 'Pindai kamera'}
          </button>
        </form>
        {camOn && <video ref={videoRef} className="pos-video" muted playsInline />}

        <input
          className="pos-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Atau cari nama barang…"
          aria-label="Cari barang"
        />
        <div className="pos-products">
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pos-item"
              onClick={() => {
                addProduct(p);
                setMsg(null);
                codeRef.current?.focus();
              }}
            >
              <span className="pos-emoji" aria-hidden="true">{p.emoji}</span>
              <b>{p.name}</b>
              <small>{rupiah(p.price)}{p.stock != null ? ` · stok ${p.stock}` : ''}</small>
            </button>
          ))}
          {filtered.length === 0 && <p className="muted">Barang tidak ditemukan.</p>}
        </div>
      </section>

      <aside className="pos-cart" aria-label="Keranjang">
        <div className="pos-cart-head">
          <h2>Keranjang</h2>
          {cart.length > 0 && (
            <button type="button" className="link-btn" onClick={() => { setCart([]); setPaidText(''); }}>Kosongkan</button>
          )}
        </div>
        {cart.length === 0 ? (
          <p className="muted">Belum ada barang. Scan atau pilih barang di sebelah kiri.</p>
        ) : (
          <ul className="pos-lines">
            {cart.map((l) => (
              <li key={l.product.id}>
                <div className="pos-line-name">
                  <b>{l.product.name}</b>
                  <small>{rupiah(l.product.price)} × {l.qty}</small>
                </div>
                <div className="qty">
                  <button type="button" onClick={() => setQty(l.product.id, l.qty - 1)} aria-label={`Kurangi ${l.product.name}`}>−</button>
                  <span aria-live="polite">{l.qty}</span>
                  <button type="button" onClick={() => setQty(l.product.id, l.qty + 1)} aria-label={`Tambah ${l.product.name}`}>+</button>
                </div>
                <strong>{rupiah(l.product.price * l.qty)}</strong>
              </li>
            ))}
          </ul>
        )}

        <div className="pos-total"><span>Total</span><strong>{rupiah(total)}</strong></div>

        <label className="pos-paid">
          Uang diterima (Rp)
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={paidText}
            onChange={(e) => setPaidText(e.target.value)}
            placeholder="0"
          />
        </label>
        <button type="button" className="btn ghost" onClick={() => setPaidText(String(total))} disabled={!total}>
          Uang pas
        </button>

        <div className="pos-total">
          <span>{change < 0 && paidText ? 'Kurang' : 'Kembalian'}</span>
          <strong className={change < 0 && paidText ? 'bad' : ''}>{paidText ? rupiah(Math.abs(change)) : '—'}</strong>
        </div>

        <button type="button" className="btn pos-pay" disabled={busy || !cart.length || paid < total} onClick={checkout}>
          {busy ? 'Menyimpan…' : 'Bayar & simpan'}
        </button>
        <p className={`msg ${msg?.ok ? 'ok' : 'err'}`} role="status">{msg?.text ?? ''}</p>
      </aside>

      <section className="pos-sales">
        <h2>Transaksi terbaru</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Waktu</th><th>Barang</th><th>Total</th><th>Bayar</th><th>Kembali</th></tr></thead>
            <tbody>
              {sales.length === 0 && <tr><td colSpan={5}>Belum ada transaksi.</td></tr>}
              {sales.slice(0, 30).map((s) => (
                <tr key={s.id}>
                  <td>#{s.id} · {timeOf(s.created_at)}</td>
                  <td>{s.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</td>
                  <td>{rupiah(s.total)}</td>
                  <td>{rupiah(s.paid)}</td>
                  <td>{rupiah(s.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
