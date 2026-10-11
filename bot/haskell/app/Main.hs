{-# LANGUAGE OverloadedStrings #-}
-- | swu-bot-hs: a Star Wars Unlimited bot speaking the swu-bot stdio protocol (spec/stdio-protocol.md).
-- One JSON line in, one JSON line out; stdout is protocol only, logs go to stderr.
--
-- Card data: $SWU_CARD_JSON, else forceteki/test/json/Card under the working directory (the repo root when run
-- by the adapter).
module Main (main) where

import Cards (loadCardDb)
import Control.Exception (SomeException, evaluate, try)
import qualified Data.Aeson as A
import qualified Data.ByteString.Char8 as B
import qualified Data.ByteString.Lazy.Char8 as BL
import Data.Maybe (fromMaybe)
import Policy
import Protocol
import System.Environment (lookupEnv)
import System.IO

main :: IO ()
main = do
  hSetBuffering stdout LineBuffering
  hSetBinaryMode stdin True
  hSetEncoding stderr utf8
  dir <- fromMaybe "forceteki/test/json/Card" <$> lookupEnv "SWU_CARD_JSON"
  debug <- maybe False (`elem` ["1", "true"]) <$> lookupEnv "SWU_HS_DEBUG"
  db <- loadCardDb dir
  let loop mem = do
        eof <- isEOF
        if eof
          then pure ()
          else do
            line <- B.getLine
            if B.null (B.strip line)
              then loop mem
              else case A.eitherDecodeStrict line of
                Left err -> do
                  send (A.encode (A.object ["t" A..= ("error" :: String), "error" A..= ("bad message: " ++ err)]))
                  loop mem
                Right msg -> case msg of
                  Hello {} -> send ready >> loop newMemory
                  Decide {} -> do
                    r <- try (evaluate (forceReply (decide db mem msg)))
                    case r of
                      Right (reply, mem', logs) -> do
                        if debug then logLines logs else pure ()
                        send (encodeReply reply)
                        loop mem'
                      Left e -> do
                        hPutStrLn stderr ("swu-bot-hs: " ++ show (e :: SomeException))
                        send (act (fallback msg))
                        loop mem
                  Other _ -> send (A.encode (A.object ["t" A..= ("error" :: String), "error" A..= ("unknown message" :: String)])) >> loop mem
  loop newMemory
  where
    send s = BL.putStrLn s >> hFlush stdout
    -- logging must never take the bot down
    logLines ls = try (mapM_ (hPutStrLn stderr) ls) >>= either (\e -> const (pure ()) (e :: SomeException)) pure
    encodeReply (Reply i Nothing) = act i
    encodeReply (Reply i (Just split)) = actWithSplit i split
    -- force the index and the split so an error inside the policy is caught here, not while printing
    forceReply x@(Reply i s, _, _) = i `seq` maybe () (foldr (\(k, n) acc -> k `seq` n `seq` acc) ()) s `seq` x
    -- if the policy fails: pass when possible, else the first action
    fallback msg = case [aI a | a <- dActions msg, aKind a == "button", aLabel a == "Pass"] of
      (i : _) -> i
      [] -> 0
