#!/usr/bin/env node
import { stdin, stdout } from 'node:process'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { AuthStore, type Role } from './auth-local.js'
import { installUserRuntimeProfile } from './profile-install.js'
import { gatewayArgv, packageVersion, runDoctor, runInstall, runStatus, runUninstall, type DoctorOptions, type InstallOptions, type ServiceControlOptions } from './install.js'
import { runBackup } from './backup.js'
import { runRestore } from './restore.js'

interface CommonOptions {
  db: string
  passwordStdin?: boolean
}

async function readPassword(options: CommonOptions): Promise<string> {
  if (options.passwordStdin) {
    let input = ''
    for await (const chunk of stdin) input += String(chunk)
    return input.trimEnd()
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('password input requires a TTY or --password-stdin')
  stdout.write('Password: ')
  stdin.setRawMode(true)
  stdin.resume()
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup()
          reject(new Error('password input cancelled'))
        } else if (byte === 13 || byte === 10) {
          cleanup()
          stdout.write('\n')
          resolve(value)
        } else if (byte === 127) {
          value = value.slice(0, -1)
        } else value += String.fromCharCode(byte)
      }
    }
    const cleanup = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}

async function run(action: (auth: AuthStore) => Promise<void> | void, db: string): Promise<void> {
  // Create the database's parent directory on demand. A fresh clone has no
  // data/ directory yet, and SQLite refuses to create a file inside a missing
  // directory ("unable to open database file"), which made the documented
  // quick start fail on its first command. Creating the parent keeps
  // `init-admin --db ./data/gateway.sqlite` working without a manual mkdir.
  await mkdir(dirname(resolve(db)), { recursive: true })
  const auth = new AuthStore(db)
  try { await action(auth) } finally { auth.close() }
}

const program = new Command()
  .name('dsh-multiuser')
  .description('Local account administration for the DSH multi-user gateway')
  .showSuggestionAfterError()
  .version(packageVersion(), '--version', 'output the version number')

program.command('init-admin')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--username <username>', 'administrator username')
  .requiredOption('--display-name <name>', 'administrator display name')
  .option('--password-stdin', 'read the password from standard input')
  .action(async (options: CommonOptions & { username: string; displayName: string }) => {
    try {
      await run(async auth => {
        if (auth.listUsers().some(user => user.role === 'admin')) throw new Error('an administrator already exists')
        const password = await readPassword(options)
        const user = await auth.createUser({ username: options.username, displayName: options.displayName, password, role: 'admin' })
        stdout.write(`created administrator ${user.username} (${user.id})\n`)
      }, options.db)
    } finally {
      // This command creates the credential store. Tighten it to owner-only so the
      // documented install sequence (install -> init-admin -> doctor) does not fail
      // DB_PERMISSION on a database that was just created. The file is created
      // before password validation, so tighten in a finally block: a rejected
      // password would otherwise still leave a world-readable empty database.
      await chmod(resolve(options.db), 0o600).catch(() => undefined)
    }
  })

program.command('create-user')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--username <username>', 'username')
  .requiredOption('--display-name <name>', 'display name')
  .option('--role <role>', 'user or admin', 'user')
  .option('--password-stdin', 'read the password from standard input')
  .action(async (options: CommonOptions & { username: string; displayName: string; role: string }) => {
    if (options.role !== 'user' && options.role !== 'admin') throw new Error('role must be user or admin')
    await run(async auth => {
      const password = await readPassword(options)
      const user = await auth.createUser({ username: options.username, displayName: options.displayName, password, role: options.role as Role })
      stdout.write(`created ${user.role} ${user.username} (${user.id})\n`)
    }, options.db)
  })

program.command('disable-user')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--username <username>', 'username')
  .action(async (options: { db: string; username: string }) => {
    await run(auth => {
      const user = auth.listUsers().find(item => item.username === options.username.toLowerCase())
      if (user === undefined) throw new Error('user not found')
      auth.disableUser(user.id)
      stdout.write(`disabled ${user.username}\n`)
    }, options.db)
  })

program.command('reset-password')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--username <username>', 'username')
  .option('--password-stdin', 'read the password from standard input')
  .action(async (options: CommonOptions & { username: string }) => {
    await run(async auth => {
      const user = auth.listUsers().find(item => item.username === options.username.toLowerCase())
      if (user === undefined) throw new Error('user not found')
      const password = await readPassword(options)
      await auth.resetPassword(user.id, password)
      stdout.write(`reset password for ${user.username}; existing sessions revoked\n`)
    }, options.db)
  })

program.command('link-sso-user')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--local-username <username>', 'existing local normal username')
  .requiredOption('--issuer <issuer>', 'SSO token issuer for the external identity')
  .requiredOption('--subject <uuid>', 'immutable SSO subject UUID')
  .requiredOption('--sso-username <name>', 'current SSO username')
  .requiredOption('--confirm', 'confirm that all existing local sessions will be revoked')
  .action(async (options: { db: string; localUsername: string; issuer: string; subject: string; ssoUsername: string; confirm: boolean }) => {
    if (!options.confirm) throw new Error('--confirm is required')
    await run(auth => {
      const user = auth.linkExternalUser(options.localUsername, options.issuer, options.subject, options.ssoUsername)
      stdout.write(`linked ${user.username} to SSO identity; existing sessions revoked\n`)
    }, options.db)
  })

program.command('install-profile')
  .description('install and verify the multi-user Profile in a DeepSeek Harness home')
  .requiredOption('--dsh-command <command>', 'DSH CLI command, such as dsh or node')
  .option('--dsh-args <json>', 'arguments before the DSH CLI arguments', '[]')
  .option('--dsh-cwd <path>', 'DeepSeek Harness directory used for module resolution')
  .requiredOption('--dsh-home <path>', 'Harness home used by DSH')
  .option('--profile <name>', 'profile to install into', 'user-runtime')
  .requiredOption('--profile-source <path>', 'versioned dsh-multiuser user-runtime Profile directory')
  .action(async (options: { dshCommand: string; dshArgs: string; dshCwd?: string; dshHome: string; profile: string; profileSource: string }) => {
    const args: unknown = JSON.parse(options.dshArgs)
    if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('--dsh-args must be a JSON string array')
    await installUserRuntimeProfile({
      command: options.dshCommand,
      args,
      home: options.dshHome,
      ...(options.dshCwd === undefined ? {} : { cwd: options.dshCwd }),
    }, options.profile, options.profileSource)
    stdout.write(`installed and verified DSH profile ${options.profile} in ${options.dshHome}\n`)
  })

const environmentOptions = (command: Command): Command => command
  .requiredOption('--dsh-command <command>', 'DSH CLI command, such as the path to a dsh binary')
  .option('--dsh-args <json>', 'JSON array of launcher prefix arguments', '[]')
  .option('--dsh-cwd <path>', 'directory used for DSH module resolution')

const deploymentOptions = (command: Command): Command => command
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--data-root <path>', 'per-user data root')

const ssoOptions = (command: Command): Command => command
  .option('--sso-public-key <entry...>', 'SSO public key as kid=/absolute/key.pem (repeatable)')
  .option('--sso-issuer <issuer>', 'required SSO token issuer')
  .option('--sso-audience <audience>', 'required SSO token audience')
  .option('--sso-origin <origin>', 'trusted HTTP(S) origin for SSO form posts')

environmentOptions(ssoOptions(program.command('doctor')
  .description('read-only environment check with stable result codes; never modifies state')))
  .requiredOption('--db <path>', 'SQLite database path (existence and permissions are checked)')
  .requiredOption('--data-root <path>', 'per-user data root (existence and permissions are checked)')
  .requiredOption('--profile-source <path>', 'versioned user-runtime Profile directory')
  .option('--profile <name>', 'profile to compose', 'user-runtime')
  .option('--insecure-cookies', 'report --insecure-cookies usage as a failure')
  .option('--json', 'print machine-readable JSON instead of text')
  .action(async (options: DoctorOptions) => {
    const { ok } = await runDoctor(options)
    if (!ok) process.exitCode = 1
  })

environmentOptions(ssoOptions(program.command('install')
  .description('idempotent installation of the gateway application files (local or systemd mode)')))
  .requiredOption('--mode <mode>', 'local or systemd')
  .requiredOption('--app-dir <path>', 'application installation directory')
  .requiredOption('--data-dir <path>', 'data directory (preserved when reinstalling)')
  .requiredOption('--profile-source <path>', 'versioned user-runtime Profile directory inside the app package')
  .option('--profile <name>', 'profile to install', 'user-runtime')
  .option('--host <host>', 'gateway bind host', '127.0.0.1')
  .option('--port <port>', 'gateway port', '18088')
  .option('--allowed-host <authority...>', 'accepted Host authorities')
  .option('--service-user <user>', 'systemd service account', 'dsh-multiuser')
  .option('--system-root <path>', 'stage system paths (unit, env, keys) under this root instead of / (for previewing without root)', '')
  .option('--dry-run', 'show the plan without modifying anything')
  .option('--insecure-cookies', 'disable Secure cookie for local HTTP development')
  .action(async (options: InstallOptions & { profileSource: string; dryRun?: boolean }) => {
    if (options.mode !== 'local' && options.mode !== 'systemd') throw new Error('--mode must be local or systemd')
    await runInstall({ ...options, dryRun: options.dryRun === true, systemRoot: options.systemRoot ?? '' })
  })

program.command('upgrade')
  .description('disabled in preview releases; use the documented stop/backup/install/verify flow')
  .action(() => {
    throw new Error('upgrade is disabled in preview releases; production upgrades require: stop the service -> backup -> install the new version -> start the service -> verify')
  })

program.command('uninstall')
  .description('remove application files; keeps data unless --purge-data')
  .requiredOption('--app-dir <path>', 'application installation directory')
  .requiredOption('--data-dir <path>', 'data directory (kept unless --purge-data)')
  .option('--purge-data', 'also remove the data directory (requires a safe absolute path)')
  .option('--dry-run', 'show the plan without modifying anything')
  .action(async (options: { appDir: string; dataDir: string; purgeData?: boolean; dryRun?: boolean }) => {
    await runUninstall(options.appDir, options.dataDir, options.purgeData === true, options.dryRun === true)
  })

environmentOptions(program.command('status')
  .description('report gateway health, readiness, version, and administrator initialization state'))
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--data-root <path>', 'per-user data root')
  .requiredOption('--profile-source <path>', 'versioned user-runtime Profile directory')
  .option('--profile <name>', 'profile used by the gateway', 'user-runtime')
  .option('--host <host>', 'gateway bind host', '127.0.0.1')
  .option('--port <port>', 'gateway port', '18088')
  .option('--host-header <authority>', 'Host header for the local probe when the gateway enforces --allowed-host')
  .action(async (options: ServiceControlOptions & { hostHeader?: string }) => { await runStatus(options) })

environmentOptions(program.command('start')
  .description('print the exact gateway command to start the service; does not daemonize (local mode)'))
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--data-root <path>', 'per-user data root')
  .requiredOption('--profile-source <path>', 'versioned user-runtime Profile directory')
  .option('--profile <name>', 'profile used by the gateway', 'user-runtime')
  .option('--host <host>', 'gateway bind host', '127.0.0.1')
  .option('--port <port>', 'gateway port', '18088')
  .option('--allowed-host <authority...>', 'accepted Host authorities')
  .option('--insecure-cookies', 'disable Secure cookie for local HTTP development')
  .action(async (options: Omit<ServiceControlOptions, 'allowedHost'> & { allowedHost?: string[] }) => {
    const argv = gatewayArgv({ ...options, allowedHost: options.allowedHost?.[0] })
    stdout.write(`node dist/src/gateway-cli.js ${argv.join(' ')}\n`)
    stdout.write('this command only prints the line above; it does not start or daemonize anything.\n')
    stdout.write('run it from the application directory yourself, or use install --mode systemd and systemctl.\n')
  })

program.command('backup')
  .description('write a consistent backup of the gateway (safe while the gateway is running)')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--data-root <path>', 'per-user data root (the users/ level, not its parent)')
  .requiredOption('--to <path>', 'absolute directory the timestamped backup is written into')
  .option('--config-dir <path>', 'deployment config directory to include (may hold secret material)')
  .option('--json', 'print a single machine-readable JSON line instead of a text summary')
  .action(async (options: { db: string; dataRoot: string; to: string; configDir?: string; json?: boolean }) => {
    await runBackup({
      db: options.db,
      dataRoot: options.dataRoot,
      to: options.to,
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
      json: options.json === true,
    })
  })

program.command('restore')
  .description('restore a backup after verifying it; refuses a non-empty target without --force')
  .requiredOption('--from <path>', 'backup directory containing manifest.json')
  .requiredOption('--data-root <path>', 'target per-user data root (the users/ level, not its parent)')
  .option('--db <path>', 'target SQLite database path (default: <data-root>/gateway.sqlite)')
  .option('--config-dir <path>', 'target deployment config directory (only when the backup recorded one)')
  .option('--force', 'move existing data aside instead of refusing a non-empty target')
  .option('--dry-run', 'show the plan without writing anything')
  .action(async (options: { from: string; dataRoot: string; db?: string; configDir?: string; force?: boolean; dryRun?: boolean }) => {
    // runRestore prints its own plan (dry run) or summary; never duplicate it here.
    await runRestore({
      from: options.from,
      dataRoot: options.dataRoot,
      ...(options.db === undefined ? {} : { db: options.db }),
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
      force: options.force === true,
      dryRun: options.dryRun === true,
    })
  })

program.command('stop')
  .description('stop the gateway (systemd: systemctl stop dsh-multiuser; local: send SIGTERM)')
  .option('--pid-file <path>', 'PID file of a locally started gateway')
  .action(async (options: { pidFile?: string }) => {
    if (options.pidFile === undefined) {
      stdout.write('systemd mode: sudo systemctl stop dsh-multiuser\nlocal mode: kill -TERM <gateway pid> (see the PID file used by your start wrapper)\n')
      return
    }
    const pid = Number((await readFile(options.pidFile, 'utf8')).trim())
    if (Number.isInteger(pid) && pid > 1) {
      process.kill(pid, 'SIGTERM')
      stdout.write(`sent SIGTERM to ${String(pid)}\n`)
    } else stdout.write(`PID file ${options.pidFile} does not hold a valid PID\n`)
  })

try {
  await program.parseAsync()
} catch (error) {
  stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
