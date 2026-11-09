#!/usr/bin/env python3
"""Import decrypted SoundCloud cookies into stealth Chromium and verify login.

Usage: python scripts/stealth-import-cookies.py <cookies.json> [url]
The cookie values are read from the file and never printed.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HOME = Path.home()
BASE = Path(os.environ.get("STEALTH_BROWSER_MCP_BASE", HOME / ".local/share/stealth-browser-mcp"))
SOURCE = Path(os.environ.get("STEALTH_BROWSER_MCP_HOME", HOME / "stealth-browser-mcp"))
PYTHON = Path(os.environ.get("STEALTH_BROWSER_MCP_PYTHON", BASE / "venv/bin/python"))
DATA_DIR = BASE / "data"
TMP_DIR = BASE / "tmp"
CHROMIUM = Path("/data/data/com.termux/files/usr/bin/chromium-browser")


def parse_result(result):
    if getattr(result, "structuredContent", None):
        return result.structuredContent
    content = getattr(result, "content", None) or []
    if content:
        text = getattr(content[0], "text", None)
        if text:
            try:
                payload = json.loads(text)
                if isinstance(payload, dict) and "result" in payload and len(payload) == 1:
                    return payload["result"]
                return payload
            except json.JSONDecodeError:
                return text
    return None


async def call(session, name, arguments=None):
    result = await session.call_tool(name, arguments or {})
    return parse_result(result)


async def main():
    cookies_path = Path(sys.argv[1])
    target = sys.argv[2] if len(sys.argv) > 2 else "https://soundcloud.com/you/library"
    data = json.loads(cookies_path.read_text())
    cookies = [c for c in data.get("cookies", []) if c.get("value")]

    env = {
        **os.environ,
        "HOME": str(HOME),
        "TMPDIR": str(TMP_DIR),
        "STEALTH_BROWSER_MCP_DATA_DIR": str(DATA_DIR),
    }
    if CHROMIUM.exists():
        env["STEALTH_BROWSER_EXECUTABLE"] = str(CHROMIUM)

    params = StdioServerParameters(
        command=str(PYTHON),
        args=["-m", "stealth_browser_mcp"],
        env=env,
        cwd=str(SOURCE),
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            spawned = await call(
                session,
                "spawn_browser",
                {
                    "headless": True,
                    "user_agent": "Mozilla/5.0 (Linux; Android 16; RMX3709) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
                    "viewport_width": 412,
                    "viewport_height": 915,
                    "timezone_id": "Europe/Moscow",
                    "browser_args": ["--no-sandbox", "--disable-dev-shm-usage"],
                    "sandbox": False,
                },
            )
            instance_id = spawned["instance_id"] if isinstance(spawned, dict) else None
            if not instance_id:
                print("spawn_failed", spawned)
                return 1

            imported = 0
            for cookie in cookies:
                domain = cookie.get("domain", "")
                host = domain.lstrip(".")
                payload = {
                    "instance_id": instance_id,
                    "name": cookie["name"],
                    "value": cookie["value"],
                    "path": cookie.get("path") or "/",
                    "secure": bool(cookie.get("secure")),
                    "http_only": bool(cookie.get("httpOnly")),
                }
                if domain.startswith("."):
                    payload["domain"] = domain
                else:
                    payload["url"] = f"https://{host}{cookie.get('path') or '/'}"
                same_site = cookie.get("sameSite")
                if same_site in (1, 2, 3):
                    payload["same_site"] = "Lax" if same_site == 1 else "Strict"
                try:
                    if await call(session, "set_cookie", payload):
                        imported += 1
                except Exception as error:
                    print("cookie_error", cookie["name"], str(error)[:120])

            navigation = await call(session, "navigate", {
                "instance_id": instance_id,
                "url": target,
                "wait_until": "load",
                "timeout": 45000,
            })
            checked = await call(session, "execute_script", {
                "instance_id": instance_id,
                "script": "(function(){var t=(document.body&&document.body.innerText)||'';return {url:location.href,title:document.title,text:t.slice(0,400),loggedIn:!/\\bLog in\\b|\\bSign in\\b/i.test(t)&&t.length>0}})()",
            })
            await call(session, "close_instance", {"instance_id": instance_id})
            print(json.dumps({
                "imported": imported,
                "total": len(cookies),
                "navigate": navigation,
                "check": checked,
            }, ensure_ascii=False)[:1500])
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
