#!/usr/bin/env bash
# What our apps take on the car: CPU and memory of Custom HUD, Custom Cluster, cluster-render and live2d-render, over
# a window, with the head unit's own totals and its busiest other processes (BMW's HMI) beside them.
#
#   tools/car_usage.sh <car-ssh-host> [seconds=10] [rounds=1]
#   tools/car_usage.sh root@$CAR_IP 30           one 30 s window
#   tools/car_usage.sh root@$CAR_IP 10 6         a minute, a table every 10 s
#   tools/car_usage.sh - 5                       this machine instead (testing it on any Linux)
#
# For each process: % of one core over the window (100 = a whole core; the car has 4), its RSS (resident memory, MB)
# and threads. Then the whole unit: CPU % of all cores, memory available, load, the GPU's clock (a rough sign of
# how hard it's drawing: it climbs from its idle MHz as it works), and live2d-render's own last timing line from
# its log. Finds each app's folder the way scripts/deploy.sh does (the oap_* folder whose package.json names it),
# then the processes whose command line or working folder is in it; cluster-render and live2d-render by name.
# Reads /proc and /sys only: changes nothing. What runs on the unit is tools/car_usage.remote.sh.
set -euo pipefail

DEFAULT_SECS=10   # the window, unless given
DEFAULT_ROUNDS=1
CAR="${1:?usage: $(basename "$0") <car-ssh-host> [seconds] [rounds]}"
SECS="${2:-$DEFAULT_SECS}"
ROUNDS="${3:-$DEFAULT_ROUNDS}"
case "$SECS$ROUNDS" in *[!0-9]*) echo "seconds and rounds are whole numbers" >&2; exit 2 ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$CAR" = "-" ]; then
    SECS=$SECS ROUNDS=$ROUNDS sh "$HERE/car_usage.remote.sh"
else
    ssh "$CAR" "SECS=$SECS ROUNDS=$ROUNDS sh -s" < "$HERE/car_usage.remote.sh"
fi
