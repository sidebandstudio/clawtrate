import type { UpdateInstallRefusal, UpdateTrack } from "@clawtrate/core";

/** Host proof captured after the engine renamed, reopened and hashed the file. */
export interface VerifiedArtifact {
  readonly offerId: string | null;
  readonly track: UpdateTrack;
  readonly version: string;
  readonly path: string;
  readonly identity: string;
  readonly sha512: string;
  readonly size: number;
}

export interface UpdateInstaller {
  /** Build policy alone can forbid an install. This check does no I/O. */
  unavailable: UpdateInstallRefusal | null;
  completesOnQuit?: true;
  /** The native owner asks the app to quit while waiting on its process handle. */
  requestsQuit?: true;
  retire?(): void;
  inspect(file: VerifiedArtifact): Promise<UpdateInstallRefusal | null>;
  /** Recheck identity, bytes and signature under protection through launch. */
  launch(
    file: VerifiedArtifact,
    signal: AbortSignal,
    handed: () => void,
    submitted?: () => void,
  ): Promise<UpdateInstallRefusal | "installer-failed" | null>;
}
