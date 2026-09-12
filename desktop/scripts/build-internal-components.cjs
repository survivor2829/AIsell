try {
  require("./build-internal-release.cjs").main(["--components", ...process.argv.slice(2)]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
