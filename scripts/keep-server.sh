#!/bin/bash
cd /Users/tangtang/kunming-gis-buildings/score-video-demo
LOG=/tmp/tangtang-server.log
while true; do
  echo "[$(date '+%F %T')] start" >> "$LOG"
  /usr/bin/env node src/server.mjs >> "$LOG" 2>&1
  ec=$?
  echo "[$(date '+%F %T')] exit=$ec" >> "$LOG"
  [ -f /tmp/tangtang-server.stop ] && exit 0
  sleep 1
done
