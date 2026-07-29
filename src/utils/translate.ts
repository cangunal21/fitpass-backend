import Groq from 'groq-sdk'

let client: Groq | null = null
// TIMEOUT + maxRetries ZORUNLU: bu çeviriler ders/eğitmen OLUŞTURMADAN ÖNCE await ediliyor.
// Varsayılan SDK ayarlarıyla (uzun timeout + 2 yeniden deneme) yavaşlayan Groq, tamamen KOZMETİK
// bir İngilizce başlık için salonun ders eklemesini dakikalarca bloke edebiliyordu.
// 6 saniyede dönmezse çeviriden vazgeç (null) — ders yine oluşur, titleEn sonra doldurulabilir.
const getClient = () => {
  if (!client) client = new Groq({ apiKey: process.env.GROQ_API_KEY || 'dummy', timeout: 6000, maxRetries: 0 })
  return client
}

// Türkçe ders başlığını doğru İngilizce spor terimine çevirir (düz çeviri değil,
// gerçek karşılık: "Güç Yogası" -> "Power Yoga"). Hata/anahtar yoksa null döner.
export async function translateClassTitle(title: string): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) return null
  const clean = (title || '').trim()
  if (!clean) return null
  try {
    const res = await getClient().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      max_tokens: 30,
      messages: [
        {
          role: 'system',
          content:
            'You translate Turkish fitness/sports class titles into their correct, natural English equivalent (the real term a native speaker would use, not a literal word-for-word translation). Examples: "Güç Yogası" -> "Power Yoga", "Sabah Pilatesi" -> "Morning Pilates", "Yeni Başlayanlar Boks" -> "Beginner Boxing", "Halı Saha Maçı" -> "Football Match". Reply with ONLY the English title, no quotes, no explanation.',
        },
        { role: 'user', content: clean },
      ],
    })
    const out = res.choices?.[0]?.message?.content?.trim()
    if (!out) return null
    // tek satır, makul uzunluk
    return out.split('\n')[0].slice(0, 120)
  } catch (e) {
    console.error('translateClassTitle error:', e)
    return null
  }
}

// Türkçe eğitmen biyografisini doğal İngilizce'ye çevirir (akıcı, anlam-odaklı).
export async function translateInstructorBio(bio: string): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) return null
  const clean = (bio || '').trim()
  if (!clean) return null
  try {
    const res = await getClient().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: 'system', content: 'You translate a Turkish fitness instructor bio into natural, fluent English. Keep it concise and professional, same meaning. Reply with ONLY the English translation, no quotes, no notes.' },
        { role: 'user', content: clean },
      ],
    })
    const out = res.choices?.[0]?.message?.content?.trim()
    return out ? out.slice(0, 600) : null
  } catch (e) {
    console.error('translateInstructorBio error:', e)
    return null
  }
}

// Uzmanlık alanını İngilizce'ye çevirir ("Boks · Kickboks" -> "Boxing · Kickboxing").
export async function translateSpecialty(specialty: string): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) return null
  const clean = (specialty || '').trim()
  if (!clean) return null
  try {
    const res = await getClient().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: 'system', content: 'Translate Turkish sports/fitness specialty terms to natural English, keeping the same separators. Examples: "Boks · Kickboks · MMA" -> "Boxing · Kickboxing · MMA", "Reformer · Rehabilitasyon Pilates" -> "Reformer · Rehabilitation Pilates". Reply with ONLY the English text.' },
        { role: 'user', content: clean },
      ],
    })
    const out = res.choices?.[0]?.message?.content?.trim()
    return out ? out.split('\n')[0].slice(0, 200) : null
  } catch (e) {
    console.error('translateSpecialty error:', e)
    return null
  }
}
