// otto/mamoru#293 (review of #202 r3): the OnFailure helper of the guardian unit. A fixed line through the guardian's own
// alert sinks (console + the webhook file); never a log excerpt, never the webhook URL.
import { alerterFrom } from './main.ts'

const unit = process.argv[2] ?? 'mamoru-guardian'
if (!/^mamoru-guardian(@[\w.-]+)?$/.test(unit)) process.exit(2)
await alerterFrom(process.env).alert(`:warning: ${unit} failed. On the host: journalctl --user -u ${unit} -n 30`)
