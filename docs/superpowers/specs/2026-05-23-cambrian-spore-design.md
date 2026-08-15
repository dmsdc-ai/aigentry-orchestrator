---
title: Cambrian Spore — Game Design Spec
date: 2026-05-23
status: draft (post-brainstorm, pre-review)
target: V1.0 (3-month MVP)
audience: parent (solo dev, first Godot project) + 10yo daughter (player + primary artist)
---

# Cambrian Spore — Game Design Spec

> Personal 2D side-project game. Player controls a tiny prehistoric creature, eats smaller creatures to grow XP, evolves up a branching tree from Cambrian to Devonian (MVP) with planned expansion through Mesozoic and Cenozoic. Inspired by Spore (Cell stage) + Tasty Blue + Maneater. Engine: Godot 4. Distribution: private only.

## 1. Concept

### Source inspiration
- Book: **"동글동글 귀여운 고생물 도감"** (Takahashi Nozomu / 다카하시 노조무, ISBN 979-11-89239-89-3, 14,000원, 고래가숨쉬는도서관 2022)
- Japanese original: ゆるかわ古生物図鑑 (Seitosha 2021)
- Art style: child-drawn pencil sketches — **11/13 species hand-drawn by daughter**, 2/13 generated via OpenAI gpt-image-1 with daughter's drawings as style reference (삼엽충 + 오파비니아)

### Core fantasy
"I am the smallest creature in the Cambrian sea. I eat smaller things to grow. I become a famous prehistoric monster. My encyclopedia fills up with my own drawings."

### Genre tags
- 2D top-down/side-view open-area swimmer
- Eat-to-grow / size-based predation (Spore Cell, Tasty Blue, Maneater, agar.io)
- Branching evolution (Pokemon Legends-style biome zones + Slay-the-Spire-style fork choice)
- No combat HP/blood — predation only (cute chomp animation)

### Target player
10-year-old daughter. Reads Korean fluently. Familiar with Animal Crossing / Pokemon / Stardew genre. Plays 15-30 min sessions.

---

## 2. World structure

**LOCKED: Option A — single ocean with depth gradient** (over 다중 시대 존 / 단일 맵 영역 분할).

### Layout
One large 2D open underwater map. Vertical depth = 5 zones. Player can move freely within accessible zones.

```
┌──── ☀️ 해수면 — T0 zone (spawn point, safe)
├──── 🌿 Shallow — T1-T2 zone (sea grass + sand)
├──── 🐚 Mid — T3 zone (coral, branching point)
├──── 🌑 Deep — T4 zone (darkness, apex prey)
├──── 🦈 Trench — T5 zone (boss tier, danger)
        ↓ T6 expansion (해변 / 석탄기)
```

### Access rule
- Player tier ≥ zone recommended tier → safe-ish (smaller creatures around)
- Player tier < zone recommended tier → predators spawn → death on contact (unless ability/dodge)
- Locked deepest zones gated until evolution unlocks them

### MVP simplification
- V0: Mid zone only (single screen)
- V0.5: All 5 zones with gating
- V1.0: Same 5 zones + V0.5 features

---

## 3. Controls + core gameplay loop

### Input (keyboard primary, gamepad optional)

| Action | Key | Gamepad | Function |
|---|---|---|---|
| Move | WASD / Arrows | Left stick | Free 8-direction swim |
| Auto-eat | (passive) | (passive) | Auto-chomp on contact with smaller creatures |
| Dash | Space | A | Burst movement (cooldown 2s) |
| Branch ability | Shift | B | T3+ unlocked. Shell / Dash+ / Strike per branch |
| Pause / Encyclopedia | Esc / Tab | Start / Select | Menu access |

3-button core (Move + Space + Shift). 10yo learns in 5 seconds.

### Size / eating rule (single source of truth: `EatingRule` module — see §9)

```
my_tier vs other_tier:
  my > other  → auto-eat (gain XP, chomp animation)
  my == other → ignore (mutual non-predation)
  my < other  → danger (contact = eaten → respawn)
                Exception: STRIKE ability can eat same-tier 1× per cooldown
```

### Branch abilities (3 total, NOT 13 — one per branch)

| Branch | Ability | Effect |
|---|---|---|
| 🛡️ Defender (T3a / T4a / T5a) | **Shell** | Hold button = invulnerable + immobile. 2s duration, 5s cooldown |
| 💨 Balanced (T3c / T4c / T5c) | **Dash+** | 2× normal dash distance, short i-frames |
| ⚔️ Predator (T3b / T4b / T5b) | **Strike** | Forward charge + eat 1 same-tier creature. 8s cooldown |

T0-T2 (linear): no special ability. Just movement + auto-eat.

### Core loop (~15s per cycle)

```
spawn → swim → find smaller prey → contact (auto-chomp) → XP gain (+N)
  → repeat 5-10× → XP bar 100% → game pause → evolution screen
  → choose branch (or next tier) → animation 2-3s → new tier
  → new ability/zone unlocked → continue
```

### Session pacing target
- Tier transition: 2-15 min per tier (faster early, slower later)
- T0 → T5 single playthrough: ~40-60 min first time, ~30 min replays
- Full completion (3 branches + convergence): ~3-4 hours
- 10yo daughter target: 15-min sessions × 3-4 to reach T5 first time

### Death handling
- Eaten by larger creature → screen dims + "🥲 잡혀먹혔어!" (1.5s)
- Respawn at last evolved tier (no regression), safe nearest depth zone
- XP penalty: -30% of progress toward next evolution (mild)
- "Chicken mode" setting: 0 penalty (for frustrated sessions)

---

## 4. Evolution UX

### Trigger
XP bar 100% → game pauses → chime → "🎉 진화 가능!" banner (1.5s) → evolution screen.

### Evolution screen variants

**Case 1: Linear (T0→T1, T1→T2)**
Single large card. "✨ 자랐어! → [할루키게니아 card] → click to confirm"

**Case 2: T2 branch point (MOST IMPORTANT decision)**
- Title: "어떤 모습으로 자랄래?"
- Diet analysis bars (defender/balanced/predator food eaten %)
- ⭐ recommended branch flagged (based on diet)
- 3 cards side-by-side: daughter's drawing + name + ability + 1-line stats
- Free choice (override recommendation OK)

**Case 3: T3→T4, T4→T5 (within branch + cross-routes)**
- 2-3 cards (next tier in branch + optional convergence T5c shark)
- MVP simplification: T4→T5 always shows 2 cards (own branch T5 + T5c shark) — "I can become a shark!"

### Animation (2-3s)
1. Previous form glows (white halo)
2. Brief white wash
3. New form appears (slightly larger, daughter's PNG)
4. Camera zoom in → out
5. Chime + "✨ <species> 으로 진화!" toast (2s)

### Post-evolution feedback
- First-time: tutorial popup for new ability (5s auto-close)
- Zone unlock notification + minimap highlight

### Encyclopedia (도감) auto-update
- Book-page-flip animation
- "새 페이지 추가! [daughter's drawing + species name + 1-line description]"
- Tab key opens encyclopedia anytime
- Undiscovered species shown as silhouettes ("?")

### Branching mechanic decision (MVP simplification — see §9 §EvolutionDirector)
- Branch choice = explicit player tap (always visible)
- Diet analysis = recommendation hint only (never forced)
- Convergence (T5c shark) = always-present card at T4→T5 (no hidden conditions)

---

## 5. UI / HUD

### Principles (10yo readable)
- Minimal HUD (don't obscure gameplay)
- Pictograms > text where possible
- Paper-beige + pencil-gray palette (matches book + daughter's art)
- Korean font: handwriting-style free font (온글잎 / TmoneyRoundWind)

### HUD elements

| Position | Element | Purpose |
|---|---|---|
| Top-left | Species thumbnail + label | "who am I" |
| Top-center | XP bar (horizontal) | progress to next evolution |
| Left vertical | Depth gauge (5 segments + current marker) | "where am I" |
| Bottom-right | Ability button + cooldown ring | shell/dash/strike state |
| Screen edges | ⚠️ red arrow toward nearby predator | danger warning |
| Bottom-center | Transient tutorial hint (5s fade) | first-use only |
| Top-right | 📖 encyclopedia button (Tab) | quick access |

### Color palette
- HUD background: `#f5edd8` (paper beige)
- Text: `#3a3520` (dark gray)
- XP bar fill: `#e89858` (daughter's Dunkleosteus orange!)
- Danger: `#c44a4a` (muted red, not screaming)
- Buttons: rounded + soft shadow + white fill

### Pause menu (Esc)
- 🌳 Evolution tree (current state + locked nodes as silhouettes)
- 📖 Encyclopedia
- ⚙️ Settings: BGM/SFX volume separate, chicken mode toggle, font size
- 🚪 Exit (auto-save first)

### First-launch tutorial (30s, skippable)
6 panels × 5s each: move / eat / dodge / dash / grow / start.

---

## 6. Audio

### BGM (3 tracks rotation, MVP)
- **Shallow** — peaceful piano + marimba (☀️🌿)
- **Deep** — neutral cello + synth pad (🌑)
- **Danger** — 10s tom-drum loop, fades in when predator nearby

Each 90s-3min loop. Crossfade transitions.

### SFX (~15 sounds for V1.0, ~5 for V0)
Movement loop, chomp, XP gain, dash whoosh, shell shink, strike swing, damage, eaten, respawn, evolve fanfare, page flip, menu hover, menu click, danger chime, zone enter.

### Sources (free / safe)
- BGM: incompetech.com (CC BY 4.0) / Pixabay Music (free commercial) / Suno AI (generative, ~$10/mo)
- SFX: freesound.org (CC0 filter) / Kenney Audio Packs (CC0)
- Foley: phone recordings of own voice/water/paper

### Voice — NOT in MVP
V0/V0.5/V1.0 text only. V1.5+ option: daughter's voice recording for species names ("암모나이트!") — sentimental layer.

---

## 7. Save / load

### Principles
- Single save slot (no manual save UX)
- Auto-save on milestones (no user burden)
- 1 backup file (.bak) for corruption recovery

### Auto-save triggers
- After evolution
- After death/respawn
- On exit / pause-close
- Every 60s (background fade)
- On zone change

### Save format
JSON at `user://save.json` + `user://save.bak.json`.

```json
{
  "version": "1.0",
  "current": {
    "tier": "T3a",
    "species_id": "ammonite",
    "branch": "defender",
    "xp": 47,
    "xp_to_next": 100,
    "position": { "depth_zone": "mid", "x": 450, "y": 320 },
    "playtime_sec": 1847
  },
  "encyclopedia": { "discovered": ["plankton", "hallucigenia", ...], "total": 13 },
  "evolution_history": {
    "completed_paths": ["defender_partial"],
    "branch_choices_taken": [{ "from": "T2", "to": "T3a", "ts": 1747... }]
  },
  "settings": { "bgm_volume": 0.7, "sfx_volume": 0.9, "chicken_mode": false, "font_size": "medium" },
  "stats": { "death_count": 3, "total_evolutions": 4, "first_played_at": "...", "last_played_at": "..." }
}
```

### OS locations
- macOS: `~/Library/Application Support/Godot/app_userdata/cambrian-spore/`
- Windows: `%APPDATA%/Godot/app_userdata/cambrian-spore/`
- Linux: `~/.local/share/godot/app_userdata/cambrian-spore/`

### Recovery
1. Try `save.json` → success: load
2. Fall back to `save.bak.json`
3. Both fail: friendly notice "저장 파일 못 찾았어. 새로 시작할게!" → new game (never silent restart)

### Title screen
- ▶ Continue (with tier + XP shown) if save exists
- 🆕 New game (always available, confirms overwrite)
- ⚙️ Settings
- 📖 Encyclopedia view (unlocked species)

---

## 8. MVP scope cut (3-tier release)

### V0 (Alpha) — 3-4 weeks
**Goal**: validate "does daughter want to play this?"

**IN**:
- 3 species only: T0 플랑크톤 → T1 할루키게니아 → T2 삼엽충
- Linear progression (no branching)
- 1 depth zone (Mid)
- 1 ability (dash, Space)
- Simple AI (wander / chase / flee)
- 1 predator type on screen (둔클레오스테우스 — danger only)
- Instant respawn (no save)
- Minimal HUD (species label + XP bar only)
- 1 BGM + 5 SFX
- "Start" button title (no menus)

**OUT**: branching, T3-T6 species, shell/strike, other 4 zones, save/load, encyclopedia, pause menu, full evolution screen, audio variety, statistics, tutorial.

### V0.5 (Beta) — +3-4 weeks
**Goal**: validate "does daughter finish first playthrough? want to play again?"

**ADDED to V0**:
- Species: T3b 광익류 → T4b 아노말로카리스 → T5b 둔클레오스테우스 → T6 이크티오스테가 (predator path full set, daughter-drawn)
- Single path (no branching, T2 always → T3b)
- All 5 depth zones with gating
- Evolution screen + animation
- Encyclopedia (discovered = daughter's drawings)
- Save/load (single slot)
- Title screen (continue button)
- Pause menu (encyclopedia/settings/exit)
- 2 BGM + 10 SFX
- 30s tutorial

### V1.0 (Full MVP) — +4-6 weeks
**Goal**: validate "replayability — does daughter try other branches?"

**ADDED to V0.5**:
- T2 branch system (defender/balanced/predator 3-way choice)
- Remaining 6 species: 암모나이트, 마렐라, 오쏘세라스, 오파비니아, 클라도셀라키, 앵무조개 (total 13)
- Shell + Strike abilities (branch-specific)
- Convergence node (T5c 클라도셀라키 — accessible from any branch)
- Cross-routes at T4→T5
- Encyclopedia full + "너의 여정" stats card
- 3 BGM + 15 SFX
- Danger BGM fade-in system
- Zone-specific ambience
- Settings: chicken mode + font size

### V1.5+ (Expansion, 6mo-1yr roadmap)
T7 메가네우라 → T8 디메트로돈 → T9-10 dinosaurs → T11 모사사우루스 → T12-13 신생대. Daughter draws each new addition.

### Scope comparison

| Element | V0 | V0.5 | V1.0 |
|---|---|---|---|
| Species | 3 | 7 | 13 |
| Branching | ✗ | ✗ (single) | ✓ 3-way + convergence |
| Depth zones | 1 | 5 | 5 |
| Abilities | 1 (dash) | 1 | 3 |
| Save | ✗ | ✓ | ✓ |
| Encyclopedia | ✗ | ✓ | ✓ full |
| BGM tracks | 1 | 2 | 3 |
| SFX | 5 | 10 | 15 |
| Pause menu | ✗ | ✓ basic | ✓ full |
| Dev weeks | 3-4 | +3-4 | +4-6 |
| Cumulative | 1mo | 2mo | 3mo |

---

## 9. Technical architecture (Godot 4, with 5 deepening refinements applied)

### Folder structure

```
cambrian-spore/
├── project.godot                # Godot project config
├── icon.svg                     # Game icon
├── README.md                    # Dev notes
├── .gitignore                   # Godot standard
│
├── scenes/                      # .tscn files
│   ├── main_menu.tscn
│   ├── game.tscn                # Main gameplay
│   ├── player.tscn              # Player (instantiable)
│   ├── prey.tscn                # AI prey (instantiable)
│   ├── predator.tscn            # AI predator (instantiable)
│   ├── evolution_screen.tscn    # Evolution UI overlay
│   ├── encyclopedia.tscn        # 도감
│   └── pause_menu.tscn
│
├── scripts/                     # GDScript (.gd)
│   ├── player.gd                # Movement + ability invocation (state owner)
│   ├── creature_ai.gd           # AI behavior composer (V1.0+: Strategy pattern)
│   ├── behaviors/               # V1.0+ (V0/V0.5: inlined in creature_ai.gd)
│   │   ├── wander_behavior.gd
│   │   ├── flee_behavior.gd
│   │   ├── chase_behavior.gd
│   │   └── hide_behavior.gd
│   ├── eating_rule.gd           # ⭐ DEEPENING 1: SSOT for predation logic
│   ├── evolution_director.gd    # ⭐ DEEPENING 2: pure logic, decides cards to show
│   ├── evolution_history.gd     # ⭐ DEEPENING 3: replaces GameManager (branch choices)
│   ├── encyclopedia.gd          # ⭐ DEEPENING 3: replaces GameManager (discovered species)
│   ├── save_system.gd           # JSON save/load (uses Saveable interface)
│   ├── audio_manager.gd         # BGM crossfade + SFX trigger
│   ├── species_data.gd          # @tool Resource class definition
│   ├── depth_zone.gd            # ⭐ DEEPENING 5: Resource class (V0.5+)
│   ├── evolution_graph.gd       # ⭐ DEEPENING 2: Resource class (pure topology)
│   └── hud/                     # Widget split (V0.5+)
│       ├── xp_bar.gd
│       ├── depth_gauge.gd
│       └── ability_button.gd
│
├── data/                        # .tres resources
│   ├── species/                 # 13 SpeciesData files
│   │   ├── t0_plankton.tres
│   │   ├── ... (13 total)
│   ├── evolution_graph.tres     # ⭐ DEEPENING 2: tree topology (data only)
│   └── depth_zones/             # ⭐ DEEPENING 5: 5 DepthZone files (V0.5+)
│       ├── surface.tres
│       ├── shallow.tres
│       ├── mid.tres
│       ├── deep.tres
│       └── trench.tres
│
├── art/                         # PNG assets
│   ├── creatures/               # Daughter's drawings (11) + GPT (2) = 13 PNG
│   │   ├── t0_plankton.png      # (GPT-generated TBD)
│   │   ├── t1_hallucigenia.png  # daughter
│   │   ├── t2_trilobite.png     # GPT
│   │   ├── ... (13 total)
│   ├── ui/
│   ├── backgrounds/
│   └── fonts/
│
├── audio/
│   ├── bgm/                     # .ogg
│   │   ├── shallow.ogg
│   │   ├── deep.ogg
│   │   └── danger.ogg
│   └── sfx/                     # .wav
│
└── tests/                       # Optional GUT framework
    ├── test_eating_rule.gd      # Pure logic — easy to test
    ├── test_evolution_director.gd
    └── test_save_system.gd
```

### Architectural refinements (applied from architecture review)

#### Refinement 1 — `EatingRule` extraction (V0 onward)
**Problem solved**: Predation logic was duplicated in `player.gd` (player eats prey) and `creature_ai.gd` (predator eats player). Single point of truth.

**Module**: `scripts/eating_rule.gd` — static class with pure function:
```gdscript
class_name EatingRule
extends RefCounted

static func can_eat(eater_tier: int, prey_tier: int, eater_strike_active: bool = false) -> bool:
    if eater_tier > prey_tier: return true
    if eater_strike_active and eater_tier == prey_tier: return true
    return false
```

**Seam**: every eating decision (Player auto-eat, AI predator contact, Strike ability) routes through `EatingRule.can_eat()`. Tests cover all tier permutations + ability combinations.

#### Refinement 2 — `EvolutionTree` 3-layer split (V0.5 onward)
**Problem solved**: Topology / decision logic / UI presentation each have different change rates and testability requirements.

**Modules**:
- `data/evolution_graph.tres` — `EvolutionGraph` Resource. Pure topology data (nodes + edges + recommendation weights). Designer-editable.
- `scripts/evolution_director.gd` — `EvolutionDirector` pure logic. Given graph + diet stats + current tier, returns array of cards to show. Pure function, no UI dependencies.
- `scenes/evolution_screen.tscn` + `scenes/evolution_screen.gd` — UI only. Receives card array from Director, renders.

**Seam**: `Director.decide_options(graph, current_tier, diet_stats) -> Array[EvolutionOption]`. Test all branch + diet combinations without UI instantiation.

#### Refinement 3 — `GameManager` removed (V0 onward)
**Problem solved**: Avoids God Object accumulation from day 1.

**Replacement distribution**:
- Current tier / XP / species / position → `Player` node (`@export` properties, single SSOT, no sync needed)
- Branch choice history → `EvolutionHistory` (Autoload, single responsibility)
- Discovered species → `Encyclopedia` (Autoload, single responsibility)
- Run-wide statistics (deaths, playtime) → `Encyclopedia.stats` (or separate `Stats` Autoload if grows)

**Result**: No global state container. Each piece of state has a natural owner.

#### Refinement 4 — `CreatureAI` Behavior Strategy split (V1.0 onward)
**Problem solved**: Prevents `if tier == X: ... elif tier == Y: ...` explosion as AI behaviors accumulate.

**Modules** (V1.0):
- `scripts/behaviors/wander_behavior.gd` — `Behavior` interface implementations
- `scripts/behaviors/flee_behavior.gd`
- `scripts/behaviors/chase_behavior.gd`
- `scripts/behaviors/hide_behavior.gd`

**Composition**: `CreatureAI` becomes composer — given current context (own tier, player tier, distance, ability state), selects active Behavior. Each Behavior is pure function `step(delta, context) -> velocity`.

**V0/V0.5 NOTE**: This refinement is `hypothetical seam` per architecture skill. V0 inlines behaviors in `creature_ai.gd` (1 adapter = no seam). When 2nd behavior surfaces in V0.5+ — extract.

#### Refinement 5 — `DepthZone` Resource (V0.5 onward)
**Problem solved**: Avoids depth y-range hardcoding scattered across player.gd / spawner / hud.gd / audio_manager.gd.

**Module**: `scripts/depth_zone.gd` — `DepthZone` Resource:
```gdscript
class_name DepthZone extends Resource
@export var id: String                       # "mid"
@export var y_min: float
@export var y_max: float
@export var safe_for_tiers: Array[int]
@export var ambient_color: Color
@export var bgm: AudioStream
@export var spawnable_species: Array[SpeciesData]
```

**Data**: `data/depth_zones/*.tres` — 5 files (V0.5+). V0 has 1 zone, no abstraction needed yet.

**Seam**: zone-relevant code (Player.get_current_zone(), Spawner.spawn_in_zone(), HUD.update_depth(), AudioManager.zone_changed()) all reference `DepthZone` resources, never hardcode y-ranges.

### Autoload (Project Settings → Autoload, V1.0 final)

| Name | Script | Responsibility |
|---|---|---|
| `SaveSystem` | save_system.gd | JSON serialize/deserialize, backup management |
| `AudioManager` | audio_manager.gd | BGM crossfade + SFX trigger |
| `EvolutionHistory` | evolution_history.gd | Branch choices taken (per save) |
| `Encyclopedia` | encyclopedia.gd | Discovered species + stats |

**Removed from S9**: GameManager (refinement 3).

### Scene tree — game.tscn (V1.0)

```
Game (Node2D)
├── World (Node2D)
│   ├── Background (TextureRect)
│   ├── Seafloor (StaticBody2D)
│   ├── Particles (CPUParticles2D)
│   └── Creatures (Node2D)
│       ├── Player (instance of player.tscn)
│       └── ... (dynamically spawned)
├── Camera (Camera2D)
├── HUD (CanvasLayer)
│   ├── TopBar (Control)
│   │   ├── SpeciesThumbnail
│   │   ├── SpeciesLabel
│   │   └── XPBar (instance of xp_bar.tscn)
│   ├── DepthGauge (instance of depth_gauge.tscn)
│   ├── AbilityButton (instance of ability_button.tscn)
│   └── TutorialHint (Label)
├── AudioPlayers (Node)
│   ├── BGM (AudioStreamPlayer)
│   ├── BGMDanger (AudioStreamPlayer)
│   └── SFXPool (Node + 4× AudioStreamPlayer)
├── EvolutionOverlay (CanvasLayer, hidden — instance of evolution_screen.tscn)
└── PauseMenu (CanvasLayer, hidden)
```

### Scene tree — player.tscn / prey.tscn / predator.tscn (shared shape)

```
Creature (CharacterBody2D)
├── Sprite (Sprite2D)               # daughter's PNG
├── EatHitbox (Area2D)              # smaller hitbox, signals when this creature eats
│   └── CollisionShape2D
├── BodyHitbox (Area2D)             # larger hitbox, signals when this creature is eaten
│   └── CollisionShape2D
├── DetectionRange (Area2D)         # AI only — for flee/chase decisions
│   └── CollisionShape2D
└── AnimationPlayer                 # chomp/idle/evolve
```

### `SpeciesData` Resource (data bag)

```gdscript
class_name SpeciesData
extends Resource

@export var id: String                    # "t3a_ammonite"
@export var name_ko: String               # "암모나이트"
@export var name_en: String               # "Ammonite"
@export var tier: int                     # 3
@export var branch: String                # "defender" / "balanced" / "predator" / "linear"
@export var sprite: Texture2D
@export var size_px: float                # 96
@export var speed: float                  # 80
@export var xp_to_evolve: int             # 400
# Removed (moved to other modules per architecture review):
# - eats_tiers / eaten_by_tiers → EatingRule (computed from tier comparison)
# - ability → derived from `branch` field (defender=shell, etc.)
# - depth_zone_pref → DepthZone.spawnable_species (inverted reference)
```

### Development environment setup (Day 1)

1. Download Godot 4.5 (https://godotengine.org/download) — Mac/Win free
2. Create project + mkdir folder structure
3. Git init + `.gitignore` (Godot official template)
4. First scene: `main_menu.tscn` (Label + Button)
5. F5 to run → window opens = setup OK

### Daughter art digitization workflow

1. Re-photograph each drawing (natural light, clean white background)
2. `remove.bg` (free, https://www.remove.bg/) → transparent PNG background removal
3. Standardize size: 1024×1024 canvas, creature centered
4. Godot import: `art/creatures/` → set Filter to "Nearest" (pencil lines crisp)
5. Naming: `t0_plankton.png`, `t1_hallucigenia.png`, etc. (matches species_data.tres IDs)

This is parallelizable to game-code work (parent or separate session).

### Build / distribute

- Dev: F5 / F6 to run
- Build: Project → Export → Mac/Win/Linux → 1-click
- Output: `.app` (Mac), `.exe` (Win), executable (Linux)
- Distribution: copy to daughter's laptop, double-click

---

## Appendix A: Reference materials (from dustcraw research 2026-05-23)

### Paleontology anatomy (one-stop sources)
- ROM Burgess Shale Gallery — Cambrian species: https://burgess-shale.rom.on.ca/en/fossil-gallery/
- Prehistoric-Wildlife.com — all eras: http://www.prehistoric-wildlife.com/species.html
- Wikipedia per-species: see `state/research/2026-05-23-paleogame-refs.md` §3

### Style-related illustrators (for V1.5+ if needed)
- Takahashi Nozomu (source book): https://x.com/T_marohiko · https://note.com/t_marohiko
- Closest yurui style cousins: Atamoto (タヌキとキツネ), Sakate Shunsuke, 横溝友里 (Sumikko Gurashi)

### Audio sources (CC0 / free commercial)
- BGM: Pixabay Music, incompetech.com (CC BY)
- SFX: freesound.org (CC0 filter), Kenney Audio Packs

### Commission baseline (if scope expands beyond daughter+GPT in future)
- Korean market: 크몽 theG (gig 384345) DELUXE tier ~250K KRW per character set
- Source: `state/research/2026-05-23-paleogame-refs.md` §5

## Appendix B: Open questions deferred

1. **Save format versioning** — when V0 → V0.5 schema changes, how to migrate? Current spec says "version: 1.0" string but no migration plan. Decision: write migration shim on first schema break.
2. **Daughter's voice recording for species names** — V1.5+ option, deferred.
3. **Multi-language** — Korean only for MVP. If shared with friends later, EN translation requires UI font swap.
4. **Accessibility** — colorblind mode, large-text mode (font_size setting already in save schema as placeholder).
5. **Telemetry** — none. Personal game, no analytics.
6. **Game name finalization** — "Cambrian Spore" is working title. Daughter should name it (sentimental hook).

## Appendix C: Project artifact paths (orchestrator-side, will move when game scaffolded)

- This spec: `docs/superpowers/specs/2026-05-23-cambrian-spore-design.md`
- Visual mockups (HTML): `.superpowers/brainstorm/70686-1779540471/`
- Daughter's drawings: parent's phone (not yet copied to repo)
- GPT-generated drawings: `state/research/paleogame-imagegen-test/01-trilobite.png`, `02-opabinia.png`
- Research outputs: `state/research/2026-05-23-paleogame-refs.md`
- Dispatch refs: `state/dispatch/2026-05-23-paleogame-*.md`

When game project is scaffolded (`/Users/duckyoungkim/projects/cambrian-spore/`):
- Move this spec to `<game-project>/docs/design.md`
- Move mockups + research to `<game-project>/design/`
- Daughter's PNGs to `<game-project>/art/creatures/`
- GPT PNGs same (with note: GPT-generated for T2 + T4c)
