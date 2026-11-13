import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  expect: { timeout: 20000 },
  use: {
    baseURL: "http://127.0.0.1:4179",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `${process.env.FIRE_SITE_PREVIEW ? "npm run preview" : "npm run dev"} -- --port 4179 --strictPort`,
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
