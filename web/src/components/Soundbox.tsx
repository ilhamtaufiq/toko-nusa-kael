import { useCallback, useEffect, useRef, useState } from 'react';
import { rupiah } from '../lib/api';

type Call = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
type Incoming = { id: string; time: string | null; amount: number; status: string; paymentType: string };
type Feed = {
  loggedIn: boolean;
  running: boolean;
  pollSeconds: number;
  lastPollAt: string | null;
  lastError: string | null;
  lastTransactionId: string | null;
  transactions: Incoming[];
};

// Gateway memeriksa GoBiz tiap 30 detik. Halaman ini hanya membaca hasil itu, jadi bisa lebih sering tanpa menambah beban ke GoBiz.
const READ_MS = 10_000;
const SEEN_KEY = 'nk_soundbox_seen';
const SEEN_LIMIT = 500;

const SATUAN = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];

/** Angka ke kata bahasa Indonesia, untuk dibacakan. Contoh: 25000 -> "dua puluh lima ribu". */
export function terbilang(n: number): string {
  if (n < 12) return SATUAN[n];
  if (n < 20) return `${terbilang(n - 10)} belas`;
  if (n < 100) {
    const sisa = n % 10;
    return `${terbilang(Math.floor(n / 10))} puluh${sisa ? ` ${terbilang(sisa)}` : ''}`;
  }
  if (n < 200) return `seratus${n - 100 ? ` ${terbilang(n - 100)}` : ''}`;
  if (n < 1000) {
    const sisa = n % 100;
    return `${terbilang(Math.floor(n / 100))} ratus${sisa ? ` ${terbilang(sisa)}` : ''}`;
  }
  if (n < 2000) return `seribu${n - 1000 ? ` ${terbilang(n - 1000)}` : ''}`;
  if (n < 1_000_000) {
    const sisa = n % 1000;
    return `${terbilang(Math.floor(n / 1000))} ribu${sisa ? ` ${terbilang(sisa)}` : ''}`;
  }
  if (n < 1_000_000_000) {
    const sisa = n % 1_000_000;
    return `${terbilang(Math.floor(n / 1_000_000))} juta${sisa ? ` ${terbilang(sisa)}` : ''}`;
  }
  return String(n);
}

function loadSeen(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? new Set<string>(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveSeen(seen: Set<string>) {
  try {
    const list = Array.from(seen).slice(-SEEN_LIMIT);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(list));
  } catch {
    /* penyimpanan diblokir: penanda hanya berlaku selama halaman terbuka */
  }
}

/** Soundbox QRIS: membacakan setiap pembayaran baru dan menampilkan notifikasi berjalan. */
export default function Soundbox({ call }: { call: Call }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState('');
  const [voiceOn, setVoiceOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [latest, setLatest] = useState<Incoming | null>(null);
  const [ticker, setTicker] = useState<string[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const speak = useCallback((text: string) => {
    if (mutedRef.current || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }, []);

  const announce = useCallback(
    (t: Incoming) => {
      setLatest(t);
      setTicker((list) => [`+ ${rupiah(t.amount)} masuk`, ...list].slice(0, 8));
      speak(`Pembayaran masuk, ${terbilang(t.amount)} rupiah.`);
    },
    [speak],
  );

  // Membaca hasil pemeriksaan gateway. Transaksi yang belum pernah diumumkan dibacakan sekali saja.
  useEffect(() => {
    let alive = true;
    const read = () =>
      call<Feed>('/api/admin/transactions')
        .then((r) => {
          if (!alive) return;
          setFeed(r);
          setError('');
          if (seenRef.current === null) {
            seenRef.current = loadSeen();
            // Pertama kali dibuka di perangkat ini: transaksi yang sudah ada tidak dibacakan
            if (seenRef.current === null) {
              seenRef.current = new Set(r.transactions.map((t) => t.id));
              saveSeen(seenRef.current);
              return;
            }
          }
          const seen = seenRef.current;
          const fresh = r.transactions.filter((t) => !seen.has(t.id)).reverse();
          if (fresh.length === 0) return;
          fresh.forEach((t) => seen.add(t.id));
          saveSeen(seen);
          fresh.forEach(announce);
        })
        .catch((x) => {
          if (alive) setError((x as Error).message);
        });
    read();
    const timer = window.setInterval(read, READ_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [call, announce]);

  // Layar tetap menyala selama soundbox terbuka (jika browser mendukung)
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    return () => {
      lock?.release().catch(() => {});
    };
  }, []);

  // Browser hanya mengizinkan suara setelah ada ketukan dari pengguna
  function enableVoice() {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance('Soundbox siap');
    u.lang = 'id-ID';
    window.speechSynthesis.speak(u);
    setVoiceOn(true);
  }

  const lastPoll = feed?.lastPollAt ? new Date(feed.lastPollAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) : '—';

  return (
    <section className="soundbox" aria-labelledby="sb-title">
      <div className="sb-ticker" aria-live="polite">
        <div className="sb-ticker-track">
          {ticker.length === 0 ? <span>Menunggu pembayaran…</span> : ticker.map((m, i) => <span key={`${m}-${i}`}>{m} · </span>)}
        </div>
      </div>

      <h2 id="sb-title">Soundbox QRIS</h2>

      {!voiceOn ? (
        <button type="button" className="btn" onClick={enableVoice}>
          Aktifkan suara
        </button>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? 'Suara: mati' : 'Suara: nyala'}
        </button>
      )}

      <div className="sb-display" role="status">
        {latest ? (
          <>
            <strong className="sb-amount">{rupiah(latest.amount)}</strong>
            <span>masuk {latest.time ? new Date(latest.time).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) : ''}</span>
          </>
        ) : (
          <span className="sb-idle">Menunggu pembayaran QRIS…</span>
        )}
      </div>

      <p className="sb-status">
        {feed === null
          ? 'Memuat…'
          : !feed.loggedIn
            ? 'Belum terhubung ke GoBiz. Login di tab Pengaturan.'
            : feed.lastError
              ? `Gagal memeriksa: ${feed.lastError}`
              : `Pemeriksaan otomatis aktif. Terakhir diperiksa ${lastPoll}.`}
      </p>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
