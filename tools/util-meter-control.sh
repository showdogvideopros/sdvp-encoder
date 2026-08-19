#!/bin/bash
# Proves the CPU meter can report BOTH extremes before it is trusted.
NCPU=$(nproc)

sample() {   # $1 = seconds to measure over
  read t0 i0 < <(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, idle}' /proc/stat)
  sleep "$1"
  read t1 i1 < <(awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; print tot, idle}' /proc/stat)
  awk -v dt=$((t1-t0)) -v di=$((i1-i0)) -v n="$NCPU" 'BEGIN{printf "%.2f", (1-di/dt)*n}'
}

echo "  cores available: $NCPU"

IDLE=$(sample 4)
echo "  known-negative (idle box)      : $IDLE cores busy"

for i in $(seq 1 "$NCPU"); do (timeout 6 bash -c 'while :; do :; done') & done
BUSY=$(sample 4)
wait 2>/dev/null
echo "  known-positive (all cores spun): $BUSY cores busy"

awk -v idle="$IDLE" -v busy="$BUSY" -v n="$NCPU" 'BEGIN{
  ok_lo = (idle < n*0.25);
  ok_hi = (busy > n*0.85);
  printf "  reads LOW when idle  : %s\n", ok_lo ? "YES" : "NO  <- METER IS STUCK HIGH";
  printf "  reads HIGH when busy : %s\n", ok_hi ? "YES" : "NO  <- METER CANNOT SEE FULL LOAD";
  printf "  METER: %s\n", (ok_lo && ok_hi) ? "TRUSTWORTHY" : "NOT TRUSTWORTHY";
  exit (ok_lo && ok_hi) ? 0 : 1;
}'
