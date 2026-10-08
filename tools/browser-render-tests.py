"""Differential pixels/cursors on each backend; unavailable GPUs are not passes."""
from __future__ import annotations

import argparse
import json
from typing import Any
from playwright.sync_api import sync_playwright
from browser_test_support import ORIGIN, OUTPUT, launch_options, write_report

UNAVAILABLE_MESSAGES = (
    "WebGL2 is unavailable",
    "No WebGPU adapter is available",
    "WebGPU is not exposed by this browser",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--allow-unavailable", action="store_true")
    args = parser.parse_args()
    results: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch_options(headed=args.headed))
        try:
            for backend in ("canvas", "webgl2", "webgpu"):
                page = browser.new_page(
                    viewport={"width": 800, "height": 600}, device_scale_factor=1
                )
                errors: list[str] = []
                page.on("pageerror", lambda error, log=errors: log.append(str(error)))
                try:
                    page.goto(ORIGIN + "/apps/client/render-test.html")
                    # Function syntax avoids eval of a string under the application's CSP.
                    page.wait_for_function("() => typeof window.validateRenderer === 'function'")
                    result = page.evaluate("backend => window.validateRenderer(backend)", backend)
                    result["requestedBackend"] = backend
                    result["pageErrors"] = errors
                    result["status"] = (
                        "passed" if result["mismatches"] == 0
                        and result["cursorMismatches"] == 0
                        and not result["lost"] and not errors else "failed"
                    )
                    page.locator("canvas").first.screenshot(
                        path=str(OUTPUT / f"render-{backend}.png")
                    )
                except Exception as error:
                    message = str(error)
                    unavailable = any(marker in message for marker in UNAVAILABLE_MESSAGES)
                    result = {
                        "backend": backend,
                        "status": "unavailable" if unavailable and not errors else "failed",
                        "error": message,
                        "pageErrors": errors,
                    }
                finally:
                    page.close()
                print(json.dumps(result, indent=2))
                results.append(result)
        finally:
            browser.close()
    write_report("renderers.json", results)
    allowed = {"passed", "unavailable"} if args.allow_unavailable else {"passed"}
    assert all(result["status"] in allowed for result in results), "Renderer validation failed"
    if any(result["status"] == "unavailable" for result in results):
        print("Unavailable GPU backends remain UNVERIFIED, not passed.")


if __name__ == "__main__":
    main()
