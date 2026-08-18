import prisma from '../utils/prisma'
import { translateClassTitle, translateInstructorBio, translateSpecialty } from '../utils/translate'

/**
 * EKSİK ÇEVİRİ TAMAMLAMA İŞİ
 *
 * NEDEN VAR: İngilizce alanlar (`titleEn`, `bioEn`, `specialtyEn`) yalnızca kayıt OLUŞTURULURKEN
 * bir kez üretiliyor ve `utils/translate.ts` 6 saniyede yanıt alamazsa `null` dönüyor — bilerek,
 * çünkü tamamen kozmetik bir çeviri için salonun ders eklemesini bloke etmek daha kötü. Ama
 * bunun bedeli şuydu: o tek denemede Groq yavaşladıysa ya da anahtarın kotası dolduysa
 * (denetimde çıkan bir senaryo) alan KALICI OLARAK boş kalıyor, bir daha hiç denenmiyor ve
 * kimse fark etmiyordu. Sonuç: İngilizce arayüzde Türkçe ders adı görünmesi.
 *
 * Bu iş sistemi KENDİ KENDİNİ ONARIR hâle getiriyor: eksik kalanları periyodik olarak toplayıp
 * yeniden deniyor. Geçici bir Groq arızası artık kalıcı bir kusura dönüşmüyor.
 *
 * `scripts/backfill-title-en.ts` İLE İLİŞKİSİ — ikisi de gerekli, işleri farklı:
 *   • BU İŞ: sürekli ve otomatik, tur başına birkaç kayıt. Normal işleyişte biriken tek tük
 *     eksiği kimse uğraşmadan kapatır. Yalnız titleEn değil bioEn/specialtyEn'i de kapsar.
 *   • SCRIPT: operatörün elle çalıştırdığı TEK SEFERLİK toplu doldurma; kuru çalışma (--dry),
 *     hedef veritabanını ekrana basma ve satır satır rapor sunar. Binlerce eksik kayıt varsa
 *     (örneğin alan sonradan eklendiğinde) bu işin 30 dakikalık turlarını beklemek anlamsız.
 * Kısacası: gündelik onarım burada, toplu göç script'te.
 *
 * TASARIM:
 *  • TUR BAŞINA KÜÇÜK PARTİ. Groq'un hız sınırı var ve bu iş acil değil; her turda birkaç kayıt
 *    yeter. Kuyruk normalde zaten sıfıra yakın olur.
 *  • ANAHTAR YOKSA HİÇ KOŞMA. GROQ_API_KEY tanımsızken translate* zaten null döner; boşuna
 *    sorgu açıp her turda log kirletmenin anlamı yok.
 *  • ISRARLA BAŞARISIZ OLANI GÖRÜNÜR KIL. Bir kayıt uzun süredir çevrilemiyorsa bu sessiz
 *    kalmamalı — sorun Groq tarafındadır ve operatörün bilmesi gerekir.
 *  • HATA TÜM TURU DÜŞÜRMESİN: tek bir kaydın çevirisi patlarsa diğerleri denenmeye devam eder.
 */

const PARTI = 5                 // tur başına kayıt (tür başına)
const ESKI_SAYILIR_SAAT = 24    // bundan eski ve hâlâ çevrilmemişse uyar

export async function fillMissingTranslations(): Promise<number> {
  if (!process.env.GROQ_API_KEY) return 0

  let doldurulan = 0
  const esik = new Date(Date.now() - ESKI_SAYILIR_SAAT * 3600_000)

  try {
    // ── Ders başlıkları ────────────────────────────────────────────────────────────
    // EN YENİDEN BAŞLA (id DESC) — bu bir tercih değil, testin yakaladığı bir hatanın düzeltmesi.
    // Önce "en eski" sırasıyla yazılmıştı; o hâlde ISRARLA ÇEVRİLEMEYEN birkaç eski kayıt partiyi
    // her turda doldurup YENİ derslerin sırasına hiç gelmemesine yol açıyordu — yani tam da
    // önlemek için yazdığımız kusur, kalıcı hâle geliyordu. Yeniden eskiye gidince: yeni kayıt
    // hemen çevrilir, takılmış eskiler ise başka iş kalmadığında denenmeye devam eder (ve
    // aşağıdaki uyarı onları görünür kılar).
    const dersler = await prisma.class.findMany({
      where: { titleEn: null, title: { not: '' } },
      select: { id: true, title: true, createdAt: true },
      orderBy: { id: 'desc' }, // bkz. ders başlıkları — takılmış eski kayıt yenileri engellemesin
      take: PARTI,
    })
    for (const d of dersler) {
      try {
        const en = await translateClassTitle(d.title)
        if (en) {
          await prisma.class.update({ where: { id: d.id }, data: { titleEn: en } })
          doldurulan++
        } else if (d.createdAt < esik) {
          console.warn(`[çeviri] ders #${d.id} ${ESKI_SAYILIR_SAAT} saattir çevrilemiyor — Groq anahtarı/kotası kontrol edilmeli`)
        }
      } catch (e) {
        console.error(`[çeviri] ders #${d.id} başarısız:`, e)
      }
    }

    // ── Eğitmen biyografisi ────────────────────────────────────────────────────────
    const bios = await prisma.instructor.findMany({
      where: { bioEn: null, bio: { not: null }, NOT: { bio: '' } },
      select: { id: true, bio: true, createdAt: true },
      orderBy: { id: 'desc' }, // bkz. ders başlıkları — takılmış eski kayıt yenileri engellemesin
      take: PARTI,
    })
    for (const i of bios) {
      try {
        const en = await translateInstructorBio(i.bio!)
        if (en) {
          await prisma.instructor.update({ where: { id: i.id }, data: { bioEn: en } })
          doldurulan++
        } else if (i.createdAt < esik) {
          console.warn(`[çeviri] eğitmen #${i.id} bio ${ESKI_SAYILIR_SAAT} saattir çevrilemiyor`)
        }
      } catch (e) {
        console.error(`[çeviri] eğitmen #${i.id} bio başarısız:`, e)
      }
    }

    // ── Eğitmen uzmanlığı ──────────────────────────────────────────────────────────
    const uzmanliklar = await prisma.instructor.findMany({
      where: { specialtyEn: null, specialty: { not: null }, NOT: { specialty: '' } },
      select: { id: true, specialty: true, createdAt: true },
      orderBy: { id: 'desc' }, // bkz. ders başlıkları — takılmış eski kayıt yenileri engellemesin
      take: PARTI,
    })
    for (const i of uzmanliklar) {
      try {
        const en = await translateSpecialty(i.specialty!)
        if (en) {
          await prisma.instructor.update({ where: { id: i.id }, data: { specialtyEn: en } })
          doldurulan++
        } else if (i.createdAt < esik) {
          console.warn(`[çeviri] eğitmen #${i.id} uzmanlık ${ESKI_SAYILIR_SAAT} saattir çevrilemiyor`)
        }
      } catch (e) {
        console.error(`[çeviri] eğitmen #${i.id} uzmanlık başarısız:`, e)
      }
    }

    if (doldurulan > 0) console.log(`🌐 Çeviri tamamlama: ${doldurulan} eksik alan dolduruldu.`)
    return doldurulan
  } catch (err) {
    console.error('Çeviri tamamlama işi hatası:', err)
    return doldurulan
  }
}
