/*
 * autoplay.js — Auto-play bot engine for WASM Pokemon Red.
 *
 * Reads Game Boy memory via the binjgb WASM module to understand game state
 * and sends joypad inputs to play the game automatically.  Based on the
 * combat logic from PokeBot (https://github.com/bouletmarc/PokeBot).
 *
 * Usage:
 *   const bot = new Autoplay(module, emulatorHandle);
 *   bot.start();     // begin auto-play
 *   bot.stop();      // stop
 *   bot.toggle();    // toggle on/off
 *   bot.getStatus(); // { active, state, pokemon, opponent, ... }
 */
"use strict";

/* ===================================================================
 * 1. MEMORY ADDRESS CONSTANTS
 * =================================================================== */

/**
 * Pokemon Red WRAM addresses on the Game Boy system bus.
 * PokeBot uses BizHawk WRAM-domain offsets (e.g. 0x1362); the system bus
 * equivalent is 0xC000 + offset (e.g. 0xD362).
 */
const ADDR = {
  // -- Game state --
  MAP_ID:           0xD35E,
  BATTLE_TYPE:      0xD057,  // 0=none, 1=wild, 2=trainer
  TEXTBOX:          0xCFC4,  // 1 when textbox active
  LOW_HEALTH_ALARM: 0xCFC9,
  WALK_COUNTER:     0xCFC5,  // counts down during tile walk

  // -- Player position --
  PLAYER_Y:         0xD361,
  PLAYER_X:         0xD362,
  PLAYER_FACING:    0xD52A,  // 0=down, 4=up, 8=left, 0xC=right
  PLAYER_MOVING:    0xD528,  // non-zero while walking

  // -- Party --
  PARTY_SIZE:       0xD163,
  PARTY_START:      0xD16B,  // first pokemon species byte
  PARTY_STRUCT_SIZE: 0x2C,   // 44 bytes per pokemon

  // -- Menu --
  MENU_ROW:         0xCC26,
  MENU_COL:         0xCC25,
  BATTLE_MENU_POS:  0xCC2D,  // cursor position in battle menu
  MENU_CURRENT:     0xCC36,
  SUBMENU_ITEM:     0xCC28,

  // -- Active battle pokemon (ours) --
  OUR_ID:           0xD014,
  OUR_HP_HI:        0xD015,
  OUR_HP_LO:        0xD016,
  OUR_STATUS:       0xD018,
  OUR_TYPE1:        0xD019,
  OUR_TYPE2:        0xD01A,
  OUR_MOVES:        0xD01C,   // 4 consecutive bytes
  OUR_LEVEL:        0xD022,
  OUR_MAX_HP_HI:    0xD023,
  OUR_MAX_HP_LO:    0xD024,
  OUR_ATK_HI:       0xD025,
  OUR_ATK_LO:       0xD026,
  OUR_DEF_HI:       0xD027,
  OUR_DEF_LO:       0xD028,
  OUR_SPD_HI:       0xD029,
  OUR_SPD_LO:       0xD02A,
  OUR_SPC_HI:       0xD02B,
  OUR_SPC_LO:       0xD02C,
  OUR_PP:           0xD02D,   // 4 consecutive bytes

  // -- Active battle pokemon (opponent) --
  OPP_ID:           0xCFE5,
  OPP_HP_HI:        0xCFE6,
  OPP_HP_LO:        0xCFE7,
  OPP_TYPE1:        0xCFEA,
  OPP_TYPE2:        0xCFEB,
  OPP_MOVES:        0xCFED,   // 4 consecutive bytes
  OPP_LEVEL:        0xCFF3,
  OPP_MAX_HP_HI:    0xCFF4,
  OPP_MAX_HP_LO:    0xCFF5,
  OPP_ATK_HI:       0xCFF6,
  OPP_ATK_LO:       0xCFF7,
  OPP_DEF_HI:       0xCFF8,
  OPP_DEF_LO:       0xCFF9,
  OPP_SPD_HI:       0xCFFA,
  OPP_SPD_LO:       0xCFFB,
  OPP_SPC_HI:       0xCFFC,
  OPP_SPC_LO:       0xCFFD,

  // -- Inventory --
  INVENTORY_COUNT:   0xD31D,
  INVENTORY_START:   0xD31E,  // 2 bytes each: (item_id, quantity)

  // -- Playtime --
  PLAY_HOURS:        0xDA41,
  PLAY_MINUTES:      0xDA43,
  PLAY_SECONDS:      0xDA44,

  // -- Dialog / options --
  OPTION_DIALOGUE:   0xD125,
  TEXT_SPEED:        0xCD3D,
  CURSOR_TILE:       0xC4F2,

  // -- Battle sub-state flags --
  BATTLE_TURN:       0xCCD5,  // whose turn it is
  ANIM_PLAYING:      0xCF07,  // 1 while attack animation plays

  // -- Misc --
  AUDIO_BANK:        0xC0EF,
  WRAM_BANK:         0xFF70,
};

/* ===================================================================
 * 2. GEN 1 TYPE SYSTEM
 * =================================================================== */

/** Game Boy internal type IDs → type name. */
const TYPE_IDS = {
  0x00: "normal",
  0x01: "fighting",
  0x02: "flying",
  0x03: "poison",
  0x04: "ground",
  0x05: "rock",
  0x07: "bug",
  0x08: "ghost",
  0x14: "fire",
  0x15: "water",
  0x16: "grass",
  0x17: "electric",
  0x18: "psychic",
  0x19: "ice",
  0x1A: "dragon",
};

/** Numeric indices used internally for the type chart matrix. */
const TYPE_INDEX = {
  normal:   0,
  fighting: 1,
  flying:   2,
  poison:   3,
  ground:   4,
  rock:     5,
  bug:      6,
  ghost:    7,
  fire:     8,
  water:    9,
  grass:   10,
  electric:11,
  psychic: 12,
  ice:     13,
  dragon:  14,
};

/**
 * Gen 1 type effectiveness chart — 15 × 15 matrix.
 * Rows = attacking type, Columns = defending type.
 * 0 = immune, 0.5 = not very effective, 1 = normal, 2 = super effective.
 */
const TYPE_CHART = [
  //             NOR FIG FLY POI GND ROC BUG GHO FIR WAT GRA ELE PSY ICE DRA
  /* normal   */[1,  1,  1,  1,  1, .5,  1,  0,  1,  1,  1,  1,  1,  1,  1],
  /* fighting */[2,  1, .5, .5,  1,  2, .5,  0,  1,  1,  1,  1,  1,  2,  1],
  /* flying   */[1,  2,  1,  1,  1, .5,  2,  1,  1,  1,  2, .5,  1,  1,  1],
  /* poison   */[1,  1,  1, .5, .5, .5,  2, .5,  1,  1,  2,  1,  1,  1,  1],
  /* ground   */[1,  1,  0,  2,  1,  2, .5,  1,  2,  1, .5,  2,  1,  1,  1],
  /* rock     */[1, .5,  2,  1, .5,  1,  2,  1,  2,  1,  1,  1,  1,  2,  1],
  /* bug      */[1, .5, .5, .5,  1,  1,  1, .5,  .5, 1,  2,  1,  2,  1,  1],
  /* ghost    */[0,  1,  1,  1,  1,  1,  1,  2,  1,  1,  1,  1,  0,  1,  1],
  /* fire     */[1,  1,  1,  1,  1, .5,  2,  1, .5, .5,  2,  1,  1,  2,  .5],
  /* water    */[1,  1,  1,  1,  2,  2,  1,  1,  2, .5, .5,  1,  1,  1, .5],
  /* grass    */[1,  1, .5, .5,  2,  2, .5,  1, .5,  2, .5,  1,  1,  1, .5],
  /* electric */[1,  1,  2,  1,  0,  1,  1,  1,  1,  2, .5, .5,  1,  1, .5],
  /* psychic  */[1,  2,  1,  2,  1,  1,  1,  1,  1,  1,  1,  1, .5,  1,  1],
  /* ice      */[1,  1,  2,  1,  2,  1,  1,  1,  1, .5,  2,  1,  1, .5,  2],
  /* dragon   */[1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  2],
];

/* ===================================================================
 * 3. GEN 1 MOVE DATA (ALL 165 MOVES)
 * =================================================================== */

/**
 * Gen 1 special types (use Special stat instead of Atk/Def in Gen 1).
 */
const SPECIAL_TYPES = new Set([
  "fire", "water", "grass", "electric", "psychic", "ice", "dragon",
]);

/**
 * Complete Gen 1 move list.
 * [name, typeId, power, accuracy, pp]
 * Index = move ID (1-based; index 0 is unused).
 * typeId uses the Game Boy internal IDs (0x00, 0x01, ... 0x1A).
 * power 0 = status move.  accuracy in %; 0 means never misses.
 */
const MOVE_DATA = [
  null, // 0: no move
  // ID  Name                Type  Pow  Acc  PP
  /*   1 */ ["Pound",           0x00,  40, 100, 35],
  /*   2 */ ["Karate Chop",     0x00,  50, 100, 25], // Normal in Gen 1
  /*   3 */ ["Double Slap",     0x00,  15,  85, 10],
  /*   4 */ ["Comet Punch",     0x00,  18,  85, 15],
  /*   5 */ ["Mega Punch",      0x00,  80,  85, 20],
  /*   6 */ ["Pay Day",         0x00,  40, 100, 20],
  /*   7 */ ["Fire Punch",      0x14,  75, 100, 15],
  /*   8 */ ["Ice Punch",       0x19,  75, 100, 15],
  /*   9 */ ["Thunder Punch",   0x17,  75, 100, 15],
  /*  10 */ ["Scratch",         0x00,  40, 100, 35],
  /*  11 */ ["Vice Grip",       0x00,  55, 100, 30],
  /*  12 */ ["Guillotine",      0x00,   0,  30,  5], // OHKO; power 0 (special handling)
  /*  13 */ ["Razor Wind",      0x00,  80,  75, 10],
  /*  14 */ ["Swords Dance",    0x00,   0,   0, 30],
  /*  15 */ ["Cut",             0x00,  50,  95, 30],
  /*  16 */ ["Gust",            0x00,  40, 100, 35], // Normal in Gen 1
  /*  17 */ ["Wing Attack",     0x02,  35, 100, 35],
  /*  18 */ ["Whirlwind",       0x00,   0,  85, 20],
  /*  19 */ ["Fly",             0x02,  70,  95, 15],
  /*  20 */ ["Bind",            0x00,  15,  75, 20],
  /*  21 */ ["Slam",            0x00,  80,  75, 20],
  /*  22 */ ["Vine Whip",       0x16,  35, 100, 10],
  /*  23 */ ["Stomp",           0x00,  65, 100, 20],
  /*  24 */ ["Double Kick",     0x01,  30, 100, 30],
  /*  25 */ ["Mega Kick",       0x00, 120,  75,  5],
  /*  26 */ ["Jump Kick",       0x01,  70,  95, 25],
  /*  27 */ ["Rolling Kick",    0x01,  60,  85, 15],
  /*  28 */ ["Sand Attack",     0x04,   0, 100, 15],
  /*  29 */ ["Headbutt",        0x00,  70, 100, 15],
  /*  30 */ ["Horn Attack",     0x00,  65, 100, 25],
  /*  31 */ ["Fury Attack",     0x00,  15,  85, 20],
  /*  32 */ ["Horn Drill",      0x00,   0,  30,  5], // OHKO
  /*  33 */ ["Tackle",          0x00,  35,  95, 35],
  /*  34 */ ["Body Slam",       0x00,  85, 100, 15],
  /*  35 */ ["Wrap",            0x00,  15,  85, 20],
  /*  36 */ ["Take Down",       0x00,  90,  85, 20],
  /*  37 */ ["Thrash",          0x00,  90, 100, 20],
  /*  38 */ ["Double-Edge",     0x00, 100, 100, 15],
  /*  39 */ ["Tail Whip",       0x00,   0, 100, 30],
  /*  40 */ ["Poison Sting",    0x03,  15, 100, 35],
  /*  41 */ ["Twineedle",       0x07,  25, 100, 20],
  /*  42 */ ["Pin Missile",     0x07,  14,  85, 20],
  /*  43 */ ["Leer",            0x00,   0, 100, 30],
  /*  44 */ ["Bite",            0x00,  60, 100, 25], // Normal in Gen 1
  /*  45 */ ["Growl",           0x00,   0, 100, 40],
  /*  46 */ ["Roar",            0x00,   0, 100, 20],
  /*  47 */ ["Sing",            0x00,   0,  55, 15],
  /*  48 */ ["Supersonic",      0x00,   0,  55, 20],
  /*  49 */ ["Sonic Boom",      0x00,   0,  90, 20], // fixed 20 dmg; power 0
  /*  50 */ ["Disable",         0x00,   0,  55, 20],
  /*  51 */ ["Acid",            0x03,  40, 100, 30],
  /*  52 */ ["Ember",           0x14,  40, 100, 25],
  /*  53 */ ["Flamethrower",    0x14,  95, 100, 15],
  /*  54 */ ["Mist",            0x19,   0,   0, 30],
  /*  55 */ ["Water Gun",       0x15,  40, 100, 25],
  /*  56 */ ["Hydro Pump",      0x15, 120,  80,  5],
  /*  57 */ ["Surf",            0x15,  95, 100, 15],
  /*  58 */ ["Ice Beam",        0x19,  95, 100, 10],
  /*  59 */ ["Blizzard",        0x19, 120,  90,  5],
  /*  60 */ ["Psybeam",         0x18,  65, 100, 20],
  /*  61 */ ["Bubble Beam",     0x15,  65, 100, 20],
  /*  62 */ ["Aurora Beam",     0x19,  65, 100, 20],
  /*  63 */ ["Hyper Beam",      0x00, 150,  90,  5],
  /*  64 */ ["Peck",            0x02,  35, 100, 35],
  /*  65 */ ["Drill Peck",      0x02,  80, 100, 20],
  /*  66 */ ["Submission",      0x01,  80,  80, 25],
  /*  67 */ ["Low Kick",        0x01,  50,  90, 20],
  /*  68 */ ["Counter",         0x01,   0, 100, 20],
  /*  69 */ ["Seismic Toss",    0x01,   0, 100, 20], // fixed=level dmg; power 0
  /*  70 */ ["Strength",        0x00,  80, 100, 15],
  /*  71 */ ["Absorb",          0x16,  20, 100, 20],
  /*  72 */ ["Mega Drain",      0x16,  40, 100, 10],
  /*  73 */ ["Leech Seed",      0x16,   0,  90, 10],
  /*  74 */ ["Growth",          0x00,   0,   0, 40],
  /*  75 */ ["Razor Leaf",      0x16,  55,  95, 25],
  /*  76 */ ["Solar Beam",      0x16, 120, 100, 10],
  /*  77 */ ["Poison Powder",   0x03,   0,  75, 35],
  /*  78 */ ["Stun Spore",      0x16,   0,  75, 30],
  /*  79 */ ["Sleep Powder",    0x16,   0,  75, 15],
  /*  80 */ ["Petal Dance",     0x16,  70, 100, 20],
  /*  81 */ ["String Shot",     0x07,   0,  95, 40],
  /*  82 */ ["Dragon Rage",     0x1A,   0, 100, 10], // fixed 40 dmg
  /*  83 */ ["Fire Spin",       0x14,  15,  70, 15],
  /*  84 */ ["Thunder Shock",   0x17,  40, 100, 30],
  /*  85 */ ["Thunderbolt",     0x17,  95, 100, 15],
  /*  86 */ ["Thunder Wave",    0x17,   0, 100, 20],
  /*  87 */ ["Thunder",         0x17, 120,  70, 10],
  /*  88 */ ["Rock Throw",      0x05,  50,  65, 15],
  /*  89 */ ["Earthquake",      0x04, 100, 100, 10],
  /*  90 */ ["Fissure",         0x04,   0,  30,  5], // OHKO
  /*  91 */ ["Dig",             0x04,  100,100, 10],
  /*  92 */ ["Toxic",           0x03,   0,  85, 10],
  /*  93 */ ["Confusion",       0x18,  50, 100, 25],
  /*  94 */ ["Psychic",         0x18,  90, 100, 10],
  /*  95 */ ["Hypnosis",        0x18,   0,  60, 20],
  /*  96 */ ["Meditate",        0x18,   0,   0, 40],
  /*  97 */ ["Agility",         0x18,   0,   0, 30],
  /*  98 */ ["Quick Attack",    0x00,  40, 100, 30],
  /*  99 */ ["Rage",            0x00,  20, 100, 20],
  /* 100 */ ["Teleport",        0x18,   0,   0, 20],
  /* 101 */ ["Night Shade",     0x08,   0, 100, 15], // fixed=level dmg
  /* 102 */ ["Mimic",           0x00,   0, 100, 10],
  /* 103 */ ["Screech",         0x00,   0,  85, 40],
  /* 104 */ ["Double Team",     0x00,   0,   0, 15],
  /* 105 */ ["Recover",         0x00,   0,   0, 20],
  /* 106 */ ["Harden",          0x00,   0,   0, 30],
  /* 107 */ ["Minimize",        0x00,   0,   0, 20],
  /* 108 */ ["Smokescreen",     0x00,   0, 100, 20],
  /* 109 */ ["Confuse Ray",     0x08,   0, 100, 10],
  /* 110 */ ["Withdraw",        0x15,   0,   0, 40],
  /* 111 */ ["Defense Curl",    0x00,   0,   0, 40],
  /* 112 */ ["Barrier",         0x18,   0,   0, 30],
  /* 113 */ ["Light Screen",    0x18,   0,   0, 30],
  /* 114 */ ["Haze",            0x19,   0,   0, 30],
  /* 115 */ ["Reflect",         0x18,   0,   0, 20],
  /* 116 */ ["Focus Energy",    0x00,   0,   0, 30],
  /* 117 */ ["Bide",            0x00,   0, 100, 10],
  /* 118 */ ["Metronome",       0x00,   0,   0, 10],
  /* 119 */ ["Mirror Move",     0x02,   0,   0, 20],
  /* 120 */ ["Self-Destruct",   0x00, 130, 100,  5],
  /* 121 */ ["Egg Bomb",        0x00, 100,  75, 10],
  /* 122 */ ["Lick",            0x08,  20, 100, 30],
  /* 123 */ ["Smog",            0x03,  20,  70, 20],
  /* 124 */ ["Sludge",          0x03,  65, 100, 20],
  /* 125 */ ["Bone Club",       0x04,  65,  85, 20],
  /* 126 */ ["Fire Blast",      0x14, 120,  85,  5],
  /* 127 */ ["Waterfall",       0x15,  80, 100, 15],
  /* 128 */ ["Clamp",           0x15,  35,  75, 10],
  /* 129 */ ["Swift",           0x00,  60,   0, 20], // never misses (acc=0)
  /* 130 */ ["Skull Bash",      0x00, 100, 100, 15],
  /* 131 */ ["Spike Cannon",    0x00,  20, 100, 15],
  /* 132 */ ["Constrict",       0x00,  10, 100, 35],
  /* 133 */ ["Amnesia",         0x18,   0,   0, 20],
  /* 134 */ ["Kinesis",         0x18,   0,  80, 15],
  /* 135 */ ["Soft-Boiled",     0x00,   0,   0, 10],
  /* 136 */ ["High Jump Kick",  0x01,  85,  90, 20],
  /* 137 */ ["Glare",           0x00,   0,  75, 30],
  /* 138 */ ["Dream Eater",     0x18, 100, 100, 15],
  /* 139 */ ["Poison Gas",      0x03,   0,  55, 40],
  /* 140 */ ["Barrage",         0x00,  15,  85, 20],
  /* 141 */ ["Leech Life",      0x07,  20, 100, 15],
  /* 142 */ ["Lovely Kiss",     0x00,   0,  75, 10],
  /* 143 */ ["Sky Attack",      0x02, 140,  90,  5],
  /* 144 */ ["Transform",       0x00,   0,   0, 10],
  /* 145 */ ["Bubble",          0x15,  20, 100, 30],
  /* 146 */ ["Dizzy Punch",     0x00,  70, 100, 10],
  /* 147 */ ["Spore",           0x16,   0, 100, 15],
  /* 148 */ ["Flash",           0x00,   0,  70, 20],
  /* 149 */ ["Psywave",         0x18,   0,  80, 15], // variable dmg
  /* 150 */ ["Splash",          0x00,   0,   0, 40],
  /* 151 */ ["Acid Armor",      0x03,   0,   0, 40],
  /* 152 */ ["Crabhammer",      0x15,  90,  85, 10],
  /* 153 */ ["Explosion",       0x00, 170, 100,  5],
  /* 154 */ ["Fury Swipes",     0x00,  18,  80, 15],
  /* 155 */ ["Bonemerang",      0x04,  50,  90, 10],
  /* 156 */ ["Rest",            0x18,   0,   0, 10],
  /* 157 */ ["Rock Slide",      0x05,  75,  90, 10],
  /* 158 */ ["Hyper Fang",      0x00,  80,  90, 15],
  /* 159 */ ["Sharpen",         0x00,   0,   0, 30],
  /* 160 */ ["Conversion",      0x00,   0,   0, 30],
  /* 161 */ ["Tri Attack",      0x00,  80, 100, 10],
  /* 162 */ ["Super Fang",      0x00,   0,  90, 10], // halves HP; power 0
  /* 163 */ ["Slash",           0x00,  70, 100, 20],
  /* 164 */ ["Substitute",      0x00,   0,   0, 10],
  /* 165 */ ["Struggle",        0x00,  50, 100,  1], // last resort move
];

/* ===================================================================
 * 4. GEN 1 POKEMON NAME TABLE
 * =================================================================== */

/**
 * Game Boy internal index number → species name.
 * Gen 1 internal IDs are NOT sequential Pokedex numbers.
 */
const POKEMON_NAMES = {
  0x01: "Rhydon",
  0x02: "Kangaskhan",
  0x03: "Nidoran♂",
  0x04: "Clefairy",
  0x05: "Spearow",
  0x06: "Voltorb",
  0x07: "Nidoking",
  0x08: "Slowbro",
  0x09: "Ivysaur",
  0x0A: "Exeggutor",
  0x0B: "Lickitung",
  0x0C: "Exeggcute",
  0x0D: "Grimer",
  0x0E: "Gengar",
  0x0F: "Nidoran♀",
  0x10: "Nidoqueen",
  0x11: "Cubone",
  0x12: "Rhyhorn",
  0x13: "Lapras",
  0x14: "Arcanine",
  0x15: "Mew",
  0x16: "Gyarados",
  0x17: "Shellder",
  0x18: "Tentacool",
  0x19: "Gastly",
  0x1A: "Scyther",
  0x1B: "Staryu",
  0x1C: "Blastoise",
  0x1D: "Pinsir",
  0x1E: "Tangela",
  0x21: "Growlithe",
  0x22: "Onix",
  0x23: "Fearow",
  0x24: "Pidgey",
  0x25: "Slowpoke",
  0x26: "Kadabra",
  0x27: "Graveler",
  0x28: "Chansey",
  0x29: "Machoke",
  0x2A: "Mr. Mime",
  0x2B: "Hitmonlee",
  0x2C: "Hitmonchan",
  0x2D: "Arbok",
  0x2E: "Parasect",
  0x2F: "Psyduck",
  0x30: "Drowzee",
  0x31: "Golem",
  0x33: "Magmar",
  0x35: "Electabuzz",
  0x36: "Magneton",
  0x37: "Koffing",
  0x39: "Mankey",
  0x3A: "Seel",
  0x3B: "Diglett",
  0x3C: "Tauros",
  0x40: "Farfetch'd",
  0x41: "Venonat",
  0x42: "Dragonite",
  0x46: "Doduo",
  0x47: "Poliwag",
  0x48: "Jynx",
  0x49: "Moltres",
  0x4A: "Articuno",
  0x4B: "Zapdos",
  0x4C: "Ditto",
  0x4D: "Meowth",
  0x4E: "Krabby",
  0x52: "Vulpix",
  0x53: "Ninetales",
  0x54: "Pikachu",
  0x55: "Raichu",
  0x58: "Dratini",
  0x59: "Dragonair",
  0x5A: "Kabuto",
  0x5B: "Kabutops",
  0x5C: "Horsea",
  0x5D: "Seadra",
  0x60: "Sandshrew",
  0x61: "Sandslash",
  0x62: "Omanyte",
  0x63: "Omastar",
  0x65: "Jigglypuff",
  0x66: "Wigglytuff",
  0x67: "Eevee",
  0x68: "Flareon",
  0x69: "Jolteon",
  0x6A: "Vaporeon",
  0x6B: "Machop",
  0x6C: "Zubat",
  0x6D: "Ekans",
  0x6E: "Paras",
  0x6F: "Poliwhirl",
  0x70: "Poliwrath",
  0x71: "Weedle",
  0x72: "Kakuna",
  0x73: "Beedrill",
  0x74: "Dodrio",
  0x75: "Primeape",
  0x76: "Dugtrio",
  0x77: "Venomoth",
  0x78: "Dewgong",
  0x7B: "Caterpie",
  0x7C: "Metapod",
  0x7D: "Butterfree",
  0x7E: "Machamp",
  0x80: "Golduck",
  0x81: "Hypno",
  0x82: "Golbat",
  0x83: "Mewtwo",
  0x84: "Snorlax",
  0x85: "Magikarp",
  0x88: "Muk",
  0x8A: "Kingler",
  0x8B: "Cloyster",
  0x8D: "Electrode",
  0x8E: "Clefable",
  0x8F: "Weezing",
  0x90: "Persian",
  0x91: "Marowak",
  0x93: "Haunter",
  0x94: "Abra",
  0x95: "Alakazam",
  0x96: "Pidgeotto",
  0x97: "Pidgeot",
  0x98: "Starmie",
  0x99: "Bulbasaur",
  0x9A: "Venusaur",
  0x9B: "Tentacruel",
  0x9D: "Goldeen",
  0x9E: "Seaking",
  0xA3: "Ponyta",
  0xA4: "Rapidash",
  0xA5: "Rattata",
  0xA6: "Raticate",
  0xA7: "Nidorino",
  0xA8: "Nidorina",
  0xA9: "Geodude",
  0xAA: "Porygon",
  0xAB: "Aerodactyl",
  0xAD: "Magnemite",
  0xB0: "Charmander",
  0xB1: "Squirtle",
  0xB2: "Charmeleon",
  0xB3: "Wartortle",
  0xB4: "Charizard",
  0xB9: "Oddish",
  0xBA: "Gloom",
  0xBB: "Vileplume",
  0xBC: "Bellsprout",
  0xBD: "Weepinbell",
  0xBE: "Victreebel",
};

/** Move names by ID (1-based). */
const MOVE_NAMES = MOVE_DATA.map((m, i) => (m ? m[0] : `Move${i}`));

/* ===================================================================
 * 5. POKEMON CENTER MAP IDS
 * =================================================================== */

const POKEMON_CENTER_MAPS = new Set([
  41,   // Viridian
  58,   // Pewter
  64,   // Cerulean
  68,   // Route 4 (Mt. Moon)
  89,   // Vermilion
  133,  // Celadon
  141,  // Lavender
  154,  // Fuchsia
  171,  // Cinnabar
  174,  // Saffron
  181,  // Indigo Plateau
]);

/* ===================================================================
 * 6. AUTOPLAY CLASS
 * =================================================================== */

class Autoplay {
  /**
   * @param {object} module  - The binjgb WASM module (app.emulator.module).
   * @param {number} emulatorHandle - Emulator pointer (app.emulator.e).
   */
  constructor(module, emulatorHandle) {
    this.module = module;
    this.e = emulatorHandle;

    // Runtime state
    this.active = false;
    this.intervalId = null;
    this.tickCount = 0;

    // Input tracking
    this.heldButtons = {};   // button name → remaining hold frames
    this.inputCooldown = 0;  // frames to wait before next input

    // Overworld exploration state
    this.currentDirection = "down";
    this.directionTimer = 0;
    this.lastPosition = { x: -1, y: -1 };
    this.stuckFrames = 0;
    this.lastInteractFrame = 0;

    // Ring buffer for position history (stuck detection)
    this.positionHistory = [];
    this.positionHistoryIdx = 0;
    this.POSITION_HISTORY_SIZE = 30;
    this.consecutiveStuckEvents = 0;
    this.positionSampleCounter = 0;

    // Battle state
    this.inBattle = false;
    this.battleAction = "";
    this.battleSubState = "idle";  // idle | selecting_fight | selecting_move | text
    this.lastBattleType = 0;

    // Statistics
    this.encountersWon = 0;
    this.encountersFled = 0;

    // Battle state transition tracking
    this.lastState = "idle";
    this.battleEndCooldown = 0;
    this.battleSubStateTicks = 0;

    // Activity log
    this.activityLog = [];
    this.MAX_LOG_ENTRIES = 50;

    // Speed hint
    this._speedHintCallback = null;

    // Multiplayer gate: null = no gate (solo/local), true/false = mp-controlled
    this.multiplayerAllowed = null;

    // Encounter species tracking
    this.speciesEncountered = {};
    this.recentSpecies = []; // last 10 species for grinding fatigue

    // Uptime
    this.startTime = Date.now();

    // Memory read mode
    this.hasDirectRead = typeof module._read_u8 === "function";
    this.stateCache = null;
    this.stateCacheAge = 0;
    this.STATE_CACHE_MAX_AGE = 6; // refresh every ~6 ticks (100ms at 60fps)
    this.wramBaseOffset = -1;     // discovered offset into state buffer

    // Joypad function references
    this.joypad = {
      up:     (v) => module._set_joyp_up(emulatorHandle, v),
      down:   (v) => module._set_joyp_down(emulatorHandle, v),
      left:   (v) => module._set_joyp_left(emulatorHandle, v),
      right:  (v) => module._set_joyp_right(emulatorHandle, v),
      a:      (v) => module._set_joyp_A(emulatorHandle, v),
      b:      (v) => module._set_joyp_B(emulatorHandle, v),
      start:  (v) => module._set_joyp_start(emulatorHandle, v),
      select: (v) => module._set_joyp_select(emulatorHandle, v),
    };

    if (!this.hasDirectRead) {
      this._log("module._read_u8 not found; using state-capture fallback (slower).", "warn");
    }
    this._log("Initialized. Call .start() to begin.");
  }

  /* -----------------------------------------------------------------
   * Public API
   * ----------------------------------------------------------------- */

  start() {
    if (this.active) return;
    this.active = true;
    this.intervalId = setInterval(() => this._safeTick(), 16);
    this._log("Started.");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.releaseAll();
    this._log("Stopped.");
  }

  toggle() {
    this.active ? this.stop() : this.start();
    return this.active;
  }

  /**
   * Set the multiplayer gate.
   * null  = solo mode, no gate
   * true  = multiplayer, AI granted — inputs allowed
   * false = multiplayer, AI revoked — suppress all inputs
   */
  setMultiplayerAllowed(allowed) {
    this.multiplayerAllowed = allowed;
  }

  getStatus() {
    const state = this.detectState();
    const result = {
      active: this.active,
      state: state,
      map: this._tryRead(ADDR.MAP_ID),
      position: {
        x: this._tryRead(ADDR.PLAYER_X),
        y: this._tryRead(ADDR.PLAYER_Y),
      },
      battleAction: this.battleAction,
      framesPlayed: this.tickCount,
      encountersWon: this.encountersWon,
      encountersFled: this.encountersFled,
      pokemon: null,
      opponent: null,
      party: [],
      log: this.activityLog.slice(-5),
      isReady: this.isReady(),
      mode: this.hasDirectRead ? "direct" : "fallback",
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      speciesEncountered: Object.assign({}, this.speciesEncountered),
    };

    // Lead pokemon info
    try {
      const partySize = this.readU8(ADDR.PARTY_SIZE);
      if (partySize > 0 && partySize <= 6) {
        const species = this.readU8(ADDR.PARTY_START);
        const name = POKEMON_NAMES[species] || `#${species}`;
        const base = ADDR.PARTY_START + 8; // skip species list + terminator (7+1)
        // Actually party data starts right after species list:
        // D164 = party count, D165-D16A = species list (6 bytes), D16B = terminator?
        // No: D163 = count, D164-D169 = species, D16A = terminator (0xFF), D16B = start of first mon struct
        const structBase = 0xD16B;
        const hp = (this.readU8(structBase + 0x01) << 8) | this.readU8(structBase + 0x02);
        const level = this.readU8(structBase + 0x21);
        const maxHp = (this.readU8(structBase + 0x22) << 8) | this.readU8(structBase + 0x23);
        result.pokemon = { name, hp, maxHp, level };

        // Build party array
        for (let i = 0; i < partySize && i < 6; i++) {
          const sb = structBase + i * ADDR.PARTY_STRUCT_SIZE;
          const pHp = (this.readU8(sb + 0x01) << 8) | this.readU8(sb + 0x02);
          const pLvl = this.readU8(sb + 0x21);
          const pMax = (this.readU8(sb + 0x22) << 8) | this.readU8(sb + 0x23);
          result.party.push({ hp: pHp, maxHp: pMax, level: pLvl });
        }
      }
    } catch (_) { /* emulator not ready */ }

    // Opponent info (only during battle)
    if (state === "battling") {
      try {
        const oppSpecies = this.readU8(ADDR.OPP_ID);
        const oppName = POKEMON_NAMES[oppSpecies] || `#${oppSpecies}`;
        const oppHp = (this.readU8(ADDR.OPP_HP_HI) << 8) | this.readU8(ADDR.OPP_HP_LO);
        const oppMaxHp = (this.readU8(ADDR.OPP_MAX_HP_HI) << 8) | this.readU8(ADDR.OPP_MAX_HP_LO);
        const oppLevel = this.readU8(ADDR.OPP_LEVEL);
        result.opponent = { name: oppName, hp: oppHp, maxHp: oppMaxHp, level: oppLevel };
      } catch (_) { /* ok */ }
    }

    return result;
  }

  /**
   * Returns true only when memory reading is working reliably.
   */
  isReady() {
    if (this.hasDirectRead) return true;
    if (!this.stateCache || this.wramBaseOffset < 0) return false;
    // Validate current readings are still sensible
    try {
      const party = this.readU8(ADDR.PARTY_SIZE);
      return party >= 1 && party <= 6;
    } catch (_) {
      return false;
    }
  }

  /**
   * Register a callback for speed hint suggestions.
   * The callback receives a multiplier (e.g. 1 for normal, 4 for fast-forward).
   * @param {function} callback
   */
  setSpeedHint(callback) {
    this._speedHintCallback = callback;
  }

  /**
   * Get activity log entries since a given timestamp.
   * @param {number} since - Unix timestamp in ms (default 0 = all entries).
   * @returns {Array<{time: number, message: string, type: string}>}
   */
  getLog(since = 0) {
    return this.activityLog.filter(e => e.time > since);
  }

  /* -----------------------------------------------------------------
   * Activity Logging
   * ----------------------------------------------------------------- */

  /**
   * Log an event to the activity log and console.
   * @param {string} message
   * @param {string} type - 'info' | 'battle' | 'explore' | 'heal' | 'warn'
   * @private
   */
  _log(message, type = "info") {
    this.activityLog.push({
      time: Date.now(),
      message,
      type,
    });
    if (this.activityLog.length > this.MAX_LOG_ENTRIES) {
      this.activityLog.shift();
    }
    console.log(`[AutoPlay] ${message}`);
  }

  /* -----------------------------------------------------------------
   * Memory Readers
   * ----------------------------------------------------------------- */

  /** Read a single byte from the Game Boy address space. */
  readU8(addr) {
    if (this.hasDirectRead) {
      return this.module._read_u8(this.e, addr);
    }
    return this._readFromStateCache(addr);
  }

  /** Read 16-bit value (big-endian: hi byte at addr, lo at addr+1). */
  readU16(addr) {
    return (this.readU8(addr) << 8) | this.readU8(addr + 1);
  }

  /**
   * Safe wrapper — returns 0 on error instead of throwing.
   * @private
   */
  _tryRead(addr) {
    try { return this.readU8(addr); } catch (_) { return 0; }
  }

  /**
   * Fallback: read from a cached emulator state snapshot.
   * WRAM (0xC000-0xDFFF) is located inside the state blob at a
   * discovered offset.
   * @private
   */
  _readFromStateCache(addr) {
    // Refresh cache periodically
    this.stateCacheAge++;
    if (!this.stateCache || this.stateCacheAge >= this.STATE_CACHE_MAX_AGE) {
      this._refreshStateCache();
    }
    if (!this.stateCache) return 0;

    // If we haven't found the WRAM base yet, discover it
    if (this.wramBaseOffset < 0) {
      this._discoverWramOffset();
    }
    if (this.wramBaseOffset < 0) return 0;

    // Map the GB address into the state buffer
    if (addr >= 0xC000 && addr <= 0xDFFF) {
      const idx = this.wramBaseOffset + (addr - 0xC000);
      if (idx < this.stateCache.length) {
        return this.stateCache[idx];
      }
    }
    // For addresses outside WRAM, we can't reliably read from state
    return 0;
  }

  /** @private */
  _refreshStateCache() {
    try {
      // Find the EmulatorRuntime that owns our handle
      if (typeof app !== "undefined" && app.emulator && app.emulator.captureState) {
        const buf = app.emulator.captureState();
        this.stateCache = new Uint8Array(buf);
        this.stateCacheAge = 0;
      }
    } catch (err) {
      this._log("State capture failed: " + err.message, "warn");
      this.stateCache = null;
      this.wramBaseOffset = -1;
    }
  }

  /**
   * Try to locate WRAM inside the state blob by checking for the
   * party count byte (should be 0-6 at WRAM offset 0x1163).
   * @private
   */
  _discoverWramOffset() {
    if (!this.stateCache) return;
    const wramSize = 0x2000; // 8 KiB
    const partyCountOffset = ADDR.PARTY_SIZE - 0xC000; // 0x1163

    // Scan for a block where offset 0x1163 holds 0-6
    for (let base = 0; base <= this.stateCache.length - wramSize; base += 4) {
      const val = this.stateCache[base + partyCountOffset];
      if (val < 1 || val > 6) continue;

      // Validation 1: species byte should be a known Pokemon
      const speciesOffset = ADDR.PARTY_START - 0xC000; // 0x116B
      const species = this.stateCache[base + speciesOffset];
      if (species === 0 || species >= 0xBF || !POKEMON_NAMES[species]) continue;

      // Validation 2: player coordinates should be in reasonable range
      const playerXOffset = ADDR.PLAYER_X - 0xC000;
      const playerYOffset = ADDR.PLAYER_Y - 0xC000;
      const px = this.stateCache[base + playerXOffset];
      const py = this.stateCache[base + playerYOffset];
      if (px > 100 || py > 100) continue;

      // Validation 3: map ID should be valid (< 0xFF, not garbage)
      const mapOffset = ADDR.MAP_ID - 0xC000;
      const mapId = this.stateCache[base + mapOffset];
      if (mapId >= 0xFF) continue;

      this.wramBaseOffset = base;
      this._log(`Found WRAM at state offset 0x${base.toString(16)}`, "info");
      return;
    }
    // Didn't find it — will retry next cache refresh
  }

  /* -----------------------------------------------------------------
   * Game State Detection
   * ----------------------------------------------------------------- */

  /**
   * Determine the current game state.
   * Returns: "title" | "exploring" | "battling" | "text" | "menu" | "idle"
   */
  detectState() {
    try {
      const battleType = this.readU8(ADDR.BATTLE_TYPE);
      const textbox = this.readU8(ADDR.TEXTBOX);
      const mapId = this.readU8(ADDR.MAP_ID);

      if (battleType > 0 && battleType <= 2) {
        if (textbox === 1) return "battling"; // battle text
        return "battling";
      }
      if (textbox === 1) return "text";
      if (mapId === 0 || mapId === 0xFF) return "title";
      return "exploring";
    } catch (_) {
      return "idle";
    }
  }

  /* -----------------------------------------------------------------
   * Main Tick
   * ----------------------------------------------------------------- */

  /** @private */
  _safeTick() {
    try {
      this.tick();
    } catch (err) {
      // Never crash the bot loop
      if (this.tickCount % 300 === 0) {
        this._log("Tick error: " + err.message, "warn");
      }
    }
  }

  /** Main loop — called every frame (~60fps). */
  tick() {
    this.tickCount++;

    // Process held button releases
    this._processHeldButtons();

    // Multiplayer gate: if mp-controlled and not granted, suppress all inputs
    if (this.multiplayerAllowed === false) return;

    // Battle end cooldown
    if (this.battleEndCooldown > 0) {
      this.battleEndCooldown--;
      return;
    }

    // If still in input cooldown, skip decision-making
    if (this.inputCooldown > 0) {
      this.inputCooldown--;
      return;
    }

    const state = this.detectState();

    // Track battle → overworld transitions
    if (this.lastState === "battling" && state !== "battling") {
      this._onBattleEnd();
    }
    this.lastState = state;

    switch (state) {
      case "battling":
        this.handleBattle();
        break;
      case "text":
        this.handleTextbox();
        break;
      case "exploring":
        this.handleOverworld();
        break;
      case "title":
        this.handleTitle();
        break;
      default:
        // idle — press A periodically to try to get unstuck
        if (this.tickCount % 60 === 0) {
          this.pressButton("a", 4);
        }
        break;
    }
  }

  /* -----------------------------------------------------------------
   * Input System
   * ----------------------------------------------------------------- */

  /**
   * Press a button and hold it for a given number of frames.
   * @param {string} button - "up"|"down"|"left"|"right"|"a"|"b"|"start"|"select"
   * @param {number} frames - How many ticks to hold (default 4).
   */
  pressButton(button, frames = 4) {
    const fn = this.joypad[button];
    if (!fn) return;

    // Release any conflicting directional inputs
    const dirs = ["up", "down", "left", "right"];
    if (dirs.includes(button)) {
      for (const d of dirs) {
        if (d !== button && this.heldButtons[d]) {
          this.joypad[d](false);
          delete this.heldButtons[d];
        }
      }
    }

    fn(true);
    this.heldButtons[button] = frames;
  }

  /** Release all currently held buttons. */
  releaseAll() {
    for (const [button, _] of Object.entries(this.heldButtons)) {
      const fn = this.joypad[button];
      if (fn) fn(false);
    }
    this.heldButtons = {};
  }

  /** @private — Count down held buttons and release when timer expires. */
  _processHeldButtons() {
    for (const button of Object.keys(this.heldButtons)) {
      this.heldButtons[button]--;
      if (this.heldButtons[button] <= 0) {
        const fn = this.joypad[button];
        if (fn) fn(false);
        delete this.heldButtons[button];
      }
    }
  }

  /* -----------------------------------------------------------------
   * Title Screen Handler
   * ----------------------------------------------------------------- */

  handleTitle() {
    // Mash A/Start to get through title/intro
    if (this.tickCount % 30 < 15) {
      this.pressButton("a", 6);
    } else {
      this.pressButton("start", 6);
    }
    this.inputCooldown = 10;
  }

  /* -----------------------------------------------------------------
   * Textbox Handler
   * ----------------------------------------------------------------- */

  handleTextbox() {
    // Alternate A/B to advance text as fast as possible
    if (this.tickCount % 8 < 4) {
      this.pressButton("a", 3);
    } else {
      this.pressButton("b", 3);
    }
    this.inputCooldown = 4;
  }

  /* -----------------------------------------------------------------
   * Overworld Exploration
   * ----------------------------------------------------------------- */

  handleOverworld() {
    const x = this._tryRead(ADDR.PLAYER_X);
    const y = this._tryRead(ADDR.PLAYER_Y);
    const moving = this._tryRead(ADDR.PLAYER_MOVING);
    const mapId = this._tryRead(ADDR.MAP_ID);

    // Ring buffer position sampling (every ~15 ticks)
    this.positionSampleCounter++;
    if (this.positionSampleCounter >= 15) {
      this.positionSampleCounter = 0;
      const pos = (x << 8) | y; // pack x,y into one number
      if (this.positionHistory.length < this.POSITION_HISTORY_SIZE) {
        this.positionHistory.push(pos);
      } else {
        this.positionHistory[this.positionHistoryIdx] = pos;
      }
      this.positionHistoryIdx = (this.positionHistoryIdx + 1) % this.POSITION_HISTORY_SIZE;

      // Check if all positions in the ring buffer are identical
      if (this.positionHistory.length >= this.POSITION_HISTORY_SIZE) {
        const allSame = this.positionHistory.every(p => p === this.positionHistory[0]);
        if (allSame) {
          this.consecutiveStuckEvents++;
          this._log(`Stuck detected (event #${this.consecutiveStuckEvents}) at x=${x} y=${y}`, "warn");

          // Escalating escape strategy
          if (this.consecutiveStuckEvents >= 3) {
            // Level 3: press B to cancel menus, then A to interact
            this.pressButton("b", 6);
            this.inputCooldown = 8;
            setTimeout(() => {
              if (this.active) {
                this.pressButton("a", 6);
              }
            }, 150);
          } else if (this.consecutiveStuckEvents >= 2) {
            // Level 2: press B to dismiss possible menu
            this.pressButton("b", 6);
            this.inputCooldown = 10;
          } else {
            // Level 1: random direction change
            this.currentDirection = this._randomDirection();
            this.pressButton(this.currentDirection, 8);
            this.inputCooldown = 10;
          }

          // Reset ring buffer after escape attempt
          this.positionHistory = [];
          this.positionHistoryIdx = 0;
          return;
        } else {
          this.consecutiveStuckEvents = 0;
        }
      }
    }

    // If in a Pokemon Center, try to walk toward the nurse
    if (POKEMON_CENTER_MAPS.has(mapId)) {
      this._navigatePokemonCenter(x, y);
      return;
    }

    // Change direction periodically (every 45-90 frames)
    this.directionTimer--;
    if (this.directionTimer <= 0) {
      this.currentDirection = this._randomDirection();
      this.directionTimer = 45 + Math.floor(Math.random() * 45);
    }

    // Walk in current direction
    if (moving === 0) {
      this.pressButton(this.currentDirection, 6);
      this.inputCooldown = 4;
    }

    // Occasionally interact (press A)
    if (this.tickCount - this.lastInteractFrame > 120 && Math.random() < 0.05) {
      this.pressButton("a", 4);
      this.lastInteractFrame = this.tickCount;
      this.inputCooldown = 8;
    }
  }

  /** @private */
  _randomDirection() {
    const dirs = ["up", "down", "left", "right"];
    return dirs[Math.floor(Math.random() * dirs.length)];
  }

  /**
   * Simplified Pokemon Center navigation:
   * Walk up toward the nurse's counter (top-center of the map).
   * @private
   */
  _navigatePokemonCenter(x, y) {
    // Nurse desk is roughly at x=7, y=3 in most Pokemon Centers
    const targetX = 7;
    const targetY = 3;

    if (y > targetY) {
      this.pressButton("up", 6);
    } else if (x < targetX) {
      this.pressButton("right", 6);
    } else if (x > targetX) {
      this.pressButton("left", 6);
    } else {
      // At the desk — press A to talk
      this.pressButton("a", 6);
    }
    this.inputCooldown = 8;
  }

  /* -----------------------------------------------------------------
   * Battle Automation
   * ----------------------------------------------------------------- */

  handleBattle() {
    const battleType = this._tryRead(ADDR.BATTLE_TYPE);
    const textbox = this._tryRead(ADDR.TEXTBOX);

    // Track battle start/end
    if (battleType > 0 && !this.inBattle) {
      this.inBattle = true;
      this.battleSubState = "idle";
      this.battleSubStateTicks = 0;
      this.lastBattleType = battleType;
      const oppSpecies = this._tryRead(ADDR.OPP_ID);
      const oppName = POKEMON_NAMES[oppSpecies] || `#${oppSpecies}`;
      const oppLevel = this._tryRead(ADDR.OPP_LEVEL);

      // Track species encounters
      this.speciesEncountered[oppSpecies] = (this.speciesEncountered[oppSpecies] || 0) + 1;
      this.recentSpecies.push(oppSpecies);
      if (this.recentSpecies.length > 10) this.recentSpecies.shift();

      this._log(
        `Battle started (${battleType === 1 ? "wild" : "trainer"}) vs ${oppName} Lv${oppLevel}`,
        "battle"
      );

      // Speed hint: fast-forward if grinding a low-level opponent
      const ourLevel = this._tryRead(ADDR.OUR_LEVEL);
      if (this._speedHintCallback && ourLevel >= oppLevel + 5) {
        this._speedHintCallback(4);
      }
    }

    // Check if our Pokemon fainted
    const ourHp = (this._tryRead(ADDR.OUR_HP_HI) << 8) | this._tryRead(ADDR.OUR_HP_LO);
    if (ourHp === 0) {
      this._handleFaintedPokemon();
      return;
    }

    // Check if opponent fainted (battle won)
    const oppHp = (this._tryRead(ADDR.OPP_HP_HI) << 8) | this._tryRead(ADDR.OPP_HP_LO);
    if (oppHp === 0 && this.inBattle) {
      // Opponent fainted — press A to continue through victory text
      this.pressButton("a", 4);
      this.inputCooldown = 6;
      this.battleAction = "Victory!";
      return;
    }

    // If text is active, advance it
    if (textbox === 1) {
      this.pressButton("a", 3);
      this.inputCooldown = 4;
      this.battleAction = "Advancing text";
      return;
    }

    // Detect battle menu vs move select
    const menuRow = this._tryRead(ADDR.MENU_ROW);
    const menuCol = this._tryRead(ADDR.MENU_COL);

    // Wild battle with low-level opponent: consider running
    if (battleType === 1 && this._shouldRun()) {
      this._selectRun();
      return;
    }

    // Try to select Fight → best move
    this._selectFight();
  }

  /**
   * Decide whether to run from a wild battle.
   * Runs if:
   * - Our lead is 10+ levels higher than opponent
   * - We've fought 3+ of the same species recently (grinding fatigue)
   * - HP below 30% and no healing items
   * - There's a Pokemon Center nearby
   * @private
   */
  _shouldRun() {
    const ourLevel = this._tryRead(ADDR.OUR_LEVEL);
    const oppLevel = this._tryRead(ADDR.OPP_LEVEL);

    // Classic level gap check
    if (ourLevel >= oppLevel + 10) return true;

    // Grinding fatigue: fought 3+ of same species recently
    const oppSpecies = this._tryRead(ADDR.OPP_ID);
    const recentSameCount = this.recentSpecies.filter(s => s === oppSpecies).length;
    if (recentSameCount >= 3) return true;

    // Low HP check: run if HP < 30% and no potions
    const ourHp = (this._tryRead(ADDR.OUR_HP_HI) << 8) | this._tryRead(ADDR.OUR_HP_LO);
    const ourMaxHp = (this._tryRead(ADDR.OUR_MAX_HP_HI) << 8) | this._tryRead(ADDR.OUR_MAX_HP_LO);
    if (ourMaxHp > 0 && ourHp < ourMaxHp * 0.3) {
      // Check inventory for healing items (Potion=0x14, Super Potion=0x19, Hyper Potion=0x1A, Max Potion=0x1B, Full Restore=0x10)
      const healingItems = new Set([0x14, 0x19, 0x1A, 0x1B, 0x10]);
      const invCount = this._tryRead(ADDR.INVENTORY_COUNT);
      let hasHealing = false;
      for (let i = 0; i < Math.min(invCount, 20); i++) {
        const itemId = this._tryRead(ADDR.INVENTORY_START + i * 2);
        if (healingItems.has(itemId)) { hasHealing = true; break; }
      }
      if (!hasHealing) return true;
    }

    // Near a Pokemon Center — check if last map was a center
    const mapId = this._tryRead(ADDR.MAP_ID);
    if (POKEMON_CENTER_MAPS.has(mapId)) return true;

    return false;
  }

  /**
   * Navigate battle menu to select "Run" (bottom-right of 2×2 grid).
   * @private
   */
  _selectRun() {
    this.battleAction = "Running away";
    // Run is bottom-right: press down, then right, then A
    if (this.battleSubState !== "selecting_run") {
      this.battleSubState = "selecting_run";
      this.releaseAll();
      this.pressButton("down", 4);
      this.inputCooldown = 6;
      return;
    }
    // Then right
    this.pressButton("right", 4);
    this.inputCooldown = 4;
    // Press A to confirm
    setTimeout(() => {
      if (this.active && this.inBattle) {
        this.pressButton("a", 4);
      }
    }, 100);
    this.battleSubState = "idle";
    this.encountersFled++;
  }

  /**
   * Navigate battle menu to select "Fight", then pick best move.
   * @private
   */
  _selectFight() {
    const bestMove = this.selectBestMove();
    if (bestMove) {
      this.battleAction = `Using ${bestMove.name}`;
    } else {
      this.battleAction = "Attacking";
    }

    // Timeout: if stuck in same sub-state for 120+ ticks, reset
    this.battleSubStateTicks++;
    if (this.battleSubStateTicks >= 120) {
      this._log("Battle sub-state timeout, resetting to idle", "warn");
      this.battleSubState = "idle";
      this.battleSubStateTicks = 0;
      this.releaseAll();
      this.pressButton("b", 4);
      this.inputCooldown = 8;
      return;
    }

    // Sequence: navigate to Fight (top-left), press A, then select move
    switch (this.battleSubState) {
      case "idle":
        // Move cursor to Fight (top-left)
        this.releaseAll();
        this.pressButton("up", 3);
        this.inputCooldown = 4;
        this.battleSubState = "fight_up";
        this.battleSubStateTicks = 0;
        break;

      case "fight_up":
        this.pressButton("left", 3);
        this.inputCooldown = 4;
        this.battleSubState = "fight_left";
        break;

      case "fight_left":
        this.pressButton("a", 4);
        this.inputCooldown = 8;
        this.battleSubState = "selecting_move";
        this.battleSubStateTicks = 0;
        break;

      case "selecting_move":
        this._navigateToMove(bestMove ? bestMove.slot : 0);
        this.pressButton("a", 4);
        this.inputCooldown = 10;
        this.battleSubState = "idle";
        this.battleSubStateTicks = 0;
        break;

      case "selecting_run":
        // Reset after a failed run attempt
        this.battleSubState = "idle";
        this.battleSubStateTicks = 0;
        this.pressButton("a", 4);
        this.inputCooldown = 6;
        break;

      default:
        this.battleSubState = "idle";
        this.battleSubStateTicks = 0;
        this.pressButton("a", 4);
        this.inputCooldown = 6;
        break;
    }
  }

  /**
   * Navigate the move selection cursor to the desired slot (0-3).
   * Move list is a 2×2 grid: slot 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right.
   * @private
   */
  _navigateToMove(slot) {
    // 2×2 grid: row = floor(slot/2), col = slot % 2
    // slot 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
    const targetRow = Math.floor(slot / 2);
    const targetCol = slot % 2;

    // Reset cursor to top-left first
    this.pressButton("up", 2);
    this.pressButton("left", 2);

    // Navigate to target column
    if (targetCol === 1) {
      setTimeout(() => this.active && this.pressButton("right", 2), 60);
    }
    // Navigate to target row
    if (targetRow === 1) {
      setTimeout(() => this.active && this.pressButton("down", 2), 60);
    }
  }

  /**
   * Handle a fainted Pokemon — try to switch to next alive party member.
   * @private
   */
  _handleFaintedPokemon() {
    this.battleAction = "Switching Pokemon";
    const partySize = this._tryRead(ADDR.PARTY_SIZE);
    if (partySize <= 0 || partySize > 6) {
      // Can't read party — just mash A
      this.pressButton("a", 4);
      this.inputCooldown = 8;
      return;
    }

    // Find first alive Pokemon
    for (let i = 0; i < partySize; i++) {
      const base = 0xD16B + i * ADDR.PARTY_STRUCT_SIZE;
      const hp = (this._tryRead(base + 0x01) << 8) | this._tryRead(base + 0x02);
      if (hp > 0) {
        // Navigate to this Pokemon in the party menu
        // Press down i times then A
        for (let j = 0; j < i; j++) {
          setTimeout(() => this.active && this.pressButton("down", 3), j * 80);
        }
        setTimeout(() => this.active && this.pressButton("a", 4), i * 80 + 100);
        this.inputCooldown = i * 5 + 15;
        return;
      }
    }

    // All fainted — white out is coming, just mash A
    this.pressButton("a", 4);
    this.inputCooldown = 8;
  }

  /* -----------------------------------------------------------------
   * Battle End Detection
   * ----------------------------------------------------------------- */

  /**
   * Call this from tick() when transitioning out of battle.
   * @private
   */
  _checkBattleEnd() {
    const battleType = this._tryRead(ADDR.BATTLE_TYPE);
    if (battleType === 0 && this.inBattle) {
      this._onBattleEnd();
    }
  }

  /**
   * Handle the battle→overworld transition cleanly.
   * @private
   */
  _onBattleEnd() {
    const wasWild = this.lastBattleType === 1;
    this.inBattle = false;
    this.battleSubState = "idle";
    this.battleSubStateTicks = 0;
    this.battleAction = "";
    this.releaseAll();

    if (wasWild) {
      this.encountersWon++;
    }

    this._log(`Battle ended. Total wins: ${this.encountersWon}`, "battle");

    // Short cooldown before resuming exploration
    this.battleEndCooldown = 30; // ~0.5s at 60fps

    // Reset speed hint to normal
    if (this._speedHintCallback) {
      this._speedHintCallback(1);
    }
  }

  /* -----------------------------------------------------------------
   * Combat AI — Move Selection
   * ----------------------------------------------------------------- */

  /**
   * Analyze all available moves and pick the best one.
   * Returns { slot, name, minDmg, maxDmg, turnsToKO } or null.
   */
  selectBestMove() {
    try {
      const attacker = this._readActivePokemon("ours");
      const defender = this._readActivePokemon("opponent");
      if (!attacker || !defender) return null;

      let bestSlot = null;
      let bestScore = -Infinity;
      let bestInfo = null;

      for (let i = 0; i < 4; i++) {
        const moveId = attacker.moves[i];
        if (moveId === 0) continue;

        const pp = attacker.pp[i];
        if (pp <= 0) continue;

        const moveEntry = MOVE_DATA[moveId];
        if (!moveEntry) continue;

        const [name, typeId, power, accuracy, _maxPp] = moveEntry;

        // Skip status moves (power === 0) unless it's our only option
        if (power === 0) continue;

        const { minDmg, maxDmg } = this.calcDamage(
          moveId, typeId, power,
          attacker, defender
        );

        if (maxDmg <= 0) continue;

        const turnsToKO = Math.ceil(defender.hp / maxDmg);
        // Score: fewer turns to KO is better; tiebreak on min damage
        const score = -turnsToKO * 10000 + minDmg;

        if (score > bestScore) {
          bestScore = score;
          bestSlot = i;
          bestInfo = { slot: i, name, minDmg, maxDmg, turnsToKO };
        }
      }

      // If no damaging move found, pick first move with PP
      if (bestSlot === null) {
        for (let i = 0; i < 4; i++) {
          if (attacker.moves[i] !== 0 && attacker.pp[i] > 0) {
            const entry = MOVE_DATA[attacker.moves[i]];
            return { slot: i, name: entry ? entry[0] : "???", minDmg: 0, maxDmg: 0, turnsToKO: 99 };
          }
        }
        return null; // Struggle time
      }

      return bestInfo;
    } catch (err) {
      this._log("selectBestMove error: " + err.message, "warn");
      return null;
    }
  }

  /**
   * Read the active battle Pokemon stats.
   * @param {"ours"|"opponent"} side
   * @returns {{hp, maxHp, level, atk, def, spd, spc, type1, type2, moves, pp, status}|null}
   * @private
   */
  _readActivePokemon(side) {
    const a = side === "ours" ? {
      hp_hi: ADDR.OUR_HP_HI, hp_lo: ADDR.OUR_HP_LO,
      maxHp_hi: ADDR.OUR_MAX_HP_HI, maxHp_lo: ADDR.OUR_MAX_HP_LO,
      level: ADDR.OUR_LEVEL,
      atk_hi: ADDR.OUR_ATK_HI, atk_lo: ADDR.OUR_ATK_LO,
      def_hi: ADDR.OUR_DEF_HI, def_lo: ADDR.OUR_DEF_LO,
      spd_hi: ADDR.OUR_SPD_HI, spd_lo: ADDR.OUR_SPD_LO,
      spc_hi: ADDR.OUR_SPC_HI, spc_lo: ADDR.OUR_SPC_LO,
      type1: ADDR.OUR_TYPE1, type2: ADDR.OUR_TYPE2,
      moves: ADDR.OUR_MOVES, pp: ADDR.OUR_PP,
      status: ADDR.OUR_STATUS,
    } : {
      hp_hi: ADDR.OPP_HP_HI, hp_lo: ADDR.OPP_HP_LO,
      maxHp_hi: ADDR.OPP_MAX_HP_HI, maxHp_lo: ADDR.OPP_MAX_HP_LO,
      level: ADDR.OPP_LEVEL,
      atk_hi: ADDR.OPP_ATK_HI, atk_lo: ADDR.OPP_ATK_LO,
      def_hi: ADDR.OPP_DEF_HI, def_lo: ADDR.OPP_DEF_LO,
      spd_hi: ADDR.OPP_SPD_HI, spd_lo: ADDR.OPP_SPD_LO,
      spc_hi: ADDR.OPP_SPC_HI, spc_lo: ADDR.OPP_SPC_LO,
      type1: ADDR.OPP_TYPE1, type2: ADDR.OPP_TYPE2,
      moves: ADDR.OPP_MOVES, pp: null, // we don't know opponent PP
      status: null,
    };

    const hp = (this.readU8(a.hp_hi) << 8) | this.readU8(a.hp_lo);
    const maxHp = (this.readU8(a.maxHp_hi) << 8) | this.readU8(a.maxHp_lo);
    const level = this.readU8(a.level);

    // Sanity check
    if (level === 0 || level > 100 || maxHp === 0) return null;

    const atk = (this.readU8(a.atk_hi) << 8) | this.readU8(a.atk_lo);
    const def = (this.readU8(a.def_hi) << 8) | this.readU8(a.def_lo);
    const spd = (this.readU8(a.spd_hi) << 8) | this.readU8(a.spd_lo);
    const spc = (this.readU8(a.spc_hi) << 8) | this.readU8(a.spc_lo);
    const type1 = this.readU8(a.type1);
    const type2 = this.readU8(a.type2);
    const status = a.status !== null ? this.readU8(a.status) : 0;

    const moves = [];
    for (let i = 0; i < 4; i++) moves.push(this.readU8(a.moves + i));

    const pp = [];
    if (a.pp !== null) {
      for (let i = 0; i < 4; i++) pp.push(this.readU8(a.pp + i));
    } else {
      pp.push(99, 99, 99, 99); // assume opponent has PP
    }

    return { hp, maxHp, level, atk, def, spd, spc, type1, type2, moves, pp, status };
  }

  /* -----------------------------------------------------------------
   * Damage Calculation (Gen 1 Formula)
   * ----------------------------------------------------------------- */

  /**
   * Calculate min and max damage for a move.
   *
   * Gen 1 formula:
   *   base = floor(floor(floor(2*level/5 + 2) * attack * power / defense) / 50) + 2
   *   if STAB → base = floor(base * 1.5)
   *   base *= type effectiveness
   *   min = floor(base * 217/255)
   *   max = base
   *
   * @param {number} moveId
   * @param {number} typeId   - Game Boy internal type ID
   * @param {number} power
   * @param {object} attacker - { level, atk, spc, type1, type2 }
   * @param {object} defender - { def, spc, type1, type2 }
   * @returns {{ minDmg: number, maxDmg: number }}
   */
  calcDamage(moveId, typeId, power, attacker, defender) {
    if (power <= 0) return { minDmg: 0, maxDmg: 0 };

    const typeName = TYPE_IDS[typeId];
    if (!typeName) return { minDmg: 0, maxDmg: 0 };

    // Determine physical vs special (Gen 1 split)
    const isSpecial = SPECIAL_TYPES.has(typeName);
    const attackStat = isSpecial ? attacker.spc : attacker.atk;
    const defenseStat = isSpecial ? defender.spc : defender.def;

    // Guard against division by zero
    const effectiveDef = Math.max(defenseStat, 1);
    const effectiveAtk = Math.max(attackStat, 1);

    const level = attacker.level;

    // Core formula
    let damage = Math.floor(
      Math.floor(
        Math.floor(2 * level / 5 + 2) * effectiveAtk * power / effectiveDef
      ) / 50
    ) + 2;

    // STAB (Same Type Attack Bonus)
    const attackerType1 = TYPE_IDS[attacker.type1];
    const attackerType2 = TYPE_IDS[attacker.type2];
    if (typeName === attackerType1 || typeName === attackerType2) {
      damage = Math.floor(damage * 1.5);
    }

    // Type effectiveness
    const atkIdx = TYPE_INDEX[typeName];
    const defType1 = TYPE_IDS[defender.type1];
    const defType2 = TYPE_IDS[defender.type2];

    let effectiveness = 1;
    if (defType1 !== undefined && TYPE_INDEX[defType1] !== undefined) {
      effectiveness *= TYPE_CHART[atkIdx][TYPE_INDEX[defType1]];
    }
    if (defType2 !== undefined && defType2 !== defType1 && TYPE_INDEX[defType2] !== undefined) {
      effectiveness *= TYPE_CHART[atkIdx][TYPE_INDEX[defType2]];
    }

    damage = Math.floor(damage * effectiveness);

    // Minimum roll is 217/255 ≈ 85% of max
    const minDmg = Math.max(Math.floor(damage * 217 / 255), effectiveness > 0 ? 1 : 0);
    const maxDmg = Math.max(damage, effectiveness > 0 ? 1 : 0);

    return { minDmg, maxDmg };
  }

  /**
   * Get type effectiveness multiplier between two types.
   * @param {string} atkType - attacking type name
   * @param {string} defType - defending type name
   * @returns {number} 0, 0.5, 1, or 2
   */
  getTypeEffectiveness(atkType, defType) {
    const ai = TYPE_INDEX[atkType];
    const di = TYPE_INDEX[defType];
    if (ai === undefined || di === undefined) return 1;
    return TYPE_CHART[ai][di];
  }
}

/* ===================================================================
 * 7. EXPORT
 * =================================================================== */

window.Autoplay = Autoplay;
