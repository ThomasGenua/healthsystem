/**
 * Native SFTP polling client.
 *
 * The filedrop source already covers the common northern pattern: openssh
 * terminates a transfer into a landing directory and Portage takes it from
 * there. This is for the case where there is no local landing directory to
 * watch because the files live on someone else's server.
 *
 * `ssh2-sftp-client` is an optional dependency, imported only when a channel
 * names an sftp source.
 */

export interface SftpFile {
  name: string;
  size: number;
}

export interface SftpClient {
  list(dir: string): Promise<SftpFile[]>;
  get(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  close(): Promise<void>;
}

export interface SftpConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
  readyTimeoutMs?: number;
}

interface RawSftp {
  connect(cfg: Record<string, unknown>): Promise<unknown>;
  list(dir: string): Promise<Array<{ name: string; size: number; type: string }>>;
  get(path: string): Promise<Buffer | string>;
  rename(from: string, to: string): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  mkdir(dir: string, recursive?: boolean): Promise<unknown>;
  end(): Promise<unknown>;
}

export async function connectSftp(opts: SftpConnectOptions): Promise<SftpClient> {
  // Held in a variable so the TypeScript program does not require the
  // package's types for an optional dependency.
  const specifier: string = "ssh2-sftp-client";
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `the sftp source needs the optional 'ssh2-sftp-client' package (npm install ssh2-sftp-client): ${detail}`
    );
  }

  const Ctor = (mod.default ?? mod) as new () => RawSftp;
  const sftp = new Ctor();
  await sftp.connect({
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.username,
    password: opts.password,
    privateKey: opts.privateKey,
    passphrase: opts.passphrase,
    readyTimeout: opts.readyTimeoutMs ?? 20_000,
  });

  return {
    async list(dir) {
      const entries = await sftp.list(dir);
      // "-" is a regular file. Directories and links are not ingestible.
      return entries.filter((e) => e.type === "-").map((e) => ({ name: e.name, size: e.size }));
    },
    async get(path) {
      const data = await sftp.get(path);
      return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    },
    rename: async (from, to) => void (await sftp.rename(from, to)),
    delete: async (path) => void (await sftp.delete(path)),
    mkdir: async (dir) => void (await sftp.mkdir(dir, true)),
    close: async () => void (await sftp.end()),
  };
}
