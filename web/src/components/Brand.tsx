import { useEffect, useState } from 'react';
import { FALLBACK_SETTINGS, getJson, type Settings } from '../lib/api';

/** Logo di header dan footer; nama toko diambil dari pengaturan admin. */
export default function Brand() {
  const [name, setName] = useState(FALLBACK_SETTINGS.shop_name);

  useEffect(() => {
    getJson<Settings>('/api/settings', FALLBACK_SETTINGS).then((s) => setName(s.shop_name));
  }, []);

  return (
    <a className="logo" href="#top">
      <span className="logo-mark">{name.charAt(0).toUpperCase()}</span> {name}
    </a>
  );
}
