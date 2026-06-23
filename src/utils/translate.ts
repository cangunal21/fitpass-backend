import Groq from 'groq-sdk'

let client: Groq | null = null
const getClient = () => {
  if (!client) client = new Groq({ apiKey: process.env.GROQ_API_KEY || 'dummy' })
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
