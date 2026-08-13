import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
    isTemporarilyUnavailable?: boolean;
  }>;
}

export class ManagedObsSecretError extends Error {
  constructor(readonly code: "OBS_SECURE_STORAGE_UNAVAILABLE" | "OBS_SECURE_STORAGE_FAILED", cause?: unknown) {
    super(code, { cause });
    this.name = "ManagedObsSecretError";
  }
}

export class ManagedObsSecretStore {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly generateSecret: () => string = () => randomBytes(32).toString("base64url")
  ) {}

  async loadOrCreate(): Promise<string> {
    if (!(await this.safeStorage.isAsyncEncryptionAvailable())) {
      throw new ManagedObsSecretError("OBS_SECURE_STORAGE_UNAVAILABLE");
    }

    try {
      const encrypted = await readFile(this.filePath);
      const decrypted = await this.safeStorage.decryptStringAsync(encrypted);
      if (decrypted.isTemporarilyUnavailable || !decrypted.result) {
        throw new ManagedObsSecretError("OBS_SECURE_STORAGE_UNAVAILABLE");
      }
      if (decrypted.shouldReEncrypt) await this.persist(decrypted.result);
      return decrypted.result;
    } catch (error) {
      if (error instanceof ManagedObsSecretError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ManagedObsSecretError("OBS_SECURE_STORAGE_FAILED", error);
      }
    }

    const secret = this.generateSecret();
    if (!secret) throw new ManagedObsSecretError("OBS_SECURE_STORAGE_FAILED");
    await this.persist(secret);
    return secret;
  }

  private async persist(secret: string): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      const encrypted = await this.safeStorage.encryptStringAsync(secret);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new ManagedObsSecretError("OBS_SECURE_STORAGE_FAILED", error);
    }
  }
}
