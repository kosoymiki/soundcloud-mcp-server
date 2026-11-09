import { loadConfig } from "../dist/config.js";
import { Logger } from "../dist/logger.js";
import { EventBus } from "../dist/events.js";
import { UploadService } from "../dist/uploads/service.js";
import { AudioService } from "../dist/audio/service.js";

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error("usage: node scripts/trim-track.mjs <input> <output> [startSeconds] [endSeconds]");
  process.exit(1);
}
const startSeconds = Number(process.argv[4] ?? 21);
const endSeconds = Number(process.argv[5] ?? 105);

const config = loadConfig();
const logger = new Logger("warn");
const events = new EventBus();
const uploads = new UploadService(config, logger, events, null);
const audio = new AudioService(config, logger, events, uploads);

const result = await audio.process({
  filePath: input,
  operation: "trim",
  startSeconds,
  endSeconds,
  format: "mp3",
  bitrateKbps: 320,
  outputPath: output,
  overwrite: true,
});
console.log(JSON.stringify({
  input: input,
  input_duration: result.input.duration_seconds,
  start_seconds: startSeconds,
  end_seconds: endSeconds,
  output_path: result.output_path,
  output_duration: result.output.duration_seconds,
  output_size: result.output.size,
  elapsed_ms: result.elapsed_ms,
  warnings: result.warnings,
}, null, 2));
