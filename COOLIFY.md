# Deploy Soenarto Tree di Coolify

Repository ini sudah siap dibuild dengan `Dockerfile` di root. Container aplikasi
mendengarkan pada port `8080` dan menyediakan health check pada `/health`.
`docker-compose.yml` root juga dapat dipakai sebagai resource Docker Compose di
Coolify: file tersebut hanya menjalankan app dan mengambil seluruh environment dari
Coolify, tanpa credential database atau secret default.

## Konfigurasi aplikasi

Di Coolify, buat resource dari GitHub repository ini dengan build method Dockerfile
atau Docker Compose dan exposed port `8080`. Hubungkan ke persistent PostgreSQL
terpisah (jangan memakai `docker-compose.local.yml` untuk production), lalu isi
environment variables berikut di halaman Environment Coolify:

```text
NODE_ENV=production
PORT=8080
COOKIE_SECURE=1
DATABASE_URL=postgres://USER:PASSWORD@POSTGRES_HOST:5432/soenarto
SESSION_SECRET=<random minimal 32 karakter>
BOOTSTRAP_ADMIN_USERNAME=<username admin pertama>
BOOTSTRAP_ADMIN_PASSWORD=<password admin pertama minimal 12 karakter>
CANONICAL_TREE_TITLE=Keluarga Haji Soenarto
PUBLIC_APP_ORIGIN=https://soenarto.fgdev.tech
```

`BOOTSTRAP_ADMIN_*` hanya dipakai saat belum ada admin aktif. Setelah login admin
berhasil dan database sudah persisten, hapus kedua variable bootstrap tersebut dari
environment production. `POSTGRES_DB`, `POSTGRES_USER`, dan `POSTGRES_PASSWORD`
hanya diperlukan untuk override lokal, bukan untuk deployment dengan PostgreSQL
terpisah.

`SESSION_SECRET` harus berbeda dari contoh lokal. Buat secara acak, misalnya dengan
password manager atau generator secret yang tersedia di server.

## Pengaturan environment di Coolify

Untuk semua variable aplikasi di atas, gunakan pengaturan `Available at Runtime`:

- `Available at Buildtime`: **OFF**
- `Available at Runtime`: **ON**

Ini terutama wajib untuk `NODE_ENV`, `DATABASE_URL`, `SESSION_SECRET`, dan kedua
variable bootstrap. Jangan kirim database URL atau secret sebagai build argument
karena build argument dapat masuk ke metadata proses build. Dockerfile sudah memaksa
dependency frontend tetap terpasang walaupun `NODE_ENV=production` terlanjur ikut
terkirim saat build, tetapi checkbox buildtime tetap harus dimatikan untuk menjaga
secret hanya tersedia di runtime.

## Urutan reverse proxy sesuai homelab

1. Set domain Coolify ke `http://soenarto.fgdev.tech`, exposed port aplikasi `8080`,
   lalu deploy/redeploy.
2. Di SafeLine, buat application `soenarto.fgdev.tech` mode Reverse Proxy ke
   upstream Coolify VM seperti aplikasi lain yang sudah berjalan. Jika Coolify
   menerima request melalui proxy pada port 80, upstream SafeLine tetap diarahkan ke
   `http://192.168.18.37` sesuai pola homelab yang ada; port `8080` adalah port
   container di belakang proxy Coolify.
3. Caddy Oracle tetap meneruskan wildcard/catch-all ke SafeLine. Tidak perlu membuat
   DNS Cloudflare baru karena wildcard `*` sudah mencakup subdomain ini.
4. Verifikasi berurutan:

   ```text
   # Coolify VM
   curl -I -H "Host: soenarto.fgdev.tech" http://127.0.0.1

   # SafeLine VM
   curl -I -H "Host: soenarto.fgdev.tech" http://127.0.0.1

   # dari luar jaringan
   curl -I https://soenarto.fgdev.tech
   ```

Pastikan HTTPS sudah aktif pada jalur publik sebelum production digunakan. Dengan
`COOKIE_SECURE=1`, browser hanya mengirim session cookie melalui HTTPS.

Encrypted sharing berjalan di server Soenarto Tree sendiri. Ciphertext share
disimpan di PostgreSQL, sehingga deployment ini tidak membutuhkan Cloud Run,
Firestore, Google Cloud Storage, atau `SHARE_API_ORIGIN` tambahan.

## Uji lokal

```text
copy .env.example .env.local
# Edit .env.local dan ganti semua nilai CHANGE_ME.
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.local.yml ps
```

Buka `http://127.0.0.1:8080`. `docker-compose.local.yml` menambahkan PostgreSQL
lokal dengan volume bernama `soenarto-postgres`; file itu tidak dipakai Coolify.
Smoke test RBAC/BOLA dapat dijalankan dengan:

```text
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.local.yml exec --no-TTY app npm --prefix /app/server run smoke
```

Jangan expose konfigurasi compose lokal ke internet.

## GitHub Actions

Workflow `.github/workflows/docker-ci.yml` berjalan pada pull request dan push ke
`main` yang mengubah Dockerfile, Compose, server, atau web. Workflow tersebut
memvalidasi konfigurasi Compose, membuild image yang sama, menunggu health check,
menguji `/health` dan `/ready`, lalu menjalankan smoke test RBAC/BOLA/CSRF/share
di dalam container. Jika workflow hijau, image sudah melewati parity check dasar
sebelum dipilih sebagai source deployment Coolify.
