export type Product = {
  id: number;
  name: string;
  category: string;
  price: number;
  unit: string;
  emoji: string;
  tag: string | null;
  barcode?: string | null;
  /** null/undefined = stok tidak dilacak */
  stock?: number | null;
};

export type Promo = {
  id: number;
  title: string;
  detail: string;
  price: number;
  normal_price: number;
  /** Detik sejak epoch Unix */
  ends_at: number;
};


export type Settings = {
  shop_name: string;
  tagline: string;
  address: string;
  phone: string;
  whatsapp: string;
  email: string;
  open_hour: number;
  close_hour: number;
  delivery_note: string;
};

export const FALLBACK_SETTINGS: Settings = {
  shop_name: 'Toko Nusa Kael',
  tagline: 'Belanja lengkap, harga bersahabat',
  address: 'Bumi Marhamah Blok A No. 3, RT 01/RW 08, Jl. KH. Saleh, Desa Sindangasih, Kec. Karangtengah, Kab. Cianjur',
  phone: '',
  whatsapp: '',
  email: '',
  open_hour: 6,
  close_hour: 23,
  delivery_note: '',
};

export const pad2 = (n: number) => String(n).padStart(2, '0');

export const hoursLabel = (open: number, close: number) =>
  open === 0 && close === 24 ? 'Buka 24 jam' : `${pad2(open)}.00–${pad2(close)}.00`;

/** Nomor lokal (0812…) diubah ke format wa.me (62812…). */
export function waLink(wa: string) {
  let d = wa.replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return `https://wa.me/${d}`;
}

export const rupiah = (n: number) => 'Rp' + n.toLocaleString('id-ID');

/** Ambil data dari backend Rust; jika gagal, pakai data cadangan agar halaman tetap hidup. */
export async function getJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export const FALLBACK_PRODUCTS: Product[] = [
  { id: 1, name: 'Beras Pulen 5 kg', category: 'Sembako', price: 74500, unit: 'karung', emoji: '🌾', tag: 'Terlaris' },
  { id: 2, name: 'Minyak Goreng 2 L', category: 'Sembako', price: 36900, unit: 'pouch', emoji: '🫗', tag: null },
  { id: 3, name: 'Gula Pasir 1 kg', category: 'Sembako', price: 17800, unit: 'pak', emoji: '🧂', tag: null },
  { id: 4, name: 'Telur Ayam', category: 'Segar', price: 29500, unit: 'kg', emoji: '🥚', tag: 'Baru datang' },
  { id: 5, name: 'Pisang Ambon', category: 'Segar', price: 14000, unit: 'sisir', emoji: '🍌', tag: null },
  { id: 6, name: 'Tempe Daun', category: 'Segar', price: 6000, unit: 'bungkus', emoji: '🍃', tag: 'Lokal' },
  { id: 7, name: 'Kopi Tubruk Kael', category: 'Minuman', price: 22000, unit: '200 g', emoji: '☕', tag: 'Produk kami' },
  { id: 8, name: 'Teh Botol Dingin', category: 'Minuman', price: 5500, unit: 'botol', emoji: '🧋', tag: null },
  { id: 9, name: 'Air Mineral 600 ml', category: 'Minuman', price: 3500, unit: 'botol', emoji: '💧', tag: null },
  { id: 10, name: 'Mi Instan Goreng', category: 'Camilan', price: 3300, unit: 'bungkus', emoji: '🍜', tag: null },
  { id: 11, name: 'Keripik Singkong Pedas', category: 'Camilan', price: 11000, unit: 'bungkus', emoji: '🌶️', tag: 'Pedas!' },
  { id: 12, name: 'Roti Tawar Gandum', category: 'Camilan', price: 16500, unit: 'loaf', emoji: '🍞', tag: null },
  { id: 13, name: 'Sabun Cuci Piring', category: 'Rumah', price: 9800, unit: 'refill', emoji: '🧼', tag: null },
  { id: 14, name: 'Deterjen Bubuk 800 g', category: 'Rumah', price: 21500, unit: 'pak', emoji: '🧺', tag: null },
  { id: 15, name: 'Tisu Gulung 4 pcs', category: 'Rumah', price: 18000, unit: 'pak', emoji: '🧻', tag: null },
];

const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;

export const FALLBACK_PROMOS: Promo[] = [
  { id: 1, title: 'Paket Sarapan Hemat', detail: 'Roti tawar + telur 6 butir + teh botol', price: 34900, normal_price: 41000, ends_at: inHours(30) },
  { id: 2, title: 'Borong Sembako', detail: 'Beras 5 kg + minyak 2 L + gula 1 kg', price: 119000, normal_price: 129200, ends_at: inHours(72) },
  { id: 3, title: 'Ngopi Sore', detail: 'Kopi Tubruk Kael + keripik singkong', price: 29000, normal_price: 33000, ends_at: inHours(8) },
];

