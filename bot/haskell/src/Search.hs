-- | The search, in the style of Hughes' "Why Functional Programming Matters": the whole game tree of the model is
-- one lazy value ('gameTree'); 'prune' cuts it to a depth and 'alphaBeta' reads only the branches it needs.
-- Nothing is built that the search does not look at.
module Search
  ( Move (..)
  , movesFor
  , applyMove
  , gameTree
  , prune
  , alphaBeta
  , searchValue
  ) where

import Data.List (sortOn)
import qualified Data.Text as T
import Data.Tree (Tree (..), unfoldTree)
import Effects
import Model

data Move
  = MPlay !Card
  | MAttack !T.Text !Target
  | MDeploy
  | MLeaderAct
  | MPass
  | MClaim
  | MOpaque !Double -- a legal action the model cannot simulate, with a guessed value
  deriving (Show)

-- | Moves of the side to act. The opponent's hand is hidden, so it only attacks, uses its leader, passes or claims.
movesFor :: Model -> [Move]
movesFor m =
  [MPass]
    ++ [MClaim | not (mClaimed m)]
    ++ attacks
    ++ plays
    ++ [MDeploy | Just l <- [sLeader s], not (lDeployed l), sRes s >= lDeployAt l]
    ++ [ MLeaderAct
       | Just l <- [sLeader s]
       , not (lDeployed l)
       , not (lExh l)
       , Just c <- [lActCost l]
       , c <= sReady s
       ]
  where
    w = mTurn m
    s = side w m
    o = side (other w) m
    attacks = [MAttack (uId u) t | u <- sUnits s, not (uExh u), uPow u + uRaid u > 0, t <- targetsFor u o]
    plays = [MPlay c | c <- sHand s, cCost c <= sReady s]

-- | The model after the side to act makes a move. Turn order follows the action phase: players alternate; a player
-- who claimed the initiative is out; two passes in a row (or a pass after the other claimed) end the round.
applyMove :: Model -> Move -> Model
applyMove m mv = case mv of
  MPass
    | sPassed o || sOut o -> m {mRoundEnd = True, mMe = readyAll (mMe m), mOpp = readyAll (mOpp m)}
    | otherwise -> withSide w (\s -> s {sPassed = True}) m {mTurn = other w}
  MClaim -> next (withSide w (\s -> s {sOut = True, sPassed = True}) m {mInit = w, mClaimed = True})
  MPlay c -> next (playCard w c m)
  MAttack k t -> next (attack w k t m)
  MDeploy -> next (deployLeader w m)
  MLeaderAct -> next (leaderAction w m)
  MOpaque v -> next (addBonus w v m)
  where
    w = mTurn m
    o = side (other w) m
    next m' =
      let m'' = if sOut (side w m') then m' else withSide w (\s -> s {sPassed = False}) m'
       in if sOut (side (other w) m'') then m'' else m'' {mTurn = other w}

terminal :: Model -> Bool
terminal m = mOver m || mRoundEnd m

-- | Every reachable position, best-looking moves first, at most @beam@ children per node. Each node carries its
-- static value, computed once and only if needed. A won (lost) game is worth more (less) the sooner it happens, so
-- the search does not put off a win it can take now.
gameTree :: Int -> Model -> Tree (Model, Double)
gameTree beam = unfoldTree grow . (,) (0 :: Int)
  where
    grow (d, m) = ((m, valueAt d m), if terminal m then [] else [(d + 1, c) | c <- ordered m])
    valueAt d m
      | mOver m = let v = evaluate m in v - signum v * fromIntegral d
      | otherwise = evaluate m
    ordered m =
      let sign = if mTurn m == Me then negate else id
       in map fst . take beam . sortOn snd $ [(c, sign (evaluate c)) | c <- map (applyMove m) (movesFor m)]

prune :: Int -> Tree a -> Tree a
prune 0 (Node a _) = Node a []
prune n (Node a cs) = Node a (map (prune (n - 1)) cs)

-- | Minimax with alpha-beta cutoffs; I maximise, the opponent minimises.
alphaBeta :: Double -> Double -> Tree (Model, Double) -> Double
alphaBeta _ _ (Node (_, v) []) = v
alphaBeta alpha beta (Node (m, _) cs)
  | mTurn m == Me = goMax alpha (-1 / 0) cs
  | otherwise = goMin beta (1 / 0) cs
  where
    goMax _ best [] = best
    goMax a best (c : rest) =
      let v = alphaBeta a beta c
          best' = max best v
          a' = max a best'
       in if a' >= beta then best' else goMax a' best' rest
    goMin _ best [] = best
    goMin b best (c : rest) =
      let v = alphaBeta alpha b c
          best' = min best v
          b' = min b best'
       in if alpha >= b' then best' else goMin b' best' rest

-- | Value of a position looking @depth@ moves ahead.
searchValue :: Int -> Int -> Model -> Double
searchValue beam depth = alphaBeta (-1 / 0) (1 / 0) . prune depth . gameTree beam
