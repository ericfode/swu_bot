{-# LANGUAGE OverloadedStrings #-}
-- | Card data from forceteki's @test/json/Card/*.json@. The stdio protocol sends card names and set codes but no
-- costs or keywords, so the bot reads the same files the engine uses.
module Cards
  ( CardInfo (..)
  , CardDb
  , emptyDb
  , loadCardDb
  , bySet
  , byInternal
  , byTitle
  , isType
  , hasKeyword
  , keywordNum
  , numAfter
  , smuggleCost
  , aspectPenalty
  , lower
  ) where

import Control.Exception (SomeException, try)
import Data.Aeson ((.:?))
import qualified Data.Aeson as A
import qualified Data.ByteString as BS
import Data.Char (isDigit)
import Data.List (foldl')
import qualified Data.Map.Strict as M
import Data.Maybe (fromMaybe, mapMaybe)
import qualified Data.Text as T
import System.Directory (doesDirectoryExist, listDirectory)
import System.FilePath (takeExtension, (</>))

data CardInfo = CardInfo
  { ciTitle :: !T.Text
  , ciInternal :: !T.Text
  , ciCost :: !Int
  , ciPower :: !Int
  , ciHp :: !Int
  , ciText :: !T.Text
  , ciAspects :: [T.Text]
  , ciTraits :: [T.Text]
  , ciKeywords :: [T.Text]
  , ciTypes :: [T.Text]
  , ciArena :: !T.Text
  , ciUpPower :: !Int
  , ciUpHp :: !Int
  , ciCodes :: [T.Text]
  }
  deriving (Show)

newtype SetCode = SetCode T.Text

instance A.FromJSON SetCode where
  parseJSON = A.withObject "setId" $ \o -> do
    s <- fromMaybe "" <$> o .:? "set"
    n <- fromMaybe (0 :: Int) <$> o .:? "number"
    pure (SetCode (s <> "_" <> T.justifyRight 3 '0' (T.pack (show n))))

instance A.FromJSON CardInfo where
  parseJSON = A.withObject "card" $ \o -> do
    let opt k d = fromMaybe d <$> o .:? k
    title <- opt "title" ""
    internal <- opt "internalName" ""
    cost <- opt "cost" 0
    power <- opt "power" 0
    hp <- opt "hp" 0
    text <- opt "text" ""
    aspects <- opt "aspects" []
    traits <- opt "traits" []
    kws <- opt "keywords" []
    types <- opt "types" []
    arena <- opt "arena" "ground"
    upP <- opt "upgradePower" 0
    upH <- opt "upgradeHp" 0
    codes <- opt "setCodes" []
    sid <- o .:? "setId"
    let allCodes = [c | SetCode c <- maybe [] pure sid ++ codes]
    pure (CardInfo title internal cost power hp text aspects traits kws types arena upP upH allCodes)

data CardDb = CardDb
  { dbSet :: M.Map T.Text CardInfo
  , dbInternal :: M.Map T.Text CardInfo
  , dbTitle :: M.Map T.Text CardInfo
  }

emptyDb :: CardDb
emptyDb = CardDb M.empty M.empty M.empty

-- | Load the card data from the folder that holds @Card/@ (@$SWU_CARD_JSON@, as the other bots and the arena read
-- it) or from @Card/@ itself. Unreadable files are skipped; a missing directory gives an empty db (the bot still
-- plays, it just knows less).
loadCardDb :: FilePath -> IO CardDb
loadCardDb given = do
  nested <- doesDirectoryExist (given </> "Card")
  loadDir (if nested then given </> "Card" else given)

-- | Load every card file in one directory.
loadDir :: FilePath -> IO CardDb
loadDir dir = do
  ok <- doesDirectoryExist dir
  if not ok
    then pure emptyDb
    else do
      files <- filter ((== ".json") . takeExtension) <$> listDirectory dir
      cards <- mapMaybe id <$> mapM readCard files
      pure (foldl' add emptyDb cards)
  where
    readCard f = do
      r <- try (BS.readFile (dir </> f)) :: IO (Either SomeException BS.ByteString)
      pure (either (const Nothing) A.decodeStrict r)
    add db c =
      db
        { dbSet = foldl' (\m k -> M.insertWith keep k c m) (dbSet db) (ciCodes c)
        , dbInternal = M.insertWith keep (ciInternal c) c (dbInternal db)
        , dbTitle = M.insertWith keep (ciTitle c) c (dbTitle db)
        }
    keep _new old = old

bySet :: CardDb -> Maybe T.Text -> Maybe CardInfo
bySet db s = s >>= \k -> M.lookup k (dbSet db)

byInternal :: CardDb -> T.Text -> Maybe CardInfo
byInternal db k = M.lookup k (dbInternal db)

byTitle :: CardDb -> T.Text -> Maybe CardInfo
byTitle db k = M.lookup k (dbTitle db)

isType :: T.Text -> CardInfo -> Bool
isType t c = t `elem` ciTypes c

hasKeyword :: T.Text -> CardInfo -> Bool
hasKeyword k c = k `elem` ciKeywords c

lower :: T.Text -> T.Text
lower = T.toLower

-- | First number that follows @key@ in @txt@ (case-insensitive), e.g. @numAfter "raid" "Raid 2 (...)" == Just 2@.
numAfter :: T.Text -> T.Text -> Maybe Int
numAfter key txt = go (lower txt)
  where
    k = lower key
    go t = case T.breakOn k t of
      (_, rest)
        | T.null rest -> Nothing
        | otherwise ->
            let after = T.drop (T.length k) rest
                ds = T.takeWhile isDigit (T.stripStart after)
             in if T.null ds then go after else Just (read (T.unpack ds))

-- | Amount for numbered keywords (Raid 2, Restore 1); 0 if the card lacks the keyword.
keywordNum :: T.Text -> CardInfo -> Int
keywordNum k c
  | hasKeyword k c = fromMaybe 1 (numAfter (k <> " ") (ciText c))
  | otherwise = 0

-- | Cost to play from the resource zone, when the card has Smuggle.
smuggleCost :: CardInfo -> Maybe Int
smuggleCost c
  | hasKeyword "smuggle" c = numAfter "smuggle [" (ciText c)
  | otherwise = Nothing

-- | Extra cost for aspect icons the leader and base do not provide: 2 per missing icon.
aspectPenalty :: [T.Text] -> CardInfo -> Int
aspectPenalty have c = 2 * missing (ciAspects c) have
  where
    missing [] _ = 0
    missing (a : as) hs
      | a `elem` hs = missing as (dropOne a hs)
      | otherwise = 1 + missing as hs
    dropOne _ [] = []
    dropOne a (h : hs)
      | a == h = hs
      | otherwise = h : dropOne a hs
