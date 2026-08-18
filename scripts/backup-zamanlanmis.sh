#!/usr/bin/env bash
# ŞİPŞAKSPOR — GÜNLÜK ZAMANLANMIŞ YEDEK (launchd sarmalayıcısı)
# ============================================================================================
# Bu betik `backup-prod.sh`i günlük olarak, insan müdahalesi olmadan çalıştırır.
#
# NEDEN AYRI BİR SARMALAYICI: `backup-prod.sh` elle çalıştırılmak üzere yazılmış — argüman
# bekler, çıktıyı ekrana basar, hedefi varsayılan olarak `~/Desktop`tır. Zamanlanmış çalışma
# üç ek şey ister: (1) gizli değeri güvenli okumak, (2) hedefi İCLOUD'A SENKRONLANMAYAN bir
# yere sabitlemek, (3) sonucu sonradan denetlenebilir bir yere yazmak.
#
# ── HEDEF NEDEN `~/Desktop` DEĞİL ───────────────────────────────────────────────────────────
# Bu makinede `FXICloudDriveDesktop = 1`: `~/Desktop` ve `~/Documents` iCloud'a senkronlanıyor.
# Yedek dosyası TÜM kullanıcı verisini içerir (e-posta, passwordHash, KVKK kapsamlı alanlar).
# Varsayılan hedefle alınacak her yedek, bu veriyi sessizce buluta taşırdı — kullanıcının
# açık politikası ("prod dump'ı buluta gitmez, şifreli harici disk") tam tersini söylüyor.
# 17 Ağu 2026'da masaüstünde bu şekilde bırakılmış üç dosya bulundu. Bu yüzden hedef, home
# kökünde senkronlanmayan bir klasöre SABİTLENDİ ve `BACKUP_DIR` dışarıdan ezilemiyor.
#
# ── NE YAPMAZ ───────────────────────────────────────────────────────────────────────────────
# Harici diske KOPYALAMAZ. Kullanıcı "yalnız yerel klasör" dedi (17 Ağu 2026); diske kopyalama
# bilinçli olarak elle kalıyor. Bu yüzden aşağıda GÖRÜNÜR bir hatırlatma bırakılıyor —
# Railway'de otomatik yedek OLMADIĞI için şu an tek yedek hattı bu.
# ============================================================================================
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GIZLI="$HOME/.config/sipsakspor/backup.env"
# SABİT HEDEF — iCloud'a senkronlanmayan home kökü. Dışarıdan ezilemez (bkz. yukarıdaki gerekçe).
HEDEF="$HOME/sipsakspor-yedek"
GUNLUK="$HEDEF/yedek.log"
DURUM="$HEDEF/SON-DURUM.txt"
SAKLANACAK=14   # kaç yedek tutulacak (günlükte ~2 hafta)

mkdir -p "$HEDEF"
chmod 700 "$HEDEF" 2>/dev/null || true   # klasor drwxr-xr-x idi; icerik TUM kullanici verisi
exec >> "$GUNLUK" 2>&1
echo ""
echo "════════ $(date '+%Y-%m-%d %H:%M:%S') ════════"

# ── ESZAMANLILIK KILIDI ─────────────────────────────────────────────────────────────────────
# Iki kosu ust uste binerse (elle tetikleme + zamanlanmis is, ya da uykudan sonra telafi) asagidaki
# "yarim yedek supurgesi" DEVAM EDEN kosunun klasorunu yeniden adlandiriyor; psql `\copy` artik
# olmayan dizine yazmaya calisip exit 1 veriyor ve KOSAN yedek oluyor. macOS'ta flock yok;
# `mkdir` atomik oldugu icin kilit olarak kullaniliyor.
KILIT="$HEDEF/.kilit"
if ! mkdir "$KILIT" 2>/dev/null; then
  # Bayat kilit (surec olmus): 6 saatten eskiyse temizle. Yedek en fazla ~10 dk suruyor.
  if [[ -n "$(find "$KILIT" -maxdepth 0 -mmin +360 2>/dev/null)" ]]; then
    echo "⚠️  bayat kilit temizlendi (6 saatten eski)"
    rm -rf "$KILIT"; mkdir "$KILIT" 2>/dev/null || true
  else
    echo "⏭️  Baska bir yedek kosusu devam ediyor — bu tetikleme atlandi."
    exit 0
  fi
fi
trap 'rm -rf "$KILIT"' EXIT

# TIME MACHINE KAPSAM DISI: yedek dosyasi TUM kullanici verisini iceriyor (e-posta, passwordHash).
# Time Machine hedefi cogu zaman sifresiz harici bir disk; oraya sessizce kopyalanmasi istenmiyor.
# Kullanicinin politikasi: prod dump'i SIFRELI harici diske ELLE. Idempotent, best-effort.
tmutil addexclusion "$HEDEF" >/dev/null 2>&1 || true

if [[ ! -f "$GIZLI" ]]; then
  echo "❌ Gizli ayar dosyası yok: $GIZLI"
  printf 'HATA\t%s\tgizli ayar dosyasi yok\n' "$(date '+%Y-%m-%d %H:%M')" > "$DURUM"
  exit 1
fi
# ── GİZLİ DOSYAYI `source` ETME, AYRIŞTIR ───────────────────────────────────────────────────
# `. "$GIZLI"` dosyayı KABUK KODU olarak çalıştırır. İçinde `ANAHTAR=değer` biçiminde OLMAYAN bir
# satır varsa (ör. kullanıcı adresi öneksiz yeni bir satıra yapıştırdıysa) kabuk onu komut sanar,
# çalıştırmaya kalkar ve hata mesajında SATIRIN TAMAMINI — yani parolayı — günlüğe basar.
# 18 Ağu 2026'da tam olarak bu oldu ve prod parolası açığa çıktı. Üstelik bu, yedeğin HER
# koşusunda tekrarlanabilecek yapısal bir kusurdu: gizli değer `yedek.log`a düşerdi.
# Artık yalnızca istenen anahtar okunuyor; dosyanın geri kalanı asla yorumlanmıyor.
PROD_DATABASE_URL="$(sed -n 's/^[[:space:]]*PROD_DATABASE_URL=//p' "$GIZLI" | head -1)"
export PROD_DATABASE_URL
if [[ -z "${PROD_DATABASE_URL:-}" ]]; then
  echo "❌ PROD_DATABASE_URL boş."
  printf 'HATA\t%s\tPROD_DATABASE_URL bos\n' "$(date '+%Y-%m-%d %H:%M')" > "$DURUM"
  exit 1
fi

# PAROLAYI KOMUT SATIRINDAN CIKAR — aşağıdaki prob da `ps` ile okunabilen bir argüman taşıyordu.
# (Aynı sertleştirme backup-prod.sh ve backup-prod-logical.sh içinde de var.)
_urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }
PROD_URL_GUVENLI="$PROD_DATABASE_URL"
if [[ "$PROD_DATABASE_URL" =~ ^([a-zA-Z+]+)://([^:@/]+):([^@]+)@(.+)$ ]]; then
  PGPASSWORD="$(_urldecode "${BASH_REMATCH[3]}")"; export PGPASSWORD
  PROD_URL_GUVENLI="${BASH_REMATCH[1]}://${BASH_REMATCH[2]}@${BASH_REMATCH[4]}"
fi

# Ağ yoksa sessizce başarısız olma — DURUM dosyasına yaz ki bayatlık fark edilsin.
if ! psql "$PROD_URL_GUVENLI" -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "❌ Prod'a bağlanılamadı (ağ yok ya da URL değişti)."
  printf 'HATA\t%s\tproda baglanilamadi\n' "$(date '+%Y-%m-%d %H:%M')" > "$DURUM"
  exit 1
fi

# ── YARIM KALMIŞ YEDEKLERİ İŞARETLE (kendi kendini iyileştirme) ─────────────────────────────
# Süreç ortasında ölürse (makine uyudu, kapandı, işlem öldürüldü) geride TAM YEDEK GİBİ GÖRÜNEN
# ama eksik bir klasör kalıyor — ölçüldü: 42 tablodan 16'sı yazılmışken kesilen bir koşu,
# klasörde sıradan bir yedek gibi duruyordu. Böyle bir klasöre güvenmek, yedeksiz kalmaktan
# daha tehlikelidir: insan "yedeğim var" sanır.
#
# `meta.txt` mantıksal yedeğin EN SON yazdığı dosya; yoksa o koşu tamamlanmamıştır.
# Her koşunun BAŞINDA süpürülüp adı değiştiriliyor ki bir bakışta ayırt edilsin.
for d in "$HEDEF"/sipsakspor-prod-*/; do
  [[ -d "$d" ]] || continue
  if [[ ! -f "${d}meta.txt" ]]; then
    yeni_ad="$HEDEF/EKSIK-$(basename "$d")"
    echo "⚠️  yarım kalmış yedek işaretlendi: $(basename "$d") → $(basename "$yeni_ad")"
    mv "$d" "$yeni_ad" 2>/dev/null || true
  fi
done

echo "→ yedek alınıyor (hedef: $HEDEF)"
# Koşudan ÖNCEKİ dosya listesi: aşağıda "bu koşunun ürettiği dosya hangisi" sorusunu
# tarih/saat tahminiyle değil, KÜME FARKIYLA cevaplamak için.
ONCEKI=$(ls -1d "$HEDEF"/sipsakspor-prod-* 2>/dev/null | sort)
# URL ARGUMAN DEGIL ORTAM: komut satirlari makinedeki her yerel surec tarafindan okunabilir
# (`ps`/`pgrep -f`). 18 Agu 2026'da bu gerceklesti ve prod parolasi bir surec listesinde gorundu.
BACKUP_DIR="$HEDEF" bash "$REPO/scripts/backup-prod.sh"
KOD=$?

# ── DOĞRULANMAMIŞ ÜRÜNÜ ADIYLA AYIR ─────────────────────────────────────────────────────────
# Doğrulama koşmadığında (3) ya da düştüğünde (2) de ortada bir arşiv KALIYOR — ve adı
# kanıtlanmış bir yedekten AYIRT EDİLEMİYORDU. İki sonucu vardı: (1) felaket anında insan
# en yeni dosyayı alır, geri yüklenemediğini orada öğrenir; (2) 14'lük saklama kotasında yer
# kaplayıp KANITLANMIŞ bir yedeği emekliye ayırır — yani kötü yedek iyisini kovar.
if [[ "$KOD" -ne 0 ]]; then
  SONRAKI=$(ls -1d "$HEDEF"/sipsakspor-prod-* 2>/dev/null | sort)
  comm -13 <(printf '%s\n' "$ONCEKI") <(printf '%s\n' "$SONRAKI") | while read -r yeni; do
    [[ -e "$yeni" ]] || continue
    yeni_ad="DOGRULANMAMIS-$(basename "$yeni")"
    mv "$yeni" "$HEDEF/$yeni_ad" 2>/dev/null || true
    # .sha256 dosyasinin ICINDE eski dosya adi yaziyor; yeniden adlandirdiktan sonra
    # `shasum -c` "No such file" der ve saglama DOGRULANAMAZ hale gelir. Adi da guncelle.
    if [[ "$yeni_ad" == *.sha256 ]]; then
      sed -i '' "s| sipsakspor-prod-| DOGRULANMAMIS-sipsakspor-prod-|" "$HEDEF/$yeni_ad" 2>/dev/null || true
    fi
    echo "⚠️  doğrulanmamış ürün işaretlendi: $yeni_ad"
  done
fi

# ── EMEKLİLİK: eski yedekleri sil, disk dolmasın ─────────────────────────────────────────────
# En yeni $SAKLANACAK tanesi kalır. `backup-prod.sh` hem .dump hem klasör üretebiliyor
# (sürüm uyuşmazlığında mantıksal yedeğe düşüyor), ikisini de kapsa.
cd "$HEDEF" || exit 0
ls -1dt sipsakspor-prod-* 2>/dev/null | tail -n +$((SAKLANACAK + 1)) | while read -r eski; do
  echo "  emeklilik: $eski siliniyor"
  rm -rf "$eski"
done
# EKSIK-* ve DOGRULANMAMIS-* olanları daha kısa tut: bunlar yedek DEĞİL, yalnız teşhis için
# duruyorlar. Saklama kotasını (14) yemesinler diye ayrı ve kısa bir kuyrukları var.
ls -1dt EKSIK-* DOGRULANMAMIS-* 2>/dev/null | tail -n +4 | while read -r eski; do
  echo "  emeklilik (yedek değil): $eski siliniyor"
  rm -rf "$eski"
done

SAYI=$(ls -1dt sipsakspor-prod-* 2>/dev/null | wc -l | tr -d ' ')   # EKSIK-* sayılmaz: onlar yedek değil

# ── UYARI KANALI ────────────────────────────────────────────────────────────────────────────
# SON-DURUM.txt yazılıyordu ama OKUYAN/UYARAN hiçbir şey yoktu: yedek haftalarca başarısız olsa
# insan ancak dosyayı elle açarsa görürdü — ve zaten açmıyor. Railway'de otomatik yedek olmadığı
# için bu klasör TEK yedek hattı; sessiz başarısızlık en pahalı hâli.
# macOS bildirim merkezi launchd'nin GUI oturumundan erişilebilir; best-effort (hata işi düşürmez).
uyar() {
  osascript -e "display notification \"$2\" with title \"Şipşakspor yedek\" subtitle \"$1\"" >/dev/null 2>&1 || true
}

# BAYATLIK: en yeni yedek kaç gün önce? Mac kapalıysa iş HİÇ koşmaz ve hiçbir şey uyarmaz —
# o boşluğu kapatamayız, ama koştuğunda bayatlığı GÖRÜNÜR kılabiliriz.
SON_YEDEK="$(ls -1t sipsakspor-prod-*.tgz 2>/dev/null | head -1)"
BAYAT_GUN=0
if [[ -n "$SON_YEDEK" ]]; then
  BAYAT_GUN=$(( ( $(date +%s) - $(stat -f %m "$SON_YEDEK" 2>/dev/null || echo 0) ) / 86400 ))
fi
# ── BİLİNMEYEN ÇIKIŞ KODU ASLA BAŞARI SAYILMAZ ──────────────────────────────────────────────
# Bu blok eskiden `if 0 / elif 3 / else` idi ve **3 dalı bu makinede erişilemezdi**: prod
# PostgreSQL 18.4, yereldeki istemci 16 — sürüm uyuşmazlığı yüzünden `backup-prod.sh` her zaman
# `backup-prod-logical.sh`e düşüyor (kanıt: klasörde `.dump` değil `.tgz` var). Mantıksal betik
# ise doğrulama KOŞMADIĞINDA da `exit 0` dönüyordu. Yani "geri yükleme testi hiç koşmadı" hâli
# sessizce "BASARILI — kanıtlanmış" olarak raporlanıyordu. 17 Ağu 2026 denetiminde bulundu.
case "$KOD" in
  0)
    echo "✅ BAŞARILI — kanıtlanmış yedek alındı. Klasördeki yedek sayısı: $SAYI"
    {
      printf 'BASARILI\t%s\tkanitlanmis (geri yukleme testi KOSTU ve GECTI)\n' "$(date '+%Y-%m-%d %H:%M')"
      printf '\n'
      printf '⚠️  BU DOSYALARI ŞİFRELİ HARİCİ DİSKE KOPYALA.\n'
      printf '    Railway planında otomatik yedek YOK — şu an TEK yedek hattı bu klasör.\n'
      printf '    Bu Mac kaybolursa/bozulursa veri de gider. Aynı diskteki yedek, yedek değildir.\n'
      printf '\n'
      printf 'Klasör: %s\n' "$HEDEF"
      printf 'Saklanan yedek sayısı: %s\n' "$SAYI"
    } > "$DURUM"
    ;;
  2)
    # 2 = dogrulama KOSTU ve DUSTU (veri farki ya da SEMA farki). 3'ten (hic kosmadi) ve
    # jenerik hatadan AYRI: burada elimizde somut bir kanit var, bakilacak yer belli.
    echo "❌ Yedek DOĞRULANAMADI — geri yükleme testi KOŞTU ve DÜŞTÜ."
    {
      printf 'DOGRULAMA-DUSTU\t%s\tgeri yukleme testi KOSTU ve DUSTU\n' "$(date '+%Y-%m-%d %H:%M')"
      printf '\n'
      printf '⚠️  BU YEDEGE GUVENME. Ayrinti icin arsiv icindeki SEMA-FARKLARI.txt ya da\n'
      printf '    %s dosyasindaki "5/6" bolumune bak.\n' "$GUNLUK"
      printf '    Sik sebep: schema.prisma degisti ama prod a HENUZ DEPLOY EDILMEDI.\n'
    } > "$DURUM"
    uyar "DOĞRULANAMADI" "Geri yükleme testi düştü. Şema farkı olabilir — yedek.log'a bak."
    ;;
  3)
    echo "⚠️  Yedek alındı ama DOĞRULANMADI — geri yükleme testi KOŞMADI."
    uyar "DOĞRULANMADI" "Dosya var ama geri yüklenebildiği kanıtlanmadı. Yerel PostgreSQL çalışıyor mu?"
    {
      printf 'DOGRULANMADI\t%s\tdosya var ama geri yukleme testi KOSMADI\n' "$(date '+%Y-%m-%d %H:%M')"
      printf '\n'
      printf '⚠️  BU YEDEGE GUVENME. Dosya duruyor ama geri yuklenebildigi KANITLANMADI.\n'
      printf '    En sik sebep: yerel PostgreSQL sunucusu calismiyor.\n'
      printf '      kontrol : brew services list | grep postgres\n'
      printf '      baslat  : brew services start postgresql@16\n'
      printf '      tekrar  : launchctl kickstart -p gui/$(id -u)/com.sipsakspor.yedek\n'
    } > "$DURUM"
    ;;
  *)
    echo "❌ BAŞARISIZ (çıkış kodu $KOD) — yukarıdaki çıktıya bak."
    uyar "BAŞARISIZ (kod $KOD)" "Yedek alınamadı. ~/sipsakspor-yedek/yedek.log dosyasına bak."
    printf 'HATA\t%s\tcikis kodu %s\n' "$(date '+%Y-%m-%d %H:%M')" "$KOD" > "$DURUM"
    ;;
esac
exit "$KOD"
