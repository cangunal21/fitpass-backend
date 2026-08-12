import crypto from 'crypto'
import prisma from './prisma'

/**
 * E-POSTA DOĞRULAMA KODU
 *
 * NEDEN LİNK DEĞİL KOD: doğrulama linki mobilde uygulamadan çıkıp posta kutusuna gitmeyi ve
 * tarayıcıdan geri dönmeyi gerektiriyor; akış orada kopuyor. 6 haneli kod, kayıt ekranını hiç
 * terk etmeden girilir. Kullanıcının kararı (12 Ağu 2026).
 *
 * TASARIM:
 *  • ÖMÜR 15 DAKİKA. Asıl koruma budur; 6 hanelik uzay (1.000.000) küçük olduğu için kodun uzun
 *    yaşaması kaba kuvveti mümkün kılar.
 *  • DENEME SINIRI 5. Sınıra gelen kod ÖLÜR (used=true) — kullanıcı yenisini ister. Böylece
 *    saldırgan tek bir kod için en fazla 5 tahmin yapabilir (1/200.000 şans).
 *  • KOD DB'DE SHA-256 DURUR. Bunun sızan bir yedeğe karşı gerçek koruma OLMADIĞINI biliyoruz
 *    (uzay küçük, saniyeler içinde geri çevrilir); amaç canlı kodun günlüklere/yedeklere düz
 *    metin düşmemesi. Gerçek koruma ömür + deneme sınırı.
 *  • AYNI ANDA TEK GEÇERLİ KOD. Yeni kod üretilince kullanıcının eski kodları kapatılır; yoksa
 *    beş kez "tekrar gönder" diyen birinin beş kodu birden geçerli kalır ve deneme sınırı
 *    kod başına uygulandığı için toplam tahmin hakkı katlanır.
 */

export const KOD_OMRU_DK = 15
export const MAX_DENEME = 5

function hashKod(kod: string): string {
  return crypto.createHash('sha256').update(kod).digest('hex')
}

/** 6 haneli, kriptografik olarak rastgele kod. Math.random KULLANILMAZ (tahmin edilebilir). */
export function kodUret(): string {
  // 0–999999 arası düzgün dağılım: randomInt reddetme örneklemesi yapar (modulo yanlılığı yok).
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Kullanıcı için yeni bir doğrulama kodu üret ve kaydet. HAM kodu döndürür (yalnız e-postaya gider).
 * Eski açık kodlar kapatılır — bkz. "aynı anda tek geçerli kod".
 */
export async function dogrulamaKoduUret(userId: number): Promise<string> {
  const kod = kodUret()
  await prisma.emailVerificationToken.updateMany({ where: { userId, used: false }, data: { used: true } })
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      // `token` link akışından kalma ve @unique; kod akışında kullanılmıyor ama kısıt için dolu olmalı.
      token: crypto.randomBytes(32).toString('hex'),
      code: hashKod(kod),
      expiresAt: new Date(Date.now() + KOD_OMRU_DK * 60 * 1000),
    },
  })
  return kod
}

export type KodSonuc = 'ok' | 'gecersiz' | 'suresi_doldu' | 'deneme_bitti'

/**
 * Kodu doğrula. Doğruysa kullanıcıyı doğrulanmış işaretler ve kodu tüketir.
 * Yanlışsa sayacı artırır; sınıra gelince kodu öldürür.
 */
export async function dogrulamaKoduDogrula(userId: number, kod: string): Promise<KodSonuc> {
  const temiz = String(kod || '').trim()
  if (!/^\d{6}$/.test(temiz)) return 'gecersiz'

  const kayit = await prisma.emailVerificationToken.findFirst({
    where: { userId, used: false, code: { not: null } },
    orderBy: { id: 'desc' },
  })
  if (!kayit) return 'gecersiz'
  if (kayit.expiresAt < new Date()) return 'suresi_doldu'
  if (kayit.attempts >= MAX_DENEME) {
    await prisma.emailVerificationToken.update({ where: { id: kayit.id }, data: { used: true } })
    return 'deneme_bitti'
  }

  // timingSafeEqual: hash karşılaştırmasında zamanlama sızıntısı olmasın (ikisi de 64 hex karakter).
  const beklenen = Buffer.from(kayit.code!, 'utf8')
  const gelen = Buffer.from(hashKod(temiz), 'utf8')
  const dogru = beklenen.length === gelen.length && crypto.timingSafeEqual(beklenen, gelen)

  if (!dogru) {
    const yeni = kayit.attempts + 1
    await prisma.emailVerificationToken.update({
      where: { id: kayit.id },
      data: { attempts: yeni, ...(yeni >= MAX_DENEME ? { used: true } : {}) },
    })
    return yeni >= MAX_DENEME ? 'deneme_bitti' : 'gecersiz'
  }

  // TEK TRANSACTION: kod tüketimi ile doğrulama damgası birlikte olmalı. Ayrı ayrı yazılırsa
  // araya giren bir hata "kod kullanıldı ama kullanıcı doğrulanmadı" durumunu bırakır ve
  // kullanıcı kilitli kalır.
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: kayit.id }, data: { used: true } }),
    prisma.user.update({ where: { id: userId }, data: { isEmailVerified: true } }),
  ])
  return 'ok'
}
