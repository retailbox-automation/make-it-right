#!/bin/bash
# Usage: scripts/demo-screen-photos.sh demo/ridgeway (macOS, uses sips). Makes demo/ridgeway/screen/photo-N.jpg from photos/photo-N.png: long side at most 1200 px (never enlarged), JPEG quality 80 (65 when 80 gives more than 250 KB).
set -eu
cd "$1"
mkdir -p screen
for f in photos/photo-*.png; do
  n=$(basename "$f" .png)
  w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
  long=$w
  if [ "$h" -gt "$w" ]; then long=$h; fi
  if [ "$long" -gt 1200 ]; then
    nice -n 10 sips -s format jpeg -s formatOptions 80 -Z 1200 "$f" --out "screen/$n.jpg" >/dev/null
  else
    nice -n 10 sips -s format jpeg -s formatOptions 80 "$f" --out "screen/$n.jpg" >/dev/null
  fi
  # a busy photo can stay over 250 KB at quality 80: make it again at quality 65, same size
  if [ "$(stat -f %z "screen/$n.jpg")" -gt 250000 ]; then
    nice -n 10 sips -s format jpeg -s formatOptions 65 -Z 1200 "$f" --out "screen/$n.jpg" >/dev/null
  fi
  ow=$(sips -g pixelWidth "screen/$n.jpg" | awk '/pixelWidth/{print $2}')
  oh=$(sips -g pixelHeight "screen/$n.jpg" | awk '/pixelHeight/{print $2}')
  echo "$n ${w}x${h} $(stat -f %z "$f") -> ${ow}x${oh} $(stat -f %z "screen/$n.jpg")"
done
