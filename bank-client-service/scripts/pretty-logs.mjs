// Dev log formatter: pino-pretty, with the agent-to-agent exchange logs ("Client requested ... to bank
// agent", "X agent answered ...", logged with `exchange: true`) in bold yellow so the conversation flow
// stands out. Colors follow pino-pretty's detection: dev.sh sets FORCE_COLOR since it pipes the output.
import { build } from "pino-pretty";

// The function form of messageFormat skips pino-pretty's control-character stripping: redo it, so a
// logged text can't inject terminal escape sequences.
const UNSAFE_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const stream = build({
  ignore: "hostname,exchange",
  messageFormat: (log, messageKey, _levelLabel, { colors }) => {
    const message = String(log[messageKey] ?? "").replace(UNSAFE_CONTROL_CHARS, "");
    return log.exchange ? colors.bold(colors.yellow(message)) : message;
  },
});
process.stdin.pipe(stream);
