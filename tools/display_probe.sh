#!/usr/bin/env bash
# Display service probe (run on the Mac, car on): why cluster-render says "target unavailable: display service not
# available" on both the HUD and the cluster while the cluster itself is up but BMW's map is gone.
#
# cluster-render says this when the car's display service (DCSM, which the HUD, the cluster's map and our layers all
# go through) is reported down; it logs "dcsm: Dcsm2 not available" and, if it went within 10 s of a mapping,
# "target <t>: the display service went away <n> ms after its mapping". This collects what's on the car about it.
# Changes nothing on the car: it only reads files and lists processes.
#
#   tools/display_probe.sh <car-ssh-host> [out-dir]           a snapshot: run it while the message is showing
#   tools/display_probe.sh <car-ssh-host> --watch [out-dir]   follow until Ctrl-C (drive with it running until it
#                                                              happens): the display service's ups and downs, what
#                                                              was mapped, our apps' warnings, every 10 s the
#                                                              display processes' pids (a new pid means it restarted)
set -euo pipefail

CAR="${1:?usage: $(basename "$0") <car-ssh-host> [--watch] [out-dir]}"
shift
WATCH=0
if [ "${1:-}" = "--watch" ]; then WATCH=1; shift; fi
OUT="${1:-display_probe_$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$OUT"

CR_LOG=/var/opt/cluster-render/log/cluster-render.log
OAP=/var/opt/public/oap
# processes that make or carry the picture (BMW's and ours), by name
PROCS='dcsm|ramses|display|kombi|cluster|hmi|live2d|navi|map'
# the lines that matter in cluster-render's log
CR_KEYS='Dcsm2|DCSM provider|display service|went away|unavailable|target (hud|panel)|refused|error|warn|restart|lost'

if [ "$WATCH" = 1 ]; then
    echo "following $CAR until Ctrl-C, into $OUT/watch.txt"
    echo "(drive as usual; when the message shows, note the time and leave it running a minute more)"
    # shellcheck disable=SC2029
    ssh "$CAR" "
        tail -n 0 -F $CR_LOG 2>/dev/null | grep --line-buffered -E '$CR_KEYS' | sed -u 's/^/[cluster-render] /' &
        for f in $OAP/*/data/custom_hud.log $OAP/*/data/custom_cluster.log; do
            [ -f \"\$f\" ] && tail -n 0 -F \"\$f\" | grep --line-buffered -i -E 'warn|error|refus|lost|unavailable|live2d|cluster-render' | sed -u \"s|^|[\$(basename \$f .log)] |\" &
        done
        journalctl -f -n 0 -u live2d-render -u cluster-render 2>/dev/null | sed -u 's/^/[journal] /' &
        last=''
        while true; do
            now=\$(ps -eo pid,comm 2>/dev/null | grep -i -E '$PROCS' | grep -v grep | tr '\n' ' ')
            if [ \"\$now\" != \"\$last\" ]; then echo \"[procs \$(date -u '+%Y-%m-%d %H:%M:%S')] \$now\"; last=\"\$now\"; fi
            sleep 10
        done
    " | tee "$OUT/watch.txt"
    exit 0
fi

echo "snapshot of $CAR into $OUT/"
# shellcheck disable=SC2029
ssh "$CAR" "
    echo '== car clock (UTC), uptime, boot'
    date -u '+%Y-%m-%d %H:%M:%S'; uptime; cat /proc/sys/kernel/random/boot_id
    echo
    echo '== installed versions'
    for f in /var/opt/cluster-render/current/component.json /var/opt/live2d-render/current/component.json; do
        [ -f \"\$f\" ] && echo \"\$f: \$(grep -m1 '\"version\"' \"\$f\")\"
    done
    for d in $OAP/*/; do
        p=\"\$d/source/package.json\"; [ -f \"\$p\" ] || p=\"\$d/package.json\"
        [ -f \"\$p\" ] && echo \"\$d: \$(grep -m1 -E '\"(name|title)\"' \"\$p\" | tr -d ' ') \$(grep -m1 '\"version\"' \"\$p\" | tr -d ' ')\"
    done
    echo
    echo '== cluster-render status'
    cat /run/cluster-render/status.txt 2>/dev/null || echo '(no /run/cluster-render/status.txt)'
    echo
    echo '== display service ups and downs, and what was mapped (cluster-render log)'
    cat $CR_LOG.1 $CR_LOG 2>/dev/null | grep -E 'Dcsm2|DCSM provider|went away|display service' | tail -60
    echo
    echo '== processes that make or carry the picture (pid, start time, name)'
    ps -eo pid,lstart,comm 2>/dev/null | grep -i -E '$PROCS' | grep -v grep || ps | grep -i -E '$PROCS' | grep -v grep
    echo
    echo '== failed units'
    systemctl --failed --no-legend 2>/dev/null | head -40
    echo
    echo '== crash dumps, newest first'
    for d in /var/lib/systemd/coredump /var/crash /var/opt/crash /tmp/core* /var/core; do
        [ -e \"\$d\" ] && ls -lt \"\$d\" 2>/dev/null | head -15 | sed \"s|^|\$d: |\"
    done
    echo
    echo '== live2d-render: crash guard state and journal'
    ls -la /var/opt/live2d-render/state 2>/dev/null
    journalctl -u live2d-render --since '-3h' --no-pager 2>/dev/null | grep -v -E ' fps, |glue: |fast path: ' | tail -40
" > "$OUT/summary.txt" 2>&1 || true

echo "fetching logs"
ssh "$CAR" "cat $CR_LOG.1 $CR_LOG 2>/dev/null" > "$OUT/cluster-render.log" || true
ssh "$CAR" "journalctl -u cluster-render -u live2d-render --since '-6h' --no-pager 2>/dev/null" > "$OUT/journal.txt" || true
for app in custom_hud custom_cluster; do
    ssh "$CAR" "tail -n 3000 $OAP/*/data/$app.log 2>/dev/null" > "$OUT/$app.log" || true
done

# where the display service went: the lines around each "not available" in cluster-render's log
grep -n -E 'Dcsm2 not available|DCSM provider not available' "$OUT/cluster-render.log" | tail -5 | cut -d: -f1 |
    while read -r n; do
        echo "== around line $n"
        sed -n "$((n > 40 ? n - 40 : 1)),$((n + 10))p" "$OUT/cluster-render.log"
        echo
    done > "$OUT/around_drops.txt" || true

echo "wrote $OUT/: summary.txt (start here), around_drops.txt, cluster-render.log, journal.txt, custom_hud.log, custom_cluster.log"
