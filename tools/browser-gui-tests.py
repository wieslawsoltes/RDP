"""Exercise the real GUI and packet-driven local lab; requires Python Playwright."""
from __future__ import annotations

import argparse
import json
from playwright.sync_api import expect, sync_playwright
from browser_test_support import ORIGIN, OUTPUT, launch_options, write_report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch_options(headed=args.headed))
        try:
            page = browser.new_page(
                viewport={"width": 1440, "height": 1100}, device_scale_factor=1
            )
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(ORIGIN)
            expect(page.locator("#start-lab")).to_be_visible()
            page.screenshot(path=str(OUTPUT / "workspace-desktop.png"), full_page=True)
            page.locator("#backend").select_option("canvas")
            page.locator("#start-lab").click()
            expect(page.locator(".session-foot")).to_contain_text("active", timeout=20000)
            page.wait_for_timeout(500)
            page.screenshot(path=str(OUTPUT / "protocol-lab-desktop.png"), full_page=True)
            page.get_by_role("button", name="Keyboard and Unicode input", exact=True).click()
            page.get_by_role("textbox", name="Unicode text to send", exact=True).fill(
                "Zażółć gęślą jaźń 🚀"
            )
            page.get_by_role("button", name="Send Unicode text", exact=True).click()
            page.get_by_role("button", name="Text clipboard", exact=True).click()
            page.get_by_role("textbox", name="Local clipboard text", exact=True).fill(
                "Clipboard from browser\nsecond line"
            )
            page.get_by_role("button", name="Send remote", exact=True).click()
            page.wait_for_timeout(300)
            page.screenshot(path=str(OUTPUT / "protocol-lab-clipboard.png"), full_page=True)
            page.get_by_role("button", name="Close panel", exact=True).click()
            page.get_by_role("combobox", name="Remote desktop resolution").select_option("800x600")
            expect(page.locator(".session-foot")).to_contain_text("800 × 600", timeout=10000)
            page.get_by_role("button", name="Disconnect and close session", exact=True).click()
            page.locator("#save-profile").click()
            expect(page.locator("#profile-count")).to_have_text("1")
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(OUTPUT / "workspace-mobile.png"), full_page=True)
            page.locator("#start-lab").click()
            expect(page.locator(".session-foot")).to_contain_text("active", timeout=20000)
            page.wait_for_timeout(500)
            page.screenshot(path=str(OUTPUT / "protocol-lab-mobile.png"), full_page=True)
            report = {
                "pageErrors": errors,
                "desktop": "1440x1100",
                "mobile": "390x844",
                "labActivation": True,
                "unicodeInputSent": True,
                "clipboardInputSent": True,
                "resize": "800x600",
                "profileSave": True,
                "scope": "Local encoded-packet fixture, not a Windows interoperability test.",
            }
            write_report("gui.json", report)
            print(json.dumps(report, indent=2))
            assert not errors, "Uncaught browser page errors"
        finally:
            browser.close()


if __name__ == "__main__":
    main()
