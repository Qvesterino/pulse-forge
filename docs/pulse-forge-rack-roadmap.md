# Pulse Forge Racks - Implementacny To-do

Status: planned / dalsi sound-design milestone

Tento dokument opisuje system **Pulse Forge Racks**: lokalnu kniznicu celych
zvukovych setupov, ktore sa daju ulozit, okamzite vypocut, variovat a aplikovat
na aktualny track. Rack ma spojit instrument, jeho parametre, sample reference,
efekty, makra a bezpecne routing metadata do jedneho pouzitelneho presetoveho
objektu.

Cielom nie je vytvorit VST system ani dalsi project track type. Cielom je, aby
producent vedel z jedneho dobreho zvuku vytvorit vlastnu kniznicu opakovatelnych
setupov a vracat sa k nim bez rucneho skladania celeho signal chainu.

## Produktovy ciel

Pouzivatel by mal vediet:

- ulozit aktualny instrument setup ako Rack,
- ulozit instrument, sample reference, parametre, FX chain a makra spolu,
- Rack okamzite preview-nut bez zmeny projektu,
- aplikovat Rack na aktualny instrument track jednym undo krokom,
- vytvorit deterministicku variaciu pomocou seed-u,
- ulozit variaciu ako novy Rack bez prepisania originalu,
- filtrovat Racky podla zanru, funkcie, nalady a mini-packu,
- rozlisit factory Racky od user Rackov,
- bezpecne riesit chybajuci lokalny sample alebo neplatny routing.

## V1 hranice

- Rack kniznica bude browser-local a bude ulozena v IndexedDB.
- Rack nebude sucastou `ProjectDocument`, share linku ani YDoc kolaboracie.
- V1 cieli na instrument tracky; plny Drum Rack snapshot je samostatne
  rozsirnie.
- Factory Racky budu sucastou aplikacie; user Racky budu zapisovane do lokalnej
  repository.
- User sample sa nebude kopirovat do Racku. Rack ulozi iba `sampleId` a
  jasne oznaci chybajuci lokalny asset.
- Aplikacia Racku bude pracovat s aktualnym trackom, nie s pevnym `trackId`.
- Routing sa ulozi symbolicky. Rack nesmie obsahovat konkretne `trackId`,
  `groupId`, pattern ID ani arrangement ID.
- Preview nesmie vytvarat projectove noty, efekty, makra ani undo historiu.
- Variation bude menit iba bezpecne zvukove parametre; nebude menit typ
  instrumentu, poradie FX ani projectove data.
- Nebude sa riesit VST hosting, cloud sync, user pack sharing ani automaticke
  stahovanie zvukov z internetu.

## Navrhovany datovy model

Rack bude samostatny serializovatelny objekt. Nazvy fieldov su navrh kontraktu,
ktory sa ma pred implementaciou zosuladit s existujucimi typmi v
`src/project-model/types.ts`, `src/presets/types.ts` a `src/effects/types.ts`.

```ts
interface RackDefinition {
  id: string;
  schemaVersion: 1;
  name: string;
  description?: string;
  source: "factory" | "user";
  packId?: string;
  tags: string[];
  genre?: string;
  mood?: string[];
  instrument: {
    kind: InstrumentKind;
    presetId?: string;
    sampleId?: string;
    params: Record<string, number>;
  };
  effects: RackEffectSnapshot[];
  macros: RackMacroSnapshot[];
  routing?: RackRoutingSnapshot;
  preview: RackPreviewSettings;
  gainTrimDb?: number;
  createdAt: number;
  updatedAt: number;
}

interface RackEffectSnapshot {
  type: EffectType;
  params: Record<string, number>;
  bypass?: boolean;
  sidechain?: "off" | "kick" | "symbolic-source";
}

interface RackMacroSnapshot {
  name: string;
  value: number;
  mappings: Array<{
    target: "instrument" | "effect";
    effectIndex?: number;
    param: string;
    min: number;
    max: number;
  }>;
}

interface RackRoutingSnapshot {
  destination: "track" | "group-symbolic";
  sends?: Array<{ destination: "return-symbolic"; amount: number }>;
}

interface RackPreviewSettings {
  note: number;
  velocity: number;
  durationMs: number;
  mode: "single-note" | "held-note";
}
```

Pravidla datoveho modelu:

- `params` musia byt pri ulozeni normalizovane podla registry instrumentu a FX.
- Poradie `effects` je sucastou Racku; pri aplikacii sa zachova.
- Macro mapping pouziva index efektu a nazov parametra, nie `fxId` z projektu.
- Neznama alebo neplatna hodnota sa pri nacitani zahodi alebo nahradi defaultom.
- `schemaVersion` je verzia Rack objektu, nie nova verzia project schema.
- Neskorsia zmena Rack schema bude riesena migraciou v repository, nie zmenou
  project dokumentu.

## Faza 0 - Zaklad a rozhodnutia

- [ ] Potvrdit V1 rozsah pre instrument tracky a explicitne odlozit plny Drum
      Rack snapshot.
- [ ] Zmapovat vsetky instrument parametre, FX parametre a makro mappingy,
      ktore mozu byt sucastou Racku.
- [ ] Zjednotit zoznam funkcnych tagov: `kick`, `sub`, `bass`, `stab`, `lead`,
      `pad`, `keys`, `texture`, `riser`, `impact`, `pluck`, `drums`.
- [ ] Zjednotit zoznam zanrov a nalad s existujucim preset systemom.
- [ ] Definovat pravidla pre hlasitost Rack preview a `gainTrimDb`.
- [ ] Rozhodnut, ktore parametre su vhodne pre Variation a ktore zostavaju
      nedotknute.
- [ ] Pripravit male testovacie fixture setupy pre kazdy podporovany instrument,
      sampler s factory sample a sampler s user sample.
- [ ] Spisat licencie a povod pre factory Racky, samples a preset metadata.

## Faza 1 - Rack model a lokalna repository

- [ ] Vytvorit `src/racks/types.ts` s Rack kontraktom a pomocnymi typmi.
- [ ] Vytvorit `src/racks/normalize.ts` pre clamp parametrov, tagov, mien,
      preview nastaveni a schema kompatibilitu.
- [ ] Vytvorit `src/persistence/RackRepository.ts` nad existujucou IndexedDB
      vrstvou.
- [ ] Pridat list, get, save, update, delete a bulk seed operacie.
- [ ] Zachovat oddelene factory Racky a user Racky.
- [ ] Pridat migraciu/ignorovanie poskodenych zaznamov bez padu aplikacie.
- [ ] Pridat runtime cache a subscription mechanizmus pre Rack browser.
- [ ] Pridat Rack repository do `Services`, aby UI nepouzivalo priamy IndexedDB
      pristup.
- [ ] Osetrit koliziu ID, duplicitne ulozenie a chybajuci local sample.
- [ ] Overit, ze Rack data sa nikdy nepridaju do project JSON ani YDoc mapy.

## Faza 2 - Save, apply a bezpecne undo

- [ ] Pridat cisty snapshot builder pre aktualny instrument track.
- [ ] Implementovat `saveTrackAsRack(trackId, metadata)` mimo project commandu,
      pretoze zapisuje do lokalnej kniznice.
- [ ] Implementovat atomicky command `applyRack(trackId, rack)`.
- [ ] Pri aplikacii nastavit instrument kind, preset/sample reference,
      instrument params, FX chain a macro hodnoty v jednom undo kroku.
- [ ] Pri aplikacii premapovat macro targety na cielovy track a nove FX instance.
- [ ] Pri aplikacii `sidechain: "kick"` vyhladat platny kick source; pri
      neuspechu nastavit sidechain na `off` a zobrazit upozornenie.
- [ ] Nechat existujuce track ID, patterny, noty, routing mimo Rack snapshotu
      nedotknute, pokial to nie je explicitne podporene symbolickym routingom.
- [ ] Pridat `duplicateRack` ako lokalnu repository operaciu s novym ID.
- [ ] Pridat undo/redo test, ktory obnovi povodny setup bit po bite.
- [ ] Pri chybajucom sample aplikaciu neprerusit: zobrazit `SOURCE UNAVAILABLE`
      a zachovat zvysok Racku.

## Faza 3 - Rack Library UI

- [ ] Vytvorit samostatny `RackBrowser` alebo `RackLibrary` panel, nie iba dalsi
      slider v Inspectore.
- [ ] Zobrazit sekcie `FACTORY`, `MY RACKS`, `FAVORITES` a `RECENT`.
- [ ] Pridat vyhladavanie podla nazvu a tagov.
- [ ] Pridat filtre podla zanru, nalady, instrument kind, funkcnej role a
      mini-packu.
- [ ] Pridat triedenie podla mena, novosti, naposledy pouziteho a oblubenych.
- [ ] Pri kazdom Racku zobrazit meno, instrument, FX pocet, tagy, mini-pack a
      stav dostupnosti sample.
- [ ] Pridat akcie `PREVIEW`, `APPLY`, `SAVE AS`, `VARIATION`, `FAVORITE` a
      `DELETE` tam, kde davaju zmysel.
- [ ] `DELETE` povolit iba pre user Racky a vyziadat potvrdenie.
- [ ] `SAVE AS` otvorit v editovatelnom metadata stave s predvyplnenym nazvom.
- [ ] Pridat stav prazdnej kniznice a stav pri chybe IndexedDB.
- [ ] Pri aplikacii zobrazit kratky vysledok: pouzity Rack, target track a
      pripadne varovania pre sample/routing.

## Faza 4 - Okamzity preview

- [ ] Vytvorit oddeleny `RackPreviewController`, ktory pouzije rovnake factory
      instrumentov a efektov ako realtime engine.
- [ ] Preview spustat v docasnom signal chaine mimo project tracku.
- [ ] Podporit single note, held note a kratky test pattern podla typu Racku.
- [ ] Pouzit preview parametre z Racku; default nastavit na bezpecnu strednu
      velocity a kratke trvanie.
- [ ] Aplikovat gain compensation tak, aby hlasnejsi Rack neposobil automaticky
      ako kvalitnejsi. Presne pravidlo zdokumentovat a otestovat.
- [ ] Pridat `STOP PREVIEW` a automaticky zastavit predchadzajuci preview pri
      spusteni noveho.
- [ ] Po stopnuti odpojit a dispose-nut vsetky source, gain, panner, FX a
      worklet nodes.
- [ ] Preview nesmie menit transport, selection, undo stack, project store ani
      kolaboraciu.
- [ ] Pri unsupported instrument runtime zobrazit citatelnu chybu a neblokovat
      browser.
- [ ] Overit preview po prepise projektu, reload-e, otvoreni/uzavreti panelu a
      pri rychlom prepinani viacerych Rackov.

## Faza 5 - Deterministicka Variation

- [ ] Vytvorit cisty modul `src/racks/variation.ts` bez `Math.random()`.
- [ ] Pridat explicitny `seed` a intenzitu variation, napriklad `subtle`,
      `medium`, `wild`.
- [ ] Definovat povolene rozsahy pre instrument tone, envelope, filter,
      oscillator mix, drive, EQ, compressor, delay/reverb mix a podobne.
- [ ] Vylucit z nahodnej zmeny typ instrumentu, sample ID, poradie FX, routing,
      macro mappingy a parametre, ktore mozu vytvorit nehratelny zvuk.
- [ ] Pri sampler Racku povolit variation start/end alebo playback parametre iba
      v platnom rozsahu assetu.
- [ ] Vratit novy Rack objekt s novym ID a nazvom typu `Original VAR 01`.
- [ ] Pridat `REROLL`, ktory pri rovnakom seed-e vytvori rovnaky vysledok.
- [ ] Pri zmene seed-u vytvorit novy vysledok bez mutacie originalu.
- [ ] Povolit preview variation pred ulozenim.
- [ ] Ulozenie variation urobit ako novu user Rack polozku, nie ako update
      factory Racku.
- [ ] Pridat ochranu proti variation, ktora je numericky nova, ale pocutelne
      alebo funkciou identicka s originalom.

## Faza 6 - Organizovane mini-packy

### Prva obsahova vlna

- [ ] **House Essentials**: punchy drums, bass, stabs, plucks a short FX.
- [ ] **Trap 808 Toolkit**: sub, 808, slides, dark keys, hats a impacts.
- [ ] **Lo-fi Textures**: dusty keys, pads, noise beds, tape-like textures.
- [ ] **Techno Tools**: rumble, industrial hits, stabs, percussion, risers.

### Metadata a kvalita

- [ ] Kazdemu factory presetu a Racku doplnit funkciu, zaner, naladu,
      register, energy a odporucane pouzitie.
- [ ] Zaviest konzistentne tagy namiesto volneho textu.
- [ ] Rozdelit obsah na instrument, one-shot, loop, texture a transition assety.
- [ ] Pridat preview asset alebo preview recipe pre kazdy obsahovy typ.
- [ ] Zmerat a zjednotit perceived loudness factory presetov v ramci instrument
      kategorii.
- [ ] Zachovat headroom pre transienty; loudness match nema zlikvidovat punch.
- [ ] Pre kazdy pack vytvorit kratky sound-check checklist: sub, transient,
      stereo, clipping, tail, loop boundary a preview hlasitost.
- [ ] Odstranit nepresne, duplicitne alebo zavadzajuce nazvy a tagy.
- [ ] Pridat pack manifest s ID, verziou, zoznamom Rackov, assetov, licenciou a
      checksumami, aby sa obsah dal neskor distribuovat ako samostatny balicek.

## Faza 7 - Preset preview, favorites a workflow polish

- [ ] Zjednotit preview tlacidla pre existujuce instrument presets, Racks a
      sample browser.
- [ ] Pri otvoreni browsera zachovat posledny filter, pack a scroll poziciu iba
      lokalne v UI state.
- [ ] Zaznamenat posledne pouzite Racky cez existujuci library/recent pattern.
- [ ] Pridat rychle klavesove ovladanie pre preview, apply, stop a favorite,
      ak to zapadne do existujuceho keyboard systemu.
- [ ] Pri drag-and-drop alebo double-click zachovat predvidatelne pravidlo:
      preview je explicitna akcia, apply je vzdy potvrdeny command.
- [ ] Pri sample mimo lokalnej cache zobrazit dovod a akciu `REMOVE REFERENCE`
      alebo `KEEP FOR LATER`.
- [ ] Zabezpecit, aby browser pri vela Rackoch nerenderoval vsetky preview
      thumbnails alebo audio buffers naraz.

## Routing a kompatibilita

- [ ] Presne zdokumentovat, ktore routing nastavenia Rack V1 podporuje.
- [ ] Ukladat iba symbolicke ciele ako `kick`, `group-symbolic` alebo
      `return-symbolic`; nikdy nie konkretne project IDs.
- [ ] Pri aplikacii prelozit symbolicky routing na aktualny projekt.
- [ ] Pri nejednoznacnom alebo neplatnom preklade pouzit `off` a zobrazit
      warning, nie ticho vytvorit nespravne spojenie.
- [ ] Overit kompatibilitu s group busmi, sidechain source a return trackmi.
- [ ] Factory Rack nesmie byt zmenitelny priamo. Pouzivatel vytvori user kopiu.
- [ ] Rack zmazany z local library nesmie odstranit uz aplikovany setup z
      projektu.
- [ ] Share link a YDoc budu nadalej obsahovat iba vysledny project setup, nie
      lokalnu Rack library.

## Test plan

### Pure a data tests

- [ ] Rack snapshot zachova instrument, sample reference, FX poradie, params a
      makra.
- [ ] Normalizacia opravi chybajuce, neplatne a out-of-range hodnoty.
- [ ] Symbolicky routing sa neviaze na project IDs.
- [ ] Variation je deterministicka pre rovnaky seed.
- [ ] Variation nemeni zakazane parametre a nikdy nevyrobi NaN/Infinity.
- [ ] Tagy, zanre, nalady a pack IDs maju validne hodnoty.
- [ ] Factory a user Rack zdroje sa nedaju zamenit mutaciou.

### Repository tests

- [ ] Save/list/get/update/delete funguje cez IndexedDB.
- [ ] Poskodeny zaznam nezhodi nacitanie ostatnej kniznice.
- [ ] Migracia Rack schema zachova stare platne data.
- [ ] Dva taby alebo opakovane ulozenie nesposobia necakanu stratu dat.
- [ ] User sample reference prezije reload, missing asset stav je citatelny.

### Command a project tests

- [ ] Apply Rack vytvori jeden undo krok.
- [ ] Undo/redo obnovi presny povodny track setup.
- [ ] Apply Rack nemeni noty, patterny ani arrangement.
- [ ] Macro mappingy sa spravne premapuju na nove FX IDs.
- [ ] Sidechain kick shortcut a neplatny source sa spravaju defensivne.
- [ ] Zmazanie Racku z kniznice nema vplyv na uz aplikovany projekt.

### Audio a preview tests

- [ ] Kazdy podporovany instrument Rack sa da skonstruovat v realtime aj
      OfflineAudioContext.
- [ ] Preview a normalny playback pouziju rovnaky instrument/FX definition.
- [ ] Preview sa da zastavit a novy preview ukonci predchadzajuci.
- [ ] Po zatvoreni panelu nezostanu aktivne source, worklet, timer ani audio
      connection objekty.
- [ ] Gain compensation nezmeni obsah Racku ani project gain.
- [ ] Chybajuci sample nezablokuje browser a nevytvori tichy nekonecny node.

### UI a browser QA

- [ ] Otvorenie Rack Library, filter, search a pack navigation.
- [ ] Save current setup as Rack.
- [ ] Preview factory, user a missing-sample Racku.
- [ ] Apply, Save As, Favorite, Delete a potvrdenie undo.
- [ ] Variation, REROLL, preview variation a ulozenie noveho Racku.
- [ ] Reload aplikacie zachova user Racky, tagy a favorites.
- [ ] Prepinanie projektu nema pristup k cudzim project-local datam.
- [ ] V browseri s prazdnou alebo nedostupnou IndexedDB zostane aplikacia
      pouzitelna s jasnym stavom.

## Akceptacne kriterium milestone

Milestone je pripraveny na release, ked producent dokaze:

1. vybrat instrument track a ulozit jeho zvuk ako user Rack,
2. Rack do jednej sekundy preview-nut alebo zastavit bez zmeny projektu,
3. aplikovat ho na iny kompatibilny track jednym undo krokom,
4. vytvorit rovnaku variation z rovnakeho seed-u a ulozit ju ako novy Rack,
5. najst Rack cez funkciu, zaner alebo mini-pack,
6. reloadnut aplikaciu bez straty lokalnej kniznice,
7. dostat jasne upozornenie pri chybajucom sample alebo neplatnom routingu,
8. preukazat, ze preview a kniznica nevytvaraju audio alebo memory leak.

## Neskorsie rozsirenia

- [ ] Plny Drum Rack snapshot vratane padov, slice nastaveni a pattern
      mappingu.
- [ ] Export/import Rack balickov ako verzovaneho lokalneho suboru.
- [ ] Volitelne zdielanie Rack metadata cez share link bez embedovania velkych
      sample bytes.
- [ ] Cloud library a kolaborativne user Racky.
- [ ] Automaticky loudness match pri preview podla kategorie.
- [ ] Batch preview a porovnanie viacerych Rack variation vedla seba.
- [ ] Desktop/native companion s rovnakym Rack kontraktom.
- [ ] User-defined macro templates a mapovanie viacerych targetov napriec
      modulmi.

## Predvolene rozhodnutia

- Rack je globalna browser-local kniznica, nie project-local data.
- Aplikacia Racku je project command s jednym undo krokom.
- Preview je docasny runtime a nikdy nemutuje projekt.
- Variation je deterministicka, seedovana a vytvara novu kopiu.
- Routing sa uklada symbolicky a pri aplikacii sa bezpecne prelozi.
- Factory Racky su read-only; user Racky sa ukladaju lokalne.
- Prva obsahova vlna je zamerana na male zanrovo-funkcne mini-packy, nie na
  nahodne pridavanie dalsich presetov.
- VST hosting, cloud sync, online marketplace a plny Drum Rack snapshot su
  mimo tejto etapy.
