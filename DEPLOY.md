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

## ⚠️ Şema değişikliklerinde dikkat

`npm start` → `npx prisma db push && node dist/index.js`. `overlapSeconds` yüzünden yeni ve
eski konteyner **20 sn birlikte çalışır**. Bu sürede şema yeni hâldedir:

- **Ekleyici değişiklik** (yeni nullable kolon, yeni tablo, yeni index) → güvenli. Eski
  konteyner o kolonu bilmez, sorun çıkmaz.
- **Bozucu değişiklik** (kolon silme/yeniden adlandırma, `NOT NULL` ekleme) → eski konteyner
  20 sn boyunca HATA verir. Bunu iki aşamada yap: (1) önce ekle + yaz, deploy et; (2) sonraki
  deploy'da eskiyi kaldır.
- Kolon adını değiştirmek yerine Prisma'da `@map` kullanmak DB'ye hiç dokunmaz — örnek:
  `capacity Int @map("availableSpots")`.

## Doğrulama

Deploy sonrası:

```bash
curl -s https://fitpass-backend-production-e0c9.up.railway.app/health
```

`{"ok":true,...}` beklenir. Deploy sırasında birkaç saniye `{"ok":false,"state":"booting"}`
görmek NORMALDİR — trafiğin hâlâ eski konteynere gittiği anlamına gelir.
