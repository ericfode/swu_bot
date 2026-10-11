;; swu-wasm: a Star Wars Unlimited bot written by hand in WebAssembly text.
;;
;; The host (host.js) turns each stdio `decide` message into flat i32 tables in linear memory (header, units, hand,
;; actions, distribute targets, lower-cased strings) and calls `decide`, which returns the index of the action to take.
;; Every decision is made here; the host only parses JSON and looks up printed card stats.
;;
;; Strategy, in short:
;;  - Action window: an attack planner enumerates every assignment of my ready units to targets (hold, enemy base,
;;    each enemy unit) per arena and keeps the one with the best integer score, so several units can gang up on one
;;    enemy. A knapsack over the hand picks the cards that spend the most of this turn's resources. Actions are then
;;    ranked: lethal, kill a ready enemy unit, deploy the leader, cards in the spend plan, other kills, base hits.
;;  - Base damage is weighed by a race clock (turns for me to kill their base against turns for them to kill mine).
;;  - Other prompts: the title is read with substring tests ("deal 3 damage", "defeat", "heal", "attach", ...) to
;;    decide whether a target should be friendly or enemy and which one gains the most.
;;  - A per-game memory remembers which action was tried in which position, so a click that changes nothing (a
;;    cancelled play) is not repeated.
;;
;; All scores are integers in tenths.
(module
  (import "env" "trace" (func $trace (param i32 i32)))
  (memory (export "memory") 16)

  ;; ---------- memory layout (byte offsets), exported so the host writes the same places ----------
  (global $SRC (export "SRC") i32 (i32.const 512))          ;; card record of the prompt's source card (at +64)
  (global $DIST (export "DIST") i32 (i32.const 1024))       ;; distribute targets, 16 bytes each
  (global $UNITS (export "UNITS") i32 (i32.const 4096))     ;; unit rows, 128 bytes each
  (global $HAND (export "HAND") i32 (i32.const 12288))      ;; my hand, 128 bytes each
  (global $ACTS (export "ACTS") i32 (i32.const 16384))      ;; action rows, 128 bytes each
  (global $TEXT (export "TEXT") i32 (i32.const 278528))     ;; lower-cased UTF-8 strings
  (global $TEXT_END (export "TEXT_END") i32 (i32.const 917504))
  (global $OUT (export "OUT") i32 (i32.const 917504))       ;; +0 index, +4 has split, +8.. split amounts
  (global $ST i32 (i32.const 921600))                       ;; per-game state, kept between decisions
  (global $SCR i32 (i32.const 950272))                      ;; scratch for one decision
  (global $MAX_UNITS (export "MAX_UNITS") i32 (i32.const 64))
  (global $MAX_HAND (export "MAX_HAND") i32 (i32.const 32))
  (global $MAX_ACTS (export "MAX_ACTS") i32 (i32.const 2048))
  (global $MAX_DIST (export "MAX_DIST") i32 (i32.const 64))

  ;; header: i32 slots from address 0
  (global $H_NUNITS (export "H_NUNITS") i32 (i32.const 0))
  (global $H_NHAND (export "H_NHAND") i32 (i32.const 1))
  (global $H_NACTS (export "H_NACTS") i32 (i32.const 2))
  (global $H_ROUND (export "H_ROUND") i32 (i32.const 3))
  (global $H_PHASE (export "H_PHASE") i32 (i32.const 4))      ;; 1 setup, 2 action, 3 regroup
  (global $H_INIT (export "H_INIT") i32 (i32.const 5))        ;; 1 me, 2 opponent, 0 nobody
  (global $H_AW (export "H_AW") i32 (i32.const 6))            ;; top-level action window
  (global $H_SELMODE (export "H_SELMODE") i32 (i32.const 7))  ;; 1 single, 2 multiple
  (global $H_NSEL (export "H_NSEL") i32 (i32.const 8))
  (global $H_PTYPE (export "H_PTYPE") i32 (i32.const 9))
  (global $H_TOFF (export "H_TOFF") i32 (i32.const 10))       ;; prompt title
  (global $H_TLEN (export "H_TLEN") i32 (i32.const 11))
  (global $H_POFF (export "H_POFF") i32 (i32.const 12))       ;; prompt source title
  (global $H_PLEN (export "H_PLEN") i32 (i32.const 13))
  (global $H_MYHP (export "H_MYHP") i32 (i32.const 14))
  (global $H_MYDMG (export "H_MYDMG") i32 (i32.const 15))
  (global $H_OPHP (export "H_OPHP") i32 (i32.const 16))
  (global $H_OPDMG (export "H_OPDMG") i32 (i32.const 17))
  (global $H_MYREADY (export "H_MYREADY") i32 (i32.const 18))
  (global $H_MYTOTAL (export "H_MYTOTAL") i32 (i32.const 19))
  (global $H_OPREADY (export "H_OPREADY") i32 (i32.const 20))
  (global $H_OPTOTAL (export "H_OPTOTAL") i32 (i32.const 21))
  (global $H_MYHAND (export "H_MYHAND") i32 (i32.const 22))
  (global $H_OPHAND (export "H_OPHAND") i32 (i32.const 23))
  (global $H_MYDECK (export "H_MYDECK") i32 (i32.const 24))
  (global $H_OPDECK (export "H_OPDECK") i32 (i32.const 25))
  (global $H_MYLDEP (export "H_MYLDEP") i32 (i32.const 26))   ;; my leader deployed
  (global $H_MYLEXH (export "H_MYLEXH") i32 (i32.const 27))
  (global $H_MYLCOST (export "H_MYLCOST") i32 (i32.const 28)) ;; resources needed to deploy it
  (global $H_OPLDEP (export "H_OPLDEP") i32 (i32.const 29))
  (global $H_ASP0 (export "H_ASP0") i32 (i32.const 30))       ;; my leader + base aspect icons, 4 slots
  (global $H_SEQ (export "H_SEQ") i32 (i32.const 34))
  (global $H_SRCUNIT (export "H_SRCUNIT") i32 (i32.const 35)) ;; my unit row named like the prompt source, or -1
  (global $H_SRCOK (export "H_SRCOK") i32 (i32.const 36))
  (global $H_DTYPE (export "H_DTYPE") i32 (i32.const 37))     ;; 1 damage, 2 healing, 3 other
  (global $H_DAMT (export "H_DAMT") i32 (i32.const 38))
  (global $H_DLESS (export "H_DLESS") i32 (i32.const 39))
  (global $H_DNONE (export "H_DNONE") i32 (i32.const 40))
  (global $H_DMAX (export "H_DMAX") i32 (i32.const 41))       ;; -1 = no limit
  (global $H_DN (export "H_DN") i32 (i32.const 42))
  (global $H_DACT (export "H_DACT") i32 (i32.const 43))       ;; action index of the distribute action
  (global $H_OPDISC (export "H_OPDISC") i32 (i32.const 44))
  (global $H_MYLUID (export "H_MYLUID") i32 (i32.const 45))

  ;; unit row fields (bytes)
  (global $U_OWNER (export "U_OWNER") i32 (i32.const 0))      ;; 0 me, 1 opponent
  (global $U_ARENA (export "U_ARENA") i32 (i32.const 4))      ;; 1 ground, 2 space
  (global $U_POW (export "U_POW") i32 (i32.const 8))
  (global $U_HP (export "U_HP") i32 (i32.const 12))
  (global $U_DMG (export "U_DMG") i32 (i32.const 16))
  (global $U_EXH (export "U_EXH") i32 (i32.const 20))
  (global $U_SENT (export "U_SENT") i32 (i32.const 24))
  (global $U_SHIELDS (export "U_SHIELDS") i32 (i32.const 28))
  (global $U_UPGR (export "U_UPGR") i32 (i32.const 32))
  (global $U_LEADER (export "U_LEADER") i32 (i32.const 36))
  (global $U_UID (export "U_UID") i32 (i32.const 40))
  ;; action row fields (bytes)
  (global $A_KIND (export "A_KIND") i32 (i32.const 0))        ;; 1 button 2 card 3 option 4 displayCard 5 perCardButton 6 distribute
  (global $A_ZONE (export "A_ZONE") i32 (i32.const 4))        ;; 1 hand 2 ground 3 space 4 base 5 discard 6 resource 9 other
  (global $A_CTL (export "A_CTL") i32 (i32.const 8))          ;; 0 me, 1 opponent, -1 nobody
  (global $A_UNIT (export "A_UNIT") i32 (i32.const 12))       ;; unit row index or -1
  (global $A_BASE (export "A_BASE") i32 (i32.const 16))       ;; 1 my base, 2 their base
  (global $A_LEAD (export "A_LEAD") i32 (i32.const 20))       ;; 1 my leader, 2 their leader
  (global $A_LOFF (export "A_LOFF") i32 (i32.const 24))       ;; label
  (global $A_LLEN (export "A_LLEN") i32 (i32.const 28))
  (global $A_NUM (export "A_NUM") i32 (i32.const 32))         ;; numeric arg/label or -1
  (global $A_HAND (export "A_HAND") i32 (i32.const 36))       ;; hand row index or -1
  (global $A_UID (export "A_UID") i32 (i32.const 40))
  (global $A_SEL (export "A_SEL") i32 (i32.const 44))         ;; already selected in a multi-select
  ;; hand row
  (global $R_UID (export "R_UID") i32 (i32.const 0))
  ;; card record, at +64 in unit, hand, action and source rows
  (global $C_OK (export "C_OK") i32 (i32.const 64))
  (global $C_COST (export "C_COST") i32 (i32.const 68))
  (global $C_POW (export "C_POW") i32 (i32.const 72))
  (global $C_HP (export "C_HP") i32 (i32.const 76))
  (global $C_TYPE (export "C_TYPE") i32 (i32.const 80))
  (global $C_ARENA (export "C_ARENA") i32 (i32.const 84))
  (global $C_ASP0 (export "C_ASP0") i32 (i32.const 88))       ;; aspect codes 1..6 at 88, 92, 96
  (global $C_KW (export "C_KW") i32 (i32.const 100))
  (global $C_UPOW (export "C_UPOW") i32 (i32.const 104))
  (global $C_UHP (export "C_UHP") i32 (i32.const 108))
  (global $C_TOFF (export "C_TOFF") i32 (i32.const 112))      ;; card text
  (global $C_TLEN (export "C_TLEN") i32 (i32.const 116))
  ;; distribute target fields
  (global $D_UNIT (export "D_UNIT") i32 (i32.const 0))
  (global $D_BASE (export "D_BASE") i32 (i32.const 4))
  (global $D_CAP (export "D_CAP") i32 (i32.const 8))          ;; -1 = no cap

  ;; card types and keywords (bit masks)
  (global $T_UNIT (export "T_UNIT") i32 (i32.const 1))
  (global $T_EVENT (export "T_EVENT") i32 (i32.const 2))
  (global $T_UPGRADE (export "T_UPGRADE") i32 (i32.const 4))
  (global $T_LEADER (export "T_LEADER") i32 (i32.const 8))
  (global $T_BASE (export "T_BASE") i32 (i32.const 16))
  (global $T_TOKEN (export "T_TOKEN") i32 (i32.const 32))
  (global $K_SENTINEL (export "K_SENTINEL") i32 (i32.const 1))
  (global $K_OVERWHELM (export "K_OVERWHELM") i32 (i32.const 2))
  (global $K_SABOTEUR (export "K_SABOTEUR") i32 (i32.const 4))
  (global $K_RAID (export "K_RAID") i32 (i32.const 8))
  (global $K_AMBUSH (export "K_AMBUSH") i32 (i32.const 16))
  (global $K_GRIT (export "K_GRIT") i32 (i32.const 32))
  (global $K_RESTORE (export "K_RESTORE") i32 (i32.const 64))
  (global $K_SHIELDED (export "K_SHIELDED") i32 (i32.const 128))
  (global $K_HIDDEN (export "K_HIDDEN") i32 (i32.const 256))
  (global $K_SMUGGLE (export "K_SMUGGLE") i32 (i32.const 512))
  (global $K_BOUNTY (export "K_BOUNTY") i32 (i32.const 1024))

  ;; per-game state (offsets from $ST)
  ;;  +0 rng, +4 last window pick uid, +8 planned target of that pick (-1 base, -2 none, else unit uid)
  ;;  +12 display-select prompt key, +16 its last seq, +20 cards I picked in it, +24.. their uids (16)
  ;;  +256 visit table: 512 x (key, count); +4352 tried set: 1024 keys
  ;; scratch (offsets from $SCR)
  ;;  +0 ATT unit rows, +32 ATT action index, +64 TGT unit rows, +128 LEG[8][8], +384 ASSIGN, +416 BEST
  ;;  +448 AP attacker power, +480 AV value, +512 AL left, +544 AS shields, +576 AO overwhelm
  ;;  +608 TP target power, +640 TL left, +672 TS shields, +704 TV value, +736 TR ready
  ;;  +768 SUMP, +800 MINP, +832 CNT, +864 OVW, +896 KILL, +960 KC (knapsack), +1024 pool
  ;;  +4096 PLAN_T[act], +12288 PLAN_C[act], +20480 PLAN_B[act] (can hit the base)

  ;; plan categories
  (global $CAT_NONE i32 (i32.const 0))
  (global $CAT_HOLD i32 (i32.const 1))
  (global $CAT_BASE i32 (i32.const 2))
  (global $CAT_CHIP i32 (i32.const 3))
  (global $CAT_KILL i32 (i32.const 4))
  (global $CAT_KILL_READY i32 (i32.const 5))
  (global $CAT_LETHAL i32 (i32.const 6))
  (global $CAT_PLAY_PLAN i32 (i32.const 7))
  (global $CAT_PLAY_OFF i32 (i32.const 8))
  (global $CAT_PLAY_HOLD i32 (i32.const 9))

  ;; target intents
  (global $I_NEUTRAL i32 (i32.const 0))
  (global $I_DAMAGE i32 (i32.const 1))
  (global $I_REMOVE i32 (i32.const 2))
  (global $I_EXHAUST i32 (i32.const 3))
  (global $I_HEAL i32 (i32.const 4))
  (global $I_HELP i32 (i32.const 5))
  (global $I_DEBUFF i32 (i32.const 6))

  ;; per-decision board facts, set by $prepare
  (global $g_my_left (mut i32) (i32.const 0))
  (global $g_op_left (mut i32) (i32.const 0))
  (global $g_my_pow (mut i32) (i32.const 0))
  (global $g_op_pow (mut i32) (i32.const 0))
  (global $g_my_units (mut i32) (i32.const 0))
  (global $g_op_units (mut i32) (i32.const 0))
  (global $g_bw (mut i32) (i32.const 12))       ;; value of one point of base damage, tenths
  (global $g_tm (mut i32) (i32.const 10))       ;; multiplier on trade gains, tenths
  (global $g_lethal_dmg (mut i32) (i32.const 0))
  (global $g_bdmg (mut i32) (i32.const 0))
  (global $g_fp (mut i32) (i32.const 0))
  (global $g_dsel (mut i32) (i32.const 0))

  ;; ---------- keyword strings, NUL-terminated, 32 bytes apart from 0xF0000 ----------
  (global $S_ATTACK i32 (i32.const 983040))     (data (i32.const 983040) "attack\00")
  (global $S_DEAL i32 (i32.const 983072))       (data (i32.const 983072) "deal \00")
  (global $S_DAMAGE i32 (i32.const 983104))     (data (i32.const 983104) "damage\00")
  (global $S_DEFEAT i32 (i32.const 983136))     (data (i32.const 983136) "defeat\00")
  (global $S_CAPTURE i32 (i32.const 983168))    (data (i32.const 983168) "capture\00")
  (global $S_RETURN i32 (i32.const 983200))     (data (i32.const 983200) "return\00")
  (global $S_DISCARD i32 (i32.const 983232))    (data (i32.const 983232) "discard\00")
  (global $S_EXHAUST i32 (i32.const 983264))    (data (i32.const 983264) "exhaust\00")
  (global $S_HEAL i32 (i32.const 983296))       (data (i32.const 983296) "heal\00")
  (global $S_SHIELD i32 (i32.const 983328))     (data (i32.const 983328) "shield\00")
  (global $S_EXPERIENCE i32 (i32.const 983360)) (data (i32.const 983360) "experience\00")
  (global $S_ADVANTAGE i32 (i32.const 983392))  (data (i32.const 983392) "advantage\00")
  (global $S_SENTINEL i32 (i32.const 983424))   (data (i32.const 983424) "sentinel\00")
  (global $S_ATTACH i32 (i32.const 983456))     (data (i32.const 983456) "attach\00")
  (global $S_GIVE i32 (i32.const 983488))       (data (i32.const 983488) "give\00")
  (global $S_READY i32 (i32.const 983520))      (data (i32.const 983520) "ready\00")
  (global $S_FRIENDLY i32 (i32.const 983552))   (data (i32.const 983552) "friendly\00")
  (global $S_ENEMY i32 (i32.const 983584))      (data (i32.const 983584) "enemy\00")
  (global $S_BETWEEN i32 (i32.const 983616))    (data (i32.const 983616) "between \00")
  (global $S_SELECT i32 (i32.const 983648))     (data (i32.const 983648) "select \00")
  (global $S_CHOOSE i32 (i32.const 983680))     (data (i32.const 983680) "choose \00")
  (global $S_UPTO i32 (i32.const 983712))       (data (i32.const 983712) "up to \00")
  (global $S_PASS i32 (i32.const 983744))       (data (i32.const 983744) "pass\00")
  (global $S_CLAIM i32 (i32.const 983776))      (data (i32.const 983776) "claim\00")
  (global $S_CANCEL i32 (i32.const 983808))     (data (i32.const 983808) "cancel\00")
  (global $S_DONE i32 (i32.const 983840))       (data (i32.const 983840) "done\00")
  (global $S_CONFIRM i32 (i32.const 983872))    (data (i32.const 983872) "confirm\00")
  (global $S_SKIP i32 (i32.const 983904))       (data (i32.const 983904) "skip\00")
  (global $S_NOTHING i32 (i32.const 983936))    (data (i32.const 983936) "nothing\00")
  (global $S_YOURSELF i32 (i32.const 983968))   (data (i32.const 983968) "yourself\00")
  (global $S_KEEP i32 (i32.const 984000))       (data (i32.const 984000) "keep\00")
  (global $S_MULLIGAN i32 (i32.const 984032))   (data (i32.const 984032) "mulligan\00")
  (global $S_TRIGGER i32 (i32.const 984064))    (data (i32.const 984064) "trigger\00")
  (global $S_YES i32 (i32.const 984096))        (data (i32.const 984096) "yes\00")
  (global $S_DEPLOY i32 (i32.const 984128))     (data (i32.const 984128) "deploy\00")
  (global $S_ANYWAY i32 (i32.const 984160))     (data (i32.const 984160) "anyway\00")
  (global $S_AND i32 (i32.const 984192))        (data (i32.const 984192) " and \00")
  (global $S_RESOURCE i32 (i32.const 984224))   (data (i32.const 984224) "resource\00")
  (global $S_DRAW i32 (i32.const 984256))       (data (i32.const 984256) "draw\00")
  (global $S_RAID i32 (i32.const 984288))       (data (i32.const 984288) "raid \00")
  (global $S_CONTINUE i32 (i32.const 984320))   (data (i32.const 984320) "continue\00")
  (global $S_OK i32 (i32.const 984352))         (data (i32.const 984352) "ok\00")
  (global $S_USE i32 (i32.const 984384))        (data (i32.const 984384) "use \00")
  (global $S_OPPONENT i32 (i32.const 984416))   (data (i32.const 984416) "opponent\00")
  (global $S_NO i32 (i32.const 984448))         (data (i32.const 984448) "no\00")
  (global $S_DECLINE i32 (i32.const 984480))    (data (i32.const 984480) "decline\00")
  (global $S_DEBUFF i32 (i32.const 984512))     (data (i32.const 984512) "/-\00")
  (global $S_BUFF i32 (i32.const 984544))       (data (i32.const 984544) "/+\00")
  (global $S_BOUNTY i32 (i32.const 984576))     (data (i32.const 984576) "bounty\00")
  (global $S_BASE i32 (i32.const 984608))       (data (i32.const 984608) "base\00")
  (global $S_PLAY i32 (i32.const 984640))       (data (i32.const 984640) "play\00")
  (global $S_RESOLVE i32 (i32.const 984672))    (data (i32.const 984672) "resolve\00")
  (global $S_BOTTOM i32 (i32.const 984704))     (data (i32.const 984704) "bottom\00")
  (global $S_RETURNA i32 (i32.const 984736))    (data (i32.const 984736) "return a\00")
  (global $S_EXHAUSTA i32 (i32.const 984768))   (data (i32.const 984768) "exhaust a\00")
  (global $S_TAKECONTROL i32 (i32.const 984800)) (data (i32.const 984800) "take control\00")
  (global $S_WITH i32 (i32.const 984832))       (data (i32.const 984832) "attack with\00")
  (global $S_FORTHISATTACK i32 (i32.const 984864)) (data (i32.const 984864) "for this attack\00")
  (global $S_HAND i32 (i32.const 984896))       (data (i32.const 984896) "hand\00")

  ;; ---------- small helpers ----------
  (func $hdr (param $i i32) (result i32) (i32.load (i32.shl (local.get $i) (i32.const 2))))
  (func $f (param $row i32) (param $off i32) (result i32) (i32.load (i32.add (local.get $row) (local.get $off))))
  (func $unit (param $i i32) (result i32) (i32.add (global.get $UNITS) (i32.shl (local.get $i) (i32.const 7))))
  (func $hand (param $i i32) (result i32) (i32.add (global.get $HAND) (i32.shl (local.get $i) (i32.const 7))))
  (func $act (param $i i32) (result i32) (i32.add (global.get $ACTS) (i32.shl (local.get $i) (i32.const 7))))
  (func $dist (param $i i32) (result i32) (i32.add (global.get $DIST) (i32.shl (local.get $i) (i32.const 4))))
  (func $scr (param $off i32) (param $i i32) (result i32)
    (i32.add (i32.add (global.get $SCR) (local.get $off)) (i32.shl (local.get $i) (i32.const 2))))
  (func $sget (param $off i32) (param $i i32) (result i32) (i32.load (call $scr (local.get $off) (local.get $i))))
  (func $sset (param $off i32) (param $i i32) (param $v i32) (i32.store (call $scr (local.get $off) (local.get $i)) (local.get $v)))
  (func $min (param $a i32) (param $b i32) (result i32)
    (select (local.get $a) (local.get $b) (i32.lt_s (local.get $a) (local.get $b))))
  (func $max (param $a i32) (param $b i32) (result i32)
    (select (local.get $a) (local.get $b) (i32.gt_s (local.get $a) (local.get $b))))
  (func $max0 (param $a i32) (result i32) (call $max (local.get $a) (i32.const 0)))

  ;; xorshift32, seeded by the host's per-game seed
  (func $rand (result i32)
    (local $x i32)
    (local.set $x (i32.load (global.get $ST)))
    (local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 13))))
    (local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 17))))
    (local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 5))))
    (i32.store (global.get $ST) (local.get $x))
    (local.get $x))
  ;; 0..3 tenths, to break exact ties without always favouring the first action
  (func $noise (result i32) (i32.and (call $rand) (i32.const 3)))

  ;; ---------- strings ----------
  (func $strlen (param $s i32) (result i32)
    (local $n i32)
    (block $end
      (loop $l
        (br_if $end (i32.eqz (i32.load8_u (i32.add (local.get $s) (local.get $n)))))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $l)))
    (local.get $n))

  ;; first position of the NUL-terminated needle in text[off, off+len), or -1
  (func $find (param $off i32) (param $len i32) (param $kw i32) (result i32)
    (local $i i32) (local $j i32) (local $c i32)
    (block $none
      (loop $outer
        (br_if $none (i32.ge_s (local.get $i) (local.get $len)))
        (local.set $j (i32.const 0))
        (block $miss
          (loop $inner
            (local.set $c (i32.load8_u (i32.add (local.get $kw) (local.get $j))))
            (if (i32.eqz (local.get $c)) (then (return (local.get $i))))
            (br_if $miss (i32.ge_s (i32.add (local.get $i) (local.get $j)) (local.get $len)))
            (br_if $miss (i32.ne (local.get $c)
              (i32.load8_u (i32.add (local.get $off) (i32.add (local.get $i) (local.get $j))))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $inner)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $outer)))
    (i32.const -1))

  (func $has (param $off i32) (param $len i32) (param $kw i32) (result i32)
    (i32.ge_s (call $find (local.get $off) (local.get $len) (local.get $kw)) (i32.const 0)))
  (func $t_has (param $kw i32) (result i32)
    (call $has (call $hdr (global.get $H_TOFF)) (call $hdr (global.get $H_TLEN)) (local.get $kw)))
  (func $l_has (param $row i32) (param $kw i32) (result i32)
    (call $has (call $f (local.get $row) (global.get $A_LOFF)) (call $f (local.get $row) (global.get $A_LLEN)) (local.get $kw)))
  (func $x_has (param $row i32) (param $kw i32) (result i32)
    (call $has (call $f (local.get $row) (global.get $C_TOFF)) (call $f (local.get $row) (global.get $C_TLEN)) (local.get $kw)))
  ;; label is exactly the keyword
  (func $l_is (param $row i32) (param $kw i32) (result i32)
    (i32.and
      (i32.eq (call $f (local.get $row) (global.get $A_LLEN)) (call $strlen (local.get $kw)))
      (i32.eqz (call $find (call $f (local.get $row) (global.get $A_LOFF)) (call $f (local.get $row) (global.get $A_LLEN)) (local.get $kw)))))
  ;; label starts with the keyword
  (func $l_starts (param $row i32) (param $kw i32) (result i32)
    (i32.eqz (call $find (call $f (local.get $row) (global.get $A_LOFF)) (call $f (local.get $row) (global.get $A_LLEN)) (local.get $kw))))

  ;; integer starting at text[off+pos] after optional spaces, or -1
  (func $num_at (param $off i32) (param $len i32) (param $pos i32) (result i32)
    (local $c i32) (local $n i32) (local $any i32)
    (block $done
      (loop $sp
        (br_if $done (i32.ge_s (local.get $pos) (local.get $len)))
        (br_if $done (i32.ne (i32.load8_u (i32.add (local.get $off) (local.get $pos))) (i32.const 32)))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $sp)))
    (block $end
      (loop $dig
        (br_if $end (i32.ge_s (local.get $pos) (local.get $len)))
        (local.set $c (i32.sub (i32.load8_u (i32.add (local.get $off) (local.get $pos))) (i32.const 48)))
        (br_if $end (i32.gt_u (local.get $c) (i32.const 9)))
        (local.set $n (i32.add (i32.mul (local.get $n) (i32.const 10)) (local.get $c)))
        (local.set $any (i32.const 1))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $dig)))
    (select (local.get $n) (i32.const -1) (local.get $any)))

  (func $num_after (param $off i32) (param $len i32) (param $kw i32) (result i32)
    (local $p i32)
    (local.set $p (call $find (local.get $off) (local.get $len) (local.get $kw)))
    (if (i32.lt_s (local.get $p) (i32.const 0)) (then (return (i32.const -1))))
    (call $num_at (local.get $off) (local.get $len) (i32.add (local.get $p) (call $strlen (local.get $kw)))))
  (func $t_num_after (param $kw i32) (result i32)
    (call $num_after (call $hdr (global.get $H_TOFF)) (call $hdr (global.get $H_TLEN)) (local.get $kw)))

  ;; how many cards a select prompt wants: "between 1 and 2" -> 2, "select 2", "choose up to 3"; default 1
  (func $wanted (result i32)
    (local $n i32)
    (if (call $t_has (global.get $S_BETWEEN))
      (then
        (local.set $n (call $t_num_after (global.get $S_AND)))
        (if (i32.ge_s (local.get $n) (i32.const 0)) (then (return (local.get $n))))))
    (local.set $n (call $t_num_after (global.get $S_UPTO)))
    (if (i32.ge_s (local.get $n) (i32.const 0)) (then (return (local.get $n))))
    (local.set $n (call $t_num_after (global.get $S_SELECT)))
    (if (i32.ge_s (local.get $n) (i32.const 0)) (then (return (local.get $n))))
    (local.set $n (call $t_num_after (global.get $S_CHOOSE)))
    (if (i32.ge_s (local.get $n) (i32.const 0)) (then (return (local.get $n))))
    (i32.const 1))
  ;; the lower bound of "between a and b", else what $wanted says
  (func $wanted_min (result i32)
    (local $n i32)
    (if (call $t_has (global.get $S_BETWEEN))
      (then
        (local.set $n (call $t_num_after (global.get $S_BETWEEN)))
        (if (i32.ge_s (local.get $n) (i32.const 0)) (then (return (local.get $n))))))
    (call $wanted))

  ;; ---------- card and unit values ----------
  (func $kwbonus (param $kw i32) (result i32)
    (local $b i32)
    (if (i32.and (local.get $kw) (global.get $K_OVERWHELM)) (then (local.set $b (i32.add (local.get $b) (i32.const 5)))))
    (if (i32.and (local.get $kw) (global.get $K_RAID)) (then (local.set $b (i32.add (local.get $b) (i32.const 5)))))
    (if (i32.and (local.get $kw) (global.get $K_RESTORE)) (then (local.set $b (i32.add (local.get $b) (i32.const 5)))))
    (if (i32.and (local.get $kw) (global.get $K_SABOTEUR)) (then (local.set $b (i32.add (local.get $b) (i32.const 4)))))
    (if (i32.and (local.get $kw) (global.get $K_GRIT)) (then (local.set $b (i32.add (local.get $b) (i32.const 3)))))
    (if (i32.and (local.get $kw) (global.get $K_HIDDEN)) (then (local.set $b (i32.add (local.get $b) (i32.const 2)))))
    (local.get $b))

  (func $left (param $u i32) (result i32)
    (call $max0 (i32.sub (call $f (local.get $u) (global.get $U_HP)) (call $f (local.get $u) (global.get $U_DMG)))))
  (func $ready (param $u i32) (result i32) (i32.eqz (call $f (local.get $u) (global.get $U_EXH))))
  (func $pow (param $u i32) (result i32) (call $max0 (call $f (local.get $u) (global.get $U_POW))))
  (func $mine (param $u i32) (result i32) (i32.eqz (call $f (local.get $u) (global.get $U_OWNER))))

  ;; worth of a unit on the board
  (func $uval (param $u i32) (result i32)
    (local $v i32)
    (local.set $v (i32.add
      (i32.mul (call $pow (local.get $u)) (i32.const 13))
      (i32.mul (call $left (local.get $u)) (i32.const 9))))
    (local.set $v (i32.add (local.get $v) (i32.mul (call $f (local.get $u) (global.get $U_SHIELDS)) (i32.const 20))))
    (if (call $f (local.get $u) (global.get $U_SENT)) (then (local.set $v (i32.add (local.get $v) (i32.const 10)))))
    (if (call $f (local.get $u) (global.get $U_LEADER)) (then (local.set $v (i32.add (local.get $v) (i32.const 20)))))
    (i32.add (local.get $v) (call $kwbonus (call $f (local.get $u) (global.get $C_KW)))))

  ;; worth of a unit card not yet in play (printed stats)
  (func $cval (param $r i32) (result i32)
    (local $v i32) (local $kw i32)
    (local.set $kw (call $f (local.get $r) (global.get $C_KW)))
    (local.set $v (i32.add
      (i32.mul (call $max0 (call $f (local.get $r) (global.get $C_POW))) (i32.const 13))
      (i32.mul (call $max0 (call $f (local.get $r) (global.get $C_HP))) (i32.const 9))))
    (if (i32.and (local.get $kw) (global.get $K_SHIELDED)) (then (local.set $v (i32.add (local.get $v) (i32.const 20)))))
    (if (i32.and (local.get $kw) (global.get $K_SENTINEL)) (then (local.set $v (i32.add (local.get $v) (i32.const 10)))))
    (i32.add (local.get $v) (call $kwbonus (local.get $kw))))

  ;; extra cost for aspect icons that my leader and base don't cover: 2 per missing icon
  (func $penalty (param $r i32) (result i32)
    (local $k i32) (local $j i32) (local $a i32) (local $miss i32) (local $found i32)
    (local.set $j (i32.const 0))
    (loop $copy
      (call $sset (i32.const 1024) (local.get $j) (call $hdr (i32.add (global.get $H_ASP0) (local.get $j))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br_if $copy (i32.lt_s (local.get $j) (i32.const 4))))
    (loop $each
      (local.set $a (call $f (local.get $r) (i32.add (global.get $C_ASP0) (i32.shl (local.get $k) (i32.const 2)))))
      (if (local.get $a)
        (then
          (local.set $found (i32.const 0))
          (local.set $j (i32.const 0))
          (block $hit
            (loop $scan
              (if (i32.eq (call $sget (i32.const 1024) (local.get $j)) (local.get $a))
                (then
                  (call $sset (i32.const 1024) (local.get $j) (i32.const 0))
                  (local.set $found (i32.const 1))
                  (br $hit)))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br_if $scan (i32.lt_s (local.get $j) (i32.const 4)))))
          (if (i32.eqz (local.get $found)) (then (local.set $miss (i32.add (local.get $miss) (i32.const 1)))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br_if $each (i32.lt_s (local.get $k) (i32.const 3))))
    (i32.shl (local.get $miss) (i32.const 1)))

  (func $eff_cost (param $r i32) (result i32)
    (i32.add (call $max0 (call $f (local.get $r) (global.get $C_COST))) (call $penalty (local.get $r))))
  (func $is_type (param $r i32) (param $t i32) (result i32)
    (i32.ne (i32.and (call $f (local.get $r) (global.get $C_TYPE)) (local.get $t)) (i32.const 0)))

  ;; how much I want to keep a hand card rather than resource or discard it (higher = keep)
  (func $keep (param $r i32) (result i32)
    (local $k i32) (local $eff i32) (local $total i32)
    (if (i32.eqz (call $f (local.get $r) (global.get $C_OK))) (then (return (i32.const 0))))
    (local.set $eff (call $eff_cost (local.get $r)))
    (local.set $total (call $hdr (global.get $H_MYTOTAL)))
    (if (call $is_type (local.get $r) (global.get $T_UNIT)) (then (local.set $k (i32.const 15))))
    (if (i32.le_s (local.get $eff) (i32.add (local.get $total) (i32.const 2)))
      (then (local.set $k (i32.add (local.get $k) (i32.const 15)))))
    (if (i32.gt_s (local.get $eff) (i32.add (local.get $total) (i32.const 4)))
      (then (local.set $k (i32.sub (local.get $k) (i32.const 15)))))
    (local.set $k (i32.sub (local.get $k) (i32.mul (call $penalty (local.get $r)) (i32.const 10))))
    (i32.sub (local.get $k) (i32.mul (call $max0 (call $f (local.get $r) (global.get $C_COST))) (i32.const 2))))

  ;; does card text read as removal (needs an enemy unit to be worth playing)?
  (func $is_removal (param $r i32) (result i32)
    (i32.or (i32.or (i32.or (call $x_has (local.get $r) (global.get $S_DEFEAT))
                            (call $x_has (local.get $r) (global.get $S_DEAL)))
                    (i32.or (call $x_has (local.get $r) (global.get $S_CAPTURE))
                            (call $x_has (local.get $r) (global.get $S_RETURNA))))
            (i32.or (call $x_has (local.get $r) (global.get $S_EXHAUSTA))
                    (call $x_has (local.get $r) (global.get $S_DEBUFF)))))

  ;; an upgrade meant for an enemy unit (negative stats or a bounty)
  (func $harmful_upgrade (param $r i32) (result i32)
    (i32.or (i32.or (i32.lt_s (call $f (local.get $r) (global.get $C_UPOW)) (i32.const 0))
                    (i32.lt_s (call $f (local.get $r) (global.get $C_UHP)) (i32.const 0)))
            (call $x_has (local.get $r) (global.get $S_BOUNTY))))

  ;; is it worth playing this hand card now? 0 = hold it
  (func $play_ok (param $r i32) (result i32)
    (if (i32.eqz (call $f (local.get $r) (global.get $C_OK))) (then (return (i32.const 1))))
    (if (call $is_type (local.get $r) (global.get $T_UNIT)) (then (return (i32.const 1))))
    (if (call $is_type (local.get $r) (global.get $T_UPGRADE))
      (then
        (if (call $harmful_upgrade (local.get $r)) (then (return (i32.gt_s (global.get $g_op_units) (i32.const 0)))))
        (return (i32.gt_s (global.get $g_my_units) (i32.const 0)))))
    (if (call $is_type (local.get $r) (global.get $T_EVENT))
      (then
        (if (i32.and (call $is_removal (local.get $r)) (i32.eqz (global.get $g_op_units)))
          (then (return (call $x_has (local.get $r) (global.get $S_BASE)))))))
    (i32.const 1))

  ;; ---------- board facts ----------
  (func $prepare
    (local $i i32) (local $n i32) (local $u i32) (local $myc i32) (local $opc i32)
    (global.set $g_my_left (call $max0 (i32.sub (call $hdr (global.get $H_MYHP)) (call $hdr (global.get $H_MYDMG)))))
    (global.set $g_op_left (call $max0 (i32.sub (call $hdr (global.get $H_OPHP)) (call $hdr (global.get $H_OPDMG)))))
    (global.set $g_my_pow (i32.const 0))
    (global.set $g_op_pow (i32.const 0))
    (global.set $g_my_units (i32.const 0))
    (global.set $g_op_units (i32.const 0))
    (local.set $n (call $hdr (global.get $H_NUNITS)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $u (call $unit (local.get $i)))
        (if (call $mine (local.get $u))
          (then
            (global.set $g_my_pow (i32.add (global.get $g_my_pow) (call $pow (local.get $u))))
            (global.set $g_my_units (i32.add (global.get $g_my_units) (i32.const 1))))
          (else
            (global.set $g_op_pow (i32.add (global.get $g_op_pow) (call $pow (local.get $u))))
            (global.set $g_op_units (i32.add (global.get $g_op_units) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    ;; race clock: rounds each side needs to finish the other's base with the power on the board now
    (local.set $myc (i32.const 99))
    (if (global.get $g_my_pow)
      (then (local.set $myc (i32.div_s (i32.sub (i32.add (global.get $g_op_left) (global.get $g_my_pow)) (i32.const 1)) (global.get $g_my_pow)))))
    (local.set $opc (i32.const 99))
    (if (global.get $g_op_pow)
      (then (local.set $opc (i32.div_s (i32.sub (i32.add (global.get $g_my_left) (global.get $g_op_pow)) (i32.const 1)) (global.get $g_op_pow)))))
    (global.set $g_bw (i32.const 10))
    (if (i32.eq (local.get $myc) (local.get $opc)) (then (global.set $g_bw (i32.const 13))))
    (if (i32.lt_s (local.get $myc) (local.get $opc)) (then (global.set $g_bw (i32.const 15))))
    (if (i32.le_s (global.get $g_op_left) (i32.const 8)) (then (global.set $g_bw (i32.const 18))))
    (global.set $g_tm (i32.const 10))
    (if (i32.lt_s (local.get $opc) (local.get $myc)) (then (global.set $g_tm (i32.const 12))))
    (if (i32.le_s (local.get $opc) (i32.const 2)) (then (global.set $g_tm (i32.const 14)))))

  ;; fingerprint of the visible position, to spot clicks that changed nothing
  (func $mix (param $h i32) (param $v i32) (result i32)
    (i32.mul (i32.xor (local.get $h) (local.get $v)) (i32.const 16777619)))
  (func $fingerprint (result i32)
    (local $h i32) (local $i i32) (local $n i32) (local $u i32) (local $k i32)
    (local.set $h (i32.const -2128831035))
    (local.set $k (i32.const 3))
    (loop $hd
      (local.set $h (call $mix (local.get $h) (call $hdr (local.get $k))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br_if $hd (i32.le_s (local.get $k) (global.get $H_OPLDEP))))
    (local.set $n (call $hdr (global.get $H_NUNITS)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $u (call $unit (local.get $i)))
        (local.set $k (i32.const 0))
        (loop $fl
          (local.set $h (call $mix (local.get $h) (call $f (local.get $u) (local.get $k))))
          (local.set $k (i32.add (local.get $k) (i32.const 4)))
          (br_if $fl (i32.le_s (local.get $k) (global.get $U_UID))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.or (local.get $h) (i32.const 1)))

  ;; visit counter per fingerprint (open addressing, 512 slots)
  (func $visit (param $key i32) (result i32)
    (local $slot i32) (local $a i32) (local $k i32) (local $tries i32)
    (local.set $slot (i32.and (i32.shr_u (i32.mul (local.get $key) (i32.const -1640531535)) (i32.const 20)) (i32.const 511)))
    (block $out
      (loop $probe
        (local.set $a (i32.add (i32.add (global.get $ST) (i32.const 256)) (i32.shl (local.get $slot) (i32.const 3))))
        (local.set $k (i32.load (local.get $a)))
        (if (i32.eqz (local.get $k))
          (then (i32.store (local.get $a) (local.get $key)) (local.set $k (local.get $key))))
        (if (i32.eq (local.get $k) (local.get $key))
          (then
            (i32.store offset=4 (local.get $a) (i32.add (i32.load offset=4 (local.get $a)) (i32.const 1)))
            (return (i32.load offset=4 (local.get $a)))))
        (local.set $slot (i32.and (i32.add (local.get $slot) (i32.const 1)) (i32.const 511)))
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $probe (i32.lt_s (local.get $tries) (i32.const 512)))))
    (i32.const 1))

  ;; set of (position, action) pairs already tried; $add = 1 inserts, returns whether it was there before
  (func $tried (param $key i32) (param $add i32) (result i32)
    (local $slot i32) (local $a i32) (local $k i32) (local $tries i32)
    (local.set $key (i32.or (local.get $key) (i32.const 1)))
    (local.set $slot (i32.and (i32.shr_u (i32.mul (local.get $key) (i32.const -1640531535)) (i32.const 20)) (i32.const 1023)))
    (block $out
      (loop $probe
        (local.set $a (i32.add (i32.add (global.get $ST) (i32.const 4352)) (i32.shl (local.get $slot) (i32.const 2))))
        (local.set $k (i32.load (local.get $a)))
        (if (i32.eq (local.get $k) (local.get $key)) (then (return (i32.const 1))))
        (if (i32.eqz (local.get $k))
          (then
            (if (local.get $add) (then (i32.store (local.get $a) (local.get $key))))
            (return (i32.const 0))))
        (local.set $slot (i32.and (i32.add (local.get $slot) (i32.const 1)) (i32.const 1023)))
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $probe (i32.lt_s (local.get $tries) (i32.const 1024)))))
    (i32.const 0))

  ;; identity of an action that survives between decisions: the card uid, else a hash of the label
  (func $act_key (param $r i32) (result i32)
    (local $h i32) (local $i i32) (local $off i32) (local $len i32)
    (if (i32.ge_s (call $f (local.get $r) (global.get $A_UID)) (i32.const 0))
      (then (return (i32.add (call $f (local.get $r) (global.get $A_UID)) (i32.const 7919)))))
    (local.set $off (call $f (local.get $r) (global.get $A_LOFF)))
    (local.set $len (call $f (local.get $r) (global.get $A_LLEN)))
    (local.set $h (i32.const 5381))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $len)))
        (local.set $h (i32.add (i32.mul (local.get $h) (i32.const 33)) (i32.load8_u (i32.add (local.get $off) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (local.get $h))
  (func $pair_key (param $fp i32) (param $r i32) (result i32)
    (call $mix (call $mix (local.get $fp) (call $act_key (local.get $r))) (i32.const 0x5bd1e995)))

  ;; unit row index with this uid, or -1
  (func $unit_by_uid (param $uid i32) (result i32)
    (local $i i32) (local $n i32)
    (local.set $n (call $hdr (global.get $H_NUNITS)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (if (i32.eq (call $f (call $unit (local.get $i)) (global.get $U_UID)) (local.get $uid)) (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.const -1))

  ;; ---------- attack planner ----------
  ;; attack power including Raid N from the card text
  (func $atk_pow (param $u i32) (result i32)
    (local $p i32) (local $raid i32)
    (local.set $p (call $pow (local.get $u)))
    (if (i32.and (call $f (local.get $u) (global.get $C_KW)) (global.get $K_RAID))
      (then
        (local.set $raid (call $num_after (call $f (local.get $u) (global.get $C_TOFF)) (call $f (local.get $u) (global.get $C_TLEN)) (global.get $S_RAID)))
        (if (i32.gt_s (local.get $raid) (i32.const 0)) (then (local.set $p (i32.add (local.get $p) (local.get $raid)))))))
    (local.get $p))

  ;; score of the assignment in ASSIGN (+384) for na attackers and no options (0 hold, 1 base, 2.. enemy units)
  (func $plan_value (param $na i32) (param $no i32) (result i32)
    (local $i i32) (local $j i32) (local $p i32) (local $bdmg i32) (local $loss i32) (local $gain i32)
    (local $eff i32) (local $cp i32) (local $g i32)
    (local.set $j (i32.const 0))
    (loop $z
      (call $sset (i32.const 768) (local.get $j) (i32.const 0))
      (call $sset (i32.const 800) (local.get $j) (i32.const 999))
      (call $sset (i32.const 832) (local.get $j) (i32.const 0))
      (call $sset (i32.const 864) (local.get $j) (i32.const 0))
      (call $sset (i32.const 896) (local.get $j) (i32.const 0))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br_if $z (i32.lt_s (local.get $j) (i32.const 8))))
    (local.set $i (i32.const 0))
    (block $end
      (loop $att
        (br_if $end (i32.ge_s (local.get $i) (local.get $na)))
        (local.set $j (call $sget (i32.const 384) (local.get $i)))
        (local.set $p (call $sget (i32.const 448) (local.get $i)))
        (if (i32.eq (local.get $j) (i32.const 1))
          (then (local.set $bdmg (i32.add (local.get $bdmg) (local.get $p)))))
        (if (i32.ge_s (local.get $j) (i32.const 2))
          (then
            (call $sset (i32.const 768) (local.get $j) (i32.add (call $sget (i32.const 768) (local.get $j)) (local.get $p)))
            (call $sset (i32.const 800) (local.get $j) (call $min (call $sget (i32.const 800) (local.get $j)) (local.get $p)))
            (call $sset (i32.const 832) (local.get $j) (i32.add (call $sget (i32.const 832) (local.get $j)) (i32.const 1)))
            (if (call $sget (i32.const 576) (local.get $i)) (then (call $sset (i32.const 864) (local.get $j) (i32.const 1))))
            ;; the defender hits back: a shield takes it, else it may kill the attacker
            (local.set $cp (call $sget (i32.const 608) (local.get $j)))
            (if (call $sget (i32.const 544) (local.get $i))
              (then (local.set $loss (i32.add (local.get $loss) (i32.const 10))))
              (else
                (if (i32.ge_s (local.get $cp) (call $sget (i32.const 512) (local.get $i)))
                  (then (local.set $loss (i32.add (local.get $loss) (call $sget (i32.const 480) (local.get $i)))))
                  (else (local.set $loss (i32.add (local.get $loss) (i32.mul (local.get $cp) (i32.const 3))))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $att)))
    (local.set $j (i32.const 2))
    (block $tend
      (loop $tg
        (br_if $tend (i32.ge_s (local.get $j) (local.get $no)))
        (if (call $sget (i32.const 832) (local.get $j))
          (then
            (local.set $eff (call $sget (i32.const 768) (local.get $j)))
            ;; a shield eats the first hit: let the weakest attacker take it
            (if (call $sget (i32.const 672) (local.get $j))
              (then (local.set $eff (i32.sub (local.get $eff) (call $sget (i32.const 800) (local.get $j))))))
            (if (i32.ge_s (local.get $eff) (call $sget (i32.const 640) (local.get $j)))
              (then
                (call $sset (i32.const 896) (local.get $j) (i32.const 1))
                (local.set $g (i32.add (call $sget (i32.const 704) (local.get $j)) (i32.const 20)))
                (if (call $sget (i32.const 736) (local.get $j)) (then (local.set $g (i32.add (local.get $g) (i32.const 30)))))
                (if (call $sget (i32.const 864) (local.get $j))
                  (then (local.set $bdmg (i32.add (local.get $bdmg) (i32.sub (local.get $eff) (call $sget (i32.const 640) (local.get $j))))))))
              (else
                (local.set $g (i32.mul (call $max0 (local.get $eff)) (i32.const 4)))
                (if (call $sget (i32.const 672) (local.get $j)) (then (local.set $g (i32.add (local.get $g) (i32.const 15)))))))
            (local.set $gain (i32.add (local.get $gain) (local.get $g)))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $tg)))
    (global.set $g_bdmg (local.get $bdmg))
    (i32.sub
      (i32.add (i32.mul (local.get $bdmg) (global.get $g_bw))
               (i32.div_s (i32.mul (local.get $gain) (global.get $g_tm)) (i32.const 10)))
      (local.get $loss)))

  ;; plan the attacks of one arena (1 ground, 2 space); writes PLAN_T/PLAN_C/PLAN_B for each attacker action
  (func $plan_arena (param $arena i32)
    (local $i i32) (local $n i32) (local $r i32) (local $u i32) (local $na i32) (local $no i32) (local $j i32)
    (local $sent i32) (local $sab i32) (local $ok i32) (local $v i32) (local $best i32) (local $t i32) (local $leg i32)
    (local $weak i32) (local $k i32)
    ;; attackers: my ready units in this arena that are clickable (at most 6, strongest kept)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (block $aend
      (loop $al
        (br_if $aend (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $act (local.get $i)))
        (if (i32.and (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 2))
                     (i32.and (i32.eqz (call $f (local.get $r) (global.get $A_CTL)))
                              (i32.ge_s (call $f (local.get $r) (global.get $A_UNIT)) (i32.const 0))))
          (then
            (local.set $u (call $unit (call $f (local.get $r) (global.get $A_UNIT))))
            (if (i32.and (i32.and (call $mine (local.get $u)) (call $ready (local.get $u)))
                         (i32.eq (call $f (local.get $u) (global.get $U_ARENA)) (local.get $arena)))
              (then
                (if (i32.lt_s (local.get $na) (i32.const 6))
                  (then
                    (call $sset (i32.const 0) (local.get $na) (local.get $u))
                    (call $sset (i32.const 32) (local.get $na) (local.get $i))
                    (local.set $na (i32.add (local.get $na) (i32.const 1))))
                  (else
                    ;; full: replace the weakest attacker if this one hits harder
                    (local.set $weak (i32.const 0))
                    (local.set $k (i32.const 1))
                    (loop $wk
                      (if (i32.lt_s (call $pow (call $sget (i32.const 0) (local.get $k))) (call $pow (call $sget (i32.const 0) (local.get $weak))))
                        (then (local.set $weak (local.get $k))))
                      (local.set $k (i32.add (local.get $k) (i32.const 1)))
                      (br_if $wk (i32.lt_s (local.get $k) (i32.const 6))))
                    (if (i32.gt_s (call $pow (local.get $u)) (call $pow (call $sget (i32.const 0) (local.get $weak))))
                      (then
                        (call $sset (i32.const 0) (local.get $weak) (local.get $u))
                        (call $sset (i32.const 32) (local.get $weak) (local.get $i))))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $al)))
    (if (i32.eqz (local.get $na)) (then (return)))
    ;; targets: hold, the enemy base, then up to 5 enemy units in this arena (sentinels first)
    (local.set $no (i32.const 2))
    (local.set $n (call $hdr (global.get $H_NUNITS)))
    (local.set $k (i32.const 0))
    (loop $pass2
      (local.set $i (i32.const 0))
      (block $tend
        (loop $tl
          (br_if $tend (i32.ge_s (local.get $i) (local.get $n)))
          (local.set $u (call $unit (local.get $i)))
          (if (i32.and (i32.eqz (call $mine (local.get $u)))
                       (i32.eq (call $f (local.get $u) (global.get $U_ARENA)) (local.get $arena)))
            (then
              (if (call $f (local.get $u) (global.get $U_SENT)) (then (local.set $sent (i32.const 1))))
              ;; pass 0 takes sentinels, pass 1 the rest
              (if (i32.and (i32.lt_s (local.get $no) (i32.const 7))
                           (i32.eq (i32.eqz (call $f (local.get $u) (global.get $U_SENT))) (local.get $k)))
                (then
                  (call $sset (i32.const 64) (local.get $no) (local.get $u))
                  (local.set $no (i32.add (local.get $no) (i32.const 1)))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $tl)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br_if $pass2 (i32.lt_s (local.get $k) (i32.const 2))))
    ;; per-attacker and per-target numbers, and who may hit what
    (local.set $i (i32.const 0))
    (loop $ai
      (local.set $u (call $sget (i32.const 0) (local.get $i)))
      (call $sset (i32.const 448) (local.get $i) (call $atk_pow (local.get $u)))
      (call $sset (i32.const 480) (local.get $i) (call $uval (local.get $u)))
      (call $sset (i32.const 512) (local.get $i) (call $left (local.get $u)))
      (call $sset (i32.const 544) (local.get $i) (call $f (local.get $u) (global.get $U_SHIELDS)))
      (call $sset (i32.const 576) (local.get $i) (i32.ne (i32.and (call $f (local.get $u) (global.get $C_KW)) (global.get $K_OVERWHELM)) (i32.const 0)))
      (local.set $sab (i32.ne (i32.and (call $f (local.get $u) (global.get $C_KW)) (global.get $K_SABOTEUR)) (i32.const 0)))
      (local.set $j (i32.const 0))
      (loop $lj
        (local.set $leg (i32.const 1))
        (if (i32.eq (local.get $j) (i32.const 1))
          (then (local.set $leg (i32.or (i32.eqz (local.get $sent)) (local.get $sab)))))
        (if (i32.ge_s (local.get $j) (i32.const 2))
          (then (local.set $leg (i32.or (i32.or (i32.eqz (local.get $sent)) (local.get $sab))
                                        (i32.ne (call $f (call $sget (i32.const 64) (local.get $j)) (global.get $U_SENT)) (i32.const 0))))))
        (call $sset (i32.const 128) (i32.add (i32.shl (local.get $i) (i32.const 3)) (local.get $j)) (local.get $leg))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $lj (i32.lt_s (local.get $j) (local.get $no))))
      ;; for the lethal check: how much this unit can put on the base
      (call $sset (i32.const 20480) (call $sget (i32.const 32) (local.get $i)) (i32.or (i32.eqz (local.get $sent)) (local.get $sab)))
      (if (i32.or (i32.eqz (local.get $sent)) (local.get $sab))
        (then (global.set $g_lethal_dmg (i32.add (global.get $g_lethal_dmg) (call $sget (i32.const 448) (local.get $i))))))
      (call $sset (i32.const 384) (local.get $i) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $ai (i32.lt_s (local.get $i) (local.get $na))))
    (local.set $j (i32.const 2))
    (block $tend2
      (loop $tj
        (br_if $tend2 (i32.ge_s (local.get $j) (local.get $no)))
        (local.set $t (call $sget (i32.const 64) (local.get $j)))
        (call $sset (i32.const 608) (local.get $j) (call $pow (local.get $t)))
        (call $sset (i32.const 640) (local.get $j) (call $left (local.get $t)))
        (call $sset (i32.const 672) (local.get $j) (call $f (local.get $t) (global.get $U_SHIELDS)))
        (call $sset (i32.const 704) (local.get $j) (call $uval (local.get $t)))
        (call $sset (i32.const 736) (local.get $j) (call $ready (local.get $t)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $tj)))
    ;; try every assignment (at most 7^6)
    (local.set $best (i32.const -2147483647))
    (block $done
      (loop $enum
        (local.set $ok (i32.const 1))
        (local.set $i (i32.const 0))
        (loop $chk
          (if (i32.eqz (call $sget (i32.const 128) (i32.add (i32.shl (local.get $i) (i32.const 3)) (call $sget (i32.const 384) (local.get $i)))))
            (then (local.set $ok (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $chk (i32.lt_s (local.get $i) (local.get $na))))
        (if (local.get $ok)
          (then
            (local.set $v (call $plan_value (local.get $na) (local.get $no)))
            (if (i32.gt_s (local.get $v) (local.get $best))
              (then
                (local.set $best (local.get $v))
                (local.set $i (i32.const 0))
                (loop $cp
                  (call $sset (i32.const 416) (local.get $i) (call $sget (i32.const 384) (local.get $i)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br_if $cp (i32.lt_s (local.get $i) (local.get $na))))))))
        ;; next assignment (mixed-radix counter)
        (local.set $i (i32.const 0))
        (loop $inc
          (call $sset (i32.const 384) (local.get $i) (i32.add (call $sget (i32.const 384) (local.get $i)) (i32.const 1)))
          (br_if $enum (i32.lt_s (call $sget (i32.const 384) (local.get $i)) (local.get $no)))
          (call $sset (i32.const 384) (local.get $i) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $inc (i32.lt_s (local.get $i) (local.get $na))))))
    ;; replay the best assignment to get its kill flags, then label each attacker
    (local.set $i (i32.const 0))
    (loop $cb
      (call $sset (i32.const 384) (local.get $i) (call $sget (i32.const 416) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $cb (i32.lt_s (local.get $i) (local.get $na))))
    (drop (call $plan_value (local.get $na) (local.get $no)))
    (local.set $i (i32.const 0))
    (loop $lab
      (local.set $j (call $sget (i32.const 416) (local.get $i)))
      (local.set $k (call $sget (i32.const 32) (local.get $i)))
      (if (i32.eqz (local.get $j))
        (then
          (call $sset (i32.const 4096) (local.get $k) (i32.const -2))
          (call $sset (i32.const 12288) (local.get $k) (global.get $CAT_HOLD))))
      (if (i32.eq (local.get $j) (i32.const 1))
        (then
          (call $sset (i32.const 4096) (local.get $k) (i32.const -1))
          (call $sset (i32.const 12288) (local.get $k) (global.get $CAT_BASE))))
      (if (i32.ge_s (local.get $j) (i32.const 2))
        (then
          (local.set $t (call $sget (i32.const 64) (local.get $j)))
          (call $sset (i32.const 4096) (local.get $k) (call $f (local.get $t) (global.get $U_UID)))
          (if (call $sget (i32.const 896) (local.get $j))
            (then
              (if (call $ready (local.get $t))
                (then (call $sset (i32.const 12288) (local.get $k) (global.get $CAT_KILL_READY)))
                (else (call $sset (i32.const 12288) (local.get $k) (global.get $CAT_KILL)))))
            (else (call $sset (i32.const 12288) (local.get $k) (global.get $CAT_CHIP))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $lab (i32.lt_s (local.get $i) (local.get $na)))))

  ;; ---------- spend plan: which hand cards use the most of this turn's resources ----------
  (func $knapsack
    (local $i i32) (local $n i32) (local $r i32) (local $hr i32) (local $nc i32) (local $mask i32) (local $lim i32)
    (local $cost i32) (local $val i32) (local $best i32) (local $bm i32) (local $k i32) (local $budget i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $act (local.get $i)))
        (if (i32.and (i32.and (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 2))
                              (i32.eq (call $f (local.get $r) (global.get $A_ZONE)) (i32.const 1)))
                     (i32.eqz (call $f (local.get $r) (global.get $A_CTL))))
          (then
            (if (call $play_ok (local.get $r))
              (then
                (call $sset (i32.const 12288) (local.get $i) (global.get $CAT_PLAY_OFF))
                (if (i32.and (call $f (local.get $r) (global.get $C_OK)) (i32.lt_s (local.get $nc) (i32.const 12)))
                  (then
                    (call $sset (i32.const 960) (local.get $nc) (local.get $i))
                    (local.set $nc (i32.add (local.get $nc) (i32.const 1))))))
              (else (call $sset (i32.const 12288) (local.get $i) (global.get $CAT_PLAY_HOLD))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (if (i32.eqz (local.get $nc)) (then (return)))
    (local.set $budget (call $hdr (global.get $H_MYREADY)))
    (local.set $lim (i32.shl (i32.const 1) (local.get $nc)))
    (local.set $mask (i32.const 1))
    (block $mend
      (loop $ml
        (br_if $mend (i32.ge_s (local.get $mask) (local.get $lim)))
        (local.set $cost (i32.const 0))
        (local.set $val (i32.const 0))
        (local.set $k (i32.const 0))
        (loop $bits
          (if (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $k)))
            (then
              (local.set $r (call $act (call $sget (i32.const 960) (local.get $k))))
              (local.set $cost (i32.add (local.get $cost) (call $eff_cost (local.get $r))))
              (local.set $val (i32.add (local.get $val) (i32.mul (call $eff_cost (local.get $r)) (i32.const 10))))
              (if (call $is_type (local.get $r) (global.get $T_UNIT)) (then (local.set $val (i32.add (local.get $val) (i32.const 5)))))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br_if $bits (i32.lt_s (local.get $k) (local.get $nc))))
        (if (i32.and (i32.le_s (local.get $cost) (local.get $budget)) (i32.gt_s (local.get $val) (local.get $best)))
          (then (local.set $best (local.get $val)) (local.set $bm (local.get $mask))))
        (local.set $mask (i32.add (local.get $mask) (i32.const 1)))
        (br $ml)))
    (local.set $k (i32.const 0))
    (loop $mark
      (if (i32.and (local.get $bm) (i32.shl (i32.const 1) (local.get $k)))
        (then (call $sset (i32.const 12288) (call $sget (i32.const 960) (local.get $k)) (global.get $CAT_PLAY_PLAN))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br_if $mark (i32.lt_s (local.get $k) (local.get $nc)))))

  ;; ---------- the action window ----------
  (func $is_pass (param $r i32) (result i32)
    (i32.and (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 1)) (call $l_is (local.get $r) (global.get $S_PASS))))

  ;; holding a card that only becomes useful once the opponent commits (removal with no target yet)?
  (func $holding_removal (result i32)
    (local $i i32) (local $n i32) (local $r i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (if (i32.eq (call $sget (i32.const 12288) (local.get $i)) (global.get $CAT_PLAY_HOLD)) (then (return (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.const 0))

  (func $window_score (param $i i32) (result i32)
    (local $r i32) (local $cat i32) (local $zone i32) (local $u i32) (local $t i32) (local $pow i32)
    (local.set $r (call $act (local.get $i)))
    (local.set $cat (call $sget (i32.const 12288) (local.get $i)))
    (local.set $zone (call $f (local.get $r) (global.get $A_ZONE)))
    (if (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 1))
      (then
        (if (call $l_is (local.get $r) (global.get $S_PASS)) (then (return (i32.const 0))))
        (if (call $l_has (local.get $r) (global.get $S_CLAIM))
          (then
            (if (i32.and (call $holding_removal) (i32.ge_s (call $hdr (global.get $H_MYREADY)) (i32.const 2)))
              (then (return (i32.const -1))))
            (return (i32.const 100))))
        (return (i32.const 50))))
    (if (i32.ne (call $f (local.get $r) (global.get $A_KIND)) (i32.const 2)) (then (return (i32.const 40))))
    ;; opponent's cards are rarely worth clicking from the window
    (if (call $f (local.get $r) (global.get $A_CTL)) (then (return (i32.const 20))))
    (if (i32.ge_s (call $f (local.get $r) (global.get $A_UNIT)) (i32.const 0))
      (then
        (local.set $u (call $unit (call $f (local.get $r) (global.get $A_UNIT))))
        (local.set $pow (call $atk_pow (local.get $u)))
        (if (i32.eq (local.get $cat) (global.get $CAT_LETHAL)) (then (return (i32.add (i32.const 5000) (local.get $pow)))))
        (if (i32.or (i32.eq (local.get $cat) (global.get $CAT_KILL_READY)) (i32.eq (local.get $cat) (global.get $CAT_KILL)))
          (then
            (local.set $t (call $unit_by_uid (call $sget (i32.const 4096) (local.get $i))))
            (local.set $t (select (call $uval (call $unit (local.get $t))) (i32.const 0) (i32.ge_s (local.get $t) (i32.const 0))))
            ;; the weaker partner of a gang attack goes first so it soaks the shield
            (return (i32.add (i32.add
              (select (i32.const 3000) (i32.const 1700) (i32.eq (local.get $cat) (global.get $CAT_KILL_READY)))
              (i32.div_s (local.get $t) (i32.const 10)))
              (i32.sub (i32.const 20) (call $min (local.get $pow) (i32.const 20)))))))
        (if (i32.eq (local.get $cat) (global.get $CAT_BASE)) (then (return (i32.add (i32.const 1300) (i32.mul (local.get $pow) (i32.const 10))))))
        (if (i32.eq (local.get $cat) (global.get $CAT_CHIP)) (then (return (i32.const 900))))
        (if (i32.eq (local.get $cat) (global.get $CAT_HOLD)) (then (return (i32.const -100))))
        ;; my unit that the planner didn't consider: exhausted (an action ability) or over the cap
        (if (call $ready (local.get $u)) (then (return (i32.const 800))))
        (return (i32.const 300))))
    (if (i32.eq (call $f (local.get $r) (global.get $A_LEAD)) (i32.const 1))
      (then
        (if (i32.and (i32.eqz (call $hdr (global.get $H_MYLDEP)))
                     (i32.ge_s (call $hdr (global.get $H_MYTOTAL)) (call $hdr (global.get $H_MYLCOST))))
          (then (return (i32.const 2600))))
        (return (i32.const 450))))
    (if (i32.eq (call $f (local.get $r) (global.get $A_BASE)) (i32.const 1)) (then (return (i32.const 350))))
    (if (i32.eq (local.get $cat) (global.get $CAT_PLAY_PLAN))
      (then (return (i32.add (i32.add (i32.const 2000) (i32.mul (call $eff_cost (local.get $r)) (i32.const 10)))
                             (select (i32.const 5) (i32.const 0) (call $is_type (local.get $r) (global.get $T_UNIT)))))))
    (if (i32.eq (local.get $cat) (global.get $CAT_PLAY_OFF)) (then (return (i32.add (i32.const 600) (call $eff_cost (local.get $r))))))
    (if (i32.eq (local.get $cat) (global.get $CAT_PLAY_HOLD)) (then (return (i32.const -50))))
    (if (i32.eq (local.get $zone) (i32.const 6))
      (then (return (select (i32.add (i32.const 700) (call $eff_cost (local.get $r))) (i32.const -50) (call $play_ok (local.get $r))))))
    (i32.const 300))

  (func $choose_window (result i32)
    (local $i i32) (local $n i32) (local $r i32) (local $s i32) (local $best i32) (local $bi i32) (local $pass i32)
    (local $visits i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    ;; reset plan tables
    (local.set $i (i32.const 0))
    (block $z
      (loop $zl
        (br_if $z (i32.ge_s (local.get $i) (local.get $n)))
        (call $sset (i32.const 4096) (local.get $i) (i32.const -2))
        (call $sset (i32.const 12288) (local.get $i) (global.get $CAT_NONE))
        (call $sset (i32.const 20480) (local.get $i) (i32.const 0))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $zl)))
    (global.set $g_lethal_dmg (i32.const 0))
    (call $plan_arena (i32.const 1))
    (call $plan_arena (i32.const 2))
    ;; enough reach to finish the base this turn: everything that can hit it goes face
    (if (i32.and (i32.gt_s (global.get $g_op_left) (i32.const 0)) (i32.ge_s (global.get $g_lethal_dmg) (global.get $g_op_left)))
      (then
        (local.set $i (i32.const 0))
        (block $le
          (loop $ll
            (br_if $le (i32.ge_s (local.get $i) (local.get $n)))
            (if (call $sget (i32.const 20480) (local.get $i))
              (then
                (call $sset (i32.const 4096) (local.get $i) (i32.const -1))
                (call $sset (i32.const 12288) (local.get $i) (global.get $CAT_LETHAL))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ll)))))
    (call $knapsack)
    (local.set $visits (call $visit (global.get $g_fp)))
    (local.set $best (i32.const -2147483647))
    (local.set $bi (i32.const 0))
    (local.set $pass (i32.const -1))
    (local.set $i (i32.const 0))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $act (local.get $i)))
        (if (call $is_pass (local.get $r)) (then (local.set $pass (local.get $i))))
        (local.set $s (i32.add (call $window_score (local.get $i)) (call $noise)))
        ;; this click was already made in this exact position and nothing changed
        (if (call $tried (call $pair_key (global.get $g_fp) (local.get $r)) (i32.const 0))
          (then (local.set $s (i32.sub (local.get $s) (i32.const 5000)))))
        (if (i32.gt_s (local.get $s) (local.get $best))
          (then (local.set $best (local.get $s)) (local.set $bi (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    ;; loop guard: the same position keeps coming back
    (if (i32.and (i32.gt_s (local.get $visits) (i32.const 6)) (i32.ge_s (local.get $pass) (i32.const 0)))
      (then (local.set $bi (local.get $pass))))
    (local.set $r (call $act (local.get $bi)))
    (drop (call $tried (call $pair_key (global.get $g_fp) (local.get $r)) (i32.const 1)))
    (i32.store offset=4 (global.get $ST) (call $f (local.get $r) (global.get $A_UID)))
    (i32.store offset=8 (global.get $ST) (call $sget (i32.const 4096) (local.get $bi)))
    (local.get $bi))

  ;; ---------- targets outside the window ----------
  (func $intent (result i32)
    (if (i32.ge_s (call $t_num_after (global.get $S_DEAL)) (i32.const 0)) (then (return (global.get $I_DAMAGE))))
    (if (call $t_has (global.get $S_HEAL)) (then (return (global.get $I_HEAL))))
    (if (call $t_has (global.get $S_ATTACH))
      (then
        (if (i32.and (call $hdr (global.get $H_SRCOK)) (call $harmful_upgrade (global.get $SRC)))
          (then (return (global.get $I_DEBUFF))))
        (return (global.get $I_HELP))))
    (if (i32.or (i32.or (call $t_has (global.get $S_DEFEAT)) (call $t_has (global.get $S_CAPTURE)))
                (i32.or (call $t_has (global.get $S_TAKECONTROL)) (call $t_has (global.get $S_RETURN))))
      (then (return (global.get $I_REMOVE))))
    (if (call $t_has (global.get $S_DEBUFF)) (then (return (global.get $I_DEBUFF))))
    (if (call $t_has (global.get $S_EXHAUST)) (then (return (global.get $I_EXHAUST))))
    (if (i32.or (i32.or (i32.or (call $t_has (global.get $S_SHIELD)) (call $t_has (global.get $S_EXPERIENCE)))
                        (i32.or (call $t_has (global.get $S_ADVANTAGE)) (call $t_has (global.get $S_SENTINEL))))
                (i32.or (i32.or (call $t_has (global.get $S_BUFF)) (call $t_has (global.get $S_READY)))
                        (call $t_has (global.get $S_GIVE))))
      (then (return (global.get $I_HELP))))
    (global.get $I_NEUTRAL))

  ;; score of picking card action row $r for a prompt with intent $it (amount $amt for damage/heal)
  (func $target_score (param $r i32) (param $it i32) (param $amt i32) (result i32)
    (local $zone i32) (local $mine i32) (local $v i32) (local $u i32) (local $val i32) (local $left i32)
    (local $pow i32) (local $rdy i32) (local $sh i32) (local $base i32) (local $cost i32)
    (local.set $zone (call $f (local.get $r) (global.get $A_ZONE)))
    (local.set $mine (i32.eqz (call $f (local.get $r) (global.get $A_CTL))))
    (local.set $base (call $f (local.get $r) (global.get $A_BASE)))
    ;; cards outside the arenas: hand, discard, resources, search results
    (if (i32.or (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 4))
                (i32.or (i32.or (i32.eq (local.get $zone) (i32.const 1)) (i32.eq (local.get $zone) (i32.const 5)))
                        (i32.or (i32.eq (local.get $zone) (i32.const 6)) (i32.eq (local.get $zone) (i32.const 9)))))
      (then
        (if (i32.eqz (local.get $base))
          (then
            (if (i32.eqz (call $f (local.get $r) (global.get $A_LEAD)))
              (then
                (local.set $v (i32.add (call $keep (local.get $r))
                                       (i32.mul (call $max0 (call $f (local.get $r) (global.get $C_COST))) (i32.const 3))))
                (if (i32.and (local.get $mine)
                             (i32.or (i32.and (i32.eq (local.get $zone) (i32.const 1))
                                              (i32.or (call $t_has (global.get $S_DISCARD)) (i32.eq (local.get $it) (global.get $I_REMOVE))))
                                     (call $t_has (global.get $S_BOTTOM))))
                  (then (return (i32.sub (i32.const 0) (local.get $v)))))
                (return (local.get $v))))))))
    (if (i32.eq (local.get $base) (i32.const 1))
      (then
        (if (i32.eq (local.get $it) (global.get $I_DAMAGE)) (then (return (i32.const -200))))
        (if (i32.eq (local.get $it) (global.get $I_HEAL))
          (then (return (select (i32.add (i32.const 50) (i32.mul (call $hdr (global.get $H_MYDMG)) (i32.const 3))) (i32.const 1)
                                (i32.gt_s (call $hdr (global.get $H_MYDMG)) (i32.const 0))))))
        (if (i32.or (i32.eq (local.get $it) (global.get $I_REMOVE)) (i32.eq (local.get $it) (global.get $I_EXHAUST)))
          (then (return (i32.const -100))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $base) (i32.const 2))
      (then
        (if (i32.eq (local.get $it) (global.get $I_DAMAGE))
          (then (return (select (i32.const 10000) (i32.add (i32.mul (local.get $amt) (global.get $g_bw)) (i32.const 5))
                                (i32.ge_s (local.get $amt) (global.get $g_op_left))))))
        (if (i32.or (i32.eq (local.get $it) (global.get $I_HEAL)) (i32.eq (local.get $it) (global.get $I_HELP)))
          (then (return (i32.const -100))))
        (return (i32.const 3))))
    (if (i32.lt_s (call $f (local.get $r) (global.get $A_UNIT)) (i32.const 0))
      (then
        ;; an undeployed leader or some other card
        (if (i32.eq (call $f (local.get $r) (global.get $A_LEAD)) (i32.const 2))
          (then (return (select (i32.const 10) (i32.const 0) (i32.eq (local.get $it) (global.get $I_EXHAUST))))))
        (return (select (i32.const 5) (i32.const 0) (local.get $mine)))))
    (local.set $u (call $unit (call $f (local.get $r) (global.get $A_UNIT))))
    (local.set $val (call $uval (local.get $u)))
    (local.set $left (call $left (local.get $u)))
    (local.set $pow (call $pow (local.get $u)))
    (local.set $rdy (call $ready (local.get $u)))
    (local.set $sh (call $f (local.get $u) (global.get $U_SHIELDS)))
    (local.set $cost (call $max0 (call $f (local.get $u) (global.get $C_COST))))
    (if (i32.eqz (call $mine (local.get $u)))
      (then
        (if (i32.eq (local.get $it) (global.get $I_DAMAGE))
          (then
            (if (local.get $sh) (then (return (i32.const 15))))
            (if (i32.ge_s (local.get $amt) (local.get $left))
              (then (return (i32.add (i32.add (local.get $val) (i32.const 20)) (i32.mul (local.get $rdy) (i32.const 30))))))
            (return (i32.add (i32.mul (local.get $amt) (i32.const 4)) (local.get $pow)))))
        (if (i32.eq (local.get $it) (global.get $I_REMOVE))
          (then (return (i32.add (i32.add (local.get $val) (i32.mul (local.get $cost) (i32.const 5))) (i32.mul (local.get $rdy) (i32.const 20))))))
        (if (i32.eq (local.get $it) (global.get $I_DEBUFF))
          (then (return (i32.add (local.get $val) (i32.mul (local.get $rdy) (i32.const 10))))))
        (if (i32.eq (local.get $it) (global.get $I_EXHAUST))
          (then (return (select (i32.add (i32.mul (local.get $pow) (i32.const 10)) (i32.const 10)) (i32.const 1) (local.get $rdy)))))
        (if (i32.or (i32.eq (local.get $it) (global.get $I_HEAL)) (i32.eq (local.get $it) (global.get $I_HELP)))
          (then (return (i32.sub (i32.const -10) (local.get $val)))))
        (return (i32.div_s (local.get $val) (i32.const 3)))))
    ;; my own unit
    (if (i32.eq (local.get $it) (global.get $I_DAMAGE))
      (then
        (if (i32.and (i32.ge_s (local.get $amt) (local.get $left)) (i32.eqz (local.get $sh)))
          (then (return (i32.sub (i32.const -50) (local.get $val)))))
        (return (i32.sub (i32.const -10) (i32.mul (local.get $amt) (i32.const 4))))))
    (if (i32.or (i32.eq (local.get $it) (global.get $I_REMOVE)) (i32.eq (local.get $it) (global.get $I_DEBUFF)))
      (then (return (i32.sub (i32.sub (i32.const 0) (local.get $val)) (i32.mul (local.get $cost) (i32.const 5))))))
    (if (i32.eq (local.get $it) (global.get $I_EXHAUST))
      (then (return (select (i32.sub (i32.const -5) (i32.mul (local.get $pow) (i32.const 5))) (i32.const -1) (local.get $rdy)))))
    (if (i32.eq (local.get $it) (global.get $I_HEAL))
      (then (return (select
        (i32.add (i32.mul (call $f (local.get $u) (global.get $U_DMG)) (i32.const 10)) (i32.div_s (local.get $val) (i32.const 10)))
        (i32.const 1)
        (i32.gt_s (call $f (local.get $u) (global.get $U_DMG)) (i32.const 0))))))
    (if (i32.eq (local.get $it) (global.get $I_HELP))
      (then (return (i32.add (i32.add (local.get $val) (i32.const 5)) (i32.mul (local.get $rdy) (i32.const 10))))))
    (i32.div_s (local.get $val) (i32.const 2)))

  ;; value of attacker unit $a hitting target action row $r
  (func $attack_score (param $a i32) (param $r i32) (result i32)
    (local $p i32) (local $t i32) (local $left i32) (local $tp i32) (local $g i32) (local $loss i32) (local $eff i32)
    (local.set $p (call $atk_pow (local.get $a)))
    (if (i32.eq (call $f (local.get $r) (global.get $A_BASE)) (i32.const 2))
      (then
        (if (i32.and (i32.gt_s (local.get $p) (i32.const 0)) (i32.ge_s (local.get $p) (global.get $g_op_left))) (then (return (i32.const 10000))))
        (return (i32.mul (local.get $p) (global.get $g_bw)))))
    (if (i32.lt_s (call $f (local.get $r) (global.get $A_UNIT)) (i32.const 0)) (then (return (i32.const -500))))
    (local.set $t (call $unit (call $f (local.get $r) (global.get $A_UNIT))))
    (if (call $mine (local.get $t)) (then (return (i32.const -500))))
    (local.set $left (call $left (local.get $t)))
    (local.set $eff (select (i32.const 0) (local.get $p) (call $f (local.get $t) (global.get $U_SHIELDS))))
    (if (i32.ge_s (local.get $eff) (local.get $left))
      (then
        (local.set $g (i32.add (call $uval (local.get $t)) (i32.const 20)))
        (if (call $ready (local.get $t)) (then (local.set $g (i32.add (local.get $g) (i32.const 30)))))
        (if (i32.and (call $f (local.get $a) (global.get $C_KW)) (global.get $K_OVERWHELM))
          (then (local.set $g (i32.add (local.get $g) (i32.mul (i32.sub (local.get $eff) (local.get $left)) (global.get $g_bw)))))))
      (else
        (local.set $g (i32.mul (local.get $eff) (i32.const 4)))
        (if (call $f (local.get $t) (global.get $U_SHIELDS)) (then (local.set $g (i32.add (local.get $g) (i32.const 15)))))))
    (local.set $tp (call $pow (local.get $t)))
    (if (call $f (local.get $a) (global.get $U_SHIELDS))
      (then (local.set $loss (i32.const 10)))
      (else
        (local.set $loss (select (call $uval (local.get $a)) (i32.mul (local.get $tp) (i32.const 3))
                                 (i32.ge_s (local.get $tp) (call $left (local.get $a)))))))
    (i32.sub (i32.div_s (i32.mul (local.get $g) (global.get $g_tm)) (i32.const 10)) (local.get $loss)))

  ;; score of a button by its label
  (func $button_score (param $r i32) (result i32)
    (if (call $l_has (local.get $r) (global.get $S_ANYWAY)) (then (return (i32.const -50))))
    (if (call $l_has (local.get $r) (global.get $S_DEPLOY)) (then (return (i32.const 60))))
    (if (call $l_has (local.get $r) (global.get $S_TRIGGER)) (then (return (i32.const 50))))
    (if (call $l_is (local.get $r) (global.get $S_YES)) (then (return (i32.const 40))))
    (if (call $l_has (local.get $r) (global.get $S_YOURSELF)) (then (return (i32.const 40))))
    (if (call $l_has (local.get $r) (global.get $S_KEEP)) (then (return (i32.const 40))))
    (if (call $l_has (local.get $r) (global.get $S_CANCEL)) (then (return (i32.const -40))))
    (if (call $l_has (local.get $r) (global.get $S_NOTHING)) (then (return (i32.const -30))))
    (if (call $l_is (local.get $r) (global.get $S_PASS)) (then (return (i32.const -30))))
    (if (call $l_starts (local.get $r) (global.get $S_SKIP)) (then (return (i32.const -30))))
    (if (call $l_is (local.get $r) (global.get $S_NO)) (then (return (i32.const -30))))
    (if (call $l_has (local.get $r) (global.get $S_DECLINE)) (then (return (i32.const -30))))
    (if (call $l_has (local.get $r) (global.get $S_ATTACK)) (then (return (i32.const 35))))
    (if (call $l_has (local.get $r) (global.get $S_DEFEAT)) (then (return (i32.const 32))))
    (if (call $l_has (local.get $r) (global.get $S_DRAW)) (then (return (i32.const 30))))
    (if (call $l_has (local.get $r) (global.get $S_DEAL)) (then (return (i32.const 30))))
    (if (call $l_has (local.get $r) (global.get $S_SHIELD)) (then (return (i32.const 25))))
    (if (call $l_has (local.get $r) (global.get $S_EXPERIENCE)) (then (return (i32.const 22))))
    (if (call $l_has (local.get $r) (global.get $S_USE)) (then (return (i32.const 20))))
    (if (call $l_starts (local.get $r) (global.get $S_PLAY))
      (then (return (select (i32.const 5) (i32.const 20) (call $l_has (local.get $r) (global.get $S_DISCARD))))))
    (if (call $l_has (local.get $r) (global.get $S_HEAL)) (then (return (i32.const 15))))
    (if (call $l_has (local.get $r) (global.get $S_READY))
      (then (return (select (i32.const 18) (i32.const 10) (call $l_has (local.get $r) (global.get $S_FRIENDLY))))))
    (if (call $l_has (local.get $r) (global.get $S_OPPONENT)) (then (return (i32.const 12))))
    (if (i32.or (i32.or (call $l_has (local.get $r) (global.get $S_DONE)) (call $l_has (local.get $r) (global.get $S_CONFIRM)))
                (i32.or (call $l_has (local.get $r) (global.get $S_CONTINUE)) (call $l_has (local.get $r) (global.get $S_RESOLVE))))
      (then (return (i32.const 10))))
    (if (call $l_is (local.get $r) (global.get $S_OK)) (then (return (i32.const 10))))
    (i32.const 0))

  ;; done/confirm-like button that ends a multi-select
  (func $is_done (param $r i32) (result i32)
    (i32.and (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 1))
      (i32.or (i32.or (call $l_has (local.get $r) (global.get $S_DONE)) (call $l_has (local.get $r) (global.get $S_CONFIRM)))
              (call $l_is (local.get $r) (global.get $S_OK)))))
  ;; leaving a prompt without picking (pass, skip, choose nothing, done): 0; cancel: -10; anything else is not an exit
  (func $exit_score (param $r i32) (result i32)
    (if (call $l_has (local.get $r) (global.get $S_CANCEL)) (then (return (i32.const -10))))
    (if (i32.or (i32.or (call $l_is (local.get $r) (global.get $S_PASS)) (call $l_starts (local.get $r) (global.get $S_SKIP)))
                (i32.or (call $l_has (local.get $r) (global.get $S_NOTHING)) (call $is_done (local.get $r))))
      (then (return (i32.const 0))))
    (i32.const -9999))

  ;; Display prompts ("Select up to 2 cards" from a search) don't report which cards are already picked, and clicking
  ;; a picked card unpicks it. So remember my own picks while the same prompt keeps coming back on consecutive decisions.
  (func $disp_begin
    (local $key i32) (local $i i32) (local $n i32) (local $any i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (if (i32.eq (call $f (call $act (local.get $i)) (global.get $A_KIND)) (i32.const 4)) (then (local.set $any (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (local.set $key (call $mix (call $mix (i32.const 7) (call $hdr (global.get $H_TLEN))) (call $hdr (global.get $H_PLEN))))
    (if (i32.or (i32.eqz (local.get $any))
                (i32.or (i32.ne (i32.load offset=12 (global.get $ST)) (local.get $key))
                        (i32.ne (i32.add (i32.load offset=16 (global.get $ST)) (i32.const 1)) (call $hdr (global.get $H_SEQ)))))
      (then (i32.store offset=20 (global.get $ST) (i32.const 0))))
    (i32.store offset=12 (global.get $ST) (select (local.get $key) (i32.const 0) (local.get $any)))
    (i32.store offset=16 (global.get $ST) (call $hdr (global.get $H_SEQ)))
    (global.set $g_dsel (i32.load offset=20 (global.get $ST))))
  (func $disp_has (param $uid i32) (result i32)
    (local $i i32)
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (global.get $g_dsel)))
        (if (i32.eq (i32.load offset=24 (i32.add (global.get $ST) (i32.shl (local.get $i) (i32.const 2)))) (local.get $uid))
          (then (return (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.const 0))
  (func $disp_pick (param $r i32)
    (if (i32.and (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 4)) (i32.lt_s (global.get $g_dsel) (i32.const 16)))
      (then
        (i32.store offset=24 (i32.add (global.get $ST) (i32.shl (global.get $g_dsel) (i32.const 2))) (call $f (local.get $r) (global.get $A_UID)))
        (i32.store offset=20 (global.get $ST) (i32.add (global.get $g_dsel) (i32.const 1))))))

  (func $choose_cards (result i32)
    (local $i i32)
    (call $disp_begin)
    (local.set $i (call $choose_cards_inner))
    (call $disp_pick (call $act (local.get $i)))
    (local.get $i))

  ;; prompts with selectable cards (targets, discards, search results); also the attack target prompt
  (func $choose_cards_inner (result i32)
    (local $i i32) (local $n i32) (local $r i32) (local $k i32) (local $s i32) (local $it i32) (local $amt i32)
    (local $best i32) (local $bi i32) (local $exit i32) (local $ei i32) (local $done i32) (local $attack i32)
    (local $att i32) (local $want i32) (local $plan i32) (local $planned i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (local.set $it (call $intent))
    (local.set $amt (call $t_num_after (global.get $S_DEAL)))
    (if (i32.eq (local.get $it) (global.get $I_HEAL))
      (then (local.set $amt (call $t_num_after (global.get $S_HEAL)))))
    (if (i32.lt_s (local.get $amt) (i32.const 0)) (then (local.set $amt (i32.const 99))))
    ;; attack target prompt: who is attacking?
    (local.set $attack (i32.and (call $t_has (global.get $S_ATTACK)) (i32.eqz (call $t_has (global.get $S_WITH)))))
    (local.set $att (i32.const -1))
    (local.set $planned (i32.const -2))
    (if (local.get $attack)
      (then
        (local.set $att (call $hdr (global.get $H_SRCUNIT)))
        (local.set $k (call $unit_by_uid (i32.load offset=4 (global.get $ST))))
        (if (i32.ge_s (local.get $k) (i32.const 0))
          (then
            (if (i32.or (i32.lt_s (local.get $att) (i32.const 0)) (i32.eq (local.get $att) (local.get $k)))
              (then
                (local.set $att (local.get $k))
                (local.set $planned (i32.load offset=8 (global.get $ST)))))))
        (if (i32.lt_s (local.get $att) (i32.const 0)) (then (local.set $attack (i32.const 0))))))
    (local.set $want (call $wanted))
    (local.set $best (i32.const -2147483647))
    (local.set $bi (i32.const -1))
    (local.set $exit (i32.const -2147483647))
    (local.set $ei (i32.const -1))
    (local.set $done (i32.const -1))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $act (local.get $i)))
        (local.set $k (call $f (local.get $r) (global.get $A_KIND)))
        (if (i32.eq (local.get $k) (i32.const 1))
          (then
            (if (call $is_done (local.get $r)) (then (local.set $done (local.get $i))))
            (local.set $s (call $exit_score (local.get $r)))
            (if (i32.eq (local.get $s) (i32.const -9999)) (then (local.set $s (i32.sub (call $button_score (local.get $r)) (i32.const 20)))))
            (if (i32.gt_s (local.get $s) (local.get $exit)) (then (local.set $exit (local.get $s)) (local.set $ei (local.get $i))))))
        (if (i32.and (i32.or (i32.eq (local.get $k) (i32.const 2)) (i32.eq (local.get $k) (i32.const 4)))
                     (i32.eqz (i32.or (call $f (local.get $r) (global.get $A_SEL))
                                      (i32.and (i32.eq (local.get $k) (i32.const 4)) (call $disp_has (call $f (local.get $r) (global.get $A_UID)))))))
          (then
            (if (local.get $attack)
              (then
                (local.set $s (call $attack_score (call $unit (local.get $att)) (local.get $r)))
                ;; follow the planner when its target is on offer
                (local.set $plan (i32.const 0))
                (if (i32.and (i32.eq (local.get $planned) (i32.const -1)) (i32.eq (call $f (local.get $r) (global.get $A_BASE)) (i32.const 2)))
                  (then (local.set $plan (i32.const 1))))
                (if (i32.ge_s (local.get $planned) (i32.const 0))
                  (then
                    (if (i32.ge_s (call $f (local.get $r) (global.get $A_UNIT)) (i32.const 0))
                      (then
                        (if (i32.eq (call $f (call $unit (call $f (local.get $r) (global.get $A_UNIT))) (global.get $U_UID)) (local.get $planned))
                          (then (local.set $plan (i32.const 1))))))))
                (if (local.get $plan) (then (local.set $s (i32.add (local.get $s) (i32.const 20000))))))
              (else (local.set $s (call $target_score (local.get $r) (local.get $it) (local.get $amt)))))
            (local.set $s (i32.add (local.get $s) (call $noise)))
            (if (i32.gt_s (local.get $s) (local.get $best)) (then (local.set $best (local.get $s)) (local.set $bi (local.get $i))))))
        (if (i32.eq (local.get $k) (i32.const 5))
          (then
            (local.set $s (call $button_score (local.get $r)))
            (if (i32.gt_s (local.get $s) (local.get $best)) (then (local.set $best (local.get $s)) (local.set $bi (local.get $i))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    ;; multi-select: stop once enough cards are picked
    (local.set $k (call $max (call $hdr (global.get $H_NSEL)) (global.get $g_dsel)))
    (if (i32.and (i32.ge_s (local.get $done) (i32.const 0))
                 (i32.and (i32.gt_s (local.get $k) (i32.const 0)) (i32.ge_s (local.get $k) (local.get $want))))
      (then (return (local.get $done))))
    (if (i32.lt_s (local.get $bi) (i32.const 0)) (then (return (select (local.get $ei) (i32.const 0) (i32.ge_s (local.get $ei) (i32.const 0))))))
    (if (local.get $attack)
      (then (if (i32.and (i32.ge_s (local.get $ei) (i32.const 0)) (i32.lt_s (local.get $best) (i32.const -30)))
        (then (return (local.get $ei))))
        (return (local.get $bi))))
    (if (i32.and (i32.ge_s (local.get $ei) (i32.const 0)) (i32.gt_s (local.get $exit) (local.get $best)))
      (then (return (local.get $ei))))
    (local.get $bi))

  ;; ---------- setup and resource prompts ----------
  (func $choose_resource (result i32)
    (local $i i32) (local $n i32) (local $r i32) (local $s i32) (local $best i32) (local $bi i32) (local $exit i32)
    (local $total i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (local.set $total (call $hdr (global.get $H_MYTOTAL)))
    (local.set $exit (i32.const -1))
    (block $e1
      (loop $l1
        (br_if $e1 (i32.ge_s (local.get $i) (local.get $n)))
        (if (i32.eq (call $f (call $act (local.get $i)) (global.get $A_KIND)) (i32.const 1)) (then (local.set $exit (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l1)))
    (if (i32.and (i32.ge_s (local.get $exit) (i32.const 0)) (i32.ge_s (call $hdr (global.get $H_NSEL)) (call $wanted)))
      (then (return (local.get $exit))))
    ;; optional resourcing late in the game: stop when there is enough to play anything
    (if (i32.and (i32.ge_s (local.get $exit) (i32.const 0)) (i32.eqz (call $wanted_min)))
      (then
        (if (i32.or (i32.ge_s (local.get $total) (i32.const 9))
                    (i32.and (i32.le_s (call $hdr (global.get $H_MYHAND)) (i32.const 1)) (i32.ge_s (local.get $total) (i32.const 6))))
          (then (return (local.get $exit))))))
    (local.set $best (i32.const -2147483647))
    (local.set $bi (i32.const -1))
    (local.set $i (i32.const 0))
    (block $e2
      (loop $l2
        (br_if $e2 (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $act (local.get $i)))
        (if (i32.and (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 2)) (i32.eqz (call $f (local.get $r) (global.get $A_SEL))))
          (then
            (local.set $s (i32.add (i32.sub (i32.const 0) (call $keep (local.get $r))) (call $noise)))
            (if (i32.gt_s (local.get $s) (local.get $best)) (then (local.set $best (local.get $s)) (local.set $bi (local.get $i))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l2)))
    (if (i32.ge_s (local.get $bi) (i32.const 0)) (then (return (local.get $bi))))
    (select (local.get $exit) (i32.const 0) (i32.ge_s (local.get $exit) (i32.const 0))))

  ;; keep a hand with at least two cards castable early, or a cheap unit
  (func $keep_hand (result i32)
    (local $i i32) (local $n i32) (local $r i32) (local $cheap i32) (local $unit i32)
    (local.set $n (call $hdr (global.get $H_NHAND)))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $hand (local.get $i)))
        (if (i32.eqz (call $f (local.get $r) (global.get $C_OK))) (then (return (i32.const 1))))
        (if (i32.le_s (call $eff_cost (local.get $r)) (i32.const 4)) (then (local.set $cheap (i32.add (local.get $cheap) (i32.const 1)))))
        (if (i32.and (call $is_type (local.get $r) (global.get $T_UNIT)) (i32.le_s (call $eff_cost (local.get $r)) (i32.const 3)))
          (then (local.set $unit (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.or (i32.ge_s (local.get $cheap) (i32.const 2)) (local.get $unit)))

  (func $choose_buttons (result i32)
    (local $i i32) (local $n i32) (local $r i32) (local $s i32) (local $best i32) (local $bi i32) (local $mull i32)
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (local.set $mull (call $t_has (global.get $S_MULLIGAN)))
    (local.set $best (i32.const -2147483647))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $r (call $act (local.get $i)))
        (local.set $s (call $button_score (local.get $r)))
        (if (local.get $mull)
          (then
            (local.set $s (i32.const 0))
            (if (i32.eq (call $l_has (local.get $r) (global.get $S_KEEP)) (call $keep_hand)) (then (local.set $s (i32.const 10))))))
        (if (i32.eq (call $f (local.get $r) (global.get $A_KIND)) (i32.const 3))
          ;; dropdowns: the largest number, else the first entry
          (then (local.set $s (select (call $f (local.get $r) (global.get $A_NUM)) (i32.const 0)
                                      (i32.ge_s (call $f (local.get $r) (global.get $A_NUM)) (i32.const 0))))))
        (if (i32.gt_s (local.get $s) (local.get $best)) (then (local.set $best (local.get $s)) (local.set $bi (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (local.get $bi))

  ;; ---------- distributing damage or healing ----------
  ;; fills OUT+8.. with an amount per DIST target; returns 1 if the split is legal
  (func $distribute (result i32)
    (local $n i32) (local $amt i32) (local $left i32) (local $k i32) (local $d i32) (local $u i32) (local $cap i32)
    (local $give i32) (local $best i32) (local $bk i32) (local $s i32) (local $used i32) (local $need i32) (local $type i32)
    (local $round i32) (local $max i32)
    (local.set $n (call $min (call $hdr (global.get $H_DN)) (global.get $MAX_DIST)))
    (local.set $amt (call $hdr (global.get $H_DAMT)))
    (local.set $type (call $hdr (global.get $H_DTYPE)))
    (local.set $max (call $hdr (global.get $H_DMAX)))
    (if (i32.lt_s (local.get $max) (i32.const 0)) (then (local.set $max (i32.const 999))))
    (local.set $k (i32.const 0))
    (block $z (loop $zl
      (br_if $z (i32.ge_s (local.get $k) (local.get $n)))
      (i32.store (i32.add (i32.add (global.get $OUT) (i32.const 8)) (i32.shl (local.get $k) (i32.const 2))) (i32.const 0))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $zl)))
    (local.set $left (local.get $amt))
    ;; round 0: exact kills (damage) or full heals (healing), most valuable first
    ;; round 1: bases (theirs for damage, mine for healing)
    ;; round 2: dump the rest where it hurts them most / helps me most, within caps
    ;; round 3: anywhere legal (only if the whole amount must be used)
    (block $rounds
      (loop $rl
        (br_if $rounds (i32.ge_s (local.get $round) (i32.const 4)))
        (block $picks
          (loop $pl
            (br_if $picks (i32.le_s (local.get $left) (i32.const 0)))
            (if (i32.and (i32.eq (local.get $round) (i32.const 3)) (call $hdr (global.get $H_DLESS))) (then (br $picks)))
            (local.set $best (i32.const -2147483647))
            (local.set $bk (i32.const -1))
            (local.set $k (i32.const 0))
            (block $te (loop $tl
              (br_if $te (i32.ge_s (local.get $k) (local.get $n)))
              (local.set $d (call $dist (local.get $k)))
              (local.set $give (i32.load (i32.add (i32.add (global.get $OUT) (i32.const 8)) (i32.shl (local.get $k) (i32.const 2)))))
              (local.set $cap (call $f (local.get $d) (global.get $D_CAP)))
              (if (i32.lt_s (local.get $cap) (i32.const 0)) (then (local.set $cap (i32.const 9999))))
              (local.set $cap (i32.sub (local.get $cap) (local.get $give)))
              (local.set $s (i32.const -2147483647))
              (local.set $need (i32.const 0))
              ;; a new target only while under maxTargets
              (if (i32.and (i32.gt_s (local.get $cap) (i32.const 0))
                           (i32.or (i32.gt_s (local.get $give) (i32.const 0)) (i32.lt_s (local.get $used) (local.get $max))))
                (then
                  (local.set $u (call $f (local.get $d) (global.get $D_UNIT)))
                  (if (i32.ge_s (local.get $u) (i32.const 0)) (then (local.set $u (call $unit (local.get $u)))))
                  (if (i32.eq (local.get $type) (i32.const 1))
                    (then
                      (if (i32.and (i32.eqz (local.get $round)) (i32.ge_s (local.get $u) (i32.const 0)))
                        (then
                          (if (i32.and (i32.eqz (call $mine (local.get $u))) (i32.eqz (local.get $give)))
                            (then
                              (local.set $need (call $left (local.get $u)))
                              (if (call $f (local.get $u) (global.get $U_SHIELDS)) (then (local.set $need (i32.const 1))))
                              (if (i32.and (i32.le_s (local.get $need) (local.get $left)) (i32.le_s (local.get $need) (local.get $cap)))
                                (then (local.set $s (call $uval (local.get $u)))))))))
                      (if (i32.and (i32.eq (local.get $round) (i32.const 1)) (i32.eq (call $f (local.get $d) (global.get $D_BASE)) (i32.const 2)))
                        (then (local.set $s (i32.const 1)) (local.set $need (local.get $left))))
                      (if (i32.and (i32.eq (local.get $round) (i32.const 2)) (i32.ge_s (local.get $u) (i32.const 0)))
                        (then
                          (if (i32.eqz (call $mine (local.get $u)))
                            (then (local.set $s (call $uval (local.get $u))) (local.set $need (local.get $left))))))
                      (if (i32.eq (local.get $round) (i32.const 3))
                        (then
                          (local.set $need (local.get $left))
                          ;; forced onto my side: my base first (unless that loses the game), then the unit that minds it least
                          (if (i32.eq (call $f (local.get $d) (global.get $D_BASE)) (i32.const 1))
                            (then (local.set $s (select (i32.const 1000) (i32.const -5000) (i32.lt_s (local.get $left) (global.get $g_my_left))))))
                          (if (i32.ge_s (local.get $u) (i32.const 0))
                            (then (local.set $s (select (i32.sub (i32.const 0) (call $uval (local.get $u))) (i32.const 1500) (call $mine (local.get $u))))))
                          (if (i32.eq (call $f (local.get $d) (global.get $D_BASE)) (i32.const 2))
                            (then (local.set $s (i32.const 2000)))))))
                    (else
                      ;; healing and anything else: help my side
                      (if (i32.and (i32.eqz (local.get $round)) (i32.ge_s (local.get $u) (i32.const 0)))
                        (then
                          (if (call $mine (local.get $u))
                            (then
                              (local.set $need (select (call $f (local.get $u) (global.get $U_DMG)) (local.get $left) (i32.eq (local.get $type) (i32.const 2))))
                              (if (i32.gt_s (local.get $need) (i32.const 0)) (then (local.set $s (call $uval (local.get $u)))))))))
                      (if (i32.and (i32.eq (local.get $round) (i32.const 1)) (i32.eq (call $f (local.get $d) (global.get $D_BASE)) (i32.const 1)))
                        (then
                          (local.set $need (select (call $hdr (global.get $H_MYDMG)) (local.get $left) (i32.eq (local.get $type) (i32.const 2))))
                          (if (i32.gt_s (local.get $need) (i32.const 0)) (then (local.set $s (i32.const 1))))))
                      (if (i32.eq (local.get $round) (i32.const 2))
                        (then
                          (if (i32.ge_s (local.get $u) (i32.const 0))
                            (then (if (call $mine (local.get $u)) (then (local.set $s (call $uval (local.get $u))) (local.set $need (local.get $left))))))
                          (if (i32.eq (call $f (local.get $d) (global.get $D_BASE)) (i32.const 1))
                            (then (local.set $s (i32.const 0)) (local.set $need (local.get $left))))))
                      (if (i32.eq (local.get $round) (i32.const 3))
                        (then (local.set $s (i32.const 0)) (local.set $need (local.get $left))))))))
              (if (i32.gt_s (local.get $s) (local.get $best))
                (then (local.set $best (local.get $s)) (local.set $bk (local.get $k))
                      (call $sset (i32.const 1056) (i32.const 0) (call $min (call $min (local.get $need) (local.get $cap)) (local.get $left)))))
              (local.set $k (i32.add (local.get $k) (i32.const 1)))
              (br $tl)))
            (br_if $picks (i32.lt_s (local.get $bk) (i32.const 0)))
            (local.set $give (call $sget (i32.const 1056) (i32.const 0)))
            (br_if $picks (i32.le_s (local.get $give) (i32.const 0)))
            (local.set $d (i32.add (i32.add (global.get $OUT) (i32.const 8)) (i32.shl (local.get $bk) (i32.const 2))))
            (if (i32.eqz (i32.load (local.get $d))) (then (local.set $used (i32.add (local.get $used) (i32.const 1)))))
            (i32.store (local.get $d) (i32.add (i32.load (local.get $d)) (local.get $give)))
            (local.set $left (i32.sub (local.get $left) (local.get $give)))
            (br $pl)))
        (local.set $round (i32.add (local.get $round) (i32.const 1)))
        (br $rl)))
    ;; legal total?
    (local.set $used (i32.sub (local.get $amt) (local.get $left)))
    (if (i32.eqz (local.get $used)) (then (return (call $hdr (global.get $H_DNONE)))))
    (if (i32.gt_s (local.get $left) (i32.const 0)) (then (return (call $hdr (global.get $H_DLESS)))))
    (i32.const 1))

  ;; ---------- entry points ----------
  (func (export "new_game") (param $seed i32)
    (local $a i32)
    (local.set $a (global.get $ST))
    (loop $clr
      (i32.store (local.get $a) (i32.const 0))
      (local.set $a (i32.add (local.get $a) (i32.const 4)))
      (br_if $clr (i32.lt_u (local.get $a) (global.get $SCR))))
    (i32.store (global.get $ST) (i32.or (local.get $seed) (i32.const 1)))
    (i32.store offset=4 (global.get $ST) (i32.const -1))
    (i32.store offset=8 (global.get $ST) (i32.const -2)))

  (func (export "decide") (result i32)
    (local $n i32) (local $i i32) (local $pt i32) (local $cards i32) (local $k i32)
    (i32.store offset=4 (global.get $OUT) (i32.const 0))
    (local.set $n (call $hdr (global.get $H_NACTS)))
    (call $prepare)
    ;; a distribute action: answer it with a split
    (if (i32.ge_s (call $hdr (global.get $H_DACT)) (i32.const 0))
      (then
        (i32.store offset=4 (global.get $OUT) (call $distribute))
        (return (call $hdr (global.get $H_DACT)))))
    (if (i32.le_s (local.get $n) (i32.const 1)) (then (return (i32.const 0))))
    (global.set $g_fp (call $fingerprint))
    (local.set $pt (call $hdr (global.get $H_PTYPE)))
    (if (call $hdr (global.get $H_AW)) (then (return (call $choose_window))))
    (if (i32.eq (local.get $pt) (i32.const 2)) (then (return (call $choose_resource))))
    (block $end
      (loop $l
        (br_if $end (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $k (call $f (call $act (local.get $i)) (global.get $A_KIND)))
        (if (i32.or (i32.or (i32.eq (local.get $k) (i32.const 2)) (i32.eq (local.get $k) (i32.const 4))) (i32.eq (local.get $k) (i32.const 5)))
          (then (local.set $cards (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (if (local.get $cards) (then (return (call $choose_cards))))
    (call $choose_buttons))
)
