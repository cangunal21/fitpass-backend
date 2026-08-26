/**
 * 5651 TRAFİK KAYDI — yer sağlayıcı yükümlülüğü.
 *
 * Gizlilik Politikası Bölüm 7 trafik kaydı tuttuğumuzu beyan ediyordu; şemada IP tutan tek bir
 * kolon yoktu. Metin bir şey söylüyor, kod başka bir şey yapıyordu.
 *
 * KAPSAM KARARI: her HTTP isteği loglanmıyor. Yer sağlayıcı trafik bilgisi, YAYIMLANAN İÇERİĞİ
 * kimin ne zaman nereden yayımladığını gösteren kayıttır; her istek loglansaydı hem devasa hem
 * de veri asgariliğine (KVKK m.4) aykırı olurdu. Kaydedilen: içerik yayımlama + kimlik olayları.
 */
import { Request } from 'express'
import prisma from './prisma'

/**
 * 5651: "bir yıldan az, iki yıldan fazla olmamak üzere". Üst sınır seçildi — bir soruşturma
 * talebi çoğunlukla olaydan aylar sonra gelir ve alt sınırda tutmak kaydı işe yaramaz hâle
 * getirebilir. Metin aralığı zaten kullanıcıya bildiriyor.
 */
export const TRAFIK_SAKLAMA_YILI = 2

export type TrafikOlayi = 'icerik_yayin' | 'kayit' | 'giris'
export type TrafikOzne = 'user' | 'venue' | 'instructor'

const izAl = (req: Request) => ({
  // req.ip, index.ts'teki trust proxy=2 ayarına göre gerçek istemciyi verir.
  ipAddress: (req.ip || req.socket?.remoteAddress || '').slice(0, 60) || null,
  userAgent: String(req.get('user-agent') || '').slice(0, 400) || null,
})

/**
 * Trafik kaydı yazar. ATEŞLE-UNUT: kayıt yazılamazsa kullanıcının işlemi BOZULMAZ.
 * Tersi, bir log hatası yüzünden yorumun yayımlanamaması demek olurdu.
 */
export function trafikKaydet(
  req: Request,
  olay: TrafikOlayi,
  detay: {
    ozne?: TrafikOzne
    ozneId?: number | null
    icerikTuru?: string
    icerikId?: number | null
  } = {},
): void {
  const occurredAt = new Date()
  const purgeAfter = new Date(occurredAt)
  purgeAfter.setFullYear(purgeAfter.getFullYear() + TRAFIK_SAKLAMA_YILI)

  prisma.trafikKaydi
    .create({
      data: {
        eventType: olay,
        subjectType: detay.ozne ?? null,
        subjectId: detay.ozneId ?? null,
        contentType: detay.icerikTuru ?? null,
        contentId: detay.icerikId ?? null,
        occurredAt,
        purgeAfter,
        ...izAl(req),
      },
    })
    .catch(e => console.error('[trafik] kayıt yazılamadı', olay, (e as Error).message))
}

/**
 * Hesap silinince ANONİMLEŞTİR, SİLME. Gizlilik 11.3: "5651 sayılı Kanun kapsamındaki trafik
 * kayıtları silinmez; kimliğinizle bağlantısı koparılarak (anonimleştirilerek) ... saklanır."
 * Satırı silmek yükümlülüğü ihlal ederdi; kimliği bırakmak da silme talebini karşılamazdı.
 */
export async function trafikAnonimlestir(
  tx: { trafikKaydi: { updateMany: (a: any) => Promise<{ count: number }> } },
  ozne: TrafikOzne,
  ozneId: number,
): Promise<number> {
  const r = await tx.trafikKaydi.updateMany({
    where: { subjectType: ozne, subjectId: ozneId },
    data: { subjectType: null, subjectId: null },
  })
  return r.count
}

/** Süresi dolan kayıtları imha eder — metin "süre sonunda imha edilir" diyor. */
export async function suresiDolanTrafigiImhaEt(): Promise<number> {
  const r = await prisma.trafikKaydi.deleteMany({ where: { purgeAfter: { lte: new Date() } } })
  return r.count
}
