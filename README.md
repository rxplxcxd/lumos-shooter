# Lumos Strike

Browser-3D-Taktik-Shooter und Battle Royale mit Three.js (WebGL2) und Rapier (WASM-Physik). Optimiert für Lumos Handhelds, Controller und Low-End-Hardware, spielbar in jedem modernen Browser auf Desktop, Handheld und Smartphone.

> Alle 3D-Modelle, Sounds und die Musik stammen von **Sketchfab** und **itch.io**. Die vollständige Liste mit Autoren und Lizenzen steht in [CREDITS.md](CREDITS.md).

## Schnellstart

```bash
npm install
npm run dev          # öffnet http://localhost:5173
```

**GitHub Codespaces:** Repo im Codespace öffnen. `npm install` läuft automatisch (`.devcontainer`). Danach `npm run dev` starten. Port 5173 wird weitergeleitet und öffnet sich als Vorschau, für die beste Performance im eigenen Browser-Tab öffnen.

Weitere Befehle:

| Befehl | Zweck |
|---|---|
| `npm run dev` | Dev-Server (Vite, Hot Reload) |
| `npm run server` | Echtzeit-Relay-Server (WebSocket, Port 8787) |
| `npm run dev:all` | Dev-Server und Echtzeit-Server zusammen |
| `npm run build` / `npm run preview` | Produktions-Build nach `dist/` und lokale Vorschau |
| `npm run typecheck` | TypeScript-Prüfung |
| `/viewer.html?files=vehicles/tank,vehicles/jeep` | Asset-Viewer (Ausrichtung und Skalierung prüfen) |

Das Spiel läuft **komplett offline**. Supabase, Lumos Cloud und der Echtzeit-Server sind optional (siehe `.env.example`).

## Spielmodi

- **Battle Royale**: bis zu 100 Spieler (Spieler + KI-Bots). Solo, Duos, Trios, Quads sowie die Modifikatoren Nur Sniper, CQB, High-Tier-Loot und **Extraktion**. Dazu gehören:
  - Absetzflugzeug, Freifall und Fallschirm
  - Sturmzone in 6 Phasen
  - Loot mit Seltenheits-Lichtsäulen
  - Kaufstationen (Platten, Weste, UAV, Versorgungsabwurf, Teammitglied absetzen, Loadout-Drop)
  - Versorgungsabwürfe, Down-State und Wiederbeleben, Death Crates, Platzierung
- **Zombie Royale**: Battle Royale mit Zombie-Horden an den POIs. Gefallene Spieler erheben sich wieder.
- **Multiplayer** auf der 3-Lane-Map „Crossroads“: Team Deathmatch, Free-for-All, Capture the Flag und Search & Destroy. Mit taktischen Respawns, Scorestreaks (UAV, Care Package, Cluster Strike) und einer optionalen Nachtkarte mit Nachtsicht.
- **Zombies „Outpost 9“** (rundenbasiert):
  - Türen und Trümmer kaufen, Wall-Buys
  - Perks: Juggernog, Quick Revive, Speed Cola, Double Tap, Stamin-Up
  - Mystery Box, Strom-Generator, Pack-a-Punch, Elektrofalle
  - Power-ups: Max Ammo, Insta-Kill, Nuke, Double Points
  - Kopfschuss-Zerstückelung, Kriecher durch Beintreffer
  - Story-Easter-Egg mit Funk-Logs, Notsignal, Endwelle und Heli-Evakuierung

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
| Springen, Klettern | Space | A / ✕ |
| Ducken (beim Sprinten: Rutschen) | C / Ctrl | B / ◯ |
| Sprinten | Shift | L3 (Toggle) |
| Nachladen / Nutzen / Einsteigen | R / F | X / ▢ |
| Waffe wechseln | Mausrad / 1–3 | Y / △ |
| Granate (halten zeigt die Flugbahn) | G | LB / L1 |
| Messer | V | RB / R1 |
| Heilen / Panzerplatte | H / X | ← / ↓ |
| Lehnen | Q / E | – |
| Kamera 1st/3rd Person | T | R3 |
| Nachtsicht | N | ↑ |
| Scorestreak | B | → |
| Inspizieren / Emote | I / J | – |
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
server/      WebSocket-Relay (Räume, 20-Hz-State, Hits mit Clamping, Party-Invites)
scripts/     Asset-Pipeline: process-assets, build-kit, build-characters, inspect-assets, build-credits
supabase/    schema.sql (profiles, matches, friends, party_invites + RLS)
```

**Performance für Low-End:**
- Qualitätsstufen Potato, Low, Medium und High mit automatischer Erkennung
- Dynamische Auflösung (Render-Skalierung 60–100 %, das DOM-UI bleibt scharf)
- Static Batching (eine Mesh pro Material), Instanced Vegetation in Chunks mit Distanz-Culling und LOD-Wechsel
- Animations-LOD (entfernte Charaktere werden seltener aktualisiert), Physik-LOD für entfernte Bots
- Lambert-Materialien auf Low-Spec, Draco-Geometrie, WebP-Texturen (max. 1024 px)
- Shader-Warm-up vor dem Match

## Backend und Schlüssel

Alles ist optional. Ohne Schlüssel speichert das Spiel lokal.

1. **Lumos Cloud** (Primär-Backend): `VITE_LUMOS_API` und `VITE_LUMOS_SESSION_TOKEN`, oder zur Laufzeit `window.LumosCloudSDK = { apiBase, sessionToken, cdnBase }`. Endpunkte: `GET /api/v1/lumos/user/profile`, `POST /api/v1/lumos/user/sync`, `GET /api/v1/lumos/user/friends`, `POST /api/v1/lumos/party/invite`.
2. **Supabase** (Fallback): `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY`. Dazu `supabase/schema.sql` ausführen und unter Auth die anonymen Logins aktivieren.
3. **Echtzeit**: `npm run server` und `VITE_REALTIME_URL=ws://localhost:8787` (oder `?server=ws://host:8787`).

## Assets neu erzeugen

Die Rohdaten (Sketchfab-GLB, itch.io-ZIPs) liegen nicht im Repo, nur die optimierten Dateien unter `public/assets`. Die Pipeline:

```bash
node scripts/process-assets.mjs <rawDir> public/assets/<kategorie> --tex 1024
node scripts/build-kit.mjs public/assets/kits/nature.glb --tex 512 <gltf...>
node scripts/build-characters.mjs UAL1.glb UAL2.glb public/assets/characters mannequin=...
npm run assets:credits
```
