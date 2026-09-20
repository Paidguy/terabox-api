#!/usr/bin/env python3
"""
Example: using the TeraBox API from Python with `requests`.

    pip install requests
    python examples/python-requests.py <share-link> [--base-url URL] [--key KEY]
"""

import argparse
import sys

import requests


def resolve(base_url: str, link: str, api_key: str | None = None, password: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    params = {"link": link}
    if password:
        params["password"] = password

    response = requests.get(f"{base_url}/api/resolve", params=params, headers=headers, timeout=30)
    body = response.json()

    if not response.ok:
        error = body.get("error", {})
        raise RuntimeError(f"{error.get('code')}: {error.get('message')}")
    return body


def download(stream_url: str, dest_path: str, api_key: str | None = None) -> None:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    with requests.get(stream_url, headers=headers, stream=True, timeout=30) as response:
        response.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve and download a TeraBox share link.")
    parser.add_argument("link", help="Public TeraBox share URL")
    parser.add_argument("--base-url", default="https://your-worker.workers.dev")
    parser.add_argument("--key", default=None, help="API key, if the deployment requires one")
    parser.add_argument("--password", default=None, help="Share password, if protected")
    parser.add_argument("--no-download", action="store_true", help="Only resolve, don't fetch the file")
    args = parser.parse_args()

    share = resolve(args.base_url, args.link, args.key, args.password)

    print(f"Resolved via '{share['share']['strategy']}' strategy:")
    for file in share["files"]:
        print(f"  - {file['file_name']} ({file['file_size']}, {file['category']})")

    if args.no_download:
        return 0

    first = share["files"][0]
    print(f"\nDownloading '{first['file_name']}'...")
    download(first["stream_url"], first["file_name"], args.key)
    print(f"Saved to ./{first['file_name']}")

    if first.get("hls_url"):
        print(f"\nThis file also has an HLS manifest for browser playback:")
        print(f"  {first['hls_url']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
