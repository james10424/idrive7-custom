#!/bin/sh
# The part of tools/car_usage.sh that runs on the head unit (BusyBox sh and awk): SECS and ROUNDS from the
# environment. tools/car_usage.sh sends it over ssh; see there.
SECS=${SECS:-10}
ROUNDS=${ROUNDS:-1}
OAP=/var/opt/public/oap
DEFAULT_HZ=100   # clock ticks a second when getconf can't say (Linux's usual)
TOP_OTHERS=5     # the busiest other processes listed
HZ=$(getconf CLK_TCK 2>/dev/null || echo $DEFAULT_HZ)
CORES=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
TMP=/tmp/car_usage.$$
GPU=$(ls -d /sys/class/drm/card*/gt_act_freq_mhz 2>/dev/null | head -1)

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
        case "$name" in cluster-render*|live2d-render*) echo "$pid $name" ;; esac
    done
}
# "pid ticks comm" for every process (utime + stime; comm without spaces), in one pass: an awk a process would
# cost the unit more than what it measures
all_ticks() {
    cat /proc/[0-9]*/stat 2>/dev/null | awk '{ pid = $1; c = $0; sub(/^[0-9]+ \(/, "", c); sub(/\) .*/, "", c);
        gsub(/ /, "_", c); sub(/^.*\) /, ""); print pid, $12 + $13, c }'
}
# busy and total jiffies of all cores together (/proc/stat's cpu line)
cpu_total() { awk '/^cpu / { busy = $2 + $3 + $4 + $7 + $8 + $9; total = busy + $5 + $6; print busy, total }' /proc/stat; }
mem_mb() { awk -v k="$1" '$1 == k":" { printf "%.0f", $2 / 1024 }' /proc/meminfo; }

round=1
while [ "$round" -le "$ROUNDS" ]; do
    OURS=$(find_ours)
    all_ticks > $TMP.start
    set -- $(cpu_total); busy0=$1; total0=$2
    # the GPU's clock, sampled through the window
    gpu_sum=0; gpu_n=0; gpu_max=0
    t=0
    while [ "$t" -lt "$SECS" ]; do
        sleep 1
        t=$((t + 1))
        if [ -n "$GPU" ]; then
            f=$(cat "$GPU" 2>/dev/null || echo 0)
            gpu_sum=$((gpu_sum + f)); gpu_n=$((gpu_n + 1))
            [ "$f" -gt "$gpu_max" ] && gpu_max=$f
        fi
    done
    all_ticks > $TMP.end
    set -- $(cpu_total); busy1=$1; total1=$2

    echo "== $(date '+%H:%M:%S'), over $SECS s ($CORES cores, load $(cut -d' ' -f1-3 /proc/loadavg))"
    printf '%-7s %-22s %7s %8s %5s\n' pid process "% core" "RSS MB" thr
    echo "$OURS" | awk 'NF { print $1 }' > $TMP.ours
    if [ -z "$OURS" ]; then
        echo "        (none of our processes running)"
    else
        echo "$OURS" | while read pid label; do
            a=$(awk -v p=$pid '$1 == p { print $2 }' $TMP.start); b=$(awk -v p=$pid '$1 == p { print $2 }' $TMP.end)
            rss=$(awk '/^VmRSS/ { print $2 }' /proc/$pid/status 2>/dev/null || echo 0)
            thr=$(awk '/^Threads/ { print $2 }' /proc/$pid/status 2>/dev/null || echo 0)
            awk -v a="${a:-0}" -v b="${b:-0}" -v hz="$HZ" -v s="$SECS" -v r="${rss:-0}" -v t="${thr:-0}" -v pid="$pid" -v l="$label" \
                'BEGIN { printf "%-7s %-22s %7.1f %8.1f %5s\n", pid, l, 100 * (b - a) / hz / s, r / 1024, t }'
        done
        # ours together
        awk -v hz="$HZ" -v s="$SECS" 'FILENAME == ARGV[1] { ours[$1] = 1; next }
             FILENAME == ARGV[2] { start[$1] = $2; next }
             ($1 in ours) { sum += $2 - start[$1] }
             END { printf "%-7s %-22s %7.1f\n", "", "ours together", 100 * sum / hz / s }' $TMP.ours $TMP.start $TMP.end
    fi
    echo "-- the busiest others"
    awk -v hz="$HZ" -v s="$SECS" 'FILENAME == ARGV[1] { ours[$1] = 1; next }
         FILENAME == ARGV[2] { start[$1] = $2; next }
         !($1 in ours) && ($1 in start) { d = $2 - start[$1]; if (d > 0) printf "%-7s %-22s %7.1f\n", $1, $3, 100 * d / hz / s }' \
         $TMP.ours $TMP.start $TMP.end 2>/dev/null | sort -k3 -rn | head -$TOP_OTHERS
    echo "-- the unit"
    awk -v b0=$busy0 -v t0=$total0 -v b1=$busy1 -v t1=$total1 -v n=$CORES \
        'BEGIN { if (t1 > t0) printf "CPU %.0f%% of %d cores (%.0f%% of one core)\n", 100 * (b1 - b0) / (t1 - t0), n, 100 * n * (b1 - b0) / (t1 - t0) }'
    echo "memory: $(mem_mb MemAvailable) MB available of $(mem_mb MemTotal) MB"
    if [ -n "$GPU" ] && [ "$gpu_n" -gt 0 ]; then
        dir=${GPU%/*}
        echo "GPU clock: $((gpu_sum / gpu_n)) MHz average, $gpu_max MHz top (idles at $(cat $dir/gt_min_freq_mhz 2>/dev/null || echo ?), up to $(cat $dir/gt_max_freq_mhz 2>/dev/null || echo ?))"
    fi
    if command -v journalctl >/dev/null 2>&1; then
        last=$(journalctl -u live2d-render -n 20 --no-pager -o cat 2>/dev/null | grep ' fps, ' | tail -1)
        [ -n "$last" ] && echo "live2d-render's own: ${last#live2d-render: }"
    fi
    rm -f $TMP.start $TMP.end $TMP.ours
    round=$((round + 1))
    if [ "$round" -le "$ROUNDS" ]; then echo; fi
done
