import { Request, Response } from 'express'
import { v2 as cloudinary } from 'cloudinary'

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
 * GİZLİ ANAHTAR YALNIZ SUNUCUDA: CLOUDINARY_URL ortam değişkeninden okunur, hiçbir yanıtta
 * dönmez. İstemciye yalnızca api_key (zaten herkese açık bir tanımlayıcı), timestamp ve imza
 * gider — bu üçlü tek bir yükleme için ve kısa süreliğine geçerlidir.
 *
 * KLASÖR HESABA BAĞLI: imza `folder` parametresini de kapsar ve klasörü SUNUCU belirler.
 * İstemci başka bir klasör yazarsa imza tutmaz. Böylece bir salon, başka bir salonun klasörüne
 * dosya bırakamaz ve bir sorun çıktığında hangi hesabın yüklediği belli olur.
 *
 * NEDEN RESMİ SDK: imza, parametrelerin sıralanıp gizli anahtarla özetlenmesiyle üretiliyor.
 * Elle yazmak on satır tutar ama tek karakterlik bir fark tüm yüklemeleri bozar ve gizli anahtar
 * yalnız üretimde bulunduğu için burada uçtan uca doğrulanamaz. Doğruluk, bağımlılık
 * sayısından önemli.
 */

// CLOUDINARY_URL biçimi: cloudinary://<api_key>:<api_secret>@<cloud_name>
// SDK bunu kendi okur; burada yalnız "yapılandırılmış mı" sorusunu yanıtlayacak kadar ayrıştırıyoruz.
function yapilandirmaVar(): boolean {
  return !!process.env.CLOUDINARY_URL || !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
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
    if (!yapilandirmaVar()) {
      // Açıkça söyle: sessizce imzasız akışa düşmek, kapatmaya çalıştığımız açığı geri açardı.
      console.error('CLOUDINARY_URL tanımsız — imzalı yükleme kapalı.')
      return res.status(503).json({ error: 'Görsel yükleme şu anda kullanılamıyor.' })
    }

    const hedef = klasorVe(req)
    if (!hedef) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor.' })

    // Cloudinary imzayı zaman damgasıyla birlikte doğrular ve eski damgaları reddeder;
    // yani üretilen imza sınırsız süre kullanılabilir bir yetki değildir.
    const timestamp = Math.round(Date.now() / 1000)
    const imzalanan = { timestamp, folder: hedef.folder }

    const signature = cloudinary.utils.api_sign_request(
      imzalanan,
      // Yalnızca imzalamak için okunur; hiçbir yanıtta dönmez.
      (cloudinary.config().api_secret as string) || process.env.CLOUDINARY_API_SECRET || ''
    )

    return res.json({
      signature,
      timestamp,
      folder: hedef.folder,
      apiKey: cloudinary.config().api_key || process.env.CLOUDINARY_API_KEY,
      cloudName: cloudinary.config().cloud_name || process.env.CLOUDINARY_CLOUD_NAME,
    })
  } catch (err) {
    console.error('getUploadSignature error:', err)
    return res.status(500).json({ error: 'Sunucu hatası.' })
  }
}
