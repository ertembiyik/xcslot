// Renders the README's header, figures and chips from scripts/art/*.html with headless Chrome: `bun scripts/art.ts`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const dumped = Bun.spawnSync(
    [
      CHROME,
      "--headless=new",
      "--disable-gpu",
      `--user-data-dir=${join(work, "profile")}`,
      "--dump-dom",
      `file://${resolve("scripts/art/chips.html")}`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const json = dumped.stdout.toString().match(/<pre id="out">([^<]*)<\/pre>/)?.[1];
  if (dumped.exitCode !== 0 || json === undefined) throw new Error("Chrome did not render scripts/art/chips.html");
  const unescape = (text: string) =>
    text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  mkdirSync(".github/assets/chips", { recursive: true });
  for (const chip of JSON.parse(unescape(json)) as { file: string; svg: string }[]) {
    writeFileSync(`.github/assets/chips/${chip.file}.svg`, chip.svg);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
