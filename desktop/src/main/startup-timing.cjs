// One bounded startup trace, shared by the stable bootstrap and selected app.
function createStartupTiming(clock = () => Math.round(process.uptime() * 1000)) {
  const stages = new Map();
  let logger;
  return {
    mark(stage) {
      if (stages.has(stage)) return;
      const elapsed_ms = clock();
      stages.set(stage, elapsed_ms);
      logger?.event('startup', stage, { elapsed_ms }, { trace: true });
    },
    attach(value) {
      logger = value;
      for (const [stage, elapsed_ms] of stages) logger.event('startup', stage, { elapsed_ms }, { trace: true });
    }
  };
}
module.exports = { createStartupTiming };
