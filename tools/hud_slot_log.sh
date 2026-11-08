#!/usr/bin/env bash
# HUD slot table log (run on the Mac, car on, Miku showing on the HUD): which slots BMW's own HUD content lands in
# on this car, so we know what Miku can park behind (same slot, 0x323) and what still needs the give-way timers.
#
#   tools/hud_slot_log.sh <car-ssh-host> [out.txt]
#
# For each event it asks you to make BMW show it, marks the start and end on the car's clock, then cuts
# cluster-render's log (/var/opt/cluster-render/log/cluster-render.log) to those windows and keeps the slot rows
# ("dcsm: slot ... status S content C class K map M"; map 1 shown, 3 parked, 0 unmapped) and the HUD target's lines.
# Changes nothing on the car.
set -euo pipefail

CAR="${1:?usage: $(basename "$0") <car-ssh-host> [out.txt]}"
OUT="${2:-hud_slot_log_$(date +%Y%m%d_%H%M%S).txt}"
LOG=/var/opt/cluster-render/log/cluster-render.log

EVENTS=(
    "Music pop-up: change track or volume from the wheel so the HUD shows the media pop-up"
    "List pop-up: scroll the wheel's list (radio stations or playlist) on the HUD"
    "Phone: start or receive a call so the HUD shows it, then hang up"
    "Warning: open a door or unbuckle the seatbelt (parked) so a check-control message shows"
    "Guidance: start a route, wait for the HUD turn arrow, then cancel the route"
)

carnow() { ssh "$CAR" "date -u '+%Y-%m-%d %H:%M:%S'"; }

ssh "$CAR" "test -r $LOG" || { echo "no $LOG on $CAR" >&2; exit 1; }
STARTS=(); ENDS=()
for e in "${EVENTS[@]}"; do
    echo
    echo "== $e"
    read -r -p "Press Enter when Miku is showing and you are about to start (s to skip): " k
    if [ "$k" = s ]; then STARTS+=(""); ENDS+=(""); continue; fi
    STARTS+=("$(carnow)")
    read -r -p "Make BMW show it now. Press Enter once it has gone again and Miku is back (or after 30 s): " _
    ENDS+=("$(carnow)")
done

echo; echo "fetching the log"
ssh "$CAR" "cat $LOG.1 $LOG 2>/dev/null" > "$OUT.raw"

{
    echo "HUD slot table log, $CAR, $(date)"
    echo "Slot rows before the first event (the table as it stood):"
    first=""; for s in "${STARTS[@]}"; do [ -n "$s" ] && { first="$s"; break; }; done
    if [ -n "$first" ]; then
        awk -v t="$first" 'substr($0,1,19) < t' "$OUT.raw" | grep "dcsm: slot" | tail -20
    fi
    for i in "${!EVENTS[@]}"; do
        echo
        echo "== ${EVENTS[$i]}"
        if [ -z "${STARTS[$i]}" ]; then echo "(skipped)"; continue; fi
        echo "   ${STARTS[$i]} .. ${ENDS[$i]} UTC (car clock)"
        awk -v a="${STARTS[$i]}" -v b="${ENDS[$i]}" 'substr($0,1,19) >= a && substr($0,1,19) <= b' "$OUT.raw" |
            grep -E "dcsm: slot|target hud|gives way|pop-up|stock content" || echo "(nothing logged)"
    done
} > "$OUT"
echo "wrote $OUT (full log in $OUT.raw)"
