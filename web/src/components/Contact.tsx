import { useEffect, useState } from 'react';
import { FALLBACK_SETTINGS, getJson, hoursLabel, waLink, type Settings } from '../lib/api';

/** Daftar kontak di footer, diisi dari pengaturan admin. */
export default function Contact() {
  const [s, setS] = useState<Settings>(FALLBACK_SETTINGS);

  useEffect(() => {
    getJson<Settings>('/api/settings', FALLBACK_SETTINGS).then(setS);
  }, []);

  return (
    <ul>
      <li>{s.address}</li>
      {s.whatsapp && (
        <li>
          <a href={waLink(s.whatsapp)} target="_blank" rel="noopener noreferrer">WhatsApp {s.whatsapp}</a>
        </li>
      )}
      {s.phone && <li><a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`}>Telepon {s.phone}</a></li>}
      {s.email && <li><a href={`mailto:${s.email}`}>{s.email}</a></li>}
      <li>Setiap hari, {hoursLabel(s.open_hour, s.close_hour)}</li>
      {s.delivery_note && <li>{s.delivery_note}</li>}
    </ul>
  );
}
