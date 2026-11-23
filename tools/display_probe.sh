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
#   tools/display_probe.sh <car-ssh-host> --watch [out-dir]   record until Ctrl-C (drive with it running until it
#                                                              happens): the display service's ups and downs, our
#                                                              apps' warnings, the display processes' pids every 10 s
#                                                              (a new pid means it restarted), the car's whole journal
#                                                              and its DLT trace, streamed to the Mac
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
    echo "following $CAR into $OUT/ until Ctrl-C"
    echo "(drive as usual; when the message shows, leave it running a minute more, then Ctrl-C)"
    # The car keeps only minutes of its journal and BMW's services log to DLT, so both are streamed to the Mac as
    # they happen: cluster-render.log, apps_procs.txt (our apps' logs, the display processes' pids every 10 s),
    # journal.txt (every unit), dlt.txt (dlt-daemon's whole trace). Nothing is written on the car.
    # raw streams (the car's grep and sed may be BusyBox's, without line buffering): filtered on the Mac at the end
    ssh "$CAR" "tail -n 0 -F $CR_LOG" > "$OUT/cluster-render.log" 2>/dev/null &
    W0=$!
    # shellcheck disable=SC2029
    ssh "$CAR" "
        for f in $OAP/*/data/custom_hud.log $OAP/*/data/custom_cluster.log; do
            [ -f \"\$f\" ] && tail -n 0 -F \"\$f\" &
        done
        last=''
        while true; do
            now=\$( (ps -eo pid,comm 2>/dev/null || ps) | grep -i -E '$PROCS' | grep -v grep | awk '{print \$1}' | tr '\n' ' ')
            if [ \"\$now\" != \"\$last\" ]; then echo \"[procs \$(date -u '+%Y-%m-%d %H:%M:%S')] \$now\"; last=\"\$now\"; fi
            sleep 10
        done
    " > "$OUT/apps_procs.txt" 2>/dev/null &
    W1=$!
    ssh "$CAR" "journalctl -f -n 0 --utc -o short-precise --no-pager" > "$OUT/journal.txt" 2>/dev/null &
    W2=$!
    # -a: ASCII. dlt-daemon's port 3490 on whatever address it listens on (127.0.0.1 refused on the car, Nov 23);
    # without a TCP listener there is no trace to stream, and dlt.err says what is listening instead
    # shellcheck disable=SC2016
    ssh "$CAR" '
        l=$(netstat -lnt 2>/dev/null | awk "\$4 ~ /:3490\$/ {print \$4; exit}")
        a=${l%:3490}
        case "$a" in ""|0.0.0.0|::|"[::]"|":::") a=127.0.0.1 ;; esac
        echo "dlt-daemon listening: ${l:-not on TCP 3490}; dlt-receive -a $a" >&2
        [ -n "$l" ] || { netstat -lnt 2>/dev/null >&2; ps | grep -i dlt | grep -v grep >&2; exit 1; }
        exec dlt-receive -a "$a"
    ' > "$OUT/dlt.txt" 2> "$OUT/dlt.err" &
    W3=$!
    stop() {
        kill "$W0" "$W1" "$W2" "$W3" 2>/dev/null || true
        wait 2>/dev/null || true
        # the display side of the DLT trace and the journal, and where the display service dropped
        grep -i -E 'dcsm|ramses|kombi|cluster|display|heartbeat|someip|scene|hud' "$OUT/dlt.txt" > "$OUT/dlt_display.txt" || true
        {
            grep -E "$CR_KEYS" "$OUT/cluster-render.log" | sed 's/^/[cluster-render] /'
            grep -i -E 'warn|error|refus|lost|unavailable|live2d|cluster-render|^\[procs' "$OUT/apps_procs.txt"
        } > "$OUT/watch.txt" || true
        grep -E 'Dcsm2 (not )?available|no heartbeat' "$OUT/cluster-render.log" > "$OUT/drops.txt" || true
        echo
        echo "wrote $OUT/: drops.txt (when it went), watch.txt (the key lines), journal.txt, dlt_display.txt (dlt.txt is everything)"
        wc -l "$OUT"/*.txt
        exit 0
    }
    trap stop INT TERM
    sleep 5
    kill -0 "$W3" 2>/dev/null || echo "(no DLT: $(head -c 200 "$OUT/dlt.err"))"
    echo "recording since $(date -u '+%H:%M:%S') UTC; Ctrl-C to stop"
    seen=0
    while true; do
        sleep 10
        n=$(grep -c 'Dcsm2 not available' "$OUT/cluster-render.log" 2>/dev/null || true)
        if [ "${n:-0}" -gt "$seen" ]; then
            seen=$n
            echo "$(date -u '+%H:%M:%S') UTC: the display service dropped; keep it running a minute, then Ctrl-C"
        fi
    done
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

# the whole head unit's journal (every service, BMW's too) from 60 s before to 20 s after each display service drop
# in this boot: what else went or complained when the cluster stopped answering
# shellcheck disable=SC2029
ssh "$CAR" "
    cat $CR_LOG.1 $CR_LOG 2>/dev/null | grep 'Dcsm2 not available' | cut -c1-19 | tail -4 | while read -r d t; do
        s=\$(date -u -d \"\$d \$t 60 seconds ago\" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || continue
        e=\$(date -u -d \"\$d \$t 20 seconds\" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || continue
        echo \"== journal \$s .. \$e UTC (drop at \$d \$t)\"
        journalctl --utc -o short-precise --no-pager --since \"\$s\" --until \"\$e\" 2>/dev/null |
            grep -v -E ' fps, |glue: |fast path: ' | tail -400
        echo
    done
" > "$OUT/journal_around_drops.txt" 2>&1 || true

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

echo "wrote $OUT/: summary.txt (start here), around_drops.txt, journal_around_drops.txt, cluster-render.log, journal.txt, custom_hud.log, custom_cluster.log"
