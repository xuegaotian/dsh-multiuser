import { stdin, stdout } from 'node:process'
import { Command } from 'commander'
import { AuthStore, type Role } from './auth-local.js'
import { installUserRuntimeProfile } from './profile-install.js'

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
  const auth = new AuthStore(db)
  try { await action(auth) } finally { auth.close() }
}

const program = new Command()
  .name('dsh-multiuser')
  .description('Local account administration for the DSH multi-user gateway')
  .showSuggestionAfterError()

program.command('init-admin')
  .requiredOption('--db <path>', 'SQLite database path')
  .requiredOption('--username <username>', 'administrator username')
  .requiredOption('--display-name <name>', 'administrator display name')
  .option('--password-stdin', 'read the password from standard input')
  .action(async (options: CommonOptions & { username: string; displayName: string }) => {
    await run(async auth => {
      if (auth.listUsers().some(user => user.role === 'admin')) throw new Error('an administrator already exists')
      const password = await readPassword(options)
      const user = await auth.createUser({ username: options.username, displayName: options.displayName, password, role: 'admin' })
      stdout.write(`created administrator ${user.username} (${user.id})\n`)
    }, options.db)
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

try {
  await program.parseAsync()
} catch (error) {
  stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
