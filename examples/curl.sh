#!/usr/bin/env bash
# Example usage of the TeraBox API with curl.
#
# Replace BASE_URL with your deployment, and LINK with a real TeraBox share
# URL. If the worker has API_KEY set, add:  -H "Authorization: Bearer KEY"

set -euo pipefail

BASE_URL="${BASE_URL:-https://your-worker.workers.dev}"
LINK="${LINK:-https://terabox.com/s/1EXAMPLE}"

echo "== Health check =="
curl -s "$BASE_URL/health" | jq .

echo
echo "== Resolve a share link =="
curl -s -G "$BASE_URL/api/resolve" --data-urlencode "link=$LINK" | jq .

echo
echo "== Resolve a password-protected share =="
# curl -s -G "$BASE_URL/api/resolve" \
#   --data-urlencode "link=$LINK" \
#   --data-urlencode "password=1234" | jq .

echo
echo "== Resolve via POST with a JSON body =="
curl -s -X POST "$BASE_URL/api/resolve" \
  -H "Content-Type: application/json" \
  -d "{\"link\": \"$LINK\"}" | jq .

echo
echo "== Resolve several links in one batch call =="
curl -s -X POST "$BASE_URL/api/batch" \
  -H "Content-Type: application/json" \
  -d "{\"links\": [\"$LINK\"]}" | jq .

echo
echo "== Download the first file =="
STREAM_URL=$(curl -s -G "$BASE_URL/api/resolve" --data-urlencode "link=$LINK" | jq -r '.stream_url')
curl -s -L -o downloaded_file "$STREAM_URL"
echo "Saved to ./downloaded_file"

echo
echo "== Resume a partial download with Range =="
# curl -s -H "Range: bytes=1000000-" -o downloaded_file.part "$STREAM_URL"

echo
echo "== Check file size/type without downloading (HEAD) =="
curl -s -I "$STREAM_URL"

echo
echo "== Get the HLS manifest for a video file (if hls_url is non-null) =="
HLS_URL=$(curl -s -G "$BASE_URL/api/resolve" --data-urlencode "link=$LINK" | jq -r '.files[0].hls_url')
if [ "$HLS_URL" != "null" ]; then
  curl -s "$HLS_URL"
else
  echo "(this file has no HLS manifest — it isn't a video, or one isn't available)"
fi
