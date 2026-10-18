// Runs a command with a hard timeout and kills its whole process group when the time is up,
// when it is interrupted, or when it exits, so no Electron helper outlives a run.
//   node scripts/with-timeout.mjs <seconds> <command> [args...]
// Exits with the command's code, or 124 on timeout (like coreutils timeout).

import { spawn } from 'node:child_process'

const [seconds, command, ...args] = process.argv.slice(2)
if (!seconds || !command || !(Number(seconds) > 0)) {
  console.error('usage: node scripts/with-timeout.mjs <seconds> <command> [args...]')
  process.exit(2)
}

// detached: the child leads a new process group, so -pid reaches Electron's helpers too.
const child = spawn(command, args, { stdio: 'inherit', detached: true })

function killGroup(signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  console.error(`with-timeout: ${command} still running after ${seconds} s, killing it`)
  killGroup('SIGTERM')
  setTimeout(() => killGroup('SIGKILL'), 5000).unref()
}, Number(seconds) * 1000)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killGroup('SIGTERM')
    setTimeout(() => {
      killGroup('SIGKILL')
      process.exit(130)
    }, 2000).unref()
  })
}

child.on('error', (err) => {
  console.error(`with-timeout: cannot start ${command}: ${err.message}`)
  process.exit(127)
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  killGroup('SIGKILL') // helpers left behind by the main process
  process.exit(timedOut ? 124 : (code ?? (signal ? 1 : 0)))
})
