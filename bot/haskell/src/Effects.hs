{-# LANGUAGE OverloadedStrings #-}
-- | Card text, read just well enough to value a play: the common one-line effects ("Deal 3 damage to a unit",
-- "Defeat a non-leader unit with 3 or less remaining HP", "Give a Shield token to a unit", ...) become 'Effect's
-- that the model can apply. Anything else is worth a flat amount per resource spent.
module Effects
  ( Effect (..)
  , parseEffects
  , whenPlayed
  , applyEffect
  , applyEffectTo
  , effectTargets
  , playCard
  , deployLeader
  , leaderAction
  ) where

import Cards
import Data.Char (isDigit)
import Data.List (foldl', maximumBy)
import Data.Maybe (fromMaybe, isJust)
import Data.Ord (comparing)
import qualified Data.Text as T
import Model

data Effect
  = EDamage !Int !(Maybe Arena) -- to one enemy unit
  | EDamageEach !Int !(Maybe Arena) -- to each enemy unit
  | EDamageBase !Int
  | EDefeat !(Maybe Int) !(Maybe Int) -- remaining-HP limit, cost limit (non-leader)
  | EHeal !Int -- own unit or base
  | EShield
  | EExperience !Int
  | EBuff !Int !Int -- own unit, for this phase
  | EWeaken !Int !Int -- enemy unit
  | EDraw !Int
  | ETokens !Int !Arena !Int !Int
  | EExhaust
  | ERemove !(Maybe Int) -- bounce or capture an enemy non-leader unit, optional cost limit
  | EUpgrade !Int !Int -- attach: +p/+h (negative: on an enemy unit)
  deriving (Show)

has :: T.Text -> T.Text -> Bool
has = T.isInfixOf

wordNum :: T.Text -> Maybe Int
wordNum t = case T.words t of
  (w : _) -> case w of
    "a" -> Just 1
    "an" -> Just 1
    "one" -> Just 1
    "two" -> Just 2
    "three" -> Just 3
    "four" -> Just 4
    _ | T.all isDigit w && not (T.null w) -> Just (read (T.unpack w))
    _ -> Nothing
  [] -> Nothing

arenaIn :: T.Text -> Maybe Arena
arenaIn t
  | has "ground" t = Just Ground
  | has "space" t = Just Space
  | otherwise = Nothing

-- | "+2/+2" -> (2, 2); also the "–2/–2" and "-2/-2" forms with the sign given.
statMod :: Char -> T.Text -> Maybe (Int, Int)
statMod sign t = case T.breakOn (T.singleton sign) t of
  (_, rest)
    | T.null rest -> Nothing
    | otherwise ->
        let r = T.drop 1 rest
            p = T.takeWhile isDigit r
            r2 = T.drop (T.length p) r
         in if not (T.null p) && T.isPrefixOf (T.pack ['/', sign]) r2
              then
                let h = T.takeWhile isDigit (T.drop 2 r2)
                 in if T.null h then Nothing else Just (read (T.unpack p), read (T.unpack h))
              else statMod sign r

-- | One sentence of card text (lower case) to an effect.
sentence :: T.Text -> Maybe Effect
sentence s
  | has "deal " s && has " damage to " s =
      let (pre, post) = T.breakOn " damage to " s
          n = fromMaybe 0 (numAfter "deal " pre)
          t = T.drop (T.length (" damage to " :: T.Text)) post
       in if n <= 0 || has "friendly" t || has "your base" t
            then Nothing
            else
              if has "each" t
                then if has "enemy" t then Just (EDamageEach n (arenaIn t)) else Nothing
                else
                  if has "base" t && not (has "unit" t)
                    then Just (EDamageBase n)
                    else if has "unit" t then Just (EDamage n (arenaIn t)) else Nothing
  | has "defeat a" s && has "unit" s && not (has "friendly" s) && not (has "upgrade" s) =
      let hpL = if has "remaining hp" s then numAfter "with " s else Nothing
          costL = if has "costs" s then numAfter "costs " s else Nothing
       in Just (EDefeat hpL costL)
  | has "heal " s, Just n <- numAfter "heal " s = Just (EHeal n)
  | has "shield token" s && not (has "enemy" s) = Just EShield
  | has "experience token" s && not (has "enemy" s) =
      Just (EExperience (fromMaybe 1 (wordNum (after "give "))))
  | has "draw a card" s = Just (EDraw 1)
  | has "draw " s && has " cards" s = EDraw <$> (wordNum (after "draw ") >>= nonZero)
  | has "create" s && has "token" s = tokens s
  | (has "exhaust an enemy" s || has "exhaust a unit" s || has "exhaust a ground unit" s || has "exhaust a space unit" s)
      && not (has "friendly" s) =
      Just EExhaust
  | (has "return" s && has "to its owner's hand" s) || has "captures an enemy" s || has "capture an enemy" s =
      if has "friendly unit to" s || has "your hand" s then Nothing else Just (ERemove (if has "costs" s then numAfter "costs " s else Nothing))
  | Just (p, h) <- statMod '\8211' s <|> statMod '-' s, has "give" s || has "gets" s, not (has "friendly" s) =
      Just (EWeaken p h)
  | Just (p, h) <- statMod '+' s, has "give" s || has "gets" s, not (has "each" s), not (has "enemy" s) =
      Just (EBuff p h)
  | otherwise = Nothing
  where
    nonZero n = if n > 0 then Just n else Nothing
    after k = T.drop (T.length k) (snd (T.breakOn k s))
    a <|> b = if isJust a then a else b

tokens :: T.Text -> Maybe Effect
tokens s = do
  (arena, p, h) <- kind
  let after = T.drop (T.length ("create " :: T.Text)) (snd (T.breakOn "create " s))
  pure (ETokens (fromMaybe 1 (wordNum after)) arena p h)
  where
    kind
      | has "battle droid" s = Just (Ground, 1, 1)
      | has "clone trooper" s = Just (Ground, 2, 2)
      | has "tie fighter" s = Just (Space, 1, 1)
      | has "x-wing" s = Just (Space, 2, 2)
      | has "spy" s = Just (Ground, 0, 2)
      | has "mandalorian" s = Just (Ground, 1, 1)
      | otherwise = Nothing

parseEffects :: T.Text -> [Effect]
parseEffects txt = [e | s <- T.split (\c -> c == '.' || c == '\n') (lower txt), Just e <- [sentence (T.strip s)]]

-- | Effects of a unit's or upgrade's "When Played" ability.
whenPlayed :: CardInfo -> [Effect]
whenPlayed c = case T.breakOn "when played" (lower (ciText c)) of
  (_, rest)
    | T.null rest -> []
    | otherwise -> parseEffects (T.takeWhile (/= '\n') (T.drop 1 (T.dropWhile (/= ':') rest)))

-- ---------------------------------------------------------------- applying effects

-- | All the ways an effect can land, one model per target. Empty when it has no target.
effectTargets :: Who -> Effect -> Model -> [Model]
effectTargets w e m = case e of
  EDamage n ar -> [damageUnit o (uId u) n m | u <- foes ar]
  EDamageEach n ar -> [foldl' (\mm u -> damageUnit o (uId u) n mm) m (foes ar) | not (null (foes ar))]
  EDamageBase n -> [damageBase o n m]
  EDefeat hpL costL ->
    [ setUnit o (uId u) Nothing m
    | u <- foes Nothing
    , not (uLeader u)
    , maybe True (remaining u <=) hpL
    , maybe True (uCost u <=) costL
    ]
  EHeal n ->
    withSide w (healBase n) m
      : [putUnit w u {uDmg = max 0 (uDmg u - n)} m | u <- mine, uDmg u > 0]
  EShield -> [putUnit w u {uShield = uShield u + 1} m | u <- mine]
  EExperience n -> [putUnit w (grow n n u) m | u <- mine]
  EBuff p h -> [putUnit w (grow p h u) m | u <- preferReady]
  EWeaken p h -> [shrink u p h | u <- foes Nothing]
  EDraw n -> [withSide w (\s -> s {sHandN = sHandN s + n}) m]
  ETokens k ar p h ->
    [withSide w (\s -> s {sUnits = sUnits s ++ [token i ar p h | i <- [1 .. k]]}) m]
  EExhaust -> [putUnit o u {uExh = True} m | u <- foes Nothing, not (uExh u)]
  ERemove costL ->
    [ withSide o (\s -> s {sHandN = sHandN s + 1}) (setUnit o (uId u) Nothing m)
    | u <- foes Nothing
    , not (uLeader u)
    , maybe True (uCost u <=) costL
    ]
  EUpgrade p h
    | p + h >= 0 -> [putUnit w (grow p h u) m | u <- mine]
    | otherwise -> [shrink u (negate p) (negate h) | u <- foes Nothing]
  where
    o = other w
    mine = sUnits (side w m)
    foes ar = [u | u <- sUnits (side o m), maybe True (== uArena u) ar]
    preferReady = let r = filter (not . uExh) mine in if null r then mine else r
    grow p h u = u {uPow = uPow u + p, uHp = uHp u + h}
    shrink u p h =
      let u' = u {uPow = max 0 (uPow u - p), uHp = uHp u - h}
       in setUnit o (uId u) (if remaining u' <= 0 then Nothing else Just u') m
    token i ar p h =
      (Unit ("token-" <> T.pack (show (length mine + i))) "token" p h 0 True ar False 0 0 False False False 0 False 0)

-- | Apply an effect at its best target for @w@ (greedy, by the static evaluation).
applyEffect :: Who -> Effect -> Model -> Model
applyEffect w e m = case effectTargets w e m of
  [] -> m
  ms -> maximumBy (comparing (scoreFor w)) (reverse ms)

-- | Apply an effect to one named card (a prompt target). Bases are named by their side.
applyEffectTo :: Who -> Effect -> Maybe Target -> Who -> Model -> Model
applyEffectTo w e tgt owner m = case (e, tgt) of
  (EDamage n _, Just (TUnit k)) -> damageUnit owner k n m
  (EDamage n _, Just TBase) -> damageBase owner n m
  (EDamageBase n, _) -> damageBase owner n m
  (EDefeat _ _, Just (TUnit k)) -> setUnit owner k Nothing m
  (EHeal n, Just TBase) -> withSide owner (healBase n) m
  (EHeal n, Just (TUnit k)) -> onUnit k (\u -> u {uDmg = max 0 (uDmg u - n)})
  (EShield, Just (TUnit k)) -> onUnit k (\u -> u {uShield = uShield u + 1})
  (EExperience n, Just (TUnit k)) -> onUnit k (\u -> u {uPow = uPow u + n, uHp = uHp u + n})
  (EBuff p h, Just (TUnit k)) -> onUnit k (\u -> u {uPow = uPow u + p, uHp = uHp u + h})
  (EUpgrade p h, Just (TUnit k)) -> statChange k p h
  (EWeaken p h, Just (TUnit k)) -> statChange k (negate p) (negate h)
  (EExhaust, Just (TUnit k)) -> onUnit k (\u -> u {uExh = True})
  (ERemove _, Just (TUnit k)) -> setUnit owner k Nothing m
  _ -> applyEffect w e m
  where
    onUnit k f = maybe m (\u -> putUnit owner (f u) m) (findUnit k (side owner m))
    statChange k p h = case findUnit k (side owner m) of
      Nothing -> m
      Just u ->
        let u' = u {uPow = max 0 (uPow u + p), uHp = uHp u + h}
         in setUnit owner k (if remaining u' <= 0 then Nothing else Just u') m

-- ---------------------------------------------------------------- plays

-- | Value of a card whose text the model cannot simulate: a little more than holding it.
flatValue :: Int -> Double
flatValue cost = 1.2 + 0.9 * fromIntegral cost

playCard :: Who -> Card -> Model -> Model
playCard w c m0 = checkOver $ case cInfo c of
  Nothing -> addBonus w (flatValue (cCost c)) m
  Just info
    | isType "unit" info -> playUnit info
    | isType "upgrade" info -> playUpgrade info
    | isType "event" info -> playEvent info
    | otherwise -> addBonus w (flatValue (cCost c)) m
  where
    m = withSide w pay m0
    pay s =
      s
        { sReady = sReady s - cCost c
        , sHand = filter ((/= cId c) . cId) (sHand s)
        , sHandN = if cFromRes c then sHandN s else sHandN s - 1
        }
    playUnit info =
      let u = mkUnitFromInfo (cId c) info
          m1 = withSide w (\s -> s {sUnits = sUnits s ++ [u]}) m
          m2 = foldl' (flip (applyEffect w)) m1 (whenPlayed info)
       in if hasKeyword "ambush" info then ambush (uId u) m2 else m2
    ambush k mm = case findUnit k (side w mm) of
      Nothing -> mm
      Just u ->
        let readied = putUnit w u {uExh = False} mm
            options = [attack w k t readied | t@(TUnit _) <- targetsFor u (side (other w) mm)]
         in maximumBy (comparing (scoreFor w)) (mm : options)
    playUpgrade info =
      let m1 = applyEffect w (EUpgrade (ciUpPower info) (ciUpHp info)) m
       in foldl' (flip (applyEffect w)) m1 (whenPlayed info)
    playEvent info = case parseEffects (ciText info) of
      [] -> addBonus w (flatValue (cCost c)) m
      es -> addBonus w 0.5 (foldl' (flip (applyEffect w)) m es)

-- | Deploy the leader: it becomes a ready unit.
deployLeader :: Who -> Model -> Model
deployLeader w = withSide w $ \s -> case sLeader s of
  Just l | not (lDeployed l), Just u <- lUnit l ->
    s {sUnits = sUnits s ++ [u], sLeader = Just l {lDeployed = True}}
  _ -> s

-- | Use the leader's action ability: exhaust it, pay its cost, apply what the text says (or a flat value).
leaderAction :: Who -> Model -> Model
leaderAction w m = case sLeader (side w m) of
  Just l | not (lDeployed l), not (lExh l) ->
    let paid = withSide w (\s -> s {sReady = sReady s - fromMaybe 0 (lActCost l), sLeader = Just l {lExh = True}}) m
     in case parseEffects (lActText l) of
          [] -> addBonus w 1.0 paid
          es -> foldl' (flip (applyEffect w)) paid es
  _ -> m
