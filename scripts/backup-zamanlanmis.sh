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
exec >> "$GUNLUK" 2>&1
echo ""
echo "════════ $(date '+%Y-%m-%d %H:%M:%S') ════════"

if [[ ! -f "$GIZLI" ]]; then
  echo "❌ Gizli ayar dosyası yok: $GIZLI"
  printf 'HATA\t%s\tgizli ayar dosyasi yok\n' "$(date '+%Y-%m-%d %H:%M')" > "$DURUM"
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$GIZLI"; set +a
if [[ -z "${PROD_DATABASE_URL:-}" ]]; then
  echo "❌ PROD_DATABASE_URL boş."
  printf 'HATA\t%s\tPROD_DATABASE_URL bos\n' "$(date '+%Y-%m-%d %H:%M')" > "$DURUM"
  exit 1
fi

# Ağ yoksa sessizce başarısız olma — DURUM dosyasına yaz ki bayatlık fark edilsin.
if ! psql "$PROD_DATABASE_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
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
BACKUP_DIR="$HEDEF" bash "$REPO/scripts/backup-prod.sh" "$PROD_DATABASE_URL"
KOD=$?

# ── EMEKLİLİK: eski yedekleri sil, disk dolmasın ─────────────────────────────────────────────
# En yeni $SAKLANACAK tanesi kalır. `backup-prod.sh` hem .dump hem klasör üretebiliyor
# (sürüm uyuşmazlığında mantıksal yedeğe düşüyor), ikisini de kapsa.
cd "$HEDEF" || exit 0
ls -1dt sipsakspor-prod-* 2>/dev/null | tail -n +$((SAKLANACAK + 1)) | while read -r eski; do
  echo "  emeklilik: $eski siliniyor"
  rm -rf "$eski"
done
# EKSIK-* olanları daha kısa tut: bunlar yedek DEĞİL, yalnız teşhis için duruyorlar.
ls -1dt EKSIK-* 2>/dev/null | tail -n +4 | while read -r eski; do
  echo "  emeklilik (eksik): $eski siliniyor"
  rm -rf "$eski"
done

SAYI=$(ls -1dt sipsakspor-prod-* 2>/dev/null | wc -l | tr -d ' ')   # EKSIK-* sayılmaz: onlar yedek değil
if [[ "$KOD" -eq 0 ]]; then
  echo "✅ BAŞARILI — kanıtlanmış yedek alındı. Klasördeki yedek sayısı: $SAYI"
  {
    printf 'BASARILI\t%s\tkanitlanmis (geri yukleme testi gecti)\n' "$(date '+%Y-%m-%d %H:%M')"
    printf '\n'
    printf '⚠️  BU DOSYALARI ŞİFRELİ HARİCİ DİSKE KOPYALA.\n'
    printf '    Railway planında otomatik yedek YOK — şu an TEK yedek hattı bu klasör.\n'
    printf '    Bu Mac kaybolursa/bozulursa veri de gider. Aynı diskteki yedek, yedek değildir.\n'
    printf '\n'
    printf 'Klasör: %s\n' "$HEDEF"
  } > "$DURUM"
elif [[ "$KOD" -eq 3 ]]; then
  echo "⚠️  Yedek alındı ama DOĞRULANMADI (yerel PostgreSQL sunucusu uyumsuz)."
  printf 'DOGRULANMADI\t%s\tdosya var ama geri yukleme testi kosmadi\n' "$(date '+%Y-%m-%d %H:%M')" > "$DURUM"
else
  echo "❌ BAŞARISIZ (çıkış kodu $KOD) — yukarıdaki çıktıya bak."
  printf 'HATA\t%s\tcikis kodu %s\n' "$(date '+%Y-%m-%d %H:%M')" "$KOD" > "$DURUM"
fi
exit "$KOD"
