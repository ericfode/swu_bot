{-# LANGUAGE OverloadedStrings #-}
-- | Turning one @decide@ message into one answer. 'decide' is a pure function of the card data, the bot's memory of
-- this game and the message; Main only does the I/O around it.
--
-- * Action window: every legal action becomes one or more model moves (clicking a ready unit = one attack per
--   possible target), each is searched a few moves deep, and the best is played. What was planned (attack target,
--   deploy, ...) is remembered for the follow-up prompts.
-- * Other prompts: targets are scored by applying the prompt's effect to the model, or by simple intent rules when
--   the text is not understood; resourcing, mulligan, damage splits and menus have their own rules.
module Policy
  ( Memory
  , newMemory
  , Reply (..)
  , decide
  ) where

import Cards
import qualified Data.Aeson as A
import qualified Data.ByteString.Lazy as BL
import Data.List (find, foldl', maximumBy, sortOn)
import qualified Data.Map.Strict as M
import Data.Maybe (fromMaybe, isJust, isNothing, listToMaybe)
import Data.Ord (comparing)
import qualified Data.Text as T
import Effects
import Model
import Protocol
import Search

data Plan = PlanAttack !T.Text !(Maybe Target) | PlanPlay !T.Text | PlanDeploy | PlanLeader | PlanNone

type ActKey = (T.Text, T.Text, Maybe T.Text, T.Text)

data Memory = Memory
  { memPlan :: !Plan
  , memTried :: !(M.Map BL.ByteString [ActKey]) -- action-window position -> actions already played from it
  , memLast :: !(Maybe ActKey) -- the last action-window action
  , memBanned :: ![(Int, ActKey)] -- (round, action) cancelled in a follow-up prompt: not retried that round
  }

newMemory :: Memory
newMemory = Memory PlanNone M.empty Nothing []

data Reply = Reply {rIndex :: !Int, rSplit :: !(Maybe [(T.Text, Int)])}

data Ctx = Ctx
  { cDb :: CardDb
  , cSeat :: T.Text
  , cPrompt :: PromptObs
  , cState :: StateObs
  , cRaw :: A.Value
  , cActs :: [Action]
  , cModel :: Model
  , cMem :: Memory
  }

searchBeam, searchDepth :: Int
searchBeam = 8
searchDepth = 4

-- | The answer, the updated memory, and log lines (printed to stderr with SWU_HS_DEBUG=1).
decide :: CardDb -> Memory -> Incoming -> (Reply, Memory, [String])
decide db mem msg = case msg of
  Decide {} ->
    let acts = dActions msg
        p = dPrompt msg
        claimed = prWindow p && not (any isClaim acts)
        ctx = Ctx db (dYou msg) p (dState msg) (dStateRaw msg) acts (fromObs db (dYou msg) claimed (dState msg)) mem
        rnd = soRound (dState msg)
     in if null acts
          then (Reply 0 Nothing, mem, [])
          else
            if prWindow p
              then windowChoice ctx
              else
                let r = promptChoice ctx
                    chosen = find ((== rIndex r) . aI) acts
                    -- backing out of a prompt means the window action that led here does not work this round
                    banned = case (chosen, memLast mem) of
                      (Just a, Just k) | isCancel a -> (rnd, k) : memBanned mem
                      _ -> memBanned mem
                    note = "prompt [" ++ T.unpack (prSignature p) ++ "] " ++ T.unpack (prTitle p) ++ " (" ++ T.unpack (prSource p) ++ ") -> " ++ maybe "?" (T.unpack . aLabel) chosen
                 in (r, mem {memBanned = banned}, [note])
  _ -> (Reply 0 Nothing, mem, [])

pick :: Action -> Reply
pick a = Reply (aI a) Nothing

-- ---------------------------------------------------------------- small helpers

lbl :: Action -> T.Text
lbl = lower . aLabel

isButton, isCardAct :: Action -> Bool
isButton = (== "button") . aKind
isCardAct = (== "card") . aKind

isPass, isClaim, isCancel :: Action -> Bool
isPass a = isButton a && lbl a == "pass"
isClaim a = isButton a && "initiative" `T.isInfixOf` lbl a
isCancel a = isButton a && (lbl a == "cancel" || argText a == "cancel")

-- | "Done"-like buttons that finish or skip a selection.
isDone :: Action -> Bool
isDone a =
  isButton a
    && ( argText a `elem` ["done", "passAbility"]
           || any (`T.isPrefixOf` lbl a) ["done", "confirm", "choose nothing", "skip", "take nothing", "discard nothing", "pass"]
       )

buttons :: Ctx -> [Action]
buttons = filter isButton . cActs

byLabel :: [T.Text] -> [Action] -> Maybe Action
byLabel pats as = listToMaybe [a | p <- pats, a <- as, p `T.isInfixOf` lbl a]

titleL :: Ctx -> T.Text
titleL = lower . prTitle . cPrompt

me :: Ctx -> Maybe PlayerObs
me ctx = M.lookup (cSeat ctx) (soPlayers (cState ctx))

-- | Up to how many cards a selection prompt takes, and how many it needs.
selectionBounds :: T.Text -> (Int, Int)
selectionBounds t
  | Just hi <- numAfter " and " t, "between" `T.isInfixOf` t = (fromMaybe 0 (numAfter "between " t), hi)
  | Just n <- numAfter "up to " t = (0, n)
  | Just n <- numAfter "select " t = (n, n)
  | Just n <- numAfter "choose " t = (n, n)
  | otherwise = (1, 1)

-- ---------------------------------------------------------------- action window

windowChoice :: Ctx -> (Reply, Memory, [String])
windowChoice ctx =
  case best of
    Just (a, mv, _) ->
      ( pick a
      , mem {memPlan = planOf mv, memTried = M.insert fp (actKey a : tried) (memTried mem), memLast = Just (actKey a)}
      , logLines
      )
    Nothing ->
      let a = fromMaybe (head (cActs ctx)) (find isPass (cActs ctx))
       in (pick a, mem {memPlan = PlanNone, memLast = Nothing}, logLines)
  where
    mem = cMem ctx
    m = cModel ctx
    rnd = soRound (cState ctx)
    fp = A.encode (cRaw ctx, map aLabel (cActs ctx))
    tried = M.findWithDefault [] fp (memTried mem)
    banned = [k | (r, k) <- memBanned mem, r == rnd]
    -- an action already played from this exact position changed nothing (it was cancelled), so skip it
    fresh = [a | a <- cActs ctx, actKey a `notElem` tried, actKey a `notElem` banned]
    logLines =
      ("window r" ++ show rnd ++ " ready " ++ show (sReady (mMe m)) ++ " hand " ++ show (map (\c -> (T.unpack (cName c), cCost c)) (sHand (mMe m))))
        : ["  " ++ show (aI a) ++ " " ++ T.unpack (aLabel a) ++ " " ++ showMove mv ++ " = " ++ show (round (v * 100) :: Int) | (a, mv, v) <- scored]
    cands = [(a, mv) | a <- fresh, mv <- rootMoves ctx a]
    depth = if length cands > 30 then searchDepth - 1 else searchDepth
    scored = [(a, mv, searchValue searchBeam (depth - 1) (applyMove m mv)) | (a, mv) <- cands]
    -- ties go to the earlier action
    best = if null scored then Nothing else Just (maximumBy (comparing (\(a, _, v) -> (v, negate (aI a)))) scored)

showMove :: Move -> String
showMove mv = case mv of
  MPlay c -> "play(" ++ show (cCost c) ++ ")"
  MAttack _ TBase -> "attack base"
  MAttack _ (TUnit k) -> "attack " ++ T.unpack k
  MDeploy -> "deploy"
  MLeaderAct -> "leader"
  MPass -> "pass"
  MClaim -> "claim"
  MOpaque v -> "opaque " ++ show v

actKey :: Action -> ActKey
actKey a = (aKind a, aLabel a, aCardUuid a, argText a)

planOf :: Move -> Plan
planOf mv = case mv of
  MAttack k t -> PlanAttack k (Just t)
  MPlay c -> PlanPlay (cId c)
  MDeploy -> PlanDeploy
  MLeaderAct -> PlanLeader
  _ -> PlanNone

-- | The model moves a legal action-window action stands for.
rootMoves :: Ctx -> Action -> [Move]
rootMoves ctx a
  | isPass a = [MPass]
  | isClaim a = [MClaim]
  | isCardAct a, Just c <- aCard a = cardMoves c
  | otherwise = [MOpaque 0]
  where
    m = cModel ctx
    mine = mMe m
    cardMoves c
      | acCtl c /= Just (cSeat ctx) = [MOpaque 0]
      | acZone c `elem` ["hand", "resource", "discard"] = [MPlay (handCard c)]
      | Just u <- findUnit (acId c) mine =
          if uExh u
            then [MOpaque 0.5]
            else case targetsFor u (mOpp m) of
              [] -> [MOpaque 0.3]
              ts -> [MAttack (uId u) t | t <- ts]
      | Just l <- sLeader mine, lId l == acId c =
          let moves =
                [MDeploy | not (lDeployed l), sRes mine >= lDeployAt l]
                  ++ [MLeaderAct | not (lExh l), isJust (lActCost l)]
           in if null moves then [MOpaque 0.5] else moves
      | otherwise = [MOpaque 0.5]
    handCard c = case find ((== acId c) . cId) (sHand mine) of
      Just card -> card
      Nothing ->
        let info = bySet (cDb ctx) (acSet c)
            have = maybe [] (myAspects (cDb ctx)) (me ctx)
            cost = maybe 3 (\i -> ciCost i + aspectPenalty have i) info
         in Card (acId c) (acName c) cost info (acZone c /= "hand")

-- ---------------------------------------------------------------- other prompts

promptChoice :: Ctx -> Reply
promptChoice ctx
  | Just a <- find ((== "distribute") . aKind) acts = distributeChoice ctx a
  | prType p == Just "initiative" = orFirst (byLabel ["yourself"] bs)
  | "mulligan" `T.isInfixOf` t = mulliganChoice ctx
  | prType p == Just "resource" || "to resource" `T.isInfixOf` t = resourceChoice ctx
  | "target for attack" `T.isInfixOf` t, any isCardAct acts = attackTargetChoice ctx
  | any isCardAct acts = cardChoice ctx
  | any ((== "displayCard") . aKind) acts = displayChoice ctx
  | any ((== "perCardButton") . aKind) acts = perCardChoice ctx
  | any ((== "option") . aKind) acts = optionChoice ctx
  | otherwise = buttonChoice ctx
  where
    p = cPrompt ctx
    acts = cActs ctx
    bs = buttons ctx
    t = titleL ctx
    orFirst = pick . fromMaybe (head acts)

-- | Keep a hand with at least two cards castable by round three, one of them a unit.
mulliganChoice :: Ctx -> Reply
mulliganChoice ctx = pick . fromMaybe (head (cActs ctx)) $ byLabel [if keep then "keep" else "mulligan"] (buttons ctx)
  where
    hand = maybe [] (sHand . mkMine) (me ctx)
    mkMine _ = mMe (cModel ctx)
    cheap = [c | c <- hand, cCost c <= 3]
    keep = length cheap >= 2 && any (maybe False (isType "unit") . cInfo) cheap

-- | How much a card in hand is worth keeping (higher: keep; lowest goes to the resource zone).
keepValue :: Int -> [Card] -> Card -> Double
keepValue total hand c = 3 * efficiency + reach - penalty - smuggle - dup
  where
    info = cInfo c
    printed = maybe (cCost c) ciCost info
    quality = case info of
      Just i
        | isType "unit" i -> 1.0 * fromIntegral (ciPower i) + 0.8 * fromIntegral (ciHp i) + 0.5 * fromIntegral (length (ciKeywords i))
        | otherwise -> 1.4 * fromIntegral (ciCost i) + 1
      Nothing -> 2
    efficiency = quality / fromIntegral (max 1 printed)
    -- cards castable soon are kept; a card many resources away is better spent as one
    reach
      | cCost c <= total + 1 = 3
      | cCost c <= total + 2 = 1.5
      | otherwise = negate (fromIntegral (cCost c - total - 2))
    penalty = 0.75 * fromIntegral (cCost c - printed)
    smuggle = if maybe False (hasKeyword "smuggle") info then 2 else 0
    dup = if length (filter ((== cName c) . cName) hand) > 1 then 1.5 else 0

resourceChoice :: Ctx -> Reply
resourceChoice ctx
  | length selected >= want, Just d <- find isDone bs = pick d
  | null cards = pick (fromMaybe (head (cActs ctx)) (find isDone bs))
  | otherwise = pick (maximumBy (comparing (\a -> (negate (score a), negate (aI a)))) cards)
  where
    bs = buttons ctx
    t = titleL ctx
    selected = prSelected (cPrompt ctx)
    cards = filter isCardAct (cActs ctx)
    (lo, hi) = selectionBounds t
    mine = mMe (cModel ctx)
    total = sRes mine
    handN = sHandN mine
    wantMore = total < 6 || (handN >= 3 && total < 8) || handN >= 5
    want = if lo == hi then hi else if wantMore then hi else lo
    hand = [c | c <- sHand mine, not (cFromRes c)]
    score a = maybe 0 (keepValue total hand) (find ((== fromMaybe "" (aCardUuid a)) . cId) hand)

attackTargetChoice :: Ctx -> Reply
attackTargetChoice ctx = case planned of
  Just a -> pick a
  Nothing -> case attacker of
    Just k -> pick (maximumBy (comparing (\a -> (value k a, negate (aI a)))) cards)
    Nothing -> cardChoice ctx
  where
    m = cModel ctx
    cards = filter isCardAct (cActs ctx)
    target a = case aCard a of
      Just c | acZone c == "base" -> TBase
      _ -> TUnit (fromMaybe "" (aCardUuid a))
    planned = case memPlan (cMem ctx) of
      PlanAttack _ (Just t) -> find ((== t) . target) cards
      _ -> Nothing
    attacker = case memPlan (cMem ctx) of
      PlanAttack k _ | isJust (findUnit k (mMe m)) -> Just k
      _ -> uId <$> find ((== lower (prSource (cPrompt ctx))) . lower . uName) (sUnits (mMe m))
    value k a = searchValue searchBeam (searchDepth - 1) (applyMove m (MAttack k (target a)))

-- | The effect a targeting prompt applies, from its title or (for generic titles) its source card.
promptEffect :: Ctx -> Maybe Effect
promptEffect ctx
  | "attach " `T.isPrefixOf` t, Just c <- src = Just (EUpgrade (ciUpPower c) (ciUpHp c))
  | (e : _) <- parseEffects (prTitle (cPrompt ctx)) = Just e
  | generic, Just c <- src, (e : _) <- parseEffects (ciText c) = Just e
  | otherwise = Nothing
  where
    t = titleL ctx
    src = byTitle (cDb ctx) (prSource (cPrompt ctx))
    generic = t `elem` ["choose a unit", "choose a card", "choose a target", "choose a unit\n(because you are choosing from a hidden zone you may choose nothing)"]

data Intent = Harm | Help | Neutral

intent :: T.Text -> Intent
intent t
  | any (`T.isInfixOf` t) ["defeat", "damage", "exhaust", "capture", "return", "take control", "lose all", "can't attack", "cannot attack", "\8211", "-1/", "-2/", "-3/", "-4/", "bounty"] = Harm
  | any (`T.isInfixOf` t) ["heal", "shield", "experience", "+", "ready", "attach", "sentinel", "cannot be attacked", "gains", "attack with"] = Help
  | otherwise = Neutral

-- | Score of choosing one card in a targeting prompt (higher is better), with the score of choosing nothing.
cardScores :: Ctx -> ([(Action, Double)], Double)
cardScores ctx = case promptEffect ctx of
  Just e | all onBoard cards -> ([(a, evaluate (applyEffectTo Me e (Just (tgt a)) (owner a) m)) | a <- cards], evaluate m)
  _ -> ([(a, ruleScore a) | a <- cards], 0)
  where
    m = cModel ctx
    t = titleL ctx
    cards = filter isCardAct (cActs ctx)
    zone a = maybe "" acZone (aCard a)
    onBoard a = zone a `elem` ["groundArena", "spaceArena", "base"]
    owner a = if (aCard a >>= acCtl) == Just (cSeat ctx) then Me else Opp
    tgt a = if zone a == "base" then TBase else TUnit (fromMaybe "" (aCardUuid a))
    unitV a = maybe 4 unitValue (findUnit (fromMaybe "" (aCardUuid a)) (side (owner a) m))
    mine = mMe m
    hand = sHand mine
    keepV a = maybe 2 (keepValue (sRes mine) hand) (find ((== fromMaybe "" (aCardUuid a)) . cId) hand)
    ruleScore a
      | zone a `elem` ["hand", "discard", "resource", "deck"] =
          if "discard" `T.isInfixOf` t && owner a == Me then negate (keepV a) else keepV a
      | "attack with" `T.isInfixOf` t =
          case findUnit (fromMaybe "" (aCardUuid a)) mine of
            Just u | owner a == Me -> fromIntegral (uPow u) + (if uExh u then 0 else 5)
            _ -> -5
      | zone a == "base" = case (intent t, owner a) of
          (Harm, Opp) -> 3
          (Harm, Me) -> -6
          (Help, Me) -> 1
          _ -> -1
      | otherwise = case (intent t, owner a) of
          (Harm, Opp) -> unitV a
          (Harm, Me) -> negate (unitV a)
          (Help, Me) -> unitV a
          (Help, Opp) -> negate (unitV a)
          (Neutral, Me) -> 1 + unitV a / 10
          (Neutral, Opp) -> 0.5

cardChoice :: Ctx -> Reply
cardChoice ctx
  | multiple = multiChoice
  | otherwise = singleChoice
  where
    (scored, nothing) = cardScores ctx
    bs = buttons ctx
    passB = find isDone bs
    cancelB = find isCancel bs
    multiple = prMode (cPrompt ctx) == Just "multiple"
    selected = length (prSelected (cPrompt ctx))
    (lo, hi) = selectionBounds (titleL ctx)
    bestOf xs = fst (maximumBy (comparing (\(a, v) -> (v, negate (aI a)))) xs)
    bestV = maximum (map snd scored)
    singleChoice
      | Just b <- passB, bestV <= nothing + 0.01 = pick b
      | Just b <- cancelB, bestV < nothing - 4 = pick b
      | otherwise = pick (bestOf scored)
    multiChoice
      | selected >= hi, Just b <- doneB = pick b
      | selected >= lo, Just b <- doneB, bestV <= nothing + 0.01 = pick b
      | otherwise = pick (bestOf scored)
    doneB = passB <|> find (\a -> lbl a `elem` ["done", "confirm", "submit", "ok"]) bs
    a <|> b = if isJust a then a else b

-- | Search-the-deck style prompts: take the best card; discard prompts discard nothing when allowed.
displayChoice :: Ctx -> Reply
displayChoice ctx
  | "discard" `T.isInfixOf` t, Just d <- doneB = pick d
  | multiple && selected >= hi, Just d <- doneB = pick d
  | null cards = pick (fromMaybe (head (cActs ctx)) doneB)
  | otherwise = pick (maximumBy (comparing (\a -> (value a, negate (aI a)))) cards)
  where
    t = titleL ctx
    doneB = find isDone (buttons ctx)
    cards = filter ((== "displayCard") . aKind) (cActs ctx)
    multiple = prMode (cPrompt ctx) == Just "multiple"
    selected = length (prSelected (cPrompt ctx))
    (_, hi) = selectionBounds t
    value a = cardWorth (cDb ctx) (aLabel a)

cardWorth :: CardDb -> T.Text -> Double
cardWorth db internal = case byInternal db internal of
  Just i
    | isType "unit" i -> 1.0 * fromIntegral (ciPower i) + 0.8 * fromIntegral (ciHp i) + 1
    | otherwise -> 1.4 * fromIntegral (ciCost i) + 1
  Nothing -> 1

-- | Deck-ordering prompts: good cards on top, the rest at the bottom.
perCardChoice :: Ctx -> Reply
perCardChoice ctx = pick (maximumBy (comparing (\a -> (score a, negate (aI a)))) pcbs)
  where
    pcbs = filter ((== "perCardButton") . aKind) (cActs ctx)
    score a =
      let (button, rest) = T.breakOn ":" (aLabel a)
          worth = cardWorth (cDb ctx) (T.drop 1 rest)
          b = lower button
       in if "top" `T.isInfixOf` b then worth else if "bottom" `T.isInfixOf` b then 6 - worth else 0

optionChoice :: Ctx -> Reply
optionChoice ctx = case nums of
  [] -> pick (head opts)
  _ -> pick (snd (maximumBy (comparing fst) nums))
  where
    opts = filter ((== "option") . aKind) (cActs ctx)
    nums = [(n, a) | a <- opts, Just n <- [readNum (aLabel a)]]
    readNum l = case T.uncons l of
      Just ('#', ds) | not (T.null ds), T.all (`elem` ['0' .. '9']) ds -> Just (read (T.unpack ds) :: Int)
      _ -> Nothing

buttonChoice :: Ctx -> Reply
buttonChoice ctx
  | "are you sure" `T.isInfixOf` t || "will have no effect" `T.isInfixOf` t, Just c <- find isCancel bs = pick c
  | "choose an ability" `T.isInfixOf` t || ("play " `T.isPrefixOf` t && ":" `T.isSuffixOf` t) = abilityChoice ctx
  | "pay mode" `T.isInfixOf` t = orBest (byLabel ["normal", "pay"] bs <|> find isCancel bs)
  | "resolve all of their abilities first" `T.isInfixOf` t || "resolve first" `T.isInfixOf` t =
      orBest (byLabel ["you"] (filter (not . ("opponent" `T.isInfixOf`) . lbl) bs) <|> firstReal)
  | prType (cPrompt ctx) == Just "optionalTrigger" = orBest (byLabel ["trigger", "yes"] bs)
  | prType (cPrompt ctx) == Just "batchTriggerResolution" = orBest (byLabel ["resolve all"] bs)
  | any (("opponent" ==) . lbl) bs = case intent (t <> " " <> srcText) of
      Harm -> orBest (byLabel ["opponent"] bs)
      _ -> orBest (byLabel ["yourself", "you"] bs)
  | otherwise = orBest (byLabel ["shield", "experience"] bs <|> firstReal)
  where
    t = titleL ctx
    bs = buttons ctx
    srcText = maybe "" (lower . ciText) (byTitle (cDb ctx) (prSource (cPrompt ctx)))
    firstReal = find (\a -> not (isCancel a) && not ("(no effect)" `T.isPrefixOf` lbl a)) bs
    orBest = pick . fromMaybe (maximumBy (comparing (\a -> (buttonScore (lbl a), negate (aI a)))) (cActs ctx))
    a <|> b = if isJust a then a else b

-- | "Choose an ability:" after clicking a unit or leader: follow the plan made in the action window.
abilityChoice :: Ctx -> Reply
abilityChoice ctx = pick (fromMaybe fallback choice)
  where
    bs = buttons ctx
    real = filter (\a -> not (isCancel a) && not ("(no effect)" `T.isPrefixOf` lbl a)) bs
    isAttack a = lbl a == "attack"
    isDeploy a = "deploy" `T.isPrefixOf` lbl a
    choice = case memPlan (cMem ctx) of
      PlanAttack _ _ -> find isAttack real
      PlanDeploy -> find isDeploy real
      PlanLeader -> find (\a -> not (isDeploy a) && not (isAttack a)) real
      _ -> find (\a -> not (isDeploy a) && not (isAttack a)) real
    fallback = fromMaybe (head (cActs ctx)) (find isCancel bs <|> listToMaybe real)
    a <|> b = if isJust a then a else b

buttonScore :: T.Text -> Double
buttonScore l
  | any (`T.isInfixOf` l) ["trigger", "yes", "use", "play", "keep"] = 5
  | any (`T.isInfixOf` l) ["done", "confirm", "continue", "resolve all"] || "ok" `T.isPrefixOf` l = 3
  | "(no effect)" `T.isPrefixOf` l = -4
  | any (`T.isInfixOf` l) ["pass", "decline", "skip", "choose nothing", "cancel"] || "no" == l = -3
  | otherwise = 0

-- ---------------------------------------------------------------- distributing damage, healing and tokens

-- | A split for a distribute prompt; Nothing leaves it to the engine's random split.
distributeChoice :: Ctx -> Action -> Reply
distributeChoice ctx a = Reply (aI a) (aDist a >>= split)
  where
    m = cModel ctx
    myBase = maybe "" (crId . poBase) (me ctx)
    oppBase = maybe "" (crId . poBase) (M.lookup (if cSeat ctx == "p1" then "p2" else "p1") (soPlayers (cState ctx)))
    split spec =
      let ts = dsTargets spec
          amount = dsAmount spec
          cap dt = fromMaybe amount (dtCap dt)
          unitOf who dt = findUnit (dtId dt) (side who m)
          mineU = [(dt, u) | dt <- ts, Just u <- [unitOf Me dt]]
          oppU = [(dt, u) | dt <- ts, Just u <- [unitOf Opp dt]]
          myBaseT = find ((== myBase) . dtId) ts
          oppBaseT = find ((== oppBase) . dtId) ts
          order = case dsType spec of
            ty
              | ty == "distributeHealing" ->
                  [(dt, min (cap dt) (uDmg u)) | (dt, u) <- sortOn (negate . unitValue . snd) mineU, uDmg u > 0]
                    ++ [(dt, cap dt) | Just dt <- [myBaseT]]
              | ty == "distributeTokenUpgrade" ->
                  [(dt, cap dt) | (dt, _) <- sortOn (negate . unitValue . snd) mineU]
              | null oppU && isNothing oppBaseT ->
                  -- damage I must take: the base first while it is healthy, units only up to what they survive
                  let baseFirst = maybe False (const (sBase (mMe m) > amount + 6)) myBaseT
                      units = [(dt, min (cap dt) (remaining u - 1)) | (dt, u) <- sortOn (unitValue . snd) mineU]
                      base = [(dt, cap dt) | Just dt <- [myBaseT]]
                   in if baseFirst then base ++ units else units ++ base
              | otherwise ->
                  let kills = sortOn (\(_, u) -> negate (unitValue u / fromIntegral (max 1 (remaining u)))) oppU
                   in [(dt, min (cap dt) (killCost u)) | (dt, u) <- kills]
                        ++ [(dt, cap dt) | Just dt <- [oppBaseT]]
                        ++ [(dt, cap dt) | (dt, _) <- sortOn (negate . unitValue . snd) oppU]
          killCost u = if uShield u > 0 then remaining u + 1 else remaining u
          maxT = fromMaybe (length ts) (dsMaxTargets spec)
          go :: Int -> [(T.Text, Int)] -> [(DistTarget, Int)] -> [(T.Text, Int)]
          go 0 acc _ = acc
          go _ acc [] = acc
          go left acc ((dt, want) : rest)
            | want <= 0 = go left acc rest
            | Just have <- lookup (dtId dt) acc =
                let room = cap dt - have
                    n = min left (min want room)
                 in go (left - n) (bump (dtId dt) n acc) rest
            | length acc >= maxT = go left acc rest
            | otherwise = let n = min left want in go (left - n) (acc ++ [(dtId dt, n)]) rest
          bump k n = map (\(k', v) -> if k' == k then (k', v + n) else (k', v))
          placed = go amount [] order
          -- anything left goes wherever there is room (forced damage, or caps that ran out)
          leftover = amount - sum (map snd placed)
          filled = if leftover > 0 && not (dsLess spec) then go leftover placed [(dt, cap dt) | dt <- ts] else placed
          final = filter ((> 0) . snd) (mergeSame filled)
          total = sum (map snd final)
          okTotal
            | total == 0 = dsNone spec
            | dsLess spec = total <= amount
            | otherwise = total == amount
          okCaps = and [n <= maybe n id (dtCap =<< find ((== k) . dtId) ts) | (k, n) <- final]
       in if okTotal && okCaps && length final <= maxT then Just final else Nothing
    mergeSame = foldl' (\acc (k, n) -> if isJust (lookup k acc) then map (\(k', v) -> if k' == k then (k', v + n) else (k', v)) acc else acc ++ [(k, n)]) []
