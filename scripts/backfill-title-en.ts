/**
 * Class.titleEn GERİYE DÖNÜK DOLDURMA
 *
 * NEDEN VAR: `titleEn` yalnızca addClass/updateClass sırasında üretiliyor (Groq, utils/translate.ts).
 * Bu alan eklenmeden ÖNCE oluşturulmuş dersler ile çeviri o an başarısız olan dersler (Groq timeout/
 * anahtar yok → translateClassTitle null döner, ders yine oluşur) kalıcı olarak titleEn'siz kalıyordu.
 * Sonuç: İngilizce arayüzdeki kullanıcı o derslerin başlığını TÜRKÇE görüyor.
 * Hafızada "çalıştırılmamış backfill script'i" diye bir kayıt vardı — ÖYLE BİR SCRIPT HİÇ YOKTU;
 * bu dosya o boşluğu kapatıyor.
 *
 * KULLANIM:
 *   npm run backfill:titleen           → doldur
 *   npm run backfill:titleen -- --dry  → yalnız raporla, HİÇBİR ŞEY YAZMA
 *
 * GÜVENLİ: yalnız titleEn'i BOŞ olan satırlara yazar (idempotent, tekrar çalıştırılabilir);
 * başlıkları asla değiştirmez. Çeviri başarısız olursa o dersi ATLAR (bir sonraki koşuda denenir).
 *
 * NOT (13 Ağu 2026): gündelik onarım artık `src/jobs/translationJob.ts` işinde — sunucu 30
 * dakikada bir eksikleri kendi kapatıyor (titleEn + bioEn + specialtyEn). Bu script TOPLU
 * göç için duruyor: binlerce eksik kayıt varsa işin küçük turlarını beklemek anlamsız, ve
 * burada kuru çalışma + satır satır rapor var. İkisi çakışmaz (ikisi de yalnız BOŞ alana yazar).
 */
import 'dotenv/config'
import prisma from '../src/utils/prisma'
import { translateClassTitle } from '../src/utils/translate'

const DRY = process.argv.includes('--dry')
// Groq'u dövmemek için küçük bir ara (rate limit + adil kullanım).
const DELAY_MS = 250

async function main() {
  // Hedefi göster: bu script PROD'a karşı çalıştırılmak İÇİN var (test harness'lerinden farklı),
  // ama operatör nereye yazdığını görmeli.
  const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname } catch { return '?' } })()
  console.log(`\n📚 titleEn backfill — hedef veritabanı: ${host}${DRY ? '  (KURU ÇALIŞMA — yazma yok)' : ''}`)

  if (!process.env.GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY yok — çeviri yapılamaz. .env / Railway değişkenlerini kontrol et.')
    process.exit(1)
  }

  const missing = await prisma.class.findMany({
    where: { OR: [{ titleEn: null }, { titleEn: '' }] },
    select: { id: true, title: true },
    orderBy: { id: 'asc' },
  })

  if (missing.length === 0) {
    console.log('✅ Eksik titleEn yok — yapılacak bir şey yok.\n')
    return
  }
  console.log(`   ${missing.length} dersin İngilizce başlığı eksik.\n`)

  let ok = 0, skipped = 0
  for (const c of missing) {
    const en = await translateClassTitle(c.title)
    if (!en) {
      skipped++
      console.log(`   ⏭  #${c.id} "${c.title}" — çeviri alınamadı (sonraki koşuda tekrar denenecek)`)
    } else if (DRY) {
      ok++
      console.log(`   ○  #${c.id} "${c.title}" → "${en}"  (yazılmadı)`)
    } else {
      await prisma.class.update({ where: { id: c.id }, data: { titleEn: en } })
      ok++
      console.log(`   ✓  #${c.id} "${c.title}" → "${en}"`)
    }
    if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS))
  }

  console.log(`\n${DRY ? 'KURU ÇALIŞMA' : 'TAMAM'}: ${ok} çevrildi, ${skipped} atlandı (toplam ${missing.length}).`)
  if (skipped > 0) console.log('   Atlananlar için script tekrar çalıştırılabilir (idempotent).\n')
}

main()
  .catch(e => { console.error('backfill hatası:', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
