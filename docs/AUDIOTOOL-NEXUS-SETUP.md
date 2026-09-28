# Audiotool NEXUS — OAuth app registration

KYX je pripravený na plný OAuth flow. Chýba len clientId z registrovanej
Audiotool aplikácie.

## Krok 1 — registruj aplikáciu

Na **https://developer.audiotool.com/applications** vytvor novú aplikáciu:

| Pole                | Hodnota                                              |
| ------------------- | ---------------------------------------------------- |
| Názov               | KYX (Qvester Studio)                                 |
| Scope               | `project:write`                                      |
| Redirect URI (dev)  | `http://127.0.0.1:5173`                              |
| Redirect URI (prod) | `https://qvesterstudio.com`                          |

**Scope `project:write` je jediný, o ktorý KYX žiada.** Nič iné — žiadny
prístup k účtu, žiadne čítanie profilu, žiadne zdieľanie.

Redirect URI musia byť presné. Audiotool porovnáva origin, takže
`http://localhost:5173` **nie je** to isté čo `http://127.0.0.1:5173`.
Kod používa `window.location.origin`, takže použi ten, čo ti sedí.

## Krok 2 — pošli mi clientId

ClientId nie je tajomstvo (je to *public* client id pre SPA), ale ani tak
ho nechaj v `.env.local`, nie v `package.json` a nie v commite.

Vytvor súbor `D:\pulse-forge\.env.local`:

```
VITE_AUDIOTOOL_NEXUS_CLIENT_ID=tyo-client-id-sem
```

`.env.local` je gitignorovaný cez `.gitignore:8` (`*.local`), takže sa do
repozitára nedostane. `.env` (bez `.local`) **nie je** ignorovaný — ten
nepoužívaj.

## Krok 3 — čo spravím ja

1. `npm run build` — Vite vloží clientId do bundle
2. Spustím `vite preview` na porte, na ktorú si registroval redirect
3. Playwrightom otvorím KYX, kliknem na NEXUS export, prejdem popup
   prihlásenie, vložím URL tvojho **reálneho** Audiotool Studio projektu
4. Natočím `06-nexus-connect.webm` — vrátane toho, ako sa beat reálne
   zapíše do tvojho Audiotool projektu
5. Preplniem scénu 07 z placeholderu na reálne footage
6. Vyrenderujem finálne video

## Čo bude v scéne 07 (3:12 – 2:35)

- Prihlásenie do Audiotoolu (popup, scope `project:write`)
- Konto + otvorenie reálneho projektu
- Preview plánu: počet partov, nôt, taktov
- Potvrdenie a **zápis do tvojho Audiotool projektu**
- Receipt s overenými entitami (noteTrack, noteRegion, notes, mixer, audio cable)

## Bezpečnostné poznámky

KYX nikdy neposiela nič na svoj server. Token žije v prehliadači a ide
výhradne do Audiotoolu. Žiadny client secret sa do frontendu nedostáva —
NEXUS používa public client + PKCE.
