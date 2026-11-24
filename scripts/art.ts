// Renders the README's header and figures from scripts/art/*.html with headless Chrome: `bun scripts/art.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const work = mkdtempSync(join(tmpdir(), "xcslot-art-"));

function shoot(html: string, out: string, width: number, height: number, scale: number, transparent: boolean) {
  const done = Bun.spawnSync(
    [
      CHROME,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(work, "profile")}`,
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      ...(transparent ? ["--default-background-color=00000000"] : []),
      `--screenshot=${resolve(out)}`,
      `file://${html}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (done.exitCode !== 0) throw new Error(`Chrome failed for ${out}: ${done.stderr.toString()}`);
}

try {
  shoot(resolve("scripts/art/header.html"), ".github/assets/header.png", 1600, 800, 1.5, false);
  shoot(resolve("scripts/art/chart.html"), ".github/assets/chart.png", 1600, 900, 1.25, false);
  shoot(resolve("scripts/art/works.html"), ".github/assets/works.png", 1600, 500, 1.25, false);
} finally {
  rmSync(work, { recursive: true, force: true });
}
