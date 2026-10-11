{-# LANGUAGE OverloadedStrings #-}
-- | A small, pure model of the visible board: units, bases, hands, resources and whose turn it is. The engine is far
-- richer; this model only has to rank moves, so it keeps combat exact (power, damage, shields, Sentinel,
-- Overwhelm, Saboteur, Raid, Restore, Grit) and treats most card text as a value estimate.
module Model
  ( Arena (..)
  , Who (..)
  , other
  , Unit (..)
  , Card (..)
  , Leader (..)
  , Side (..)
  , Model (..)
  , Target (..)
  , remaining
  , side
  , withSide
  , findUnit
  , ownerOf
  , hit
  , setUnit
  , putUnit
  , damageUnit
  , damageBase
  , healBase
  , addBonus
  , checkOver
  , attack
  , targetsFor
  , readyAll
  , evaluate
  , scoreFor
  , unitValue
  , fromObs
  , mkUnitFromInfo
  , arenaOf
  , myAspects
  ) where

import Cards
import Data.List (find)
import qualified Data.Map.Strict as M
import Data.Maybe (catMaybes, fromMaybe)
import qualified Data.Text as T
import Protocol

data Arena = Ground | Space deriving (Eq, Show)

data Who = Me | Opp deriving (Eq, Show)

other :: Who -> Who
other Me = Opp
other Opp = Me

data Unit = Unit
  { uId :: !T.Text
  , uName :: !T.Text
  , uPow :: !Int
  , uHp :: !Int
  , uDmg :: !Int
  , uExh :: !Bool
  , uArena :: !Arena
  , uSent :: !Bool
  , uShield :: !Int
  , uRaid :: !Int
  , uOver :: !Bool
  , uSabo :: !Bool
  , uGrit :: !Bool
  , uRestore :: !Int
  , uLeader :: !Bool
  , uCost :: !Int
  }
  deriving (Show)

-- | A card the side could play: from hand, or from the resource zone with Smuggle (cFromRes).
data Card = Card
  { cId :: !T.Text
  , cName :: !T.Text
  , cCost :: !Int
  , cInfo :: !(Maybe CardInfo)
  , cFromRes :: !Bool
  }
  deriving (Show)

data Leader = Leader
  { lId :: !T.Text
  , lName :: !T.Text
  , lDeployAt :: !Int
  , lUnit :: !(Maybe Unit)
  , lDeployed :: !Bool
  , lExh :: !Bool
  , lActCost :: !(Maybe Int)
  , lActText :: !T.Text
  }
  deriving (Show)

data Side = Side
  { sBase :: !Int -- remaining base HP
  , sBaseMax :: !Int
  , sUnits :: [Unit]
  , sHand :: [Card] -- known playable cards (own side only)
  , sHandN :: !Int
  , sReady :: !Int
  , sRes :: !Int
  , sLeader :: !(Maybe Leader)
  , sPassed :: !Bool
  , sOut :: !Bool -- claimed the initiative: no more actions this round
  , sBonus :: !Double -- value of effects the model does not simulate
  }
  deriving (Show)

data Model = Model
  { mMe :: !Side
  , mOpp :: !Side
  , mTurn :: !Who
  , mInit :: !Who
  , mClaimed :: !Bool
  , mOver :: !Bool
  , mRoundEnd :: !Bool
  }
  deriving (Show)

data Target = TBase | TUnit !T.Text deriving (Eq, Show)

remaining :: Unit -> Int
remaining u = uHp u - uDmg u

side :: Who -> Model -> Side
side Me = mMe
side Opp = mOpp

withSide :: Who -> (Side -> Side) -> Model -> Model
withSide Me f m = m {mMe = f (mMe m)}
withSide Opp f m = m {mOpp = f (mOpp m)}

findUnit :: T.Text -> Side -> Maybe Unit
findUnit k = find ((== k) . uId) . sUnits

ownerOf :: T.Text -> Model -> Maybe Who
ownerOf k m
  | any ((== k) . uId) (sUnits (mMe m)) = Just Me
  | any ((== k) . uId) (sUnits (mOpp m)) = Just Opp
  | otherwise = Nothing

-- | @n@ damage to a unit: a Shield absorbs the whole hit. Returns the unit (Nothing if defeated) and the excess
-- damage beyond its remaining HP (for Overwhelm).
hit :: Int -> Unit -> (Maybe Unit, Int)
hit n u
  | n <= 0 = (Just u, 0)
  | uShield u > 0 = (Just u {uShield = uShield u - 1}, 0)
  | n >= r = (Nothing, n - r)
  | otherwise = (Just u {uDmg = uDmg u + n, uPow = if uGrit u then uPow u + n else uPow u}, 0)
  where
    r = remaining u

-- | Replace a unit, or remove it when defeated. A defeated leader unit goes back to the leader zone for good.
setUnit :: Who -> T.Text -> Maybe Unit -> Model -> Model
setUnit w k mu = withSide w $ \s ->
  case mu of
    Just u -> s {sUnits = map (\x -> if uId x == k then u else x) (sUnits s)}
    Nothing ->
      let wasLeader = maybe False uLeader (findUnit k s)
          ldr l = l {lDeployed = False, lUnit = Nothing, lDeployAt = 99, lExh = True}
       in s
            { sUnits = filter ((/= k) . uId) (sUnits s)
            , sLeader = if wasLeader then ldr <$> sLeader s else sLeader s
            }

putUnit :: Who -> Unit -> Model -> Model
putUnit w u = setUnit w (uId u) (Just u)

damageUnit :: Who -> T.Text -> Int -> Model -> Model
damageUnit w k n m = case findUnit k (side w m) of
  Nothing -> m
  Just u -> setUnit w k (fst (hit n u)) m

damageBase :: Who -> Int -> Model -> Model
damageBase w n = checkOver . withSide w (\s -> s {sBase = sBase s - n})

healBase :: Int -> Side -> Side
healBase n s = s {sBase = min (sBaseMax s) (sBase s + n)}

addBonus :: Who -> Double -> Model -> Model
addBonus w v = withSide w (\s -> s {sBonus = sBonus s + v})

checkOver :: Model -> Model
checkOver m = m {mOver = mOver m || sBase (mMe m) <= 0 || sBase (mOpp m) <= 0}

-- | Legal attack targets for a unit: same-arena enemy units and the base, unless the defender has a Sentinel there
-- (Saboteur ignores Sentinel).
targetsFor :: Unit -> Side -> [Target]
targetsFor a o
  | not (uSabo a) && not (null sentinels) = map (TUnit . uId) sentinels
  | otherwise = TBase : map (TUnit . uId) foes
  where
    foes = filter ((== uArena a) . uArena) (sUnits o)
    sentinels = filter uSent foes

-- | Resolve an attack exactly as the rules do for vanilla units: attacker and defender deal damage at the same time.
attack :: Who -> T.Text -> Target -> Model -> Model
attack w k tgt m0 = case findUnit k (side w m0) of
  Nothing -> m0
  Just a0 ->
    let a = a0 {uExh = True}
        pow = uPow a + uRaid a
        o = other w
        m1 = withSide w (healBase (uRestore a)) (putUnit w a m0)
     in checkOver $ case tgt of
          TBase -> withSide o (\s -> s {sBase = sBase s - pow}) m1
          TUnit d -> case findUnit d (side o m1) of
            Nothing -> m1
            Just d0 ->
              let dfd = if uSabo a then d0 {uShield = 0} else d0
                  (d', excess) = hit pow dfd
                  (a', _) = hit (uPow dfd) a
                  m2 = setUnit o d d' (setUnit w k a' m1)
               in if uOver a then withSide o (\s -> s {sBase = sBase s - excess}) m2 else m2

readyAll :: Side -> Side
readyAll s =
  s
    { sUnits = map (\u -> u {uExh = False}) (sUnits s)
    , sLeader = (\l -> l {lExh = False}) <$> sLeader s
    , sReady = sRes s
    , sPassed = False
    , sOut = False
    }

-- ---------------------------------------------------------------- evaluation

unitValue :: Unit -> Double
unitValue u = if uExh u then v * 0.93 else v
  where
    v =
      1.0
        + 1.25 * fromIntegral (max 0 (uPow u))
        + 0.85 * fromIntegral (max 0 (remaining u))
        + 1.8 * fromIntegral (uShield u)
        + (if uSent u then 1.2 else 0)
        + 0.4 * fromIntegral (uRaid u)
        + (if uOver u then 0.6 else 0)
        + (if uSabo u then 0.5 else 0)
        + 0.4 * fromIntegral (uRestore u)
        + (if uGrit u then 0.4 else 0)

-- | A base point is worth one point, and more once the base is low enough to die soon.
baseValue :: Int -> Double
baseValue h = hp - danger
  where
    hp = fromIntegral (max 0 h)
    danger = let d = max 0 (10 - hp) in d * d / 5

sideValue :: Side -> Double
sideValue s =
  baseValue (sBase s)
    + sum (map unitValue (sUnits s))
    + 1.6 * fromIntegral (sHandN s)
    + 0.7 * fromIntegral (sRes s)
    + sBonus s

boardPower :: Side -> Int
boardPower = sum . map (\u -> max 0 (uPow u + uRaid u)) . sUnits

-- | Position value from my side (higher is better). Adds a race term: how many rounds each board needs to kill the
-- other base, so damage counts for more when it shortens my clock.
evaluate :: Model -> Double
evaluate m
  | sBase (mOpp m) <= 0 = 10000
  | sBase (mMe m) <= 0 = -10000
  | otherwise = sideValue me - sideValue op + initiative + race
  where
    me = mMe m
    op = mOpp m
    initiative = if mInit m == Me then 1.5 else -1.5
    clock hp p = if p <= 0 then 8 else min 8 (fromIntegral hp / fromIntegral p) :: Double
    race = 0.8 * max (-4) (min 4 (clock (sBase me) (boardPower op) - clock (sBase op) (boardPower me)))

scoreFor :: Who -> Model -> Double
scoreFor Me = evaluate
scoreFor Opp = negate . evaluate

-- ---------------------------------------------------------------- building the model from an observation

arenaOf :: T.Text -> Arena
arenaOf a = if a == "space" then Space else Ground

mkUnit :: CardDb -> Arena -> UnitObs -> Unit
mkUnit db arena uo =
  Unit
    { uId = crId ref
    , uName = crName ref
    , uPow = uoPower uo
    , uHp = uoHp uo
    , uDmg = uoDamage uo
    , uExh = uoExhausted uo
    , uArena = arena
    , uSent = uoSentinel uo
    , uShield = length [() | (r, _) <- uoUpgrades uo, crName r == "Shield"]
    , uRaid = num "raid"
    , uOver = kw "overwhelm"
    , uSabo = kw "saboteur"
    , uGrit = kw "grit"
    , uRestore = num "restore"
    , uLeader = maybe False (isType "leader") info
    , uCost = maybe 0 ciCost info
    }
  where
    ref = uoRef uo
    info = bySet db (crSet ref)
    kw k = maybe False (hasKeyword k) info
    num k = maybe 0 (keywordNum k) info

-- | A fresh unit as it enters play from a card (exhausted, Shielded gives a Shield).
mkUnitFromInfo :: T.Text -> CardInfo -> Unit
mkUnitFromInfo k c =
  Unit
    { uId = k
    , uName = ciTitle c
    , uPow = ciPower c
    , uHp = max 1 (ciHp c)
    , uDmg = 0
    , uExh = True
    , uArena = arenaOf (ciArena c)
    , uSent = hasKeyword "sentinel" c
    , uShield = if hasKeyword "shielded" c then 1 else 0
    , uRaid = keywordNum "raid" c
    , uOver = hasKeyword "overwhelm" c
    , uSabo = hasKeyword "saboteur" c
    , uGrit = hasKeyword "grit" c
    , uRestore = keywordNum "restore" c
    , uLeader = isType "leader" c
    , uCost = ciCost c
    }

-- | Aspect icons the player's leader and base provide.
myAspects :: CardDb -> PlayerObs -> [T.Text]
myAspects db p = concatMap ciAspects (catMaybes [bySet db (crSet (poBase p)), poLeader p >>= bySet db . crSet . loRef])

mkCard :: CardDb -> [T.Text] -> Bool -> CardRef -> Card
mkCard db have fromRes ref = Card (crId ref) (crName ref) cost info fromRes
  where
    info = bySet db (crSet ref)
    pen = maybe 0 (aspectPenalty have) info
    printed = maybe 2 ciCost info
    cost
      | fromRes = maybe (printed + 2) (fromMaybe (printed + 2) . smuggleCost) info + pen
      | otherwise = printed + pen

mkLeader :: CardDb -> LeaderObs -> Leader
mkLeader db lo =
  Leader
    { lId = crId ref
    , lName = crName ref
    , lDeployAt = maybe 99 ciCost info
    , lUnit = (\c -> (mkUnitFromInfo (crId ref) c) {uExh = False, uLeader = True}) <$> info
    , lDeployed = loDeployed lo
    , lExh = loExhausted lo
    , lActCost = info >>= actionCost
    , lActText = maybe "" (actionText . ciText) info
    }
  where
    ref = loRef lo
    info = bySet db (crSet ref)
    actionCost c
      | "action [" `T.isInfixOf` lower (ciText c) = Just (fromMaybe 0 (numAfter "action [" (ciText c)))
      | otherwise = Nothing
    actionText t = case T.breakOn "]:" t of
      (_, rest) | not (T.null rest) -> T.takeWhile (/= '\n') (T.drop 2 rest)
      _ -> ""

mkSide :: CardDb -> Bool -> PlayerObs -> Side
mkSide db mine p =
  Side
    { sBase = poBaseHp p - poBaseDamage p
    , sBaseMax = poBaseHp p
    , sUnits = map (mkUnit db Ground) (poGround p) ++ map (mkUnit db Space) (poSpace p)
    , sHand =
        if mine
          then map (mkCard db have False) (poHand p) ++ smuggle
          else []
    , sHandN = poHandCount p
    , sReady = poReady p
    , sRes = poTotal p
    , sLeader = mkLeader db <$> poLeader p
    , sPassed = False
    , sOut = False
    , sBonus = 0
    }
  where
    have = myAspects db p
    smuggle =
      [ mkCard db have True r
      | (r, exhausted) <- poResources p
      , not exhausted
      , Just c <- [bySet db (crSet r)]
      , hasKeyword "smuggle" c
      ]

emptySide :: Side
emptySide = Side 30 30 [] [] 0 0 0 Nothing False False 0

-- | Model with me to move. @claimed@: someone already took the initiative this round (the Claim button is gone);
-- since I am still acting, it was the opponent, who is then out of the round.
fromObs :: CardDb -> T.Text -> Bool -> StateObs -> Model
fromObs db seat claimed st =
  Model
    { mMe = maybe emptySide (mkSide db True) (M.lookup seat ps)
    , mOpp = (maybe emptySide (mkSide db False) (M.lookup oppSeat ps)) {sOut = claimed, sPassed = claimed}
    , mTurn = Me
    , mInit = if soInitiative st == Just oppSeat then Opp else Me
    , mClaimed = claimed
    , mOver = False
    , mRoundEnd = False
    }
  where
    ps = soPlayers st
    oppSeat = if seat == "p1" then "p2" else "p1"
