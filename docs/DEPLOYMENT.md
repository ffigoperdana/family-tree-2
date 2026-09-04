# Deployment Soenarto Tree

Panduan production yang aktif memakai Docker di Coolify. Domain production:

```text
https://soenarto.fgdev.tech
```

Jangan memakai flow Vercel atau backend pihak ketiga untuk deployment ini.

## Arsitektur

```text
Cloudflare wildcard
  ↓
Oracle Caddy
  ↓ WireGuard
SafeLine
  ↓ reverse proxy
Coolify: Soenarto Tree container :8080
  ├── Node.js API + frontend + PWA
  └── PostgreSQL service terpisah
```

Backend API dan frontend berjalan dalam container aplikasi yang sama. Encrypted
sharing juga ditangani API tersebut: browser mengenkripsi arsip dengan AES-GCM,
lalu server menyimpan ciphertext-nya di PostgreSQL. Password share tidak pernah
dikirim ke server.

## Coolify

Buat resource baru dari GitHub repository ini dengan build method `Dockerfile`
dan exposed port `8080`. Set domain resource menjadi:

```text
http://soenarto.fgdev.tech
```

Environment variables production:

```text
NODE_ENV=production
PORT=8080
COOKIE_SECURE=1
DATABASE_URL=postgres://USER:PASSWORD@POSTGRES_HOST:5432/soenarto
SESSION_SECRET=<random secret minimal 32 karakter>
BOOTSTRAP_ADMIN_USERNAME=<username admin pertama>
BOOTSTRAP_ADMIN_PASSWORD=<password admin pertama minimal 12 karakter>
CANONICAL_TREE_TITLE=Keluarga Haji Soenarto
PUBLIC_APP_ORIGIN=https://soenarto.fgdev.tech
```

`POSTGRES_HOST` harus hostname internal service PostgreSQL di network Coolify,
bukan `localhost`. Jika password mengandung karakter khusus, URL-encode password
tersebut sebelum dimasukkan ke `DATABASE_URL`.

`BOOTSTRAP_ADMIN_*` hanya digunakan ketika belum ada admin aktif. Setelah login
admin pertama berhasil dan database sudah persisten, hapus kedua variable itu dari
environment production. Ganti `SESSION_SECRET` contoh dengan secret acak milik
deployment ini dan jangan commit nilainya.

PostgreSQL production harus memakai persistent storage dan backup. Database tree
menyimpan dokumen keluarga yang dilindungi RBAC; tabel share hanya menyimpan
ciphertext terenkripsi. Batas ciphertext share saat ini 32 MiB per share.

## SafeLine, Caddy, dan Cloudflare

Ikuti pola homelab yang sudah kamu gunakan:

1. Di SafeLine, buat application `soenarto.fgdev.tech` mode Reverse Proxy. Port
   listener HTTP adalah `80`, dengan upstream menuju alamat Coolify VM sesuai
   network-mu, misalnya `http://192.168.18.37`.
2. Caddy Oracle tetap meneruskan wildcard/catch-all ke SafeLine.
3. Karena record Cloudflare wildcard `*` sudah aktif dan proxied, tidak perlu
   membuat DNS record baru untuk subdomain ini.
4. Pastikan jalur HTTPS publik aktif sebelum production digunakan. Dengan
   `COOKIE_SECURE=1`, session cookie hanya dikirim melalui HTTPS.

Verifikasi bertahap:

```sh
# Coolify VM
curl -I -H "Host: soenarto.fgdev.tech" http://127.0.0.1

# SafeLine VM
curl -I -H "Host: soenarto.fgdev.tech" http://127.0.0.1

# dari luar jaringan
curl -I https://soenarto.fgdev.tech
```

Response health check:

```sh
curl https://soenarto.fgdev.tech/health
curl https://soenarto.fgdev.tech/ready
```

Keduanya harus mengembalikan status HTTP `200`. `/ready` memastikan aplikasi
benar-benar dapat mencapai PostgreSQL.

## Local Docker review

`docker-compose.yml` dipakai untuk review lokal dan membawa PostgreSQL lokal
sendiri. Compose ini bukan database production dan tidak boleh diekspos ke
internet.

```sh
docker compose up -d --build
docker compose ps
```

Buka `http://127.0.0.1:8080`, lalu jalankan smoke test backend:

```sh
cd server
npm run smoke
```

Smoke test mencakup anonymous canonical read-only, admin protection, user
isolation/BOLA, CSRF, serta lifecycle share ciphertext upload, download, dan
revocation.

## Social preview dan WhatsApp

Share link `/s/<share-id>` disajikan oleh server dengan metadata Open Graph dan
Twitter card. `PUBLIC_APP_ORIGIN` membuat `og:url` dan `og:image` menjadi URL
publik yang benar untuk crawler WhatsApp; preview image-nya adalah
`/soenarto-tree-preview.png`. Share page tetap diberi `noindex` karena ini ruang
keluarga privat.

## Environment yang tidak diperlukan

Deployment Coolify ini tidak memerlukan:

- `SHARE_API_ORIGIN`;
- Cloud Run;
- Firestore;
- Google Cloud Storage;
- DNS tambahan per aplikasi selain domain Coolify dan routing SafeLine.

Semua route `/api/v1/*`, PWA asset, login admin/user, CRUD user admin, tree RBAC,
export, dan share lifecycle dilayani oleh container Soenarto Tree yang sama.
