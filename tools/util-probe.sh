#!/bin/bash
# Samples cores-busy every 5s, tagged with the daemon's current phase.
# Usage: util-probe.sh start | stop | report
NCPU=$(nproc)
OUT=/var/lib/sdvp-encoder/util-probe.csv
PIDF=/var/lib/sdvp-encoder/util-probe.pid

loop() {
  echo "ts,phase,cores_busy,top_proc,top_pct" > "$OUT"
  read pt pi < <(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, idle}' /proc/stat)
  while true; do
    sleep 5
    read ct ci < <(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, idle}' /proc/stat)
    dt=$((ct-pt)); di=$((ci-pi)); pt=$ct; pi=$ci
    [ "$dt" -le 0 ] && continue
    cores=$(awk -v dt="$dt" -v di="$di" -v n="$NCPU" 'BEGIN{printf "%.2f", (1-di/dt)*n}')
    phase=$(curl -s --max-time 3 http://127.0.0.1:8099/api/state 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin); r = d['runs'][0]
    print(r['items'][0]['phase'] if r['items'] else 'NONE')
except Exception:
    print('UNKNOWN')" 2>/dev/null)
    tp=$(ps -eo comm,pcpu --sort=-pcpu --no-headers | head -1)
    echo "$(date -u +%H:%M:%S),${phase:-UNKNOWN},$cores,$(echo $tp | cut -d' ' -f1),$(echo $tp | cut -d' ' -f2)" >> "$OUT"
  done
}

case "$1" in
  start)
    [ -f "$PIDF" ] && kill "$(cat $PIDF)" 2>/dev/null
    loop & echo $! > "$PIDF"
    echo "  probe started, pid $(cat $PIDF), writing $OUT"
    ;;
  stop)
    [ -f "$PIDF" ] && kill "$(cat $PIDF)" 2>/dev/null && rm -f "$PIDF" && echo "  probe stopped"
    ;;
  report)
    echo "  samples: $(($(wc -l < $OUT) - 1))   cores available: $NCPU"
    echo
    awk -F, 'NR>1 && $2!="UNKNOWN" && $2!="NONE" {
      s[$2]+=$3; n[$2]++; if($3>mx[$2]) mx[$2]=$3;
      if(mn[$2]==""||$3<mn[$2]) mn[$2]=$3; proc[$2]=$4 }
      END{ printf "  %-12s %7s %8s %8s %8s   %s\n","phase","samples","mean","peak","min","top proc";
           for(p in s) printf "  %-12s %7d %8.2f %8.2f %8.2f   %s\n", p, n[p], s[p]/n[p], mx[p], mn[p], proc[p] }' "$OUT"
    echo
    echo "  headroom during each phase = cores available minus mean"
    ;;
  *) echo "  usage: $0 start|stop|report"; exit 2 ;;
esac
