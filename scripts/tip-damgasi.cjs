#!/usr/bin/env node
/*
 * API SÖZLEŞMESİ DAMGA DENETİMİ
 * ============================================================================================
 * `src/types/api.ts` üç repoda da (backend / web / mobil) BİREBİR AYNI olmalıdır. Bu betik
 * dosyanın içeriğinin SHA-256'sını hesaplar ve içindeki TIP_SOZLESMESI_SURUMU damgasıyla
 * karşılaştırır. Uyuşmazsa CI kırılır.
 *
 * NEDEN: kopyalanan her dosya bir sürüklenme kaynağıdır — bunun bedeli ödendi. i18n tarayıcısının
 * iki kopyası bağımsız evrimleşti ve MOBİL CI 11–13 Ağustos arası kırmızı kaldı, kimse fark etmedi.
 * Damga sessiz sürüklenmeyi imkânsız kılar: dosyayı değiştirirsen damgayı da değiştirmek
 * ZORUNDASIN, o da seni ikizleri güncellemeye iter.
 *
 * İKİ KOPYANIN AYNI OLDUĞUNU NASIL BİLİRİZ: damga içeriğin hash'i olduğu için, damgaları eşit
 * olan iki dosya kanıtlanabilir şekilde aynıdır. Karşılaştırmak için damga değerlerine bakmak yeter.
 *
 * Kullanım:  node scripts/tip-damgasi.cjs          → denetle (CI)
 *            node scripts/tip-damgasi.cjs --yaz    → damgayı yeniden hesapla ve dosyaya yaz
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DOSYA = path.join(__dirname, '..', 'src', 'types', 'api.ts')
const DAMGA_SATIRI = /^export const TIP_SOZLESMESI_SURUMU = '([0-9a-f]*)'$/m

function hesapla(ham) {
  // Damga satırının KENDİSİ hesaba katılmaz — aksi halde kendi kendine referans veren
  // bir hash olurdu ve hiçbir zaman sabit noktaya oturmazdı.
  const damgasiz = ham.split('\n').filter((l) => !l.includes('TIP_SOZLESMESI_SURUMU =')).join('\n')
  return crypto.createHash('sha256').update(damgasiz).digest('hex').slice(0, 13)
}

function main() {
  if (!fs.existsSync(DOSYA)) {
    console.error(`❌ API sözleşmesi bulunamadı: ${DOSYA}`)
    process.exit(1)
  }
  const ham = fs.readFileSync(DOSYA, 'utf8')
  const eslesme = ham.match(DAMGA_SATIRI)
  if (!eslesme) {
    console.error(`❌ ${DOSYA} içinde TIP_SOZLESMESI_SURUMU damga satırı yok.`)
    process.exit(1)
  }

  const beklenen = hesapla(ham)
  const mevcut = eslesme[1]

  if (process.argv.includes('--yaz')) {
    // ── DAMGAYI YALNIZ SÖZLEŞME SAHİBİ (backend) YAZABİLİR ────────────────────────────────────
    // Kapı eskiden çapraz-repo KÖRDÜ: her repo kendi dosyasını hash'leyip kendi damgasıyla
    // karşılaştırıyordu. Dolayısıyla web'in api.ts'ine bir alan eklenip `--yaz` çalıştırılınca o
    // repo kendi damgasını TAZELİYOR ve üç kapı da yeşil kalıyordu — üç repo farklı sözleşme
    // taşırken hiçbir şey ötmüyordu. (Kapı kırma deneyi bunu gösterdi: ÜÇ REPODA DA exit 0.)
    // Çözüm cross-repo CI erişimi gerektirmiyor: yazma hakkı tek repoda. İstemciler sözleşmeyi
    // yalnız KOPYALAR; kopya değiştirilirse gömülü damga artık içerikle uyuşmaz ve o reponun
    // kendi `types:check`i kırılır.
    const pkg = path.join(__dirname, '..', 'package.json')
    const ad = JSON.parse(fs.readFileSync(pkg, 'utf8')).name
    if (ad !== 'fitpass') {
      console.error(
        `✗ Damga bu repoda YAZILAMAZ (${ad}).\n\n` +
        `  Sözleşmenin sahibi backend (fitpass). Sıra:\n` +
        `    1) ~/fitpass içinde düzenle ve: node scripts/tip-damgasi.cjs --yaz\n` +
        `    2) src/types/api.ts dosyasını BU repoya olduğu gibi kopyala\n\n` +
        `  Sebep: damga her repoda tazelenebilseydi, sürüklenmiş bir kopya kendi damgasını\n` +
        `  yenileyip yeşil kalırdı — kapı tam da bunu yakalamak için var.`
      )
      process.exit(1)
    }
    if (mevcut === beklenen) {
      console.log(`✓ damga zaten güncel: ${beklenen}`)
      return
    }
    fs.writeFileSync(DOSYA, ham.replace(DAMGA_SATIRI, `export const TIP_SOZLESMESI_SURUMU = '${beklenen}'`))
    console.log(`✓ damga yazıldı: ${mevcut || '(boş)'} → ${beklenen}`)
    console.log(`  ŞİMDİ: bu dosyayı DİĞER İKİ REPOYA da kopyala (backend ↔ web ↔ mobil).`)
    return
  }

  if (mevcut !== beklenen) {
    console.error(
      `\n❌ API sözleşmesi değişmiş ama damgası güncellenmemiş.\n` +
      `   Dosya:    src/types/api.ts\n` +
      `   Mevcut:   ${mevcut || '(boş)'}\n` +
      `   Beklenen: ${beklenen}\n\n` +
      `   YAPILACAK:\n` +
      `     1) node scripts/tip-damgasi.cjs --yaz\n` +
      `     2) src/types/api.ts dosyasını DİĞER İKİ REPOYA olduğu gibi kopyala\n` +
      `        (~/fitpass · ~/fitpass-web · ~/fitpass-mobile)\n\n` +
      `   Sebep: sunucu ile istemciler arasındaki sözleşme tek bir yerde yazılı. Bir repoda\n` +
      `   değişip diğerlerinde değişmezse, uyuşmazlık yine derleyiciden kaçar — bu katmanın\n` +
      `   var olma sebebi tam olarak buydu.\n`
    )
    process.exit(1)
  }

  console.log(`✓ API sözleşmesi damgası doğru: ${beklenen}`)
}

main()
