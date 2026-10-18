# Toko Nusa Kael

Landing page + panel admin untuk toko serba ada. Frontend Astro + React, backend Rust (axum).
Di produksi, Rust menyajikan hasil build Astro, jadi hanya ada satu server.

```
web/   Astro + React (landing page di /, admin di /admin)
api/   Rust axum (API di /api, data di data.json)
```

## Development

Terminal 1, API di :8080:

```bash
cd api
ADMIN_PASSWORD=ganti-ini-dulu cargo run
```

Terminal 2, web di :4321 (otomatis meneruskan /api ke :8080):

```bash
cd web
npm install
npm run dev
```

Buka http://localhost:4321 dan http://localhost:4321/admin.
Tanpa `ADMIN_PASSWORD` (min. 8 karakter), panel admin nonaktif.

## Deploy dengan Docker

```bash
cp .env.example .env        # isi ADMIN_PASSWORD
docker compose up -d --build
```

Situs ada di http://SERVER:8080. Data (produk, promo, transaksi, pelanggan) tersimpan di MySQL, volume `nusa_db`.
**Cadangkan database secara berkala:**

```bash
docker compose exec db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" nusa_kael' > backup-$(date +%F).sql
```

### Deploy di Coolify

Buat resource dari repo ini dengan tipe **Docker Compose**, lalu isi environment variable berikut di Coolify:
`ADMIN_PASSWORD`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`, dan opsional `DB_NAME`, `DB_USER`.
Domain diarahkan ke service `nusa-kael` port `8080`. Coolify sudah menangani HTTPS.

### Di belakang HTTPS

Pasang reverse proxy (Caddy/Nginx/Traefik) yang meneruskan domain Anda ke port 8080.
Sesi admin memakai token Bearer, jadi **wajib lewat HTTPS** saat dipublikasikan.
Contoh Caddy:

```
tokonusakael.id {
    reverse_proxy 127.0.0.1:8080
}
```

## Variabel lingkungan

| Nama | Default | Fungsi |
| --- | --- | --- |
| `ADMIN_PASSWORD` | (kosong) | Kata sandi admin, min. 8 karakter |
| `BIND` | `127.0.0.1:8080` | Alamat dan port server |
| `DATABASE_URL` | `mysql://root@127.0.0.1:3306/nusa_kael` | Koneksi MySQL. Database dibuat otomatis jika belum ada |
| `DATA_FILE` | `data.json` | Hanya untuk impor sekali dari format JSON lama |
| `STATIC_DIR` | `../web/dist` | Folder hasil build Astro |

## Catatan

- Data disimpan di MySQL. Tabel dibuat otomatis saat server pertama kali jalan.
- Jika ada `data.json` lama dan database masih kosong, datanya diimpor sekali. File lama lalu diganti namanya menjadi `data.json.bak`.
- Penjualan memakai transaksi database dan mengunci baris produk, sehingga stok tidak bisa minus saat dua kasir menjual bersamaan.
- Sesi admin disimpan di memori, jadi restart server akan mengeluarkan admin (cukup masuk lagi).
- Alamat, telepon, WhatsApp, email, dan jam buka diatur dari tab **Pengaturan** di `/admin`.
