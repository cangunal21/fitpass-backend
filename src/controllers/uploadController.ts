import { Request, Response } from 'express'

/**
 * İMZALI YÜKLEME (bağımsız denetim bulgusu)
 *
 * ESKİDEN: istemci, Cloudinary'ye DOĞRUDAN "imzasız" (unsigned) yükleme yapıyordu. Bunun için
 * gereken tek şey `upload_preset` adıydı ve o ad — hesap adıyla birlikte — JavaScript paketinin
 * içindeydi. Yani sayfa kaynağını açan herkes, kimlik doğrulaması OLMADAN hesaba dosya
 * yükleyebiliyordu. İstek sunucumuza hiç uğramadığı için koyduğumuz rate limit'lerin de
 * HİÇBİRİ devreye girmiyordu. İki somut zarar: depolama/bant genişliği kotasının tüketilmesi
 * (faturalı) ve marka adresi altında istenmeyen içerik barındırılması.
 *
 * ŞİMDİ: istemci önce BU UCA gelir. Uç, isteği yapanın gerçekten giriş yapmış olduğunu
 * (authMiddleware / venueAuth / instructorAuth) doğrular ve yalnızca o zaman bir imza üretir.
 * Cloudinary imzasız yüklemeyi artık kabul etmez → anonim yükleme imkânsız.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SDK TEPEDE DEĞİL, İSTEK ANINDA YÜKLENİR — ve bu bir üslup tercihi değil, YAŞANMIŞ bir olay.
 *
 * `import { v2 } from 'cloudinary'` satırı modül yüklenirken CLOUDINARY_URL'i ayrıştırıyor ve
 * değer bozuksa `TypeError: Invalid URL` FIRLATIYOR. Bu import zinciri routes → index.ts'e
 * kadar gittiği için, tek bir yanlış ortam değişkeni SUNUCUYU HİÇ AÇILMAZ hâle getirdi:
 * üretimde deploy "failed" oldu, rezervasyondan girişe kadar her şey o değişken yüzünden
 * ayakta kalamayacaktı. Görsel yükleme İSTEĞE BAĞLI bir özellik; yapılandırması bozuk diye
 * platformun tamamı düşmemeli.
 *
 * Artık SDK yalnızca istek geldiğinde ve try/catch içinde yükleniyor: yapılandırma bozuksa
 * SADECE bu uç 503 döner, geri kalan her şey çalışmaya devam eder.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * GİZLİ ANAHTAR YALNIZ SUNUCUDA: CLOUDINARY_URL ortam değişkeninden okunur, hiçbir yanıtta
 * dönmez. İstemciye yalnızca api_key (zaten herkese açık bir tanımlayıcı), timestamp ve imza
 * gider — bu üçlü tek bir yükleme için ve kısa süreliğine geçerlidir.
 *
 * KLASÖR HESABA BAĞLI: imza `folder` parametresini de kapsar ve klasörü SUNUCU belirler.
 * İstemci başka bir klasör yazarsa imza tutmaz. Böylece bir salon, başka bir salonun klasörüne
 * dosya bırakamaz ve bir sorun çıktığında hangi hesabın yüklediği belli olur.
 */

type CloudinaryYapilandirma = { cloudName: string; apiKey: string; apiSecret: string }

/**
 * CLOUDINARY_URL biçimi: cloudinary://<api_key>:<api_secret>@<cloud_name>
 *
 * KENDİMİZ AYRIŞTIRIYORUZ ki bozuk değeri SDK'dan ÖNCE yakalayalım ve anlaşılır bir şey
 * loglayalım. Gerçekte yaşanan hata `TypeError: Invalid URL` idi ve hangi değişkenden
 * geldiğini söylemiyordu — operatörün saatini yiyen tam olarak buydu.
 */
function yapilandirmaOku(): CloudinaryYapilandirma | null {
  const ham = process.env.CLOUDINARY_URL
  if (ham) {
    const m = /^cloudinary:\/\/([^:@/<>\s]+):([^@/<>\s]+)@([^/<>\s]+)$/.exec(ham.trim())
    if (!m) {
      // Değerin KENDİSİNİ loglamıyoruz (gizli anahtar içerir); yalnız neyin yanlış olduğunu.
      console.error(
        'CLOUDINARY_URL biçimi geçersiz. Beklenen: cloudinary://<api_key>:<api_secret>@<cloud_name> ' +
        '— köşeli parantezler ŞABLON; gerçek değerlerle değiştirilmiş olmalı.'
      )
      return null
    }
    return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] }
  }
  // Ayrı ayrı verilmişse o da kabul (Railway'de üç değişken tercih edilirse).
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    return { cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, apiSecret: CLOUDINARY_API_SECRET }
  }
  return null
}

/** İstekte bulunanın kim olduğu → yükleme klasörü. Klasörü İSTEMCİ SEÇEMEZ. */
function klasorVe(req: Request): { folder: string } | null {
  const userId = (req as any).userId
  const venueId = (req as any).venueId
  const instructorId = (req as any).instructorId
  if (venueId) return { folder: `sipsakspor/venues/${venueId}` }
  if (instructorId) return { folder: `sipsakspor/instructors/${instructorId}` }
  if (userId) return { folder: `sipsakspor/users/${userId}` }
  return null
}

export const getUploadSignature = async (req: Request, res: Response) => {
  try {
    const yap = yapilandirmaOku()
    if (!yap) {
      // Açıkça söyle: sessizce imzasız akışa düşmek, kapatmaya çalıştığımız açığı geri açardı.
      return res.status(503).json({ error: 'Görsel yükleme şu anda kullanılamıyor.' })
    }

    const hedef = klasorVe(req)
    if (!hedef) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor.' })

    // Cloudinary imzayı zaman damgasıyla birlikte doğrular ve eski damgaları reddeder;
    // yani üretilen imza sınırsız süre kullanılabilir bir yetki değildir.
    const timestamp = Math.round(Date.now() / 1000)

    // GEÇ YÜKLEME (bkz. dosya başındaki uzun not): bozuk yapılandırma sunucuyu düşürmesin.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { v2: cloudinary } = require('cloudinary')
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder: hedef.folder },
      yap.apiSecret, // yalnızca imzalamak için okunur; hiçbir yanıtta dönmez
    )

    return res.json({
      signature,
      timestamp,
      folder: hedef.folder,
      apiKey: yap.apiKey,
      cloudName: yap.cloudName,
    })
  } catch (err) {
    console.error('getUploadSignature error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
