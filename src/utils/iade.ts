/**
 * İPTAL PENCERESİ VE İADE ORANI — tek tanım.
 *
 * Kural, İptal ve İade Politikası Madde 3'te yazılı:
 *   24 saat ve üzeri → tam iade
 *   12–24 saat arası → yarım iade
 *   12 saatten az    → iade yok (ama iptal YAPILABİLİR, kontenjan serbest kalır — m.3.3)
 *   başlamış         → iptal edilemez, gelmeme (no-show) sayılır
 *
 * NEDEN AYRI DOSYA: bu merdiven ders iptalinde satır içi yazılmıştı. Drop-in çıkışı da aynı
 * kurala tabi (Politika m.3.4) ve oraya KOPYALANSAYDI iki kopya kaçınılmaz olarak ayrışırdı —
 * bu oturumda tam bu sınıftan üç hata bulundu (kupon metni, asistan promptu, satıcı bildirimi).
 * Politika değişince değişecek tek yer burasıdır.
 */

export type IadeTuru = 'full' | 'half' | 'none'

export const TAM_IADE_SAATI = 24
export const YARIM_IADE_SAATI = 12

const kurus = (x: number) => Math.round(x * 100) / 100

export type IadeSonucu = {
  /** Başlamış etkinlik: iptal edilemez. */
  gecKaldi: boolean
  tur: IadeTuru
  tutar: number
  kalanSaat: number
}

/**
 * @param baslangic  Seansın/etkinliğin başlangıç zamanı
 * @param tutar      İade hesabının uygulanacağı bedel
 * @param pencereMuaf Satıcı erteledi/değiştirdi → pencere kuralı UYGULANMAZ, iade tamdır.
 *                    Kullanıcı bu saati seçmedi; geç kalmak onun kusuru değil.
 */
export function iadeHesapla(
  baslangic: Date | string | null | undefined,
  tutar: number | null | undefined,
  pencereMuaf = false,
): IadeSonucu {
  // Başlangıcı bilinmeyen kayıt cezalandırılmaz: 999 saat = tam iade tarafı.
  const kalanSaat = baslangic ? (new Date(baslangic).getTime() - Date.now()) / 3600000 : 999
  const yuvarlak = Math.round(kalanSaat * 10) / 10

  if (kalanSaat <= 0) return { gecKaldi: true, tur: 'none', tutar: 0, kalanSaat: yuvarlak }

  const tur: IadeTuru =
    pencereMuaf || kalanSaat >= TAM_IADE_SAATI ? 'full' : kalanSaat >= YARIM_IADE_SAATI ? 'half' : 'none'

  const bedel = tutar || 0
  const iade = tur === 'full' ? bedel : tur === 'half' ? kurus(bedel / 2) : 0

  return { gecKaldi: false, tur, tutar: iade, kalanSaat: yuvarlak }
}
