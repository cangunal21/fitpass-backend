// Tek seferlik: saklanan tüm sohbet kayıtlarını (ChatMessage) siler.
// Sohbet artık DB'de saklanmıyor (KVKK özel-nitelikli veri); bu, eski satırları temizler.
// Çalıştırma (prod'a karşı, Railway env'iyle):
//   npx @railway/cli run npx ts-node scripts/purge-chat.ts
import prisma from '../src/utils/prisma'

async function main() {
  const before = await prisma.chatMessage.count()
  const r = await prisma.chatMessage.deleteMany({})
  console.log(`✅ ChatMessage temizlendi — ${r.count} kayıt silindi (öncesi: ${before}).`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error('purge-chat hata:', e); process.exit(1) })
