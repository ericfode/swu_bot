#!/usr/bin/env bash
# Starts the Clojure bot on stdin/stdout. Needs Java 11+ and nothing else: the first run downloads Clojure and
# data.json from Maven Central into bot/clojure/lib/ (gitignored). With the Clojure CLI you can instead run
# `clojure -M -m swu.main` from this folder (deps.edn). `./run.sh test` runs the unit tests.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib="$here/lib"
jars=(
  "org/clojure/clojure/1.12.0/clojure-1.12.0.jar"
  "org/clojure/spec.alpha/0.5.238/spec.alpha-0.5.238.jar"
  "org/clojure/core.specs.alpha/0.4.74/core.specs.alpha-0.4.74.jar"
  "org/clojure/data.json/2.5.1/data.json-2.5.1.jar"
)
mkdir -p "$lib"
cp="$here/src"
for j in "${jars[@]}"; do
  f="$lib/$(basename "$j")"
  if [ ! -s "$f" ]; then
    curl -sSfL -o "$f.tmp" "https://repo1.maven.org/maven2/$j" >&2 && mv "$f.tmp" "$f"
  fi
  cp="$cp:$f"
done
# AOT-compiled classes (./run.sh compile) start about twice as fast; source is used when they are missing or stale.
if [ -d "$here/classes/swu" ] && [ -z "$(find "$here/src" -newer "$here/classes/swu/main__init.class" -name '*.clj' 2>/dev/null)" ]; then
  cp="$here/classes:$cp"
fi
case "${1:-}" in
  test)    exec java -cp "$cp:$here/test" clojure.main -e "(require 'swu.policy-test) (let [r (clojure.test/run-tests 'swu.policy-test)] (System/exit (if (zero? (+ (:fail r) (:error r))) 0 1)))" ;;
  compile) rm -rf "$here/classes" && mkdir -p "$here/classes" && exec java -cp "$here/classes:$cp" -Dclojure.compile.path="$here/classes" clojure.main -e "(compile 'swu.main)" ;;
  *)       exec java -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xss8m -cp "$cp" clojure.main -m swu.main ;;
esac
