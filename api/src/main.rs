use std::{
    collections::{BTreeMap, HashSet},
    path::{Path as FsPath, PathBuf},
    str::FromStr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    routing::{delete, get, post, put},
    Json, Router,
};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sqlx::{
    mysql::{MySqlArguments, MySqlConnectOptions, MySqlConnection, MySqlPoolOptions, MySqlRow},
    Connection, MySql, MySqlPool, Row,
};
use tokio::sync::Mutex;
use tower_http::services::{ServeDir, ServeFile};

// ---------- Model ----------

#[derive(Serialize, Deserialize, Clone)]
struct Product {
    id: u32,
    name: String,
    category: String,
    price: u32,
    unit: String,
    emoji: String,
    tag: Option<String>,
    #[serde(default)]
    barcode: Option<String>,
    /// None = stok tidak dilacak
    #[serde(default)]
    stock: Option<u32>,
    /// Harga beli per satuan; None = belum diisi
    #[serde(default)]
    cost: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Promo {
    id: u32,
    title: String,
    detail: String,
    price: u32,
    normal_price: u32,
    /// Waktu berakhir, detik sejak epoch Unix.
    ends_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Subscriber {
    id: u32,
    name: String,
    whatsapp: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    shop_name: String,
    tagline: String,
    address: String,
    phone: String,
    whatsapp: String,
    email: String,
    open_hour: u8,
    close_hour: u8,
    delivery_note: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct SaleItem {
    product_id: u32,
    name: String,
    price: u32,
    qty: u32,
    /// Harga beli saat barang dijual (disimpan sebagai salinan, tidak ikut berubah)
    #[serde(default)]
    cost: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Sale {
    id: u32,
    created_at: u64,
    items: Vec<SaleItem>,
    total: u64,
    paid: u64,
    change: u64,
}

/// Bentuk data.json dari versi sebelumnya. Hanya dipakai untuk impor sekali.
#[derive(Deserialize)]
struct Legacy {
    products: Vec<Product>,
    promos: Vec<Promo>,
    subscribers: Vec<Subscriber>,
    #[serde(default)]
    sales: Vec<Sale>,
    #[serde(default)]
    settings: Option<Settings>,
}

fn default_settings() -> Settings {
    Settings {
        shop_name: "Toko Nusa Kael".into(),
        tagline: "Belanja lengkap, harga bersahabat".into(),
        address: "Bumi Marhamah Blok A No. 3, RT 01/RW 08, Jl. KH. Saleh, Desa Sindangasih, Kec. Karangtengah, Kab. Cianjur".into(),
        phone: String::new(),
        whatsapp: String::new(),
        email: String::new(),
        open_hour: 6,
        close_hour: 23,
        delivery_note: String::new(),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------- Skema & impor ----------

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS products (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        category VARCHAR(30) NOT NULL,
        price BIGINT NOT NULL,
        unit VARCHAR(20) NOT NULL,
        emoji VARCHAR(16) NOT NULL,
        tag VARCHAR(20) NULL,
        barcode VARCHAR(40) NULL UNIQUE,
        stock BIGINT NULL,
        cost BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS promos (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(60) NOT NULL,
        detail VARCHAR(140) NOT NULL,
        price BIGINT NOT NULL,
        normal_price BIGINT NOT NULL,
        ends_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS subscribers (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(60) NOT NULL,
        whatsapp VARCHAR(20) NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS settings (
        id BIGINT NOT NULL PRIMARY KEY,
        shop_name VARCHAR(60) NOT NULL,
        tagline VARCHAR(120) NOT NULL,
        address VARCHAR(200) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        whatsapp VARCHAR(20) NOT NULL,
        email VARCHAR(120) NOT NULL,
        open_hour BIGINT NOT NULL,
        close_hour BIGINT NOT NULL,
        delivery_note VARCHAR(160) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS sales (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        created_at BIGINT NOT NULL,
        total BIGINT NOT NULL,
        paid BIGINT NOT NULL,
        change_amount BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS qris_orders (
        order_id VARCHAR(64) NOT NULL PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        total BIGINT NOT NULL,
        items_json TEXT NOT NULL,
        qr_url TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        sale_id BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    "CREATE TABLE IF NOT EXISTS sale_items (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        sale_id BIGINT NOT NULL,
        product_id BIGINT NOT NULL,
        name VARCHAR(80) NOT NULL,
        price BIGINT NOT NULL,
        qty BIGINT NOT NULL,
        cost BIGINT NULL,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
];

/// Data contoh untuk instalasi baru (database kosong dan tidak ada data.json).
fn seed() -> Legacy {
    let p = |id: u32, name: &str, category: &str, price: u32, unit: &str, emoji: &str, tag: Option<&str>| Product {
        id,
        name: name.into(),
        category: category.into(),
        price,
        unit: unit.into(),
        emoji: emoji.into(),
        tag: tag.map(Into::into),
        barcode: None,
        stock: None,
        cost: None,
    };
    let promo = |id: u32, title: &str, detail: &str, price: u32, normal_price: u32, hours: u64| Promo {
        id,
        title: title.into(),
        detail: detail.into(),
        price,
        normal_price,
        ends_at: now() + hours * 3600,
    };
    Legacy {
        products: vec![
            p(1, "Beras Pulen 5 kg", "Sembako", 74_500, "karung", "🌾", Some("Terlaris")),
            p(2, "Minyak Goreng 2 L", "Sembako", 36_900, "pouch", "🫗", None),
            p(3, "Gula Pasir 1 kg", "Sembako", 17_800, "pak", "🧂", None),
            p(4, "Telur Ayam", "Segar", 29_500, "kg", "🥚", Some("Baru datang")),
            p(5, "Pisang Ambon", "Segar", 14_000, "sisir", "🍌", None),
            p(6, "Tempe Daun", "Segar", 6_000, "bungkus", "🍃", Some("Lokal")),
            p(7, "Kopi Tubruk Kael", "Minuman", 22_000, "200 g", "☕", Some("Produk kami")),
            p(8, "Teh Botol Dingin", "Minuman", 5_500, "botol", "🧋", None),
            p(9, "Air Mineral 600 ml", "Minuman", 3_500, "botol", "💧", None),
            p(10, "Mi Instan Goreng", "Camilan", 3_300, "bungkus", "🍜", None),
            p(11, "Keripik Singkong Pedas", "Camilan", 11_000, "bungkus", "🌶️", Some("Pedas!")),
            p(12, "Roti Tawar Gandum", "Camilan", 16_500, "loaf", "🍞", None),
            p(13, "Sabun Cuci Piring", "Rumah", 9_800, "refill", "🧼", None),
            p(14, "Deterjen Bubuk 800 g", "Rumah", 21_500, "pak", "🧺", None),
            p(15, "Tisu Gulung 4 pcs", "Rumah", 18_000, "pak", "🧻", None),
        ],
        promos: vec![
            promo(16, "Paket Sarapan Hemat", "Roti tawar + telur 6 butir + teh botol", 34_900, 41_000, 30),
            promo(17, "Borong Sembako", "Beras 5 kg + minyak 2 L + gula 1 kg", 119_000, 129_200, 72),
            promo(18, "Ngopi Sore", "Kopi Tubruk Kael + keripik singkong", 29_000, 33_000, 8),
        ],
        subscribers: vec![],
        sales: vec![],
        settings: Some(default_settings()),
    }
}

/// Buat database jika belum ada (hanya bila nama database ada di URL).
async fn ensure_database(url: &str) -> Result<(), sqlx::Error> {
    let opts = MySqlConnectOptions::from_str(url)?;
    let Some(name) = opts.get_database().map(str::to_string) else {
        return Ok(());
    };
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(sqlx::Error::Protocol("Nama database hanya boleh huruf, angka, dan _.".into()));
    }
    let mut conn = MySqlConnection::connect_with(&opts.clone().database("mysql")).await?;
    sqlx::query(&format!(
        "CREATE DATABASE IF NOT EXISTS `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    ))
    .execute(&mut conn)
    .await?;
    Ok(())
}

fn settings_upsert(st: &Settings) -> sqlx::query::Query<'static, MySql, MySqlArguments> {
    sqlx::query(
        "REPLACE INTO settings (id, shop_name, tagline, address, phone, whatsapp, email, open_hour, close_hour, delivery_note)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(st.shop_name.clone())
    .bind(st.tagline.clone())
    .bind(st.address.clone())
    .bind(st.phone.clone())
    .bind(st.whatsapp.clone())
    .bind(st.email.clone())
    .bind(st.open_hour as i64)
    .bind(st.close_hour as i64)
    .bind(st.delivery_note.clone())
}

/// Tambah kolom bila belum ada. MySQL 8 tidak punya ADD COLUMN IF NOT EXISTS.
async fn add_column_if_missing(db: &MySqlPool, table: &str, column: &str, ddl: &str) -> Result<(), sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    )
    .bind(table)
    .bind(column)
    .fetch_one(db)
    .await?;
    if n == 0 {
        sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {ddl}")).execute(db).await?;
    }
    Ok(())
}

async fn migrate(db: &MySqlPool, data_file: &FsPath) -> Result<(), sqlx::Error> {
    for stmt in SCHEMA {
        sqlx::query(stmt).execute(db).await?;
    }
    add_column_if_missing(db, "products", "cost", "cost BIGINT NULL").await?;
    add_column_if_missing(db, "sale_items", "cost", "cost BIGINT NULL").await?;
    add_column_if_missing(db, "sales", "method", "method VARCHAR(10) NOT NULL DEFAULT 'cash'").await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM products").fetch_one(db).await?;
    if count > 0 {
        return Ok(());
    }

    // Database masih kosong: impor data.json lama bila ada, kalau tidak pakai data contoh.
    let (legacy, from_file) = match tokio::fs::read(data_file).await {
        Ok(bytes) => {
            let parsed: Legacy = serde_json::from_slice(&bytes).expect("data.json rusak: perbaiki atau hapus file tersebut");
            (parsed, true)
        }
        Err(_) => (seed(), false),
    };

    let mut tx = db.begin().await?;
    for p in &legacy.products {
        sqlx::query("INSERT INTO products (id, name, category, price, unit, emoji, tag, barcode, stock, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(p.id as i64)
            .bind(p.name.clone())
            .bind(p.category.clone())
            .bind(p.price as i64)
            .bind(p.unit.clone())
            .bind(p.emoji.clone())
            .bind(p.tag.clone())
            .bind(p.barcode.clone())
            .bind(p.stock.map(|v| v as i64))
            .bind(p.cost.map(|v| v as i64))
            .execute(&mut *tx)
            .await?;
    }
    for p in &legacy.promos {
        sqlx::query("INSERT INTO promos (id, title, detail, price, normal_price, ends_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(p.id as i64)
            .bind(p.title.clone())
            .bind(p.detail.clone())
            .bind(p.price as i64)
            .bind(p.normal_price as i64)
            .bind(p.ends_at as i64)
            .execute(&mut *tx)
            .await?;
    }
    for s in &legacy.subscribers {
        sqlx::query("INSERT INTO subscribers (id, name, whatsapp, created_at) VALUES (?, ?, ?, ?)")
            .bind(s.id as i64)
            .bind(s.name.clone())
            .bind(s.whatsapp.clone())
            .bind(s.created_at as i64)
            .execute(&mut *tx)
            .await?;
    }
    for sale in &legacy.sales {
        sqlx::query("INSERT INTO sales (id, created_at, total, paid, change_amount) VALUES (?, ?, ?, ?, ?)")
            .bind(sale.id as i64)
            .bind(sale.created_at as i64)
            .bind(sale.total as i64)
            .bind(sale.paid as i64)
            .bind(sale.change as i64)
            .execute(&mut *tx)
            .await?;
        for it in &sale.items {
            sqlx::query("INSERT INTO sale_items (sale_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)")
                .bind(sale.id as i64)
                .bind(it.product_id as i64)
                .bind(it.name.clone())
                .bind(it.price as i64)
                .bind(it.qty as i64)
                .execute(&mut *tx)
                .await?;
        }
    }
    let st = legacy.settings.clone().unwrap_or_else(default_settings);
    settings_upsert(&st).execute(&mut *tx).await?;
    tx.commit().await?;

    if from_file {
        // Jangan diimpor ulang di start berikutnya
        let _ = tokio::fs::rename(data_file, data_file.with_extension("json.bak")).await;
        println!("Data dari data.json sudah dipindah ke MySQL (file lama disimpan sebagai data.json.bak).");
    }
    Ok(())
}

// ---------- State & util ----------

struct AppState {
    db: MySqlPool,
    admin_password: Option<String>,
    sessions: Mutex<HashSet<String>>,
    midtrans: Option<Midtrans>,
    gateway: Option<Gateway>,
}

type Shared = Arc<AppState>;
type ApiError = (StatusCode, Json<Message>);
type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Serialize)]
struct Message {
    message: String,
}

fn fail(code: StatusCode, msg: &str) -> ApiError {
    (code, Json(Message { message: msg.into() }))
}

fn ok(msg: impl Into<String>) -> Json<Message> {
    Json(Message { message: msg.into() })
}

fn db_err(e: sqlx::Error) -> ApiError {
    eprintln!("database error: {e}");
    fail(StatusCode::INTERNAL_SERVER_ERROR, "Terjadi kesalahan pada database.")
}

/// Pelanggaran kunci unik (MySQL/MariaDB error 1062). sqlx hanya memberi SQLSTATE lewat `code()`,
/// jadi nomor error asli diambil dari driver MySQL.
fn is_dup(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>())
        .is_some_and(|m| m.number() == 1062)
}

fn eq_ct(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !token.is_empty() && state.sessions.lock().await.contains(token) {
        Ok(())
    } else {
        Err(fail(StatusCode::UNAUTHORIZED, "Sesi admin tidak valid, silakan masuk lagi."))
    }
}

fn clean(s: &str, max: usize) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t.chars().count() <= max).then(|| t.to_string())
}

fn text(v: &str, max: usize, label: &str, required: bool) -> Result<String, ApiError> {
    let t = v.trim();
    if required && t.is_empty() {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, &format!("{label} wajib diisi.")));
    }
    if t.chars().count() > max {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, &format!("{label} maksimal {max} karakter.")));
    }
    Ok(t.to_string())
}

fn normalize_wa(raw: &str) -> Option<String> {
    let wa: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let digits = wa.trim_start_matches('+');
    let valid = (wa.starts_with('0') || wa.starts_with("+62") || wa.starts_with("62"))
        && digits.chars().all(|c| c.is_ascii_digit())
        && (9..=16).contains(&wa.len());
    valid.then_some(wa)
}

// ---------- Pembacaan baris ----------

fn product_row(r: &MySqlRow) -> Result<Product, sqlx::Error> {
    Ok(Product {
        id: r.try_get::<i64, _>("id")? as u32,
        name: r.try_get("name")?,
        category: r.try_get("category")?,
        price: r.try_get::<i64, _>("price")? as u32,
        unit: r.try_get("unit")?,
        emoji: r.try_get("emoji")?,
        tag: r.try_get("tag")?,
        barcode: r.try_get("barcode")?,
        stock: r.try_get::<Option<i64>, _>("stock")?.map(|v| v as u32),
        cost: r.try_get::<Option<i64>, _>("cost")?.map(|v| v as u32),
    })
}

fn promo_row(r: &MySqlRow) -> Result<Promo, sqlx::Error> {
    Ok(Promo {
        id: r.try_get::<i64, _>("id")? as u32,
        title: r.try_get("title")?,
        detail: r.try_get("detail")?,
        price: r.try_get::<i64, _>("price")? as u32,
        normal_price: r.try_get::<i64, _>("normal_price")? as u32,
        ends_at: r.try_get::<i64, _>("ends_at")? as u64,
    })
}

fn subscriber_row(r: &MySqlRow) -> Result<Subscriber, sqlx::Error> {
    Ok(Subscriber {
        id: r.try_get::<i64, _>("id")? as u32,
        name: r.try_get("name")?,
        whatsapp: r.try_get("whatsapp")?,
        created_at: r.try_get::<i64, _>("created_at")? as u64,
    })
}

fn settings_row(r: &MySqlRow) -> Result<Settings, sqlx::Error> {
    Ok(Settings {
        shop_name: r.try_get("shop_name")?,
        tagline: r.try_get("tagline")?,
        address: r.try_get("address")?,
        phone: r.try_get("phone")?,
        whatsapp: r.try_get("whatsapp")?,
        email: r.try_get("email")?,
        open_hour: r.try_get::<i64, _>("open_hour")? as u8,
        close_hour: r.try_get::<i64, _>("close_hour")? as u8,
        delivery_note: r.try_get("delivery_note")?,
    })
}

fn map_rows<T>(rows: &[MySqlRow], f: impl Fn(&MySqlRow) -> Result<T, sqlx::Error>) -> Result<Vec<T>, ApiError> {
    rows.iter().map(|r| f(r).map_err(db_err)).collect()
}

async fn load_settings(db: &MySqlPool) -> Result<Settings, sqlx::Error> {
    match sqlx::query("SELECT * FROM settings WHERE id = 1").fetch_optional(db).await? {
        Some(r) => settings_row(&r),
        None => Ok(default_settings()),
    }
}

// ---------- Publik ----------

async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct ProductQuery {
    category: Option<String>,
}

async fn products(State(s): State<Shared>, Query(q): Query<ProductQuery>) -> ApiResult<Vec<Product>> {
    let rows = match q.category.as_deref().filter(|c| *c != "Semua") {
        Some(c) => sqlx::query("SELECT * FROM products WHERE LOWER(category) = LOWER(?) ORDER BY id")
            .bind(c.to_string())
            .fetch_all(&s.db)
            .await,
        None => sqlx::query("SELECT * FROM products ORDER BY id").fetch_all(&s.db).await,
    }
    .map_err(db_err)?;
    Ok(Json(map_rows(&rows, product_row)?))
}

async fn promos(State(s): State<Shared>) -> ApiResult<Vec<Promo>> {
    let rows = sqlx::query("SELECT * FROM promos WHERE ends_at > ? ORDER BY id")
        .bind(now() as i64)
        .fetch_all(&s.db)
        .await
        .map_err(db_err)?;
    Ok(Json(map_rows(&rows, promo_row)?))
}

async fn settings_get(State(s): State<Shared>) -> ApiResult<Settings> {
    Ok(Json(load_settings(&s.db).await.map_err(db_err)?))
}

#[derive(Deserialize)]
struct SubscribeIn {
    name: String,
    whatsapp: String,
}

async fn subscribe(State(s): State<Shared>, Json(b): Json<SubscribeIn>) -> ApiResult<Message> {
    let (Some(name), Some(wa)) = (clean(&b.name, 60), normalize_wa(&b.whatsapp)) else {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Nama atau nomor WhatsApp belum valid."));
    };
    match sqlx::query("INSERT INTO subscribers (name, whatsapp, created_at) VALUES (?, ?, ?)")
        .bind(name.clone())
        .bind(wa)
        .bind(now() as i64)
        .execute(&s.db)
        .await
    {
        Ok(_) => {}
        // Nomor yang sudah terdaftar dianggap berhasil
        Err(e) if is_dup(&e) => {}
        Err(e) => return Err(db_err(e)),
    }
    Ok(ok(format!("Terima kasih, {name}! Promo mingguan akan kami kirim lewat WhatsApp.")))
}

// ---------- Admin: sesi ----------

#[derive(Deserialize)]
struct LoginIn {
    password: String,
}

#[derive(Serialize)]
struct Token {
    token: String,
}

async fn login(State(s): State<Shared>, Json(b): Json<LoginIn>) -> ApiResult<Token> {
    let Some(expected) = &s.admin_password else {
        return Err(fail(StatusCode::SERVICE_UNAVAILABLE, "Admin belum aktif: atur ADMIN_PASSWORD di server."));
    };
    if !eq_ct(&b.password, expected) {
        tokio::time::sleep(Duration::from_millis(600)).await;
        return Err(fail(StatusCode::UNAUTHORIZED, "Kata sandi salah."));
    }
    let token: String = rand::rng().sample_iter(Alphanumeric).take(48).map(char::from).collect();
    s.sessions.lock().await.insert(token.clone());
    Ok(Json(Token { token }))
}

async fn logout(State(s): State<Shared>, headers: HeaderMap) -> Json<Message> {
    if let Some(t) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) {
        s.sessions.lock().await.remove(t);
    }
    ok("Sudah keluar.")
}

async fn whoami(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Message> {
    require_admin(&s, &headers).await?;
    Ok(ok("ok"))
}

// ---------- Admin: produk ----------

#[derive(Deserialize)]
struct ProductIn {
    name: String,
    category: String,
    price: u32,
    unit: String,
    emoji: String,
    tag: Option<String>,
    barcode: Option<String>,
    stock: Option<u32>,
    cost: Option<u32>,
}

impl ProductIn {
    fn into_product(self, id: u32) -> Result<Product, ApiError> {
        let bad = || fail(StatusCode::UNPROCESSABLE_ENTITY, "Data produk belum lengkap atau terlalu panjang.");
        if self.price == 0 || self.price > 100_000_000 {
            return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Harga harus antara 1 dan 100.000.000."));
        }
        Ok(Product {
            id,
            name: clean(&self.name, 80).ok_or_else(bad)?,
            category: clean(&self.category, 30).ok_or_else(bad)?,
            price: self.price,
            unit: clean(&self.unit, 20).ok_or_else(bad)?,
            emoji: clean(&self.emoji, 16).ok_or_else(bad)?,
            tag: self.tag.as_deref().and_then(|t| clean(t, 20)),
            barcode: self.barcode.as_deref().and_then(|b| clean(b, 40)),
            cost: match self.cost {
                Some(c) if c > 100_000_000 => return Err(bad()),
                other => other,
            },
            stock: match self.stock {
                Some(n) if n > 1_000_000 => return Err(bad()),
                other => other,
            },
        })
    }
}

const DUP_BARCODE: &str = "Barcode ini sudah dipakai produk lain.";

async fn product_create(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<ProductIn>) -> ApiResult<Product> {
    require_admin(&s, &headers).await?;
    let p = b.into_product(0)?;
    let res = sqlx::query("INSERT INTO products (name, category, price, unit, emoji, tag, barcode, stock, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(p.name.clone())
        .bind(p.category.clone())
        .bind(p.price as i64)
        .bind(p.unit.clone())
        .bind(p.emoji.clone())
        .bind(p.tag.clone())
        .bind(p.barcode.clone())
        .bind(p.stock.map(|v| v as i64))
        .bind(p.cost.map(|v| v as i64))
        .execute(&s.db)
        .await
        .map_err(|e| if is_dup(&e) { fail(StatusCode::CONFLICT, DUP_BARCODE) } else { db_err(e) })?;
    Ok(Json(Product { id: res.last_insert_id() as u32, ..p }))
}

async fn product_update(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<u32>, Json(b): Json<ProductIn>) -> ApiResult<Product> {
    require_admin(&s, &headers).await?;
    let p = b.into_product(id)?;
    let exists = sqlx::query("SELECT id FROM products WHERE id = ?")
        .bind(id as i64)
        .fetch_optional(&s.db)
        .await
        .map_err(db_err)?;
    if exists.is_none() {
        return Err(fail(StatusCode::NOT_FOUND, "Produk tidak ditemukan."));
    }
    sqlx::query("UPDATE products SET name = ?, category = ?, price = ?, unit = ?, emoji = ?, tag = ?, barcode = ?, stock = ?, cost = ? WHERE id = ?")
        .bind(p.name.clone())
        .bind(p.category.clone())
        .bind(p.price as i64)
        .bind(p.unit.clone())
        .bind(p.emoji.clone())
        .bind(p.tag.clone())
        .bind(p.barcode.clone())
        .bind(p.stock.map(|v| v as i64))
        .bind(p.cost.map(|v| v as i64))
        .bind(id as i64)
        .execute(&s.db)
        .await
        .map_err(|e| if is_dup(&e) { fail(StatusCode::CONFLICT, DUP_BARCODE) } else { db_err(e) })?;
    Ok(Json(p))
}

async fn product_delete(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<u32>) -> ApiResult<Message> {
    require_admin(&s, &headers).await?;
    let res = sqlx::query("DELETE FROM products WHERE id = ?").bind(id as i64).execute(&s.db).await.map_err(db_err)?;
    if res.rows_affected() == 0 {
        return Err(fail(StatusCode::NOT_FOUND, "Produk tidak ditemukan."));
    }
    Ok(ok("Produk dihapus."))
}

// ---------- Admin: promo ----------

#[derive(Deserialize)]
struct PromoIn {
    title: String,
    detail: String,
    price: u32,
    normal_price: u32,
    /// Berlaku berapa jam dari sekarang.
    hours: u32,
}

impl PromoIn {
    fn into_promo(self, id: u32) -> Result<Promo, ApiError> {
        let bad = || fail(StatusCode::UNPROCESSABLE_ENTITY, "Data promo belum lengkap atau terlalu panjang.");
        if self.price == 0 || self.price > self.normal_price || self.normal_price > 100_000_000 {
            return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Harga promo harus lebih kecil dari harga normal."));
        }
        if self.hours == 0 || self.hours > 24 * 90 {
            return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Durasi promo 1 sampai 2160 jam."));
        }
        Ok(Promo {
            id,
            title: clean(&self.title, 60).ok_or_else(bad)?,
            detail: clean(&self.detail, 140).ok_or_else(bad)?,
            price: self.price,
            normal_price: self.normal_price,
            ends_at: now() + self.hours as u64 * 3600,
        })
    }
}

async fn promos_all(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Vec<Promo>> {
    require_admin(&s, &headers).await?;
    let rows = sqlx::query("SELECT * FROM promos ORDER BY id").fetch_all(&s.db).await.map_err(db_err)?;
    Ok(Json(map_rows(&rows, promo_row)?))
}

async fn promo_create(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<PromoIn>) -> ApiResult<Promo> {
    require_admin(&s, &headers).await?;
    let p = b.into_promo(0)?;
    let res = sqlx::query("INSERT INTO promos (title, detail, price, normal_price, ends_at) VALUES (?, ?, ?, ?, ?)")
        .bind(p.title.clone())
        .bind(p.detail.clone())
        .bind(p.price as i64)
        .bind(p.normal_price as i64)
        .bind(p.ends_at as i64)
        .execute(&s.db)
        .await
        .map_err(db_err)?;
    Ok(Json(Promo { id: res.last_insert_id() as u32, ..p }))
}

async fn promo_update(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<u32>, Json(b): Json<PromoIn>) -> ApiResult<Promo> {
    require_admin(&s, &headers).await?;
    let p = b.into_promo(id)?;
    let res = sqlx::query("UPDATE promos SET title = ?, detail = ?, price = ?, normal_price = ?, ends_at = ? WHERE id = ?")
        .bind(p.title.clone())
        .bind(p.detail.clone())
        .bind(p.price as i64)
        .bind(p.normal_price as i64)
        .bind(p.ends_at as i64)
        .bind(id as i64)
        .execute(&s.db)
        .await
        .map_err(db_err)?;
    if res.rows_affected() == 0 && sqlx::query("SELECT id FROM promos WHERE id = ?").bind(id as i64).fetch_optional(&s.db).await.map_err(db_err)?.is_none() {
        return Err(fail(StatusCode::NOT_FOUND, "Promo tidak ditemukan."));
    }
    Ok(Json(p))
}

async fn promo_delete(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<u32>) -> ApiResult<Message> {
    require_admin(&s, &headers).await?;
    let res = sqlx::query("DELETE FROM promos WHERE id = ?").bind(id as i64).execute(&s.db).await.map_err(db_err)?;
    if res.rows_affected() == 0 {
        return Err(fail(StatusCode::NOT_FOUND, "Promo tidak ditemukan."));
    }
    Ok(ok("Promo dihapus."))
}

// ---------- Admin: pelanggan ----------

async fn subscribers(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Vec<Subscriber>> {
    require_admin(&s, &headers).await?;
    let rows = sqlx::query("SELECT * FROM subscribers ORDER BY id").fetch_all(&s.db).await.map_err(db_err)?;
    Ok(Json(map_rows(&rows, subscriber_row)?))
}

async fn subscriber_delete(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<u32>) -> ApiResult<Message> {
    require_admin(&s, &headers).await?;
    let res = sqlx::query("DELETE FROM subscribers WHERE id = ?").bind(id as i64).execute(&s.db).await.map_err(db_err)?;
    if res.rows_affected() == 0 {
        return Err(fail(StatusCode::NOT_FOUND, "Pelanggan tidak ditemukan."));
    }
    Ok(ok("Pelanggan dihapus."))
}

// ---------- Admin: pengaturan toko ----------

fn check_settings(s: Settings) -> Result<Settings, ApiError> {
    let email = text(&s.email, 120, "Email", false)?;
    if !email.is_empty() && !(email.contains('@') && email.contains('.') && !email.contains(' ')) {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Format email belum benar."));
    }
    if s.close_hour > 24 || s.open_hour >= s.close_hour {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Jam buka harus lebih awal dari jam tutup (0 sampai 24)."));
    }
    // WhatsApp boleh kosong; jika kosong, tombol pesan disembunyikan di situs
    let whatsapp = if s.whatsapp.trim().is_empty() {
        String::new()
    } else {
        normalize_wa(&s.whatsapp).ok_or_else(|| fail(StatusCode::UNPROCESSABLE_ENTITY, "Nomor WhatsApp tidak valid."))?
    };
    Ok(Settings {
        shop_name: text(&s.shop_name, 60, "Nama toko", true)?,
        tagline: text(&s.tagline, 120, "Slogan", false)?,
        address: text(&s.address, 200, "Alamat", true)?,
        phone: text(&s.phone, 20, "Telepon", false)?,
        whatsapp,
        email,
        open_hour: s.open_hour,
        close_hour: s.close_hour,
        delivery_note: text(&s.delivery_note, 160, "Catatan pengiriman", false)?,
    })
}

async fn settings_put(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<Settings>) -> ApiResult<Settings> {
    require_admin(&s, &headers).await?;
    let new = check_settings(b)?;
    settings_upsert(&new).execute(&s.db).await.map_err(db_err)?;
    Ok(Json(new))
}

// ---------- Admin: barcode & kasir ----------

#[derive(Deserialize)]
struct CodeQuery {
    code: String,
}

async fn barcode_lookup(State(s): State<Shared>, headers: HeaderMap, Query(q): Query<CodeQuery>) -> ApiResult<Product> {
    require_admin(&s, &headers).await?;
    let row = sqlx::query("SELECT * FROM products WHERE barcode = ? LIMIT 1")
        .bind(q.code.trim().to_string())
        .fetch_optional(&s.db)
        .await
        .map_err(db_err)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Barcode tidak dikenal."))?;
    Ok(Json(product_row(&row).map_err(db_err)?))
}

#[derive(Deserialize)]
struct SaleLine {
    product_id: u32,
    qty: u32,
}

#[derive(Deserialize)]
struct SaleIn {
    items: Vec<SaleLine>,
    paid: u64,
}

async fn sale_create(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<SaleIn>) -> ApiResult<Sale> {
    require_admin(&s, &headers).await?;
    if b.items.is_empty() || b.items.len() > 100 {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Keranjang kosong atau terlalu banyak barang."));
    }
    // Jumlah dijumlahkan per produk; urutan id naik supaya kunci baris tidak saling tunggu
    let mut need: BTreeMap<u32, u32> = BTreeMap::new();
    for line in &b.items {
        if line.qty == 0 || line.qty > 999 {
            return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Jumlah tiap barang harus 1 sampai 999."));
        }
        *need.entry(line.product_id).or_insert(0) += line.qty;
    }

    let mut tx = s.db.begin().await.map_err(db_err)?;
    let mut items = Vec::new();
    let mut total: u64 = 0;
    for (pid, qty) in &need {
        // Harga dan stok selalu dibaca dari database dalam transaksi, bukan dari browser
        let row = sqlx::query("SELECT * FROM products WHERE id = ? FOR UPDATE")
            .bind(*pid as i64)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?
            .ok_or_else(|| fail(StatusCode::UNPROCESSABLE_ENTITY, "Ada barang yang sudah tidak tersedia. Muat ulang kasir."))?;
        let p = product_row(&row).map_err(db_err)?;
        if let Some(stock) = p.stock {
            if stock < *qty {
                return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, &format!("Stok {} tidak cukup (sisa {}).", p.name, stock)));
            }
        }
        total += p.price as u64 * *qty as u64;
        items.push(SaleItem { product_id: p.id, name: p.name.clone(), price: p.price, qty: *qty, cost: p.cost });
    }
    if total > 1_000_000_000 {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Total transaksi terlalu besar."));
    }
    if b.paid < total {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Uang bayar kurang dari total."));
    }

    let created_at = now();
    let res = sqlx::query("INSERT INTO sales (created_at, total, paid, change_amount) VALUES (?, ?, ?, ?)")
        .bind(created_at as i64)
        .bind(total as i64)
        .bind(b.paid as i64)
        .bind((b.paid - total) as i64)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    let sale_id = res.last_insert_id();
    for it in &items {
        sqlx::query("INSERT INTO sale_items (sale_id, product_id, name, price, qty, cost) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(sale_id as i64)
            .bind(it.product_id as i64)
            .bind(it.name.clone())
            .bind(it.price as i64)
            .bind(it.qty as i64)
            .bind(it.cost.map(|v| v as i64))
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        sqlx::query("UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL")
            .bind(it.qty as i64)
            .bind(it.product_id as i64)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;

    Ok(Json(Sale { id: sale_id as u32, created_at, items, total, paid: b.paid, change: b.paid - total }))
}

async fn sales_list(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Vec<Sale>> {
    require_admin(&s, &headers).await?;
    let rows = sqlx::query(
        "SELECT s.id AS sid, s.created_at, s.total, s.paid, s.change_amount,
                i.product_id, i.name, i.price, i.qty
         FROM (SELECT * FROM sales ORDER BY id DESC LIMIT 200) s
         JOIN sale_items i ON i.sale_id = s.id
         ORDER BY s.id DESC, i.id",
    )
    .fetch_all(&s.db)
    .await
    .map_err(db_err)?;

    let mut out: Vec<Sale> = Vec::new();
    for r in &rows {
        let sid = r.try_get::<i64, _>("sid").map_err(db_err)? as u32;
        if out.last().map(|l| l.id) != Some(sid) {
            out.push(Sale {
                id: sid,
                created_at: r.try_get::<i64, _>("created_at").map_err(db_err)? as u64,
                items: Vec::new(),
                total: r.try_get::<i64, _>("total").map_err(db_err)? as u64,
                paid: r.try_get::<i64, _>("paid").map_err(db_err)? as u64,
                change: r.try_get::<i64, _>("change_amount").map_err(db_err)? as u64,
            });
        }
        let item = SaleItem {
            product_id: r.try_get::<i64, _>("product_id").map_err(db_err)? as u32,
            name: r.try_get("name").map_err(db_err)?,
            price: r.try_get::<i64, _>("price").map_err(db_err)? as u32,
            qty: r.try_get::<i64, _>("qty").map_err(db_err)? as u32,
            cost: None,
        };
        if let Some(last) = out.last_mut() {
            last.items.push(item);
        }
    }
    Ok(Json(out))
}

// ---------- Analisa penjualan ----------

/// Selisih waktu WIB (UTC+7) dalam detik. Hari dihitung menurut jam Indonesia.
const WIB: i64 = 7 * 3600;

/// Hari sejak 1970-01-01 untuk tanggal kalender (algoritma Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "YYYY-MM-DD" menjadi jumlah hari sejak 1970-01-01.
fn parse_day(s: &str) -> Option<i64> {
    let mut it = s.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

#[derive(Deserialize)]
struct RangeQuery {
    from: Option<String>,
    to: Option<String>,
}

#[derive(Serialize, Default)]
struct DayStat {
    /// Awal hari dalam detik sejak epoch (pukul 00.00 WIB)
    day: i64,
    transactions: u64,
    revenue: i64,
    /// Omzet dari barang yang harga belinya sudah diisi
    revenue_known: i64,
    cost: i64,
    profit: i64,
}

#[derive(Serialize, Default)]
struct ProductStat {
    product_id: u32,
    name: String,
    qty: i64,
    revenue: i64,
    revenue_known: i64,
    cost: i64,
    profit: i64,
    /// Baris penjualan yang harga belinya belum diisi saat dijual
    missing_cost_lines: u64,
}

#[derive(Serialize, Default)]
struct Analytics {
    transactions: u64,
    qty: i64,
    revenue: i64,
    revenue_known: i64,
    cost: i64,
    profit: i64,
    /// Margin dihitung dari barang yang harga belinya sudah diisi
    margin: f64,
    missing_cost_lines: u64,
    days: Vec<DayStat>,
    products: Vec<ProductStat>,
}

async fn analytics(State(s): State<Shared>, headers: HeaderMap, Query(q): Query<RangeQuery>) -> ApiResult<Analytics> {
    require_admin(&s, &headers).await?;
    let today = (now() as i64 + WIB) / 86_400;
    let to_day = q.to.as_deref().and_then(parse_day).unwrap_or(today);
    let from_day = q.from.as_deref().and_then(parse_day).unwrap_or(to_day - 29);
    if from_day > to_day || to_day - from_day > 366 {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Rentang tanggal harus 1 sampai 366 hari."));
    }
    let start = from_day * 86_400 - WIB;
    let end = (to_day + 1) * 86_400 - WIB;

    let rows = sqlx::query(
        "SELECT s.id AS sid, s.created_at, i.product_id, i.name, i.price, i.qty, i.cost
         FROM sales s JOIN sale_items i ON i.sale_id = s.id
         WHERE s.created_at >= ? AND s.created_at < ?",
    )
    .bind(start)
    .bind(end)
    .fetch_all(&s.db)
    .await
    .map_err(db_err)?;

    let mut a = Analytics::default();
    let mut days: BTreeMap<i64, DayStat> = BTreeMap::new();
    let mut products: BTreeMap<i64, ProductStat> = BTreeMap::new();
    let mut counted: HashSet<i64> = HashSet::new();
    for r in &rows {
        let sid: i64 = r.try_get("sid").map_err(db_err)?;
        let created: i64 = r.try_get("created_at").map_err(db_err)?;
        let pid: i64 = r.try_get("product_id").map_err(db_err)?;
        let name: String = r.try_get("name").map_err(db_err)?;
        let price: i64 = r.try_get("price").map_err(db_err)?;
        let qty: i64 = r.try_get("qty").map_err(db_err)?;
        let cost: Option<i64> = r.try_get("cost").map_err(db_err)?;
        let line = price * qty;

        let day_key = (created + WIB) / 86_400;
        let d = days.entry(day_key).or_insert_with(|| DayStat { day: day_key * 86_400 - WIB, ..Default::default() });
        if counted.insert(sid) {
            d.transactions += 1;
            a.transactions += 1;
        }
        let p = products
            .entry(pid)
            .or_insert_with(|| ProductStat { product_id: pid as u32, name: name.clone(), ..Default::default() });

        a.qty += qty;
        a.revenue += line;
        d.revenue += line;
        p.qty += qty;
        p.revenue += line;
        match cost {
            Some(c) => {
                let lc = c * qty;
                a.revenue_known += line;
                a.cost += lc;
                d.revenue_known += line;
                d.cost += lc;
                p.revenue_known += line;
                p.cost += lc;
            }
            None => {
                a.missing_cost_lines += 1;
                p.missing_cost_lines += 1;
            }
        }
    }

    for d in days.values_mut() {
        d.profit = d.revenue_known - d.cost;
    }
    for p in products.values_mut() {
        p.profit = p.revenue_known - p.cost;
    }
    a.profit = a.revenue_known - a.cost;
    a.margin = if a.revenue_known > 0 { a.profit as f64 / a.revenue_known as f64 * 100.0 } else { 0.0 };
    a.days = days.into_values().collect();
    a.products = products.into_values().collect();
    a.products.sort_by_key(|p| std::cmp::Reverse(p.profit));
    Ok(Json(a))
}

// ---------- QRIS (Midtrans Core API) ----------

use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha512};

struct Midtrans {
    key: String,
    base: String,
    http: reqwest::Client,
}

/// Kode pesanan unik. Bagian acak membuat URL QR dan status tidak bisa ditebak.
fn new_order_id() -> String {
    let rnd: String = rand::rng().sample_iter(Alphanumeric).take(10).map(char::from).collect();
    format!("NK{}{}", now(), rnd)
}

/// Status pembayaran diambil langsung dari Midtrans. Ini sumber kebenarannya, bukan body webhook.
async fn midtrans_status(mt: &Midtrans, order_id: &str) -> Result<(String, String), ApiError> {
    let res = mt
        .http
        .get(format!("{}/v2/{}/status", mt.base, order_id))
        .basic_auth(&mt.key, Some(""))
        .send()
        .await
        .map_err(|_| fail(StatusCode::BAD_GATEWAY, "Midtrans tidak dapat dihubungi."))?;
    let v: serde_json::Value = res
        .json()
        .await
        .map_err(|_| fail(StatusCode::BAD_GATEWAY, "Respons Midtrans tidak valid."))?;
    Ok((
        v["transaction_status"].as_str().unwrap_or("").to_string(),
        v["gross_amount"].as_str().unwrap_or("").to_string(),
    ))
}

/// Membuat penjualan di dalam transaksi database yang sudah berjalan: kunci baris produk, cek stok, kurangi stok.
async fn create_sale_tx(tx: &mut sqlx::Transaction<'_, MySql>, lines: &[(u32, u32)], paid: u64, method: &str) -> Result<Sale, ApiError> {
    let mut items = Vec::new();
    let mut total: u64 = 0;
    for (pid, qty) in lines {
        let row = sqlx::query("SELECT * FROM products WHERE id = ? FOR UPDATE")
            .bind(*pid as i64)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db_err)?
            .ok_or_else(|| fail(StatusCode::UNPROCESSABLE_ENTITY, "Ada barang yang sudah tidak tersedia."))?;
        let p = product_row(&row).map_err(db_err)?;
        if let Some(stock) = p.stock {
            if stock < *qty {
                return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, &format!("Stok {} tidak cukup (sisa {}).", p.name, stock)));
            }
        }
        total += p.price as u64 * *qty as u64;
        items.push(SaleItem { product_id: p.id, name: p.name.clone(), price: p.price, qty: *qty, cost: p.cost });
    }
    if paid < total {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Uang bayar kurang dari total."));
    }
    let created_at = now();
    let res = sqlx::query("INSERT INTO sales (created_at, total, paid, change_amount, method) VALUES (?, ?, ?, ?, ?)")
        .bind(created_at as i64)
        .bind(total as i64)
        .bind(paid as i64)
        .bind((paid - total) as i64)
        .bind(method.to_string())
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    let sale_id = res.last_insert_id();
    for it in &items {
        sqlx::query("INSERT INTO sale_items (sale_id, product_id, name, price, qty, cost) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(sale_id as i64)
            .bind(it.product_id as i64)
            .bind(it.name.clone())
            .bind(it.price as i64)
            .bind(it.qty as i64)
            .bind(it.cost.map(|v| v as i64))
            .execute(&mut **tx)
            .await
            .map_err(db_err)?;
        sqlx::query("UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL")
            .bind(it.qty as i64)
            .bind(it.product_id as i64)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?;
    }
    Ok(Sale { id: sale_id as u32, created_at, items, total, paid, change: paid - total })
}

/// Menerapkan status dari Midtrans ke pesanan. Dipanggil dari webhook dan dari cek status.
/// Penjualan hanya dibuat sekali (dikunci dengan FOR UPDATE), jadi webhook dobel tidak mencatat dua kali.
async fn apply_status(s: &AppState, order_id: &str, mt_status: &str, gross: &str) -> Result<String, ApiError> {
    let next = match mt_status {
        "settlement" => "paid",
        "expire" => "expired",
        "cancel" | "deny" | "failed" => "failed",
        _ => return Ok("pending".into()),
    };
    let mut tx = s.db.begin().await.map_err(db_err)?;
    let row = sqlx::query("SELECT status, total, items_json FROM qris_orders WHERE order_id = ? FOR UPDATE")
        .bind(order_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Pesanan tidak ditemukan."))?;
    let local: String = row.try_get("status").map_err(db_err)?;
    if local != "pending" {
        tx.rollback().await.map_err(db_err)?;
        return Ok(local);
    }
    let total: i64 = row.try_get("total").map_err(db_err)?;
    let items_json: String = row.try_get("items_json").map_err(db_err)?;

    if next != "paid" {
        tx.rollback().await.map_err(db_err)?;
        sqlx::query("UPDATE qris_orders SET status = ? WHERE order_id = ? AND status = 'pending'")
            .bind(next)
            .bind(order_id.to_string())
            .execute(&s.db)
            .await
            .map_err(db_err)?;
        return Ok(next.into());
    }

    // Nominal yang dibayar harus sama dengan tagihan
    let paid_ok = gross.parse::<f64>().map(|g| (g - total as f64).abs() < 0.5).unwrap_or(false);
    if !paid_ok {
        tx.rollback().await.map_err(db_err)?;
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Nominal pembayaran tidak sama dengan tagihan."));
    }
    let lines: Vec<(u32, u32)> =
        serde_json::from_str(&items_json).map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "Data pesanan rusak."))?;
    match create_sale_tx(&mut tx, &lines, total as u64, "qris").await {
        Ok(sale) => {
            sqlx::query("UPDATE qris_orders SET status = 'paid', sale_id = ? WHERE order_id = ?")
                .bind(sale.id as i64)
                .bind(order_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
            tx.commit().await.map_err(db_err)?;
            Ok("paid".into())
        }
        Err(_) => {
            // Uang sudah masuk tetapi stok keburu habis: tandai untuk ditinjau manual, jangan diam-diam gagal
            tx.rollback().await.map_err(db_err)?;
            eprintln!("PERLU TINJAUAN: pesanan {order_id} sudah dibayar tetapi stok tidak cukup");
            sqlx::query("UPDATE qris_orders SET status = 'review' WHERE order_id = ? AND status = 'pending'")
                .bind(order_id.to_string())
                .execute(&s.db)
                .await
                .map_err(db_err)?;
            Ok("review".into())
        }
    }
}

#[derive(Deserialize)]
struct QrisIn {
    items: Vec<SaleLine>,
}

#[derive(Serialize)]
struct QrisOut {
    order_id: String,
    total: i64,
    expires_at: u64,
    /// Data QR dinamis; ditampilkan sebagai gambar di browser
    qr_string: String,
}

fn midtrans_or_503(s: &AppState) -> Result<&Midtrans, ApiError> {
    s.midtrans
        .as_ref()
        .ok_or_else(|| fail(StatusCode::SERVICE_UNAVAILABLE, "QRIS belum aktif: atur MIDTRANS_SERVER_KEY di server."))
}

async fn qris_create(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<QrisIn>) -> ApiResult<QrisOut> {
    require_admin(&s, &headers).await?;
    let gw = gateway_or_503(&s)?;
    if b.items.is_empty() || b.items.len() > 100 {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Keranjang kosong atau terlalu banyak barang."));
    }
    let mut need: BTreeMap<u32, u32> = BTreeMap::new();
    for line in &b.items {
        if line.qty == 0 || line.qty > 999 {
            return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Jumlah tiap barang harus 1 sampai 999."));
        }
        *need.entry(line.product_id).or_insert(0) += line.qty;
    }

    // Total dihitung dari harga di server. Stok dikurangi nanti, saat pembayaran lunas.
    let mut total: i64 = 0;
    let mut lines: Vec<(u32, u32)> = Vec::new();
    for (pid, qty) in &need {
        let row = sqlx::query("SELECT * FROM products WHERE id = ?")
            .bind(*pid as i64)
            .fetch_optional(&s.db)
            .await
            .map_err(db_err)?
            .ok_or_else(|| fail(StatusCode::UNPROCESSABLE_ENTITY, "Ada barang yang sudah tidak tersedia."))?;
        let p = product_row(&row).map_err(db_err)?;
        if let Some(stock) = p.stock {
            if stock < *qty {
                return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, &format!("Stok {} tidak cukup (sisa {}).", p.name, stock)));
            }
        }
        total += p.price as i64 * *qty as i64;
        lines.push((*pid, *qty));
    }
    if total <= 0 || total > 1_000_000_000 {
        return Err(fail(StatusCode::UNPROCESSABLE_ENTITY, "Total transaksi tidak valid."));
    }

    // Pembayaran dibuat di gateway: nominal pas, QR dinamis dari QRIS statis, berlaku 15 menit
    let created = gateway_call(
        gw,
        reqwest::Method::POST,
        "/v1/payments",
        Some(serde_json::json!({ "amount": total, "reference": new_order_id() })),
    )
    .await?;
    let order_id = created["id"]
        .as_str()
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "Respons gateway tidak valid."))?
        .to_string();
    let qr_string = created["qrString"]
        .as_str()
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "QR tidak ada di respons gateway."))?
        .to_string();
    // expiresAt dari gateway dalam milidetik
    let expires_at = created["expiresAt"].as_u64().unwrap_or(0) / 1000;

    sqlx::query("INSERT INTO qris_orders (order_id, status, total, items_json, qr_url, expires_at, created_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)")
        .bind(order_id.clone())
        .bind(total)
        .bind(serde_json::to_string(&lines).unwrap_or_default())
        .bind(qr_string.clone())
        .bind(expires_at as i64)
        .bind(now() as i64)
        .execute(&s.db)
        .await
        .map_err(db_err)?;

    Ok(Json(QrisOut { order_id, total, expires_at, qr_string }))
}

/// Status pembayaran dari gateway, diterjemahkan ke istilah yang sudah dipakai apply_status.
/// Nominal dari gateway selalu sama dengan total pesanan (tanpa kode unik).
async fn gateway_payment_status(gw: &Gateway, id: &str, total: i64) -> Result<(String, String), ApiError> {
    let v = gateway_call(gw, reqwest::Method::GET, &format!("/v1/payments/{id}"), None).await?;
    let mapped = match v["status"].as_str().unwrap_or("") {
        "paid" => "settlement",
        "expired" => "expire",
        "cancelled" => "cancel",
        _ => "pending",
    };
    Ok((mapped.to_string(), total.to_string()))
}

async fn qris_status(State(s): State<Shared>, headers: HeaderMap, Path(order_id): Path<String>) -> ApiResult<serde_json::Value> {
    require_admin(&s, &headers).await?;
    let local: String = sqlx::query("SELECT status FROM qris_orders WHERE order_id = ?")
        .bind(order_id.clone())
        .fetch_optional(&s.db)
        .await
        .map_err(db_err)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Pesanan tidak ditemukan."))?
        .try_get("status")
        .map_err(db_err)?;
    let status = if local == "pending" {
        let gw = gateway_or_503(&s)?;
        let total: i64 = sqlx::query("SELECT total FROM qris_orders WHERE order_id = ?")
            .bind(order_id.clone())
            .fetch_one(&s.db)
            .await
            .map_err(db_err)?
            .try_get("total")
            .map_err(db_err)?;
        let (ms, gross) = gateway_payment_status(gw, &order_id, total).await?;
        apply_status(&s, &order_id, &ms, &gross).await?
    } else {
        local
    };
    let sale_id: Option<i64> = sqlx::query("SELECT sale_id FROM qris_orders WHERE order_id = ?")
        .bind(order_id.clone())
        .fetch_optional(&s.db)
        .await
        .map_err(db_err)?
        .and_then(|r| r.try_get::<Option<i64>, _>("sale_id").ok().flatten());
    Ok(Json(serde_json::json!({ "order_id": order_id, "status": status, "sale_id": sale_id })))
}

/// Gambar QR diambil dari Midtrans lewat server, supaya kunci server tidak pernah sampai ke browser.
/// URL-nya memuat kode acak, jadi tidak bisa ditebak.
async fn qris_qr(State(s): State<Shared>, Path(order_id): Path<String>) -> Result<Response, ApiError> {
    let mt = midtrans_or_503(&s)?;
    let qr_url: String = sqlx::query("SELECT qr_url FROM qris_orders WHERE order_id = ?")
        .bind(order_id)
        .fetch_optional(&s.db)
        .await
        .map_err(db_err)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Pesanan tidak ditemukan."))?
        .try_get("qr_url")
        .map_err(db_err)?;
    // Kunci hanya dikirim ke host Midtrans yang dikenal
    let trusted = qr_url.starts_with("https://api.midtrans.com/") || qr_url.starts_with("https://api.sandbox.midtrans.com/");
    let req = mt.http.get(&qr_url);
    let req = if trusted { req.basic_auth(&mt.key, Some("")) } else { req };
    let res = req.send().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "Gambar QR tidak dapat diambil."))?;
    let bytes = res.bytes().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "Gambar QR tidak dapat diambil."))?;
    Ok(([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "no-store")], bytes).into_response())
}

#[derive(Deserialize)]
struct Notify {
    order_id: String,
    status_code: String,
    gross_amount: String,
    signature_key: String,
}

/// Webhook dari Midtrans. Signature diverifikasi dulu, lalu status diambil ulang dari Midtrans.
async fn midtrans_notify(State(s): State<Shared>, Json(n): Json<Notify>) -> Result<StatusCode, ApiError> {
    let mt = midtrans_or_503(&s)?;
    let raw = format!("{}{}{}{}", n.order_id, n.status_code, n.gross_amount, mt.key);
    let expected = hex::encode(Sha512::digest(raw.as_bytes()));
    if !eq_ct(&expected, &n.signature_key) {
        return Err(fail(StatusCode::FORBIDDEN, "Signature tidak valid."));
    }
    let (ms, gross) = midtrans_status(mt, &n.order_id).await?;
    apply_status(&s, &n.order_id, &ms, &gross).await?;
    Ok(StatusCode::OK)
}

// ---------- Koneksi GoPay lewat gateway ----------

/// Gateway QRIS (service Node terpisah). Hanya bisa dihubungi dari jaringan internal Docker.
struct Gateway {
    url: String,
    secret: String,
    http: reqwest::Client,
}

fn gateway_or_503(s: &AppState) -> Result<&Gateway, ApiError> {
    s.gateway
        .as_ref()
        .ok_or_else(|| fail(StatusCode::SERVICE_UNAVAILABLE, "Gateway QRIS belum dikonfigurasi (GATEWAY_SECRET)."))
}

/// Meneruskan request ke gateway. Pesan error hanya diambil dari field `message` yang sudah aman.
async fn gateway_call(gw: &Gateway, method: reqwest::Method, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, ApiError> {
    let mut req = gw.http.request(method, format!("{}{}", gw.url, path)).header("x-gateway-secret", gw.secret.as_str());
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req
        .send()
        .await
        .map_err(|_| fail(StatusCode::SERVICE_UNAVAILABLE, "Gateway QRIS tidak dapat dihubungi."))?;
    let status = res.status();
    let v: serde_json::Value = res.json().await.unwrap_or(serde_json::json!({}));
    if !status.is_success() {
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let msg = v["message"].as_str().unwrap_or("Gateway menolak permintaan.").to_string();
        return Err(fail(code, &msg));
    }
    Ok(v)
}

async fn gopay_status(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<serde_json::Value> {
    require_admin(&s, &headers).await?;
    let gw = gateway_or_503(&s)?;
    Ok(Json(gateway_call(gw, reqwest::Method::GET, "/v1/login/status", None).await?))
}

#[derive(Deserialize)]
struct GopayPhoneIn {
    phone: String,
}

async fn gopay_request(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<GopayPhoneIn>) -> ApiResult<serde_json::Value> {
    require_admin(&s, &headers).await?;
    let gw = gateway_or_503(&s)?;
    Ok(Json(gateway_call(gw, reqwest::Method::POST, "/v1/login/request", Some(serde_json::json!({ "phone": b.phone }))).await?))
}

#[derive(Deserialize)]
struct GopayOtpIn {
    otp: String,
}

async fn gopay_verify(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<GopayOtpIn>) -> ApiResult<serde_json::Value> {
    require_admin(&s, &headers).await?;
    let gw = gateway_or_503(&s)?;
    Ok(Json(gateway_call(gw, reqwest::Method::POST, "/v1/login/verify", Some(serde_json::json!({ "otp": b.otp }))).await?))
}

async fn gopay_logout(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<serde_json::Value> {
    require_admin(&s, &headers).await?;
    let gw = gateway_or_503(&s)?;
    Ok(Json(gateway_call(gw, reqwest::Method::POST, "/v1/logout", None).await?))
}

// ---------- Main ----------

#[tokio::main]
async fn main() {
    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "mysql://root@127.0.0.1:3306/nusa_kael".into());
    let opts = MySqlConnectOptions::from_str(&url).expect("DATABASE_URL tidak valid");
    let connect = || MySqlPoolOptions::new().max_connections(10).connect_with(opts.clone());
    // Coba langsung ke database tujuan; kalau belum ada, buat dulu lalu sambung lagi
    let db = match connect().await {
        Ok(pool) => pool,
        Err(_) => {
            ensure_database(&url).await.unwrap_or_else(|e| panic!("Tidak bisa membuat database: {e}"));
            connect().await.expect("Tidak bisa terhubung ke MySQL. Periksa DATABASE_URL.")
        }
    };

    let data_file = PathBuf::from(std::env::var("DATA_FILE").unwrap_or_else(|_| "data.json".into()));
    migrate(&db, &data_file).await.expect("Gagal menyiapkan tabel database");

    let admin_password = std::env::var("ADMIN_PASSWORD").ok().filter(|p| p.len() >= 8);
    if admin_password.is_none() {
        eprintln!("PERINGATAN: ADMIN_PASSWORD kosong atau kurang dari 8 karakter. Panel admin dinonaktifkan.");
    }

    // Midtrans aktif hanya jika server key diisi. Tanpa itu, fitur QRIS nonaktif, kasir tunai tetap jalan.
    let midtrans = std::env::var("MIDTRANS_SERVER_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .map(|key| Midtrans {
            key,
            base: std::env::var("MIDTRANS_API_BASE").unwrap_or_else(|_| "https://api.sandbox.midtrans.com".into()),
            http: reqwest::Client::builder().timeout(Duration::from_secs(20)).build().expect("HTTP client gagal dibuat"),
        });
    if midtrans.is_none() {
        eprintln!("INFO: MIDTRANS_SERVER_KEY kosong. Pembayaran QRIS dinonaktifkan.");
    }
    // Gateway GoPay (service terpisah). Aktif hanya jika GATEWAY_SECRET diisi, minimal 32 karakter.
    let gateway = std::env::var("GATEWAY_SECRET")
        .ok()
        .filter(|s| s.len() >= 32)
        .map(|secret| Gateway {
            url: std::env::var("GATEWAY_URL").unwrap_or_else(|_| "http://gateway:3100".into()),
            secret,
            http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("HTTP client gagal dibuat"),
        });

    let state: Shared = Arc::new(AppState {
        db,
        admin_password,
        sessions: Mutex::new(HashSet::new()),
        midtrans,
        gateway,
    });

    let api = Router::new()
        .route("/health", get(health))
        .route("/products", get(products))
        .route("/promos", get(promos))
        .route("/settings", get(settings_get))
        .route("/subscribe", post(subscribe))
        .route("/admin/login", post(login))
        .route("/admin/logout", post(logout))
        .route("/admin/me", get(whoami))
        .route("/admin/products", post(product_create))
        .route("/admin/products/{id}", put(product_update))
        .route("/admin/products/{id}", delete(product_delete))
        .route("/admin/promos", get(promos_all).post(promo_create))
        .route("/admin/promos/{id}", put(promo_update))
        .route("/admin/promos/{id}", delete(promo_delete))
        .route("/admin/subscribers", get(subscribers))
        .route("/admin/subscribers/{id}", delete(subscriber_delete))
        .route("/admin/settings", put(settings_put))
        .route("/admin/barcode", get(barcode_lookup))
        .route("/admin/sales", get(sales_list).post(sale_create))
        .route("/admin/analytics", get(analytics))
        .route("/admin/qris", post(qris_create))
        .route("/admin/qris/{order_id}", get(qris_status))
        .route("/qris/{order_id}/qr", get(qris_qr))
        .route("/midtrans/notify", post(midtrans_notify))
        .route("/admin/gopay", get(gopay_status))
        .route("/admin/gopay/request", post(gopay_request))
        .route("/admin/gopay/verify", post(gopay_verify))
        .route("/admin/gopay/logout", post(gopay_logout));

    let mut app = Router::new().nest("/api", api).with_state(state);

    // Sajikan hasil build Astro jika foldernya ada (mode produksi)
    let static_dir = PathBuf::from(std::env::var("STATIC_DIR").unwrap_or_else(|_| "../web/dist".into()));
    if static_dir.join("index.html").exists() {
        let index = ServeFile::new(static_dir.join("index.html"));
        app = app.fallback_service(ServeDir::new(&static_dir).not_found_service(index));
        println!("Menyajikan frontend dari {}", static_dir.display());
    }

    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind gagal");
    println!("Nusa Kael berjalan di http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
