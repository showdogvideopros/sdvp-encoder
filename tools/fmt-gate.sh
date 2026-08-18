#!/bin/bash
# Refuses printf width/precision specifiers. Node's console.log does not
# support them: the specifier prints literally and every argument after it
# shifts one position left, silently attaching numbers to wrong labels.
# Allowed: %s %d %i %f %j %o %O %c %%
BAD='%[-+ #0-9.]+[a-zA-Z]'
cd /root/build || exit 2

# --- control: the gate must go RED on a known-positive and GREEN on a known-negative
KP=$(mktemp); KN=$(mktemp)
printf 'console.log("%%-8s %%.2f", a, b);\n' > "$KP"
printf 'console.log("%%s %%d %%f", a, b, c);\n' > "$KN"
grep -qE "$BAD" "$KP"; p=$?
grep -qE "$BAD" "$KN"; n=$?
rm -f "$KP" "$KN"
if [ $p -ne 0 ] || [ $n -eq 0 ]; then
  echo "⛔ GATE IS BLIND — known-positive=$p (want 0), known-negative=$n (want 1)"
  exit 2
fi
echo "control: RED on known-positive, GREEN on known-negative — gate has power"

HITS=$(grep -rnE "$BAD" --include='*.js' . 2>/dev/null | grep -v '\.bak\.')
if [ -n "$HITS" ]; then
  echo "⛔ FORMAT GATE FAILED:"
  echo "$HITS"
  exit 1
fi
echo "format gate: PASS — no width/precision specifiers in any .js"
