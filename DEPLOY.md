# Deploy — sıfır kesinti

`main`'e push → Railway otomatik deploy. Aşağıdaki ayarlar **her deploy'da kısa kesinti**
sorununu çözer (ölçülmüştü: `/health/ready` deploy sırasında ~30 sn `502 Application failed
to respond` dönüyordu).

## Neden kesinti oluyordu

1. **`healthcheckPath` tanımlı değildi.** Railway yeni konteyneri ayağa kaldırır kaldırmaz
   trafiği ona döndürüyordu. Ama sunucu `app.listen` geri çağrısında hâlâ açılış işleri
   yapıyor (özellikle `ensureIndexes` — rozet çift-veriş korumasının dayandığı tekillik
   index'leri). Yani "port açık" ≠ "hazır".
2. **`SIGTERM` işleyicisi yoktu.** Eski konteyner sinyali alınca Node süreci anında ölüyor,
   o an işlenen her istek (rezervasyon, check-in) yarıda kalıyordu.

## Çözüm — üç parça birlikte çalışır

**1) `railway.json`**

| alan | değer | ne işe yarıyor |
|---|---|---|
| `healthcheckPath` | `/health` | Yeni konteynere trafik, bu uç 200 dönene kadar YÖNLENDİRİLMEZ |
| `healthcheckTimeout` | 180 sn | Açılış işleri + `prisma db push` için üst sınır |
| `overlapSeconds` | 20 sn | Eski konteyner, yenisi hazır olduktan sonra 20 sn daha çalışır |
| `drainingSeconds` | 25 sn | `SIGTERM` → `SIGKILL` arası süre |
| `restartPolicyType` | `ON_FAILURE` | Çöken konteyner 3 kez yeniden denenir |

**2) Hazır-olma sinyali (`src/index.ts`)**
`/health`, `bootTamam` bayrağına bakar. Açılış işleri bitene kadar `503 {state:"booting"}`
döner. Açılışta hata olursa bayrak set edilmez → healthcheck geçmez → **Railway eski sürümü
ayakta tutar**. Bozuk bir sürüme trafik dönmesindense deploy'un geri alınması yeğdir.

**3) Graceful shutdown (`src/index.ts`)**
`SIGTERM` sırası: sağlıksız işaretle → 3 sn bekle (yönlendirici `/health`'i 503 görüp trafiği
kessin) → yeni bağlantıları kapat → uçan istekleri bitir → Prisma havuzunu kapat → `exit(0)`.
Takılırsa 12 sn sonra zorla çıkar. Toplam süre `drainingSeconds`ten (25 sn) kısadır; aksi
halde `SIGKILL` yeriz.

Regresyon testi: smoke → *"Deploy: /health hazır-olma sinyali verir ve SIGTERM'de temiz
kapanır"*. Ayrı portta sunucu açar, sağlıklı olmasını bekler, `SIGTERM` yollar, drenaj
penceresinde 503 gördüğünü ve sürecin **kod 0** ile kapandığını doğrular.

## Şema değişiklikleri — `db push` DEĞİL, migration

### Neden değişti

`npm start` eskiden her açılışta `npx prisma db push` çalıştırıyordu. Yerelde ölçüldü:
şemadan bir kolon silindiğinde `db push` **7 satırlık tablodan o kolonu SESSİZCE düşürdü** —
uyarı yok, onay yok, **çıkış kodu 0**. Yani şemaya yanlışlıkla dokunan biri, bir sonraki
deploy'da üretim verisini kalıcı kaybedebiliyordu. `db push` bir prototipleme aracıdır;
sürüm geçmişi, gözden geçirme ve geri alma imkânı yoktur.

Artık: `railway.json → preDeployCommand: node scripts/db-deploy.cjs`

### Yeni bir şema değişikliği nasıl yapılır

```bash
npm run db:migrate
```

`prisma migrate dev` şemayı DB'ye uygular **ve** `prisma/migrations/<zaman>_<ad>/migration.sql`
dosyasını üretir. Bu dosya git'e girer: ne çalıştığı gözle görülür, geçmişte kalır.

### Deploy'da ne oluyor (`scripts/db-deploy.cjs`)

1. **Yıkıcı SQL kapısı** — bekleyen migration'larda `DROP TABLE/COLUMN`, `RENAME`,
   `SET NOT NULL`, `DROP CONSTRAINT`, `TRUNCATE` varsa **deploy DURUR**. (Yorum satırındaki
   kelimeler sayılmaz.)
2. **İlk geçiş (baseline)** — DB'de tablolar var ama migration geçmişi yoksa `0_init`
   *çalıştırılmadan* "uygulanmış" işaretlenir. Otomatiktir, elle bir şey yapman gerekmez.
3. `prisma migrate deploy` — yalnız bekleyenleri uygular.

Kapıya takılırsan hata mesajı ne yapman gerektiğini yazar. Özet:

- **Kolon ADI değiştiriyorsan DB'ye hiç dokunma:** Prisma'da `@map` kullan —
  `capacity Int @map("availableSpots")`. Kolon yerinde kalır, hiçbir risk yok.
- **Gerçekten silmen gerekiyorsa iki aşamada yap:** (1) bu deploy'da yeni alanı ekle, kod iki
  alanı da yazsın; (2) sonraki deploy'da eskiyi kaldıran migration'ı yaz.
- **Bilinçli ve güvenliyse** migration dosyasının başına gerekçesini yaz:
  `-- ALLOW-DESTRUCTIVE: veri yeni alana taşındı, eski alan artık okunmuyor`

Bu neden önemli: `overlapSeconds=20` yüzünden yeni ve eski konteyner 20 sn **birlikte**
çalışır. Ekleyici değişiklik güvenlidir (eski konteyner yeni kolonu bilmez, umursamaz);
bir kolon o anda kaybolursa eski konteyner 20 sn hata verir ve veri kaybı geri alınamaz.

Regresyon testi: smoke → *"Şema: yıkıcı migration SQL'i deploy kapısına takılır"*. Kapının
desenlerini, yanlış-alarm vermediğini, `ALLOW-DESTRUCTIVE` çıkışını ve `npm start`'ta
`db push` kalmadığını doğrular.

## Doğrulama

Deploy sonrası:

```bash
curl -s https://fitpass-backend-production-e0c9.up.railway.app/health
```

`{"ok":true,...}` beklenir. Deploy sırasında birkaç saniye `{"ok":false,"state":"booting"}`
görmek NORMALDİR — trafiğin hâlâ eski konteynere gittiği anlamına gelir.
