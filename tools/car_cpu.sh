#!/usr/bin/env bash
# CPU and memory of our processes on the car: Custom HUD, Custom Cluster and cluster-render, over a window.
#
#   tools/car_cpu.sh <car-ssh-host> [seconds=10]
#
# Finds each app's folder the way scripts/deploy.sh does (the oap_* folder whose package.json names it), then the
# processes whose command line or working folder is in it, and cluster-render by name. Reads each one's CPU time
# from /proc at the start and the end of the window: % is of one core (100 = a whole core; the car has 4).
# Changes nothing.
set -euo pipefail

CAR="${1:?usage: $(basename "$0") <car-ssh-host> [seconds]}"
SECS="${2:-10}"

ssh "$CAR" "SECS=$SECS sh -s" <<'EOF'
OAP=/var/opt/public/oap
HZ=$(getconf CLK_TCK 2>/dev/null || echo 100)
# "pid label" for each process of ours
find_ours() {
    for app in custom_hud custom_cluster; do
        dir=$(grep -l "\"name\": \"$app\"" $OAP/oap_*/source/package.json 2>/dev/null | head -1 | sed 's#/source/package.json##')
        [ -n "$dir" ] || continue
        for p in /proc/[0-9]*; do
            pid=${p#/proc/}
            cmd=$(tr '\0' ' ' < $p/cmdline 2>/dev/null) || continue
            cwd=$(readlink $p/cwd 2>/dev/null || true)
            case "$cmd $cwd" in *"$dir"*) echo "$pid $app" ;; esac
        done
    done
    for p in /proc/[0-9]*; do
        pid=${p#/proc/}
        name=$(cat $p/comm 2>/dev/null) || continue
        case "$name" in cluster-render*) echo "$pid $name" ;; esac
    done
}
# utime + stime, in ticks
ticks() { awk '{ print $14 + $15 }' /proc/$1/stat 2>/dev/null || echo 0; }
OURS=$(find_ours)
[ -n "$OURS" ] || { echo "none of our processes found"; exit 1; }
echo "$OURS" | while read pid label; do echo "$pid $(ticks $pid)"; done > /tmp/car_cpu.start
sleep "$SECS"
echo "over $SECS s ($(nproc 2>/dev/null || echo '?') cores, load $(cut -d' ' -f1-3 /proc/loadavg)):"
printf '%-7s %-22s %7s %9s\n' pid process "% core" "RSS MB"
echo "$OURS" | while read pid label; do
    start=$(awk -v p=$pid '$1 == p { print $2 }' /tmp/car_cpu.start)
    now=$(ticks $pid)
    rss=$(awk '/^VmRSS/{ print $2 }' /proc/$pid/status 2>/dev/null || echo 0)
    awk -v a="$start" -v b="$now" -v hz="$HZ" -v s="$SECS" -v r="$rss" -v pid="$pid" -v l="$label" \
        'BEGIN { printf "%-7s %-22s %7.1f %9.1f\n", pid, l, 100 * (b - a) / hz / s, r / 1024 }'
done
rm -f /tmp/car_cpu.start
EOF
