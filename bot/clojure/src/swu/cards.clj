(ns swu.cards
  "Card stats from the engine's card JSON (forceteki/test/json/Card/*.json, or $SWU_CARD_JSON).
  The stdio protocol sends names and set codes but no costs or keywords, so the bot reads them here."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(defn- set-code
  "{\"set\" \"SOR\" \"number\" 95} -> \"SOR_095\" (the engine's setCodeToString)."
  [{:keys [set number]}]
  (when (and set number)
    (format "%s_%03d" set (long number))))

(defn- keyword-number
  "\"Raid 2\" in the rules text -> 2."
  [text kw]
  (some->> (re-find (re-pattern (str "(?i)\\b" kw " (\\d+)")) (or text ""))
           second
           parse-long))

(defn- card-record [raw]
  (let [text (str (:text raw) " " (:deployBox raw))]
    {:title     (:title raw)
     :name      (:internalName raw)
     :cost      (or (:cost raw) 0)
     :power     (or (:power raw) 0)
     :hp        (or (:hp raw) 0)
     :upower    (:upgradePower raw)
     :uhp       (:upgradeHp raw)
     :types     (set (:types raw))
     :aspects   (vec (:aspects raw))
     :arena     (:arena raw)
     :unique    (boolean (:unique raw))
     :keywords  (set (map str/lower-case (:keywords raw)))
     :raid      (or (keyword-number text "raid") 0)
     :restore   (or (keyword-number text "restore") 0)
     :text      (str/lower-case (or (:text raw) ""))
     :deploy    (str/lower-case (or (:deployBox raw) ""))
     :codes     (vec (keep set-code (:setCodes raw)))}))

(def empty-db {:by-code {} :by-name {} :by-title {}})

(defn load-db
  "Reads every card file once. Returns empty-db (and warns) when the folder is missing: the bot then plays on the
  board numbers alone."
  ([] (load-db (or (System/getenv "SWU_CARD_JSON") "forceteki/test/json")))
  ([dir]
   (let [folder (io/file dir "Card")
         files  (when (.isDirectory folder)
                  (filter #(str/ends-with? (.getName ^java.io.File %) ".json") (.listFiles folder)))]
     (if (empty? files)
       (do (binding [*out* *err*]
             (println "[clj] no card data in" (str folder) "- playing on board numbers only"))
           empty-db)
       (reduce (fn [db f]
                 (let [c (try (card-record (json/read-str (slurp f) :key-fn keyword))
                              (catch Exception _ nil))]
                   (if-not c
                     db
                     (-> (reduce #(update %1 :by-code assoc %2 c) db (:codes c))
                         (update :by-name assoc (:name c) c)
                         (update :by-title #(if (contains? % (:title c)) % (assoc % (:title c) c)))))))
               empty-db
               files)))))

(defn lookup
  "Finds a card by set code, then internal name (an action's label), then title."
  [db {:keys [s n label]}]
  (or (get-in db [:by-code s])
      (get-in db [:by-name label])
      (get-in db [:by-title n])))

(defn is? [card type] (contains? (:types card) type))
(defn kw? [card k] (contains? (:keywords card) k))

(defn aspect-penalty
  "Extra cost for each aspect icon the leader and base do not cover: 2 per missing icon."
  [card have]
  (loop [need (:aspects card) pool have missing 0]
    (if-let [[a & more] (seq need)]
      (let [i (.indexOf ^java.util.List pool a)]
        (if (neg? i)
          (recur more pool (inc missing))
          (recur more (into (subvec pool 0 i) (subvec pool (inc i))) missing)))
      (* 2 missing))))
