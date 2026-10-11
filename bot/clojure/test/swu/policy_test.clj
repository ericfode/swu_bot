(ns swu.policy-test
  (:require [clojure.test :refer [deftest is testing]]
            [swu.board :as b]
            [swu.cards :as cards]
            [swu.policy :as policy]))

(defn- unit [id p h & {:as more}] (merge {:id id :n id :s nil :p p :h h :d 0} more))

(defn- state [my-ground op-ground & {:keys [my-base op-base hand] :or {my-base 0 op-base 0 hand []}}]
  {:round 3 :phase "action" :initiative "p1"
   :players {:p1 {:base {:id "B1" :n "Base" :hp 30 :d my-base} :leader {:id "L1" :n "Leader" :dep 0 :x 0}
                  :res {:ready 4 :total 4} :handCount (count hand) :hand hand :deck 30 :discard []
                  :ground my-ground :space []}
             :p2 {:base {:id "B2" :n "Base" :hp 30 :d op-base} :leader {:id "L2" :n "Leader" :dep 0 :x 0}
                  :res {:ready 4 :total 4} :handCount 3 :deck 30 :discard [] :ground op-ground :space []}}})

(defn- model [st] (b/from-state cards/empty-db st :p1))

(deftest combat-math
  (let [m (model (state [(unit "a" 3 3)] [(unit "b" 2 2) (unit "s" 1 4 :sn 1)]))]
    (testing "sentinel forces the target"
      (is (= ["s"] (b/attack-targets m (b/unit m "a")))))
    (testing "both sides take damage at once, dead units leave"
      (let [m' (b/attack m "a" "s")]
        (is (= 3 (:d (b/unit m' "s"))))
        (is (= 1 (:d (b/unit m' "a"))))
        (is (false? (:ready (b/unit m' "a"))))))
    (testing "shield absorbs one hit"
      (let [m (model (state [(unit "a" 5 5)] [(unit "b" 2 2 :u [{:n "Shield" :t 1}])]))
            m' (b/attack m "a" "b")]
        (is (= 0 (:shields (b/unit m' "b"))))
        (is (= 0 (:d (b/unit m' "b"))))))
    (testing "base attack"
      (is (= 3 (:base-d (get-in (b/attack m "a" :base) [:sides :p2])))))))

(deftest search-sees-lethal
  (let [m (model (state [(unit "a" 4 3)] [(unit "b" 1 1)] :op-base 27))]
    (is (= b/win (b/search (assoc m :passes 0) :p1 1 (- Double/MAX_VALUE) Double/MAX_VALUE)))))

(deftest window-takes-the-kill
  (testing "attacking a ready enemy that would hit our low base beats hitting their base"
    (let [st  (state [(unit "a" 4 5)] [(unit "b" 3 3)] :my-base 27)
          msg {:seq 5 :you "p1" :state st
               :prompt {:type "actionWindow" :title "Choose an action" :actionWindow true :selected []}
               :actions [{:i 0 :kind "card" :label "a" :cardUuid "a" :card {:id "a" :n "a" :zone "groundArena" :ctl "p1"}}
                         {:i 1 :kind "button" :label "Pass" :arg "pass"}]}
          [bot reply] (policy/decide (policy/new-game cards/empty-db {:you "p1"}) msg)]
      (is (= 0 (:i reply)))
      (is (= "b" (get-in bot [:plan :attack :target]))))))

(deftest distribution-is-legal
  (let [st  (state [(unit "a" 2 2)] [(unit "b" 3 2) (unit "c" 5 6)])
        ctx (policy/context (policy/new-game cards/empty-db {:you "p1"}) {:state st :prompt {}} [])
        split (policy/distribution ctx {:type "distributeDamage" :amount 4 :canDistributeLess false
                                        :canChooseNoTargets false :maxTargets nil
                                        :targets [{:id "a" :cap nil} {:id "b" :cap nil} {:id "c" :cap nil} {:id "B2" :cap nil}]})]
    (is (= 4 (reduce + (map :amount split))))
    (is (= 2 (:amount (first (filter #(= "b" (:id %)) split)))) "kills the 3/2 first")
    (is (empty? (filter #(= "a" (:id %)) split)) "keeps damage off our own unit")))

(deftest wanted-counts
  (is (= 2 (policy/wanted "select 2 cards to resource")))
  (is (= 1 (policy/wanted "select between 0 and 1 cards to resource")))
  (is (= 3 (policy/wanted "choose up to 3 units")))
  (is (= 3 (policy/wanted "give an experience token to each of up to 3 units"))))
