/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';
import { disconnect } from '../connection.js';

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      const marker = sub === cmd.defaultSubcommand ? '  (default)' : '';
      console.log(`  ${sub.padEnd(12)}${subConf.description}${marker}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
  const opts = cmd.options || {};
  if (Object.keys(opts).length > 0) {
    console.log('\nOptions:');
    for (const [k, v] of Object.entries(opts)) {
      const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
      console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
    }
  }
}

/**
 * Reject flags the command never declared.
 *
 * parseArgs runs with `strict: false` so that negative numbers survive
 * (`--price -5.5` is an error under strict parsing). The cost is that an
 * unknown flag is accepted silently: `--targts 110` becomes `{targts: true}`
 * plus a stray positional, and the command runs on with targets missing. On a
 * CLI that mutates a live chart a swallowed typo is a wrong action, not a
 * no-op, so every parsed key has to be one the command asked for.
 */
function assertKnownOptions(values, options, usage) {
  const known = new Set(['help', 'h']);
  for (const [name, conf] of Object.entries(options)) {
    known.add(name);
    if (conf.short) known.add(conf.short);
  }
  const unknown = Object.keys(values).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    const flags = unknown.map((u) => (u.length === 1 ? `-${u}` : `--${u}`)).join(', ');
    throw new Error(
      `Unknown option${unknown.length > 1 ? 's' : ''}: ${flags}. Run "tv ${usage} --help" for the accepted options.`,
    );
  }
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return finish(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    return finish(1);
  }

  // Handle subcommands (e.g., tv pine get)
  let handler, options;
  if (cmd.subcommands) {
    let subName = args[1];
    let subArgs = args.slice(2);

    if (subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      return finish(0);
    }

    // A command may nominate a read-only default so that the bare verb still
    // reports state (`tv symbol` -> `tv symbol get`). Only a declared default
    // is ever run implicitly — a mutating subcommand must always be typed.
    if (subName === undefined || subName.startsWith('-')) {
      if (!cmd.defaultSubcommand) {
        if (subName !== undefined) console.error(`${cmdName} needs a subcommand before ${subName}.`);
        printCommandHelp(cmdName, cmd);
        return finish(subName === undefined ? 0 : 1);
      }
      subArgs = args.slice(1);
      subName = cmd.defaultSubcommand;
    }

    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      printCommandHelp(cmdName, cmd);
      return finish(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
      const { values, positionals } = parseArgs({
        args: subArgs,
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName} [options]\n`);
        console.log(sub.description);
        if (Object.keys(options).length > 0) {
          console.log('\nOptions:');
          for (const [k, v] of Object.entries(options)) {
            const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
            console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
          }
        }
        return finish(0);
      }
      assertKnownOptions(values, options, `${cmdName} ${subName}`);
      await execute(handler, values, positionals);
    } catch (err) {
      await handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        return finish(0);
      }
      assertKnownOptions(values, options, cmdName);
      await execute(handler, values, positionals);
    } catch (err) {
      await handleError(err);
    }
  }
}

/** Grace period before force-exiting if a handle is still holding the loop open. */
const EXIT_GRACE_MS = 2000;

/**
 * Ends a command: records the exit code and releases resources so the event loop
 * can drain on its own.
 *
 * Deliberately does NOT call process.exit(). On Windows, tearing down the libuv
 * loop while an outbound HTTPS request is still closing (e.g. `pine check`, which
 * posts to pine-facade.tradingview.com) aborts the process with
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 * and an exit code of 0xC0000409 instead of the code we asked for.
 *
 * The CDP WebSocket does have to be closed explicitly — it is a live handle that
 * would otherwise keep the process alive indefinitely.
 */
async function finish(code) {
  process.exitCode = code;
  await disconnect();
  // Safety net so an unexpected open handle can never turn into a hang. Unref'd,
  // so it does not delay an otherwise clean exit.
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
}

async function execute(handler, values, positionals) {
  try {
    const result = await handler(values, positionals);
    console.log(JSON.stringify(result, null, 2));
    await finish(0);
  } catch (err) {
    await handleError(err);
  }
}

async function handleError(err) {
  const message = err.message || String(err);
  // Connection failures get exit code 2, everything else 1.
  const code = /CDP|connection|ECONNREFUSED|not running/i.test(message) ? 2 : 1;
  console.error(JSON.stringify({ success: false, error: message }, null, 2));
  await finish(code);
}
