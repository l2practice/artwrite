#!/bin/sh
# Regenerates gas/Cefr.gs from aw-cefr.js so the feedback Doc (Apps Script)
# and the browser use the same CEFR wordlist and analyser.
# Run from the repo root after editing aw-cefr.js:  sh gas/build-cefr.sh
set -e
{
  echo '/* GENERATED from aw-cefr.js by gas/build-cefr.sh — do not edit here.'
  echo '   Same CEFR analyser as the browser, for the feedback Doc: AWCEFR.analyseVocabulary(text). */'
  echo 'var AWCEFR = {};'
  sed 's/^})(window\.AW = window\.AW || {});$/})(AWCEFR);/' aw-cefr.js
} > gas/Cefr.gs
grep -q '})(AWCEFR);' gas/Cefr.gs || { echo 'build-cefr: wrapper line not found' >&2; exit 1; }
