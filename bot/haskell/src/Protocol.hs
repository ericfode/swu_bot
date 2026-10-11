{-# LANGUAGE OverloadedStrings #-}
-- | Messages of the swu-bot stdio protocol v1 (spec/stdio-protocol.md). Only the fields the bot uses are parsed;
-- unknown fields are ignored, as the spec asks.
module Protocol
  ( CardRef (..)
  , UnitObs (..)
  , LeaderObs (..)
  , PlayerObs (..)
  , StateObs (..)
  , PromptObs (..)
  , ActCard (..)
  , DistTarget (..)
  , DistSpec (..)
  , Action (..)
  , Incoming (..)
  , argText
  , ready
  , act
  , actWithSplit
  ) where

import Data.Aeson ((.:), (.:?), (.=))
import qualified Data.Aeson as A
import qualified Data.Aeson.Types as A
import qualified Data.ByteString.Lazy as BL
import qualified Data.Map.Strict as M
import Data.Maybe (fromMaybe)
import Data.Scientific (floatingOrInteger)
import qualified Data.Text as T

data CardRef = CardRef {crId :: !T.Text, crName :: !T.Text, crSet :: !(Maybe T.Text)}
  deriving (Show)

data UnitObs = UnitObs
  { uoRef :: !CardRef
  , uoPower :: !Int
  , uoHp :: !Int
  , uoDamage :: !Int
  , uoExhausted :: !Bool
  , uoSentinel :: !Bool
  , uoUpgrades :: [(CardRef, Bool)]
  }
  deriving (Show)

data LeaderObs = LeaderObs {loRef :: !CardRef, loDeployed :: !Bool, loExhausted :: !Bool}
  deriving (Show)

data PlayerObs = PlayerObs
  { poBase :: !CardRef
  , poBaseHp :: !Int
  , poBaseDamage :: !Int
  , poLeader :: !(Maybe LeaderObs)
  , poReady :: !Int
  , poTotal :: !Int
  , poHandCount :: !Int
  , poDeck :: !Int
  , poDiscard :: [CardRef]
  , poGround :: [UnitObs]
  , poSpace :: [UnitObs]
  , poHand :: [CardRef]
  , poResources :: [(CardRef, Bool)]
  }
  deriving (Show)

data StateObs = StateObs
  { soRound :: !Int
  , soPhase :: !T.Text
  , soInitiative :: !(Maybe T.Text)
  , soPlayers :: M.Map T.Text PlayerObs
  }
  deriving (Show)

data PromptObs = PromptObs
  { prType :: !(Maybe T.Text)
  , prSignature :: !T.Text
  , prTitle :: !T.Text
  , prSource :: !T.Text
  , prMode :: !(Maybe T.Text)
  , prSelected :: [T.Text]
  , prWindow :: !Bool
  }
  deriving (Show)

data ActCard = ActCard
  { acId :: !T.Text
  , acName :: !T.Text
  , acSet :: !(Maybe T.Text)
  , acZone :: !T.Text
  , acCtl :: !(Maybe T.Text)
  }
  deriving (Show)

data DistTarget = DistTarget {dtId :: !T.Text, dtCap :: !(Maybe Int)}
  deriving (Show)

data DistSpec = DistSpec
  { dsType :: !T.Text
  , dsAmount :: !Int
  , dsLess :: !Bool
  , dsNone :: !Bool
  , dsMaxTargets :: !(Maybe Int)
  , dsTargets :: [DistTarget]
  }
  deriving (Show)

data Action = Action
  { aI :: !Int
  , aKind :: !T.Text
  , aLabel :: !T.Text
  , aArg :: !(Maybe A.Value)
  , aCardUuid :: !(Maybe T.Text)
  , aCard :: !(Maybe ActCard)
  , aDist :: !(Maybe DistSpec)
  }
  deriving (Show)

data Incoming
  = Hello {hYou :: !T.Text, hSeed :: !Integer}
  | Decide
      { dSeq :: !Int
      , dYou :: !T.Text
      , dPrompt :: !PromptObs
      , dState :: !StateObs
      , dStateRaw :: !A.Value
      , dActions :: [Action]
      }
  | Other !T.Text

-- | Flags are sent as @1@ (sometimes @true@); absent means false.
flag :: A.Object -> A.Key -> A.Parser Bool
flag o k = maybe False truthy <$> o .:? k
  where
    truthy (A.Bool b) = b
    truthy (A.Number n) = n /= 0
    truthy _ = False

int0 :: A.Object -> A.Key -> A.Parser Int
int0 o k = do
  v <- o .:? k
  pure $ case v of
    Just (A.Number n) -> either round id (floatingOrInteger n :: Either Double Int)
    _ -> 0

text0 :: A.Object -> A.Key -> A.Parser T.Text
text0 o k = fromMaybe "" <$> o .:? k

instance A.FromJSON CardRef where
  parseJSON = A.withObject "card" $ \o -> CardRef <$> o .: "id" <*> text0 o "n" <*> o .:? "s"

instance A.FromJSON UnitObs where
  parseJSON v@(A.Object o) = do
    ref <- A.parseJSON v
    ups <- fromMaybe [] <$> o .:? "u"
    upgrades <- mapM (\u -> (,) <$> A.parseJSON u <*> A.withObject "upgrade" (`flag` "t") u) ups
    UnitObs ref <$> int0 o "p" <*> int0 o "h" <*> int0 o "d" <*> flag o "x" <*> flag o "sn" <*> pure upgrades
  parseJSON v = A.typeMismatch "unit" v

instance A.FromJSON LeaderObs where
  parseJSON v@(A.Object o) = LeaderObs <$> A.parseJSON v <*> flag o "dep" <*> flag o "x"
  parseJSON v = A.typeMismatch "leader" v

instance A.FromJSON PlayerObs where
  parseJSON = A.withObject "player" $ \o -> do
    baseV <- o .: "base"
    base <- A.parseJSON baseV
    (bhp, bd) <- A.withObject "base" (\b -> (,) <$> int0 b "hp" <*> int0 b "d") baseV
    leader <- o .:? "leader"
    (rReady, rTotal) <- maybe (pure (0, 0)) (A.withObject "res" (\r -> (,) <$> int0 r "ready" <*> int0 r "total")) =<< o .:? "res"
    resV <- fromMaybe [] <$> o .:? "resources"
    resources <- mapM (\r -> (,) <$> A.parseJSON r <*> A.withObject "resource" (`flag` "x") r) resV
    PlayerObs base bhp bd leader rReady rTotal
      <$> int0 o "handCount"
      <*> int0 o "deck"
      <*> (fromMaybe [] <$> o .:? "discard")
      <*> (fromMaybe [] <$> o .:? "ground")
      <*> (fromMaybe [] <$> o .:? "space")
      <*> (fromMaybe [] <$> o .:? "hand")
      <*> pure resources

instance A.FromJSON StateObs where
  parseJSON = A.withObject "state" $ \o ->
    StateObs <$> int0 o "round" <*> text0 o "phase" <*> o .:? "initiative" <*> (fromMaybe M.empty <$> o .:? "players")

instance A.FromJSON PromptObs where
  parseJSON = A.withObject "prompt" $ \o ->
    PromptObs
      <$> o .:? "type"
      <*> text0 o "signature"
      <*> text0 o "title"
      <*> text0 o "promptTitle"
      <*> o .:? "selectCardMode"
      <*> (fromMaybe [] <$> o .:? "selected")
      <*> flag o "actionWindow"

instance A.FromJSON ActCard where
  parseJSON = A.withObject "actcard" $ \o ->
    ActCard <$> o .: "id" <*> text0 o "n" <*> o .:? "s" <*> text0 o "zone" <*> o .:? "ctl"

instance A.FromJSON DistTarget where
  parseJSON = A.withObject "target" $ \o -> DistTarget <$> o .: "id" <*> o .:? "cap"

instance A.FromJSON DistSpec where
  parseJSON = A.withObject "distribute" $ \o ->
    DistSpec
      <$> text0 o "type"
      <*> int0 o "amount"
      <*> flag o "canDistributeLess"
      <*> flag o "canChooseNoTargets"
      <*> o .:? "maxTargets"
      <*> (fromMaybe [] <$> o .:? "targets")

instance A.FromJSON Action where
  parseJSON = A.withObject "action" $ \o ->
    Action
      <$> o .: "i"
      <*> text0 o "kind"
      <*> text0 o "label"
      <*> o .:? "arg"
      <*> o .:? "cardUuid"
      <*> o .:? "card"
      <*> o .:? "distribute"

instance A.FromJSON Incoming where
  parseJSON = A.withObject "message" $ \o -> do
    t <- text0 o "t"
    case t of
      "hello" -> Hello <$> text0 o "you" <*> (fromMaybe 0 <$> o .:? "seed")
      "decide" -> do
        st <- o .: "state"
        Decide <$> int0 o "seq" <*> text0 o "you" <*> o .: "prompt" <*> A.parseJSON st <*> pure st <*> o .: "actions"
      _ -> pure (Other t)

-- | An action's @arg@ as text (strings as is, numbers shown).
argText :: Action -> T.Text
argText a = case aArg a of
  Just (A.String s) -> s
  Just (A.Number n) -> T.pack (either show show (floatingOrInteger n :: Either Double Integer))
  _ -> ""

ready :: BL.ByteString
ready = A.encode (A.object ["t" .= ("ready" :: T.Text), "v" .= (1 :: Int), "name" .= ("haskell" :: T.Text)])

act :: Int -> BL.ByteString
act i = A.encode (A.object ["t" .= ("act" :: T.Text), "i" .= i])

actWithSplit :: Int -> [(T.Text, Int)] -> BL.ByteString
actWithSplit i split =
  A.encode
    ( A.object
        [ "t" .= ("act" :: T.Text)
        , "i" .= i
        , "distribution" .= [A.object ["id" .= k, "amount" .= n] | (k, n) <- split]
        ]
    )
