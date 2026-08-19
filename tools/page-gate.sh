#!/bin/bash
# Executes the status page's JavaScript against live state.
# node --check only PARSES. This RUNS, so an undefined variable throws here
# instead of silently in the browser.
cd /root/build || exit 2
PAGE=public/status.html

run_draw() {   # $1 = page file
  python3 - "$1" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
a, b = s.find('<script>'), s.find('</script>')
open('/tmp/pg.js','w').write(s[a+8:b])
PYEOF
  curl -s --max-time 5 http://127.0.0.1:8099/api/state > /tmp/pg-state.json 2>/dev/null
  [ -s /tmp/pg-state.json ] || { echo "  no state available"; return 2; }
  node -e '
    const fs = require("fs");
    const el = { textContent:"", innerHTML:"", value:"2000", addEventListener(){} };
    global.document = { getElementById: () => el };
    global.fetch = () => Promise.reject(new Error("stubbed"));
    global.setInterval = () => 0; global.clearInterval = () => {};
    eval(fs.readFileSync("/tmp/pg.js","utf8"));
    draw(JSON.parse(fs.readFileSync("/tmp/pg-state.json","utf8")));
    if (el.innerHTML.length < 200) { console.log("rendered too little"); process.exit(1); }
    console.log(el.innerHTML.length);
  ' 2>&1
}

# ---- control: a deliberately broken copy MUST fail, or this gate is blind
BROKEN=/tmp/pg-broken.html
sed 's/var p=it.progress||{};/var p=it.progressUNDEFINED_ON_PURPOSE.x;/' "$PAGE" > "$BROKEN"
if run_draw "$BROKEN" >/dev/null 2>&1; then
  echo "⛔ GATE IS BLIND — a broken page passed"
  rm -f "$BROKEN" /tmp/pg.js /tmp/pg-state.json
  exit 2
fi
echo "control: broken page REJECTED — gate has power"
rm -f "$BROKEN"

OUT=$(run_draw "$PAGE")
RC=$?
rm -f /tmp/pg.js /tmp/pg-state.json
if [ $RC -ne 0 ]; then
  echo "⛔ PAGE GATE FAILED:"
  echo "$OUT"
  exit 1
fi
echo "page gate: PASS — draw() rendered $OUT bytes against live state"
