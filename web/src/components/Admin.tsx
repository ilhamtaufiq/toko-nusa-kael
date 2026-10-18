import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { rupiah, type Product, type Promo, type Settings } from '../lib/api';
import Pos from './Pos';

type Subscriber = { id: number; name: string; whatsapp: string; created_at: number };
type Tab = 'kasir' | 'produk' | 'promo' | 'pelanggan' | 'pengaturan';

const KEY = 'nk_admin_token';
const CATEGORIES = ['Sembako', 'Segar', 'Minuman', 'Camilan', 'Rumah'];

const readToken = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export default function Admin() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
    setToken(null);
  }, []);

  if (!ready) return null;
  if (!token) {
    return (
      <Login
        onDone={(t) => {
          try {
            sessionStorage.setItem(KEY, t);
          } catch {}
          setToken(t);
        }}
      />
    );
  }
  return <Panel token={token} onExpire={signOut} />;
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
    <form className="form login" method="post" onSubmit={submit}>
      <h1>Admin Nusa Kael</h1>
      <label>
        Kata sandi
        <input name="password" type="password" autoComplete="current-password" required autoFocus />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        Masuk
      </button>
      <p className="msg err" role="alert">{err}</p>
    </form>
  );
}

/* ---------- Panel ---------- */

function useApi(token: string, onExpire: () => void) {
  return useCallback(
    async function call<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
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
    },
    [token, onExpire],
  );
}

function Panel({ token, onExpire }: { token: string; onExpire: () => void }) {
  const [tab, setTab] = useState<Tab>('kasir');
  const call = useApi(token, onExpire);

  const logout = async () => {
    await call('/api/admin/logout', { method: 'POST' }).catch(() => {});
    onExpire();
  };

  return (
    <div className="admin">
      <header className="admin-bar">
        <h1>Admin Nusa Kael</h1>
        <div className="tabs" role="group" aria-label="Bagian admin">
          {(['kasir', 'produk', 'promo', 'pelanggan', 'pengaturan'] as Tab[]).map((t) => (
            <button key={t} className="tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <a className="btn ghost" href="/" target="_blank" rel="noopener noreferrer">Lihat situs</a>
        <button className="btn ghost" onClick={logout}>Keluar</button>
      </header>
      {tab === 'kasir' && <Pos call={call} />}
      {tab === 'produk' && <Products call={call} />}
      {tab === 'promo' && <Promos call={call} />}
      {tab === 'pelanggan' && <Subscribers call={call} />}
      {tab === 'pengaturan' && <ShopSettings call={call} />}
    </div>
  );
}

type Call = ReturnType<typeof useApi>;

function Notice({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return <p className={`msg ${msg?.ok ? 'ok' : 'err'}`} role="status">{msg?.text ?? ''}</p>;
}

/* ---------- Produk ---------- */

const emptyProduct = { name: '', category: 'Sembako', price: '', unit: '', emoji: '', tag: '', barcode: '', stock: '' };

function Products({ call }: { call: Call }) {
  const [items, setItems] = useState<Product[]>([]);
  const [form, setForm] = useState(emptyProduct);
  const [editId, setEditId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => call<Product[]>('/api/products').then(setItems).catch(() => {}), [call]);
  useEffect(() => void load(), [load]);

  const set = (k: keyof typeof emptyProduct) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = JSON.stringify({
      ...form,
      price: Number(form.price),
      tag: form.tag.trim() || null,
      barcode: form.barcode.trim() || null,
      stock: form.stock.trim() === '' ? null : Number(form.stock),
    });
    try {
      await call(editId ? `/api/admin/products/${editId}` : '/api/admin/products', {
        method: editId ? 'PUT' : 'POST',
        body,
      });
      setMsg({ ok: true, text: editId ? 'Produk diperbarui.' : 'Produk ditambahkan.' });
      setForm(emptyProduct);
      setEditId(null);
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  }

  async function remove(p: Product) {
    if (!confirm(`Hapus "${p.name}"?`)) return;
    try {
      await call(`/api/admin/products/${p.id}`, { method: 'DELETE' });
      setMsg({ ok: true, text: 'Produk dihapus.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  }

  return (
    <div className="admin-grid">
      <form className="form" onSubmit={submit}>
        <h2>{editId ? 'Ubah produk' : 'Tambah produk'}</h2>
        <label>Nama<input value={form.name} onChange={set('name')} maxLength={80} required /></label>
        <label>
          Kategori
          <input value={form.category} onChange={set('category')} list="cats" maxLength={30} required />
          <datalist id="cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <div className="two">
          <label>Harga (Rp)<input type="number" min={1} max={100000000} value={form.price} onChange={set('price')} required /></label>
          <label>Satuan<input value={form.unit} onChange={set('unit')} maxLength={20} placeholder="pak, botol, kg" required /></label>
        </div>
        <div className="two">
          <label>Emoji<input value={form.emoji} onChange={set('emoji')} maxLength={16} required /></label>
          <label>Label (opsional)<input value={form.tag} onChange={set('tag')} maxLength={20} placeholder="Terlaris" /></label>
        </div>
        <label>
          Barcode / QR (opsional)
          <input value={form.barcode} onChange={set('barcode')} maxLength={40} placeholder="Scan atau ketik kode" inputMode="text" />
        </label>
        <label>
          Stok (kosongkan jika tidak dilacak)
          <input type="number" min={0} max={1000000} value={form.stock} onChange={set('stock')} />
        </label>
        <div className="actions">
          <button className="btn" type="submit">{editId ? 'Simpan perubahan' : 'Tambah'}</button>
          {editId && (
            <button className="btn ghost" type="button" onClick={() => { setEditId(null); setForm(emptyProduct); }}>
              Batal
            </button>
          )}
        </div>
        <Notice msg={msg} />
      </form>

      <div className="table-wrap">
        <table>
          <thead><tr><th></th><th>Produk</th><th>Kategori</th><th>Harga</th><th></th></tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td aria-hidden="true">{p.emoji}</td>
                <td>{p.name}<small>per {p.unit}{p.tag ? ` · ${p.tag}` : ''}{p.barcode ? ` · ${p.barcode}` : ''}{p.stock != null ? ` · stok ${p.stock}` : ''}</small></td>
                <td>{p.category}</td>
                <td>{rupiah(p.price)}</td>
                <td className="row-actions">
                  <button onClick={() => { setEditId(p.id); setForm({ name: p.name, category: p.category, price: String(p.price), unit: p.unit, emoji: p.emoji, tag: p.tag ?? '', barcode: p.barcode ?? '', stock: p.stock == null ? '' : String(p.stock) }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Ubah</button>
                  <button className="danger" onClick={() => remove(p)}>Hapus</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Promo ---------- */

const emptyPromo = { title: '', detail: '', price: '', normal_price: '', hours: '24' };

function Promos({ call }: { call: Call }) {
  const [items, setItems] = useState<Promo[]>([]);
  const [form, setForm] = useState(emptyPromo);
  const [editId, setEditId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => call<Promo[]>('/api/admin/promos').then(setItems).catch(() => {}), [call]);
  useEffect(() => void load(), [load]);

  const set = (k: keyof typeof emptyPromo) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = JSON.stringify({
      ...form,
      price: Number(form.price),
      normal_price: Number(form.normal_price),
      hours: Number(form.hours),
    });
    try {
      await call(editId ? `/api/admin/promos/${editId}` : '/api/admin/promos', { method: editId ? 'PUT' : 'POST', body });
      setMsg({ ok: true, text: editId ? 'Promo diperbarui.' : 'Promo ditambahkan.' });
      setForm(emptyPromo);
      setEditId(null);
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  }

  async function remove(p: Promo) {
    if (!confirm(`Hapus promo "${p.title}"?`)) return;
    try {
      await call(`/api/admin/promos/${p.id}`, { method: 'DELETE' });
      setMsg({ ok: true, text: 'Promo dihapus.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  }

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="admin-grid">
      <form className="form" onSubmit={submit}>
        <h2>{editId ? 'Ubah promo' : 'Tambah promo'}</h2>
        <label>Judul<input value={form.title} onChange={set('title')} maxLength={60} required /></label>
        <label>Isi paket<input value={form.detail} onChange={set('detail')} maxLength={140} required /></label>
        <div className="two">
          <label>Harga promo (Rp)<input type="number" min={1} value={form.price} onChange={set('price')} required /></label>
          <label>Harga normal (Rp)<input type="number" min={1} value={form.normal_price} onChange={set('normal_price')} required /></label>
        </div>
        <label>
          Berlaku (jam dari sekarang)
          <input type="number" min={1} max={2160} value={form.hours} onChange={set('hours')} required />
        </label>
        <div className="actions">
          <button className="btn" type="submit">{editId ? 'Simpan perubahan' : 'Tambah'}</button>
          {editId && (
            <button className="btn ghost" type="button" onClick={() => { setEditId(null); setForm(emptyPromo); }}>
              Batal
            </button>
          )}
        </div>
        <Notice msg={msg} />
      </form>

      <div className="table-wrap">
        <table>
          <thead><tr><th>Promo</th><th>Harga</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {items.map((p) => {
              const left = p.ends_at - now;
              return (
                <tr key={p.id}>
                  <td>{p.title}<small>{p.detail}</small></td>
                  <td>{rupiah(p.price)}<small>normal {rupiah(p.normal_price)}</small></td>
                  <td>{left > 0 ? `Aktif, sisa ${Math.ceil(left / 3600)} jam` : 'Berakhir'}</td>
                  <td className="row-actions">
                    <button onClick={() => { setEditId(p.id); setForm({ title: p.title, detail: p.detail, price: String(p.price), normal_price: String(p.normal_price), hours: String(Math.max(1, Math.ceil(left / 3600))) }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Ubah</button>
                    <button className="danger" onClick={() => remove(p)}>Hapus</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Pengaturan toko ---------- */

const numOr = (v: string, fallback: number) => (v.trim() === '' ? fallback : Number(v));

function ShopSettings({ call }: { call: Call }) {
  const [form, setForm] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Settings) => setForm(s))
      .catch(() => setMsg({ ok: false, text: 'Gagal memuat pengaturan.' }));
  }, []);

  if (!form) return <p>Memuat pengaturan…</p>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const text = (k: 'shop_name' | 'tagline' | 'phone' | 'whatsapp' | 'email' | 'delivery_note') => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = await call<Settings>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(form) });
      setForm(saved);
      setMsg({ ok: true, text: 'Pengaturan disimpan. Alamat, kontak, dan jam buka langsung tampil di situs.' });
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form settings-form" onSubmit={save}>
      <h2>Identitas toko</h2>
      <label>Nama toko<input {...text('shop_name')} maxLength={60} required /></label>
      <label>Slogan<input {...text('tagline')} maxLength={120} /></label>

      <h2>Kontak</h2>
      <label>
        Alamat
        <textarea
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
          maxLength={200}
          rows={3}
          required
        />
      </label>
      <div className="two">
        <label>Telepon<input {...text('phone')} maxLength={20} /></label>
        <label>WhatsApp pemesanan (kosongkan jika tidak dipakai)<input {...text('whatsapp')} maxLength={20} placeholder="0812…" /></label>
      </div>
      <label>Email<input type="email" {...text('email')} maxLength={120} /></label>

      <h2>Jam operasional</h2>
      <div className="two">
        <label>
          Buka (jam)
          <input
            type="number"
            min={0}
            max={23}
            value={form.open_hour}
            onChange={(e) => set('open_hour', numOr(e.target.value, 0))}
            required
          />
        </label>
        <label>
          Tutup (jam, 24 = tengah malam)
          <input
            type="number"
            min={1}
            max={24}
            value={form.close_hour}
            onChange={(e) => set('close_hour', numOr(e.target.value, 24))}
            required
          />
        </label>
      </div>

      <h2>Pengiriman</h2>
      <label>Catatan pengiriman<input {...text('delivery_note')} maxLength={160} /></label>

      <div className="actions">
        <button className="btn" type="submit" disabled={busy}>Simpan pengaturan</button>
      </div>
      <Notice msg={msg} />
    </form>
  );
}

/* ---------- Pelanggan ---------- */

// Cegah formula spreadsheet (CSV injection) pada sel yang diawali = + - @
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};

function Subscribers({ call }: { call: Call }) {
  const [items, setItems] = useState<Subscriber[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => call<Subscriber[]>('/api/admin/subscribers').then(setItems).catch(() => {}), [call]);
  useEffect(() => void load(), [load]);

  async function remove(s: Subscriber) {
    if (!confirm(`Hapus ${s.name} dari daftar?`)) return;
    try {
      await call(`/api/admin/subscribers/${s.id}`, { method: 'DELETE' });
      setMsg({ ok: true, text: 'Pelanggan dihapus.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  }

  function download() {
    const rows = [['nama', 'whatsapp', 'daftar'], ...items.map((s) => [s.name, s.whatsapp, new Date(s.created_at * 1000).toISOString()])];
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pelanggan-nusa-kael.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="actions" style={{ marginBottom: 14 }}>
        <strong>{items.length} pelanggan terdaftar</strong>
        <span className="spacer" />
        <button className="btn ghost" onClick={download} disabled={!items.length}>Unduh CSV</button>
      </div>
      <Notice msg={msg} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Nama</th><th>WhatsApp</th><th>Daftar</th><th></th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={4}>Belum ada pelanggan.</td></tr>}
            {items.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td><a href={`https://wa.me/${s.whatsapp.replace(/^\+/, '').replace(/^0/, '62')}`} target="_blank" rel="noopener noreferrer">{s.whatsapp}</a></td>
                <td>{new Date(s.created_at * 1000).toLocaleDateString('id-ID')}</td>
                <td className="row-actions"><button className="danger" onClick={() => remove(s)}>Hapus</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
