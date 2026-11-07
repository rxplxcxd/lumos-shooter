# Lumos Strike

Browser-3D-Taktik-Shooter und Battle Royale mit Three.js (WebGL2) und Rapier (WASM-Physik). Optimiert für Lumos Handhelds, Controller und Low-End-Hardware, spielbar in jedem modernen Browser auf Desktop, Handheld und Smartphone.

> Alle 3D-Modelle, Sounds und die Musik stammen von **Sketchfab** und **itch.io**. Die vollständige Liste mit Autoren und Lizenzen steht in [CREDITS.md](CREDITS.md).

## Schnellstart

```bash
npm install
npm run dev          # Spiel auf http://localhost:5173 + Echtzeit-Relay (Port 8787, über /ws durchgereicht)
```

**GitHub Codespaces:** Repo im Codespace öffnen. `npm install` läuft automatisch (`.devcontainer`). Danach `npm run dev` starten. Port 5173 wird weitergeleitet und öffnet sich als Vorschau, für die beste Performance im eigenen Browser-Tab öffnen. Für Online-Tests mit einer zweiten Person den Port 5173 im Tab „Ports“ auf **Public** stellen und die URL teilen.

### Zu zweit (oder mehr) online spielen

1. Beide öffnen dieselbe Spiel-URL (lokal im LAN `http://<deine-IP>:5173`, im Codespace die öffentliche Port-URL).
2. Im Spielen-Tab im Kasten **Online · Party** einen Party-Code eintragen (z. B. `ALPHA`) und beitreten, die zweite Person tritt mit demselben Code bei.
3. Der erste Spieler im Raum ist Host. Er wählt Modus und Karte und startet: alle laden mit demselben Seed dieselbe Welt.
4. Host-Relay: der Host simuliert Bots, Zombies, Zone und Spielstand und schickt 10-mal pro Sekunde Snapshots, Spieler senden ihren Zustand mit 20 Hz. Treffer, Loot, Türen, Fahrzeuge und Pings werden als Events synchronisiert. Verlässt der Host das Spiel, übernimmt automatisch ein anderer Spieler.

Weitere Befehle:

| Befehl | Zweck |
|---|---|
| `npm run dev` | Dev-Server (Vite, Hot Reload) und Echtzeit-Relay zusammen |
| `npm run dev:web` | nur der Vite-Dev-Server |
| `npm run server` | nur der Echtzeit-Relay-Server (WebSocket, Port 8787) |
| `npm run build` / `npm run preview` | Produktions-Build nach `dist/` und lokale Vorschau |
| `npm run typecheck` | TypeScript-Prüfung |
| `/viewer.html?files=vehicles/tank,vehicles/jeep` | Asset-Viewer (Ausrichtung und Skalierung prüfen) |

Das Spiel läuft **komplett offline**. Supabase, Lumos Cloud und der Echtzeit-Server sind optional (siehe `.env.example`).

## Spielmodi

- **Battle Royale**: bis zu 100 Spieler (Spieler + KI-Bots). Solo, Duos, Trios, Quads sowie die Modifikatoren Nur Sniper, CQB, High-Tier-Loot und **Extraktion**. Dazu gehören:
  - Absetzflugzeug, Freifall und **Fallschirm wie in Warzone**: mit Space beliebig oft öffnen und wieder kappen, automatische Öffnung in Bodennähe
  - **Gezielter Gleitflug**: im Freifall mit WASD/Stick in jede Richtung steuern, nach unten schauen = Sturzflug, am Schirm flacher Gleitwinkel (ca. 3:1) für weit entfernte Ziele
  - Sturmzone in 6 Phasen
  - Loot mit Seltenheits-Lichtsäulen
  - Kaufstationen (Platten, Weste, UAV, Versorgungsabwurf, Teammitglied absetzen, Loadout-Drop)
  - Versorgungsabwürfe, Down-State und Wiederbeleben, Death Crates, Platzierung
  - **Lumos City** als echtes Straßenraster: Fahrbahnen mit Zebrastreifen, Gehwege mit Bordsteinen, Ampeln, Verkehrsschilder, Bushaltestellen, Bänke, Hydranten, Parkuhren, Müllcontainer, Pflanzkübel, Baustellen und Bäume. Straßenlaternen (einige flackern) und Fenster gehen in der Dämmerung an, bei Regen spiegeln die Straßen, aus Gullys und Schornsteinen steigt Rauch
  - **Altstadt** aus europäischen Backstein- und Giebelhäusern mit Rathaus, Eckläden und historischen Laternen, dazu ein **Stadtpark** mit Musikpavillon, Pavillons, Blumenbeeten, Trittsteinwegen und schmiedeeisernem Zaun. Am Hafen steht ein Bahnhof, am Flugfeld eine Glas-Arkade, auf dem Land Villa und Herrenhaus
  - Mülltonnen, Container und Paletten sind Physik-Objekte, die Autos, Schüsse und Explosionen umwerfen
- **Zombie Royale**: Battle Royale mit Zombie-Horden an den POIs. Gefallene Spieler erheben sich wieder.
- **Multiplayer** auf der 3-Lane-Map „Crossroads“: Team Deathmatch, Free-for-All, Capture the Flag und Search & Destroy. Mit taktischen Respawns, Scorestreaks (UAV, Care Package, Cluster Strike) und einer optionalen Nachtkarte mit Nachtsicht.
- **Zombies „Outpost 9“** (rundenbasiert):
  - Türen und Trümmer kaufen, Wall-Buys
  - Perks: Juggernog, Quick Revive, Speed Cola, Double Tap, Stamin-Up
  - Mystery Box, Strom-Generator, Pack-a-Punch, Elektrofalle
  - Power-ups: Max Ammo, Insta-Kill, Nuke, Double Points
  - Kopfschuss-Zerstückelung, Kriecher durch Beintreffer
  - Story-Easter-Egg mit Funk-Logs, Notsignal, Endwelle und Heli-Evakuierung

## Release-Candidate-Features

- **Echte Killcam**: Das Spiel zeichnet die letzten 9 Sekunden ständig in einem Ringpuffer auf (Positionen, Blickrichtung, Animationen, Waffen, Fahrzeuge, Schüsse, Einschläge, Explosionen und Sounds). Nach dem Tod läuft die Wiederholung aus der Sicht des Killers mit seinem Waffenmodell, Mündungsfeuer und Rückstoß, der tödliche Treffer in Zeitlupe. Mit Sprung oder Interagieren überspringen.
- **Ping-System**: Z / mittlere Maustaste / Steuerkreuz ↑. Kontextabhängig: Feind unter dem Fadenkreuz, Fahrzeug, Loot oder Ort, doppelt tippen = Gefahr. Marker in der Welt, am Bildschirmrand und auf der Minimap, wird im Team übers Netz geteilt, KI-Teammitglieder laufen zum Ping.
- **Medaillen**: Doppel-/Triple-/Multi-Kill, Serien, First Blood, Kopfschuss, Weitschuss, Rache, Kollateral, Überlebenskünstler und mehr, jeweils mit Bonus-XP.
- **Schadenszahlen** über getroffenen Gegnern (stapeln sich pro Ziel, gelb = Kopf, blau = Rüstung), abschaltbar in den Einstellungen.
- **Match-Statistik** am Ende: Kills, Schaden, Kopftreffer, Trefferquote, weitester Kill, Strecke zu Fuß und im Fahrzeug, Überlebenszeit, Medaillen.
- **Fotomodus** (Pausenmenü): freie Kamera, FOV und Neigung, Filter (Kino, Noir, Lebendig, Vintage, Nachtsicht, Wärmebild), Kinobalken und PNG-Screenshot.
- **Visier-Kalibrierung**: Für jede Waffe wird die Visierlinie aus der Modellgeometrie berechnet (Kimme/Korn, Lochkimmen werden erkannt). Bei Zielfernrohren, 3,5x- und Wärmebild-Optiken verschwindet das Waffenmodell beim Zielen vollständig, das Okular mit Absehen und Parallaxe-Schatten übernimmt.

## Grafik, Wetter und Atmosphäre

- **Atmosphären-Pass** (ab Medium, SSR-Schritte und Godray-Samples skalieren mit der Qualitätsstufe) auf dem Tiefenpuffer: Screen-Space-Reflections auf nassen Straßen und Pfützen (Raymarching mit Verfeinerung, rauigkeitsabhängige Unschärfe), exponentieller Höhennebel mit Sonnen-Streuung, Godrays durch Wolkenlücken und an Gebäudekanten, Blitz-Aufhellung
- **PBR-Materialien**: Metall/Rauigkeit pro Materialklasse abgestimmt, Lack mit Klarlack-Schicht auf Fahrzeugen (High/Ultra), Umgebungsreflexionen aus dem Himmel
- **Dynamisches Wetter** mit fließenden Übergängen: Sonnig, Bewölkt, Bedeckt, Nebel, Nieselregen, Regen, Gewitter und Hagel. Die Vorhersage folgt plausiblen Übergängen und wird aus dem Match-Seed erzeugt, ist online also für alle gleich. Dazu GPU-Regen und Hagel, Straßen, die nass werden und langsam wieder trocknen, Regentropfen auf dem Bildschirm bzw. Visier (nicht in geschlossenen Fahrzeugen), Blitze mit verzögertem Donner nach Entfernung, Windböen und eine prozedurale Regen- und Windgeräuschkulisse
- **Tag-Nacht-Zyklus**: Sternenhimmel mit Milchstraße, Mond mit Phasen und Mondlicht, warme Dämmerung, Straßenlaternen, die nacheinander angehen, leuchtende Fenster und eine weiche Taschenlampe bei Nacht
- **Lebendige Welt**: Vögel, die bei Schüssen auffliegen, Glühwürmchen nachts, Blätter, Staub und Müll bei Wind, Schornstein- und Gullyrauch, Funken. Die Kirchenglocke schlägt zur vollen Stunde, dazu Vogelgesang, Eulen und Brandung
- **Animationen**: realistisches Head-Bobbing im Schrittrhythmus inkl. Atmen (abschaltbar unter Einstellungen → Kopfbewegung), Kamera-Zucken bei Treffern aus der Trefferrichtung, Taumeln bei schweren Treffern, Schrittanimation beim Drehen auf der Stelle
- **Kollisionen**: Gebäude, Bordsteine, Pflanzkübel, Laternen und Schilder haben passgenaue Kollider, Fahrzeuge fahren über Bordsteine und stoppen an Fassaden, Loot liegt immer auf dem Boden statt in Dächern

## Fahrzeuge (30, alle fahr-, flieg- oder schwimmbar)

| Gruppe | Fahrzeuge |
|---|---|
| Autos | Sedan, Hatchback, SUV, 2 Sportwagen, Taxi, 2 Polizeiwagen, Classic 53, Muscle Car, Roadster, Jeep |
| Schwer | Sattelzug, Bus, Traktor, Golfcart, **Kampfpanzer** (Kanone), **Radpanzer** (MG) |
| Zweiräder und Hover | Motorrad, Fahrrad, Hovercar |
| Wasser | Jetski, Speedboot, Motorboot, **U-Boot** (tauchen mit Space/Ctrl) |
| Luft | Transport-Heli (MG), **Kampfhubschrauber** (Raketen), Rettungs-Heli, Propellerflugzeug, **Kampfjet** (Raketen) |

Die Landfahrzeuge nutzen Rapier-Raycast-Räder, Wasserfahrzeuge haben Auftrieb an vier Punkten, Helis und Flugzeuge ein Arcade-Flugmodell mit Strömungsabriss. Es gibt Schaden, Explosionen mit Wrack und Mitfahrer, die auf offenen Fahrzeugen schießen können.

## Steuerung

| Aktion | Tastatur / Maus | Controller (Xbox / PS / Lumos) |
|---|---|---|
| Bewegen / Zielen | WASD / Maus | linker / rechter Stick |
| Schießen / ADS | LMB / RMB | RT / LT |
| Springen, Klettern, Fallschirm öffnen/kappen | Space | A / ✕ |
| Ducken (beim Sprinten: Rutschen) | C / Ctrl | B / ◯ |
| Sprinten | Shift | L3 (Toggle) |
| Nachladen / Nutzen / Einsteigen | R / F | X / ▢ |
| Waffe wechseln | Mausrad / 1–3 | Y / △ |
| Granate (halten zeigt die Flugbahn) | G | LB / L1 |
| Messer | V | RB / R1 |
| Heilen / Panzerplatte | H / X | ← / ↓ |
| Lehnen | Q / E | – |
| Kamera 1st/3rd Person | T | R3 |
| Nachtsicht | N | View / Select |
| Ping (2× = Gefahr) | Z / mittlere Maustaste | ↑ |
| Scorestreak | B | → |
| Inspizieren / Emote | I / J | – |
| Atem anhalten (mit Zielfernrohr) | Shift | L3 |
| Fotomodus | Pausenmenü → Fotomodus (F: Filter, I: Kinobalken, Klick: Foto, Esc: zurück) | Pausenmenü (A: Foto) |
| Fahrzeug: Heli hoch / runter | Space / Ctrl | A / B oder RT / LT |
| Flugzeug: Schub, Neigen, Rollen | W/S, Pfeiltasten | Trigger, linker Stick |

**Touch:** Auf Smartphones und Tablets erscheint automatisch ein virtuelles Twin-Stick-Layout. **Gyro-Zielen** (Lumos Handheld, Steam Deck, Smartphone) lässt sich in den Einstellungen aktivieren. **Haptik** läuft über `vibrationActuator` (Dual-Rumble) bzw. `navigator.vibrate`. Die Tasten-Symbole passen sich automatisch an Xbox, PlayStation, Lumos oder Tastatur an.

## Architektur

```
src/
  core/      Engine (Loop, Fixed-Step, Dynamic Resolution Scaling, Post-FX-Kette, Grading NVG/Thermal/Unterwasser/Replay), Settings, Events
  fx/        AtmospherePass (SSR, Höhennebel, Godrays), Precipitation (GPU-Regen/Hagel), Effects (Partikel, Decals, Trümmer)
  assets/    AssetManager (Draco, Meshopt, KTX2, Lumos-CDN-Routing mit lokalem Fallback), Manifest + Normalisierung
  physics/   Rapier-Wrapper (Heightfield, Trimesh, Character Controller, Raycasts)
  input/     Tastatur/Maus, Gamepad API, Touch, Gyro, Haptik, Button-Glyphen
  audio/     Web Audio: HRTF-3D-Sound, vertikale Dämpfung, Engine-Loops, Musik-Crossfade
  world/     Terrain (Insel-Heightmap), Wasser, Himmel / Tag-Nacht, dynamisches Wetter, Stadt (Raster, Altstadt, Park), Straßenlicht, Ambient Life, Karten, Static Batching, Instanced Scatter + LOD
  entities/  CharacterModel (Layered Animation: Unter-/Oberkörper), Soldier, PlayerController, BotBrain (Utility-KI), Zombie + Flow-Field-NavGrid
  weapons/   17 Waffen, 12 Gunsmith-Aufsätze (3D am Modell), Projektil-Ballistik mit Fall, Durchschuss, Granaten
  vehicles/  30 Fahrzeugdefinitionen + Fahrzeugphysik (Land / Wasser / Luft)
  gameplay/  GameWorld, Mode-Basis, Loot, Replay (Ringpuffer + Killcam), Modi (BattleRoyale, Multiplayer, Zombies)
  ui/        Menü (Lobby 3D, Gunsmith, Operator, Battle Pass, Kisten, Karriere, Einstellungen), HUD, Touch
  net/       Backend (Lumos Cloud → Supabase → lokal), Profil/Progression, NetClient (WebSocket)
server/      WebSocket-Relay (Party-Räume per Code, Host-Migration, State/Snapshots/Events, Hits mit Clamping, Rate-Limit)
scripts/     Asset-Pipeline: process-assets, build-kit, build-pack-kit, build-lod, split-scene, build-characters, inspect-assets, build-credits
supabase/    schema.sql (profiles, matches, friends, party_invites + RLS)
```

**Performance für Low-End:**
- Qualitätsstufen Potato, Low, Medium, High und Ultra mit automatischer Erkennung
- Dynamische Auflösung (Render-Skalierung 60–100 %, das DOM-UI bleibt scharf)
- Static Batching (eine Mesh pro Material und Block), Instanced Vegetation in Chunks mit Distanz-Culling und dreistufigem LOD
- Gebäude-LOD pro Stadtblock, kleine Requisiten ohne Schattenwurf und mit Distanz-Culling, Charakter-LOD-Mesh am selben Skelett
- Straßenlaternen: nur die nächsten Lampen bekommen echte Punktlichter, alle anderen leuchten über einen einzigen Glow-Draw-Call
- Animations-LOD (entfernte Charaktere werden seltener aktualisiert), Physik-LOD für entfernte Bots
- Lambert-Materialien auf Low-Spec, Draco-Geometrie, WebP-Texturen (max. 1024 px)
- Shader-Warm-up hinter dem Ladebildschirm (alle Materialien inkl. Waffenmodell, ein Probe-Frame für die Fullscreen-Pässe), feste Lichteranzahl, damit Laternen beim Näherkommen keine Shader-Neukompilierung auslösen

## Backend und Schlüssel

Alles ist optional. Ohne Schlüssel speichert das Spiel lokal.

1. **Lumos Cloud** (Primär-Backend): `VITE_LUMOS_API` und `VITE_LUMOS_SESSION_TOKEN`, oder zur Laufzeit `window.LumosCloudSDK = { apiBase, sessionToken, cdnBase }`. Endpunkte: `GET /api/v1/lumos/user/profile`, `POST /api/v1/lumos/user/sync`, `GET /api/v1/lumos/user/friends`, `POST /api/v1/lumos/party/invite`.
2. **Supabase** (Fallback): `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY`. Dazu `supabase/schema.sql` ausführen und unter Auth die anonymen Logins aktivieren.
3. **Echtzeit**: läuft mit `npm run dev` automatisch mit (Vite reicht `/ws` an Port 8787 durch). Für einen separaten Server `VITE_REALTIME_URL=wss://host/ws` setzen.

## Assets neu erzeugen

Die Rohdaten (Sketchfab-GLB, itch.io-ZIPs) liegen nicht im Repo, nur die optimierten Dateien unter `public/assets`. Die Pipeline:

```bash
node scripts/process-assets.mjs <rawDir> public/assets/<kategorie> --tex 1024
node scripts/build-kit.mjs public/assets/kits/nature.glb --tex 512 <gltf...>
node scripts/build-characters.mjs UAL1.glb UAL2.glb public/assets/characters mannequin=...
node scripts/build-pack-kit.mjs cityprops.glb public/assets/kits/cityprops.glb --tex 512 --group "BusStop=BusStop_*"
node scripts/build-lod.mjs public/assets/kits/nature.glb public/assets/kits/nature_lod2.glb 0.03 0.4
# zusammengefügte Szenen (z. B. die European-Buildings-Pakete) in einzeln platzierbare Gebäude zerlegen:
# flacht die Hierarchie ab, gruppiert Meshes über überlappende Grundrisse, entfernt Bodenplatten,
# zentriert jedes Teil (Grundfläche auf y = 0) und benennt es; --report listet die gefundenen Teile
node scripts/split-scene.mjs eurobuild2.glb public/assets/kits/euro_a.glb --prefix eb2 --tol 0.3 --tex 1024 --keep "eb2_08=TownHall,eb2_15=BrickHouse_A,..."
npm run assets:credits
```
