// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 15000,
  use: {
    baseURL: 'http://localhost:3001',
    browserName: 'chromium',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx http-server . -p 3001 --cors -c-1',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
  },
});
