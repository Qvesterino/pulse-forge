# KYX — manuálny Safari / iOS Safari QA scenár (risk R6)

**Prečo manuálne:** Playwright WebKit build na Windowse nemá Web Audio vôbec
(`AudioContext === undefined` — limitácia portu, nie apky), takže túto maticu
žiadna automatizácia na tomto stroji nepokryje. Real Safari (macOS) a iOS
Safari sú jediná zostávajúca neoverená platforma pred release.

**Čo pripraviť:** macOS zariadenie so Safari 16.4+ (AudioWorklet minimum),
ideálne aj iPhone/iPad s iOS 16.4+. Hosting URL s nasadeným produkčným
buildom (dist). Časy mer očnými hodinami; každou položkou prejdi zhoranú
a zaznamenaj PASS/FAIL + poznámku.

---

## A. Boot a shell (macOS Safari aj iOS Safari)

1. Otvor hosting URL — landing sa renderuje, žiadna biela obrazovka.
2. Otvor console (macOS) / pripoj Safari Web Inspector z Macu na iOS
   (Develop → [zariadenie]) — **žiadne chyby** okrem očakávaných
   _capability_ hlášok (AudioWorklet unavailable by nemalo nastať).
3. Vstup do štúdia (HOUSE template) — projekt sa načíta, transport sa
   prehráva, meter na mastri sa hýbe.

**PASS kritérium:** boot bez konzolových chýb, audio prehráva.

## B. AudioWorklet DSP (kritická cesta)

1. Pridaj FX na track: **VLYX (Ultina)** → zapni COMP. Prehrávaj sintetický
   loop. PASS: zvuk je hlasnejšie komprimovaný (dynamics), nie tichý
   (tichý výstup = state poisoning triedy, ktorú hardening riešil).
2. **PRISM (fxeq)** → zapni saturation na bandu + reverb. PASS: saturation
   pridáva harmoniky, reverb doznieva a **dozvuk úplne utíchne** do ~5 s
   po stopnutí signálu (FDN tail konvergencia).
3. **VØID (ozvena)** → prehraj percusiu. PASS: tri enginy znú, žiadne
   "zamrznuté" dozvuky po stopnutí (freeze loop trieda).
4. Stock efekty (limiter, gate, bitcrusher) — zapni/vypni. PASS: límiter
   drží ceiling pri hot inplete, gate ticho prepúšťa 1:1 keď je otvorený.

## C. Latencia / PDC

1. Track A: dry sintetický click. Track B: ten istý click → PRISM s
   oversamplingom (reportuje ~2.7 ms). Obe prehrávaj súčasne, hard-pan
   L/R, počúvaj v slúchadlách. **PASS: žiadne flanger/echo medzi kanálmi**
   (PDC kompenzuje reportovanú latenciu — Firefox/Chromium beh meria skew
   < 2 ms; ucho rozozná > ~5 ms).

## D. Kolaborácia (ak je relay nasadený)

1. Dve zariadenia (Mac + iPhone) v jednej roomke. PASS: edit stepu na
   jednom sa objaví na druhom, presence (kurzor/meno) sa vidí, transport
   sync v Instant Jam — late joiner preberie stav.

## E. iOS špecifiká

1. **Audio unlock:** po prvom tapnutí Play zvuk znejí (iOS suspenduje
   AudioContext do gesture). PASS: žiadne "ticho po prvom štarte".
2. **Lock screen / prepnutie appky** na 30 s počas prehrávania → späť.
   PASS: transport pokračuje alebo korektne zastaví; po resume žiadne
   priškrtenie/zostrojenie; meter sa hýbe.
3. **Rotate + dock** — panelie sa prepelia, nič sa neprekrýva.
4. Dlhý prst na step → step editor (touch flow, bez right-clicku).
5. Battery/perf: 3 minúty prehrávania s 2 flagship FX — žiadne
   trvalé droparty (krátke glitchy pri prepínaní panelov sú OK).

## F. Čo zapisovať pri každom FAIL-e

- Safari version (Safari → About), iOS version, zariadenie
- Console chyby (screenshot Web Inspectoru)
- Či sa problém replikuje aj v Chromium na tom istom obsahu
  (ak áno → product bug; ak nie → engine-specific, nahlásiť s tagom R6)

---

**História behov:** (doplň riadky)

| Dátum | Zariadenie / OS | Výsledok | Poznámky |
| ----- | --------------- | -------- | -------- |
| —     | —               | —        | —        |
