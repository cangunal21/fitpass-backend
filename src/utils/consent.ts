import { Request } from 'express'
import prisma from './prisma'

/**
 * SÖZLEŞME / AÇIK RIZA ONAY KAYDI
 *
 * KVKK m.5 uyarınca açık rızanın varlığını ispat yükü veri sorumlusundadır. Kayıt ekranında
 * kutu göstermek tek başına ispat değildir: kimin, ne zaman, hangi metin SÜRÜMÜNÜ onayladığı
 * saklanmalıdır. Metnin o günkü içeriği repodan geri getirilebildiği için slug + sürüm yeterli.
 *
 * SÜRÜMÜ SUNUCU BELİRLER, İSTEMCİ DEĞİL. İstemciye güvenilseydi bayat (ya da kötü niyetli)
 * bir arayüz "Taslak 1'i onayladı" diye kaydettirebilir, kullanıcının fiilen gördüğü metinden
 * başka bir metne rıza vermiş gibi görünürdü. İstemcinin iddiası ayrı kolonda (clientVersion)
 * tutulur; ikisi ayrışırsa bunu VERİDEN görebiliriz.
 */

/**
 * Yürürlükteki metin sürümleri.
 *
 * ⚠️ fitpass-web/src/lib/hukuk/belgeler.generated.ts ile AYNI OLMALI. O dosya
 * ~/sipsakspor_*_src.py kaynaklarından `npm run hukuk:uret` ile üretilir; metin
 * güncellenince buradaki sürüm de elle yükseltilmelidir.
 *
 * Sürüm burada yükseltilmezse ne olur: kullanıcı yeni metni görür ama kayda eski sürüm
 * yazılır. Bu, ispat değerini yok eder — bu yüzden smoke testi listeyi denetler.
 */
export const RIZA_BELGELERI = {
  // Üyeliğin önkoşulu olan sözleşmeler
  uyelik: { surum: 'Taslak 11', kind: 'sozlesme' as const, zorunlu: true },
  gizlilik: { surum: 'Taslak 10', kind: 'sozlesme' as const, zorunlu: true },
  // Salon ve eğitmen tarafı
  'salon-araciligi': { surum: 'Taslak 12', kind: 'sozlesme' as const, zorunlu: true },
  'egitmen-aydinlatma': { surum: 'Taslak 2', kind: 'sozlesme' as const, zorunlu: true },
  // 18 YAŞ BEYANI — sözleşme onayından AYRI bir kalem.
  // Gizlilik 11.4: "18 yaşınızı doldurduğunuza ilişkin beyanınız AYRI BİR ONAYLA alınır ve bu
  // beyan tarih-saat bilgisiyle kayıt altında tutulur; Şipşakspor DOĞUM TARİHİ bilgisini bu
  // amacın dışında toplamaz." Bu yüzden yaş/doğum tarihi kolonu YOK: taahhüt edilen şey veri
  // toplamak değil, beyanı damgalamak. Aynı hüküm Üyelik m.3.1 ve Eğitmen Aydınlatma m.3(a)'da.
  // Sözleşme onayıyla aynı kutuya konsaydı "ayrı onay" şartı karşılanmazdı.
  'yas-beyani': { surum: 'v1', kind: 'beyan' as const, zorunlu: true },
  // İsteğe bağlı açık rızalar — verilmemesi üyeliği engellemez
  'acik-riza-ticari-ileti': { surum: 'Taslak 2', kind: 'acik_riza' as const, zorunlu: false },
} as const

export type RizaBelgesi = keyof typeof RIZA_BELGELERI

export const zorunluBelgeler = (ozne: 'user' | 'venue' | 'instructor'): RizaBelgesi[] => {
  // SALON tüzel kişidir: yaş beyanı istenmez. Üye ve eğitmen gerçek kişidir → beyan zorunlu.
  if (ozne === 'venue') return ['salon-araciligi', 'gizlilik']
  if (ozne === 'instructor') return ['egitmen-aydinlatma', 'gizlilik', 'yas-beyani']
  return ['uyelik', 'gizlilik', 'yas-beyani']
}

/** İstemcinin gönderdiği onay gövdesi: { slug: { granted, version? } } */
export type OnayGovdesi = Record<string, { granted?: boolean; version?: string } | boolean | undefined>

const okuOnay = (g: OnayGovdesi | undefined, slug: string) => {
  const v = g?.[slug]
  if (typeof v === 'boolean') return { granted: v, version: undefined }
  return { granted: v?.granted === true, version: typeof v?.version === 'string' ? v.version : undefined }
}

/**
 * Zorunlu sözleşmeler onaylanmış mı? Onaylanmadıysa eksik olanların listesini döner.
 * Kayıt uçları bunu ÖNCE çağırıp 400 vermeli — hesap açıldıktan sonra kontrol etmek,
 * onaysız bir hesabın var olmasına izin vermek demektir.
 */
export function eksikZorunluOnaylar(ozne: 'user' | 'venue' | 'instructor', govde: OnayGovdesi | undefined): RizaBelgesi[] {
  return zorunluBelgeler(ozne).filter(slug => !okuOnay(govde, slug).granted)
}

/** Kullanıcıya dönecek hata metni — HANGİSİ eksikse onu söyler. */
const BELGE_ADI: Record<RizaBelgesi, string> = {
  uyelik: 'Üyelik Sözleşmesi',
  gizlilik: 'Gizlilik Politikası',
  'salon-araciligi': 'Salon Aracılık Sözleşmesi',
  'egitmen-aydinlatma': 'Eğitmen Aydınlatma Metni',
  'yas-beyani': '18 yaş beyanı',
  'acik-riza-ticari-ileti': 'Ticari ileti izni',
}

export function eksikOnayMesaji(eksik: RizaBelgesi[]): string {
  // Sabit metin ("Üyelik Sözleşmesi ve Gizlilik Politikası onaylanmadan…") eksik olan yaş
  // beyanıyken kullanıcıyı YANLIŞ yere bakmaya gönderiyordu: zaten onayladığı sözleşmeyi
  // tekrar onaylamaya çalışıyordu.
  const adlar = eksik.map(e => BELGE_ADI[e] || e)
  const liste = adlar.length > 1 ? `${adlar.slice(0, -1).join(', ')} ve ${adlar[adlar.length - 1]}` : adlar[0]
  return `${liste} onaylanmadan kayıt tamamlanamaz.`
}

const istemciIzi = (req: Request) => ({
  // req.ip, index.ts'teki trust proxy=2 ayarına göre gerçek istemciyi verir.
  ipAddress: (req.ip || req.socket?.remoteAddress || '').slice(0, 60) || null,
  userAgent: String(req.get('user-agent') || '').slice(0, 400) || null,
})

/**
 * Onayları kaydeder. Kayıt akışını ASLA bozmaz: burada hata olursa hesap açılmış ama
 * onay kaydı düşmemiş olur ve bunu log'dan görürüz — tersi (onay kaydı yüzünden kaydın
 * başarısız olması) kullanıcıyı hesapsız bırakırdı.
 */
export async function onaylariKaydet(
  req: Request,
  ozne: 'user' | 'venue' | 'instructor',
  ozneId: number,
  govde: OnayGovdesi | undefined,
): Promise<void> {
  const iz = istemciIzi(req)
  // Bu özneyi ilgilendiren belgeler: kendi zorunlu sözleşmeleri + tüm isteğe bağlı rızalar.
  // Tüm katalog üzerinde dönülseydi, bir ÜYE kaydında salon ve eğitmen sözleşmeleri için de
  // satır yazılırdı — üyenin hiç görmediği bir sözleşmeyi onaylamış gibi görünürdü.
  const kendiZorunlulari = new Set<string>(zorunluBelgeler(ozne))
  const ilgili = (Object.keys(RIZA_BELGELERI) as RizaBelgesi[])
    .filter(slug => kendiZorunlulari.has(slug) || !RIZA_BELGELERI[slug].zorunlu)

  const satirlar = ilgili
    .map(slug => {
      const tanim = RIZA_BELGELERI[slug]
      const { granted, version } = okuOnay(govde, slug)
      // Zorunlu sözleşmeler bu noktada zaten doğrulandı. İsteğe bağlı rızalar yalnızca
      // VERİLDİYSE yazılır: "hayır" cevabı bir rıza kaydı değildir.
      const yaz = kendiZorunlulari.has(slug) ? true : granted
      if (!yaz) return null
      return {
        subjectType: ozne,
        subjectId: ozneId,
        docSlug: slug,
        docVersion: tanim.surum,
        clientVersion: version && version !== tanim.surum ? version : null,
        kind: tanim.kind,
        granted,
        ...iz,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  if (!satirlar.length) return
  try {
    await prisma.consentRecord.createMany({ data: satirlar })
  } catch (e) {
    console.error('[consent] onay kaydı yazılamadı', { ozne, ozneId, hata: (e as Error).message })
  }
}
