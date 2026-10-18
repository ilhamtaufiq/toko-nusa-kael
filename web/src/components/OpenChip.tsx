import { useEffect, useState } from 'react';
import { FALLBACK_SETTINGS, getJson, hoursLabel, pad2, type Settings } from '../lib/api';

/** Chip status buka. Jam buka diambil dari pengaturan admin; jam dihitung di browser pengunjung. */
export default function OpenChip() {
  const [s, setS] = useState<Settings>(FALLBACK_SETTINGS);
  const [hour, setHour] = useState<number | null>(null);

  useEffect(() => {
    getJson<Settings>('/api/settings', FALLBACK_SETTINGS).then(setS);
    setHour(new Date().getHours());
  }, []);

  if (hour === null) {
    return (
      <span className="open-chip" data-open="false">
        <span className="dot" />
        <span>Memuat jam buka…</span>
      </span>
    );
  }

  const open = hour >= s.open_hour && hour < s.close_hour;
  const text = open
    ? s.open_hour === 0 && s.close_hour === 24
      ? 'Buka 24 jam'
      : `Buka sekarang · tutup ${pad2(s.close_hour)}.00`
    : `Tutup · buka lagi ${pad2(s.open_hour)}.00`;

  return (
    <span className="open-chip" data-open={String(open)} title={hoursLabel(s.open_hour, s.close_hour)}>
      <span className="dot" />
      <span>{text}</span>
    </span>
  );
}
