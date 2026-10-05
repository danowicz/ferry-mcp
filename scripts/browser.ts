// Headless Chromium for the scripts: Playwright's cached build when present.
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cached = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')

export const launchBrowser = () => chromium.launch({ executablePath: existsSync(cached) ? cached : undefined })
