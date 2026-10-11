(ns swu.main
  "stdio entry point: one JSON line in, one JSON line out (spec/stdio-protocol.md). stdout carries protocol lines
  only; logs go to stderr."
  (:require [clojure.data.json :as json]
            [swu.cards :as cards]
            [swu.policy :as policy])
  (:import (java.io BufferedReader InputStreamReader OutputStreamWriter PrintWriter))
  (:gen-class))

(def bot-name "clj-forecast")

(defn- send! [^PrintWriter out msg]
  (.println out ^String (json/write-str msg))
  (.flush out))

(defn- trace!
  "With $SWU_CLJ_LOG set, appends one line per decision (prompt, offered actions, pick) to that file."
  [path msg reply]
  (when path
    (let [p (:prompt msg)
          picked (some #(when (= (:i reply) (:i %)) %) (:actions msg))]
      (spit path (str (json/write-str {:seq (:seq msg) :type (:type p) :sig (:signature p) :title (:title p)
                                       :src (:promptTitle p) :sel (count (:selected p))
                                       :actions (mapv #(str (:kind %) ":" (:label %) (when-let [z (get-in % [:card :zone])] (str "@" z "/" (get-in % [:card :ctl]))))
                                                      (take 40 (:actions msg)))
                                       :pick (str (:kind picked) ":" (:label picked)) :dist (:distribution reply)})
                  "\n")
            :append true))))

(defn -main [& _]
  (let [in  (BufferedReader. (InputStreamReader. System/in "UTF-8"))
        out (PrintWriter. (OutputStreamWriter. System/out "UTF-8"))
        db  (delay (cards/load-db))
        log (System/getenv "SWU_CLJ_LOG")]
    (loop [bot nil]
      (when-let [line (.readLine in)]
        (let [msg (try (json/read-str line :key-fn keyword) (catch Exception _ nil))]
          (case (:t msg)
            "hello"  (let [bot (policy/new-game @db msg)]
                       (send! out {:t "ready" :v 1 :name bot-name})
                       (recur bot))
            "decide" (let [[bot reply] (policy/decide (or bot (policy/new-game @db msg)) msg)]
                       (send! out reply)
                       (trace! log msg reply)
                       (recur bot))
            (do (send! out {:t "error" :error (str "unknown message " (pr-str (:t msg)))})
                (recur bot))))))
    (shutdown-agents)))
