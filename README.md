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
  - **Lumos City** als echtes Straßenraster: Fahrbahnen mit Zebrastreifen, Gehwege mit Bordsteinen, Ampeln, Bushaltestellen, Bänke, Hydranten, Parkuhren, Müllcontainer und Bäume. Straßenlaternen und Fenster gehen in der Dämmerung an, bei Regen glänzen die Straßen, aus Gullys steigt Dampf
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

- **Ping-System**: Z / mittlere Maustaste / Steuerkreuz ↑. Kontextabhängig: Feind unter dem Fadenkreuz, Fahrzeug, Loot oder Ort, doppelt tippen = Gefahr. Marker in der Welt, am Bildschirmrand und auf der Minimap, wird im Team übers Netz geteilt, KI-Teammitglieder laufen zum Ping.
- **Medaillen**: Doppel-/Triple-/Multi-Kill, Serien, First Blood, Kopfschuss, Weitschuss, Rache, Kollateral, Überlebenskünstler und mehr, jeweils mit Bonus-XP.
- **Schadenszahlen** über getroffenen Gegnern (stapeln sich pro Ziel, gelb = Kopf, blau = Rüstung), abschaltbar in den Einstellungen.
- **Match-Statistik** am Ende: Kills, Schaden, Kopftreffer, Trefferquote, weitester Kill, Strecke zu Fuß und im Fahrzeug, Überlebenszeit, Medaillen.
- **Fotomodus** (Pausenmenü): freie Kamera, FOV und Neigung, Filter (Kino, Noir, Lebendig, Vintage, Nachtsicht, Wärmebild), Kinobalken und PNG-Screenshot.
- **Visier-Kalibrierung**: Für jede Waffe wird die Visierlinie aus der Modellgeometrie berechnet (Kimme/Korn, Lochkimmen werden erkannt). Bei Zielfernrohren, 3,5x- und Wärmebild-Optiken verschwindet das Waffenmodell beim Zielen vollständig, das Okular mit Absehen und Parallaxe-Schatten übernimmt.

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
  core/      Engine (Loop, Fixed-Step, Dynamic Resolution Scaling, Post-FX NVG/Thermal/Unterwasser), Settings, Events
  assets/    AssetManager (Draco, Meshopt, KTX2, Lumos-CDN-Routing mit lokalem Fallback), Manifest + Normalisierung
  physics/   Rapier-Wrapper (Heightfield, Trimesh, Character Controller, Raycasts)
  input/     Tastatur/Maus, Gamepad API, Touch, Gyro, Haptik, Button-Glyphen
  audio/     Web Audio: HRTF-3D-Sound, vertikale Dämpfung, Engine-Loops, Musik-Crossfade
  world/     Terrain (Insel-Heightmap), Wasser, Himmel / Tag-Nacht / Wetter, Karten, Static Batching, Instanced Scatter + LOD
  entities/  CharacterModel (Layered Animation: Unter-/Oberkörper), Soldier, PlayerController, BotBrain (Utility-KI), Zombie + Flow-Field-NavGrid
  weapons/   17 Waffen, 12 Gunsmith-Aufsätze (3D am Modell), Projektil-Ballistik mit Fall, Durchschuss, Granaten
  vehicles/  30 Fahrzeugdefinitionen + Fahrzeugphysik (Land / Wasser / Luft)
  gameplay/  GameWorld, Mode-Basis, Loot, Modi (BattleRoyale, Multiplayer, Zombies)
  ui/        Menü (Lobby 3D, Gunsmith, Operator, Battle Pass, Kisten, Karriere, Einstellungen), HUD, Touch
  net/       Backend (Lumos Cloud → Supabase → lokal), Profil/Progression, NetClient (WebSocket)
server/      WebSocket-Relay (Party-Räume per Code, Host-Migration, State/Snapshots/Events, Hits mit Clamping, Rate-Limit)
scripts/     Asset-Pipeline: process-assets, build-kit, build-characters, inspect-assets, build-credits
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
- Shader-Warm-up vor dem Match

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
npm run assets:credits
```
