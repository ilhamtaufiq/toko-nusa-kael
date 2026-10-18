import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { getJson, rupiah, type Product } from '../lib/api';
import Scanner from './Scanner';

// Token yang sama dengan panel admin, jadi cukup login sekali di salah satu halaman
const KEY = 'nk_admin_token';
const CASH_QUICK = [10_000, 20_000, 50_000, 100_000];

type Line = { product: Product; qty: number };
type Sale = {
  id: number;
  created_at: number;
  items: { name: string; qty: number }[];
  total: number;
  paid: number;
  change: number;
};
type Feedback = { ok: boolean; text: string } | null;

const readToken = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const saveToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* penyimpanan diblokir: sesi hanya bertahan selama halaman terbuka */
  }
};
const timeOf = (t: number) => new Date(t * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

function makeCall(token: string, onExpire: () => void): Call {
  return async function call<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) onExpire();
    if (!res.ok) throw new Error(body.message ?? 'Terjadi kesalahan.');
    return body as T;
  };
}

export default function Kasir() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  const signOut = useCallback(() => {
    saveToken(null);
    setToken(null);
  }, []);

  if (!ready) return null;
  if (!token) {
    return (
      <Login
        onDone={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  }
  return <Till token={token} onExpire={signOut} />;
}

/* ---------- Login ---------- */

function Login({ onDone }: { onDone: (t: string) => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message);
      onDone(body.token);
    } catch (x) {
      setErr(x instanceof Error && x.message ? x.message : 'Server tidak dapat dihubungi.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="k-login">
      <form className="k-login-card" onSubmit={submit}>
        <div className="k-brand big">
          <span className="logo-mark">K</span>
          <div>
            <b>Kasir</b>
            <small>Nusa Kael</small>
          </div>
        </div>
        <label>
          Kata sandi
          <input name="password" type="password" autoComplete="current-password" required autoFocus />
        </label>
        <button className="k-pay" type="submit" disabled={busy}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>
        <p className="k-err" role="alert">{err}</p>
      </form>
    </div>
  );
}

/* ---------- Kasir ---------- */

function Till({ token, onExpire }: { token: string; onExpire: () => void }) {
  const call = useMemo(() => makeCall(token, onExpire), [token, onExpire]);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Line[]>([]);
  const [paidText, setPaidText] = useState('');
  const [code, setCode] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Semua');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [camOn, setCamOn] = useState(false);
  const [sales, setSales] = useState<Sale[]>([]);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<Sale | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Bunyi scan: nada naik untuk berhasil, nada turun untuk gagal. Dibuat di browser, tanpa file audio.
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem('k_sound') !== 'off';
    } catch {
      return true;
    }
  });
  const audioRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    // Browser hanya mengizinkan suara setelah ada interaksi pengguna
    const unlock = () => {
      if (!audioRef.current) {
        try {
          audioRef.current = new AudioContext();
        } catch {
          return;
        }
      }
      audioRef.current.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  const toggleSound = () => {
    setSound((v) => {
      try {
        localStorage.setItem('k_sound', v ? 'off' : 'on');
      } catch {
        /* penyimpanan diblokir: pilihan hanya berlaku sampai halaman ditutup */
      }
      return !v;
    });
  };
  const beep = useCallback(
    (ok: boolean) => {
      const ctx = audioRef.current;
      if (!sound || !ctx) return;
      const now = ctx.currentTime;
      const tones: [number, number][] = ok ? [[880, 0], [1320, 0.09]] : [[220, 0], [160, 0.16]];
      for (const [freq, at] of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = ok ? 'sine' : 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + (ok ? 0.08 : 0.14));
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.16);
      }
    },
    [sound],
  );

  // Di layar sentuh, fokus otomatis akan memunculkan keyboard di layar: lewati.
  // Scanner USB/Bluetooth tetap bekerja karena mengirim input seperti keyboard fisik.
  const [touch] = useState(() => !window.matchMedia('(pointer: fine)').matches);
  const focusScan = useCallback(() => {
    if (!touch) codeRef.current?.focus();
  }, [touch]);

  const loadSales = useCallback(() => call<Sale[]>('/api/admin/sales').then(setSales).catch(() => {}), [call]);
  const loadProducts = useCallback(() => getJson<Product[]>('/api/products', []).then(setProducts), []);

  useEffect(() => {
    loadProducts();
    loadSales();
    focusScan();
  }, [loadProducts, loadSales, focusScan]);

  const total = cart.reduce((sum, l) => sum + l.product.price * l.qty, 0);
  const count = cart.reduce((sum, l) => sum + l.qty, 0);
  const paid = Number(paidText) || 0;
  const change = paid - total;
  const short = paidText !== '' && change < 0;
  const canPay = cart.length > 0 && paid >= total && !busy && !success;

  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category))), [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (category === 'Semua' || p.category === category) &&
        (!q || p.name.toLowerCase().includes(q) || (p.barcode ?? '').toLowerCase().includes(q)),
    );
  }, [products, query, category]);

  const addProduct = useCallback((p: Product) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i < 0) return [...c, { product: p, qty: 1 }];
      return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
    });
    setFeedback({ ok: true, text: `+1 ${p.name}` });
  }, []);

  const addByCode = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      // Cari dulu di data yang sudah dimuat, supaya barang langsung masuk tanpa menunggu server
      const local = products.find((p) => p.barcode === value);
      if (local) {
        addProduct(local);
        beep(true);
        focusScan();
        return;
      }
      try {
        const p = await call<Product>(`/api/admin/barcode?code=${encodeURIComponent(value)}`);
        addProduct(p);
        beep(true);
      } catch {
        setFeedback({ ok: false, text: `Barcode ${value} tidak dikenal` });
        beep(false);
      } finally {
        focusScan();
      }
    },
    [call, addProduct, products, focusScan, beep],
  );

  function onCodeSubmit(e: FormEvent) {
    e.preventDefault();
    const value = code;
    setCode('');
    addByCode(value);
  }

  const setQty = (id: number, qty: number) => {
    setCart((c) => (qty <= 0 ? c.filter((l) => l.product.id !== id) : c.map((l) => (l.product.id === id ? { ...l, qty } : l))));
    focusScan();
  };

  function clearCart() {
    if (!cart.length) return;
    if (!window.confirm('Kosongkan keranjang?')) return;
    setCart([]);
    setPaidText('');
    setFeedback(null);
    focusScan();
  }

  async function checkout() {
    if (!canPay) return;
    setBusy(true);
    try {
      const sale = await call<Sale>('/api/admin/sales', {
        method: 'POST',
        body: JSON.stringify({ items: cart.map((l) => ({ product_id: l.product.id, qty: l.qty })), paid }),
      });
      setSuccess(sale);
      setCart([]);
      setPaidText('');
      setFeedback(null);
      loadSales();
      loadProducts();
    } catch (x) {
      setFeedback({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function newSale() {
    setSuccess(null);
    focusScan();
  }

  // Enter di kolom uang diterima langsung memproses pembayaran
  function onPaidKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      checkout();
    }
  }

  // Enter atau Esc di layar sukses = transaksi baru
  useEffect(() => {
    if (!success) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') newSale();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const payLabel = cart.length === 0
    ? 'Tambah barang dulu'
    : paid < total
      ? `Kurang ${rupiah(total - paid)}`
      : 'Bayar & simpan';

  return (
    <div className="kasir">
      <header className="k-top">
        <div className="k-brand">
          <span className="logo-mark">K</span>
          <div>
            <b>Kasir</b>
            <small>Nusa Kael</small>
          </div>
        </div>
        <nav className="k-nav">
          <a href="/admin/">Admin</a>
          <button type="button" onClick={toggleSound} aria-pressed={sound}>
            {sound ? 'Suara: nyala' : 'Suara: mati'}
          </button>
          <button type="button" onClick={onExpire}>Keluar</button>
        </nav>
      </header>

      <div className="k-body">
        <section className="k-main">
          <form className="k-scan" onSubmit={onCodeSubmit}>
            <input
              ref={codeRef}
              className="k-scan-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Scan barcode atau QR, lalu Enter"
              aria-label="Kode barcode"
              autoComplete="off"
              inputMode={touch ? 'none' : 'text'}
            />
            <button type="button" className={`k-cam${camOn ? ' on' : ''}`} onClick={() => setCamOn((v) => !v)}>
              {camOn ? 'Tutup kamera' : 'Kamera'}
            </button>
          </form>

          <div className={`k-feedback ${feedback ? (feedback.ok ? 'ok' : 'err') : 'idle'}`} role="status" aria-live="polite">
            {feedback ? feedback.text : 'Siap scan. Scanner USB langsung bisa dipakai.'}
          </div>

          {camOn && (
            <Scanner
              onDetect={(c) => addByCode(c)}
              onError={(m) => {
                setFeedback({ ok: false, text: m });
                setCamOn(false);
              }}
              onClose={() => {
                setCamOn(false);
                focusScan();
              }}
            />
          )}

          <div className="k-filter">
            <input
              className="k-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari nama barang"
              aria-label="Cari barang"
            />
            <div className="k-chips" role="group" aria-label="Kategori">
              {['Semua', ...categories].map((c) => (
                <button key={c} type="button" className="k-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="k-grid">
            {filtered.map((p) => {
              const out = p.stock != null && p.stock <= 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="k-tile"
                  disabled={out}
                  onClick={() => {
                    addProduct(p);
                    focusScan();
                  }}
                >
                  <span className="k-emoji" aria-hidden="true">{p.emoji}</span>
                  <b>{p.name}</b>
                  <span className="k-price">{rupiah(p.price)}</span>
                  {p.stock != null && (
                    <span className={`k-stock${out ? ' out' : p.stock <= 5 ? ' low' : ''}`}>
                      {out ? 'Habis' : `Stok ${p.stock}`}
                    </span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && <p className="k-empty">Barang tidak ditemukan.</p>}
          </div>

          <details className="k-history">
            <summary>Transaksi terbaru ({sales.length})</summary>
            <div className="k-history-list">
              {sales.length === 0 && <p className="k-empty">Belum ada transaksi.</p>}
              {sales.slice(0, 30).map((s) => (
                <div key={s.id} className="k-history-row">
                  <div>
                    <b>#{s.id} · {timeOf(s.created_at)}</b>
                    <small>{s.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</small>
                  </div>
                  <strong>{rupiah(s.total)}</strong>
                </div>
              ))}
            </div>
          </details>
        </section>

        <aside className="k-cart" id="bayar" aria-label="Keranjang">
          <div className="k-cart-head">
            <h2>Keranjang</h2>
            <span>{count} barang</span>
          </div>

          {cart.length === 0 ? (
            <div className="k-empty big">Keranjang kosong.<br />Scan atau pilih barang di kiri.</div>
          ) : (
            <ul className="k-lines">
              {cart.map((l) => (
                <li key={l.product.id}>
                  <div className="k-line-name">
                    <b>{l.product.name}</b>
                    <small>{rupiah(l.product.price)} / {l.product.unit}</small>
                  </div>
                  <div className="k-qty">
                    <button type="button" onClick={() => setQty(l.product.id, l.qty - 1)} aria-label={`Kurangi ${l.product.name}`}>−</button>
                    <span aria-live="polite">{l.qty}</span>
                    <button type="button" onClick={() => setQty(l.product.id, l.qty + 1)} aria-label={`Tambah ${l.product.name}`}>+</button>
                  </div>
                  <strong className="k-line-sum">{rupiah(l.product.price * l.qty)}</strong>
                  <button type="button" className="k-remove" onClick={() => setQty(l.product.id, 0)} aria-label={`Hapus ${l.product.name}`}>×</button>
                </li>
              ))}
            </ul>
          )}

          <div className="k-total">
            <span>Total</span>
            <strong>{rupiah(total)}</strong>
          </div>

          <label className="k-paid-label" htmlFor="k-paid">Uang diterima</label>
          <input
            id="k-paid"
            className="k-paid"
            type="number"
            inputMode="numeric"
            min={0}
            value={paidText}
            onChange={(e) => setPaidText(e.target.value)}
            onKeyDown={onPaidKey}
            placeholder="0"
          />
          <div className="k-quick">
            <button type="button" onClick={() => setPaidText(String(total))} disabled={!total}>Uang pas</button>
            {CASH_QUICK.map((v) => (
              <button key={v} type="button" onClick={() => setPaidText(String(v))}>{rupiah(v)}</button>
            ))}
          </div>

          <div className={`k-change${short ? ' bad' : ''}`}>
            <span>{short ? 'Kurang' : 'Kembalian'}</span>
            <strong>{paidText ? rupiah(Math.abs(change)) : '—'}</strong>
          </div>

          <button type="button" className="k-pay" disabled={!canPay} onClick={checkout}>
            {busy ? 'Menyimpan…' : payLabel}
          </button>
          {cart.length > 0 && (
            <button type="button" className="k-clear" onClick={clearCart}>Kosongkan keranjang</button>
          )}
        </aside>
      </div>

      <div className="k-mobile-bar">
        <div>
          <small>{count} barang</small>
          <b>{rupiah(total)}</b>
        </div>
        <a href="#bayar">Bayar</a>
      </div>

      {success && (
        <div className="k-modal" role="dialog" aria-modal="true" aria-label="Transaksi berhasil">
          <div className="k-card">
            <span className="k-check" aria-hidden="true">✓</span>
            <p>Transaksi #{success.id} tersimpan</p>
            <small>Kembalian</small>
            <strong className="k-big">{rupiah(success.change)}</strong>
            <small>Dibayar {rupiah(success.paid)} · Total {rupiah(success.total)}</small>
            <button type="button" className="k-pay" onClick={newSale} autoFocus>Transaksi baru</button>
          </div>
        </div>
      )}
    </div>
  );
}
